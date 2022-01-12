import {
  GraphQLString,
  GraphQLList,
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLNonNull,
} from 'graphql';
import client from 'util/client';

import {
  createFilterType,
  createSortType,
  getSortArgs,
  pagingArgs,
  intRangeInput,
  timeRangeInput,
  moreLikeThisInput,
  getRangeFieldParamFromArithmeticExpression,
  createCommonListFilter,
  attachCommonListFilter,
  getMediaFileHash,
} from 'graphql/util';
import scrapUrls from 'util/scrapUrls';
import ReplyTypeEnum from 'graphql/models/ReplyTypeEnum';
import ArticleTypeEnum from 'graphql/models/ArticleTypeEnum';
import fetch from 'node-fetch';

import { ArticleConnection } from 'graphql/models/Article';

export default {
  args: {
    filter: {
      type: createFilterType('ListArticleFilter', {
        ...createCommonListFilter('articles'),
        replyCount: {
          type: intRangeInput,
          description:
            'List only the articles whose number of replies matches the criteria.',
        },
        categoryCount: {
          type: intRangeInput,
          description:
            'List only the articles whose number of categories match the criteria.',
        },
        categoryIds: {
          type: new GraphQLList(GraphQLString),
          description:
            'List only articles that match any of the specified categories.' +
            'ArticleCategories that are deleted or has more negative feedbacks than positive ones are not taken into account.',
        },
        moreLikeThis: {
          type: moreLikeThisInput,
          description: 'List all articles related to a given string.',
        },
        replyRequestCount: {
          type: intRangeInput,
          description:
            'List only the articles whose number of replies matches the criteria.',
        },
        repliedAt: {
          type: timeRangeInput,
          description:
            'List only the articles that were replied between the specific time range.',
        },
        fromUserOfArticleId: {
          type: GraphQLString,
          description:
            'Specify an articleId here to show only articles from the sender of that specified article.',
        },
        articleRepliesFrom: {
          description:
            'Show only articles with(out) article replies created by specified user',
          type: new GraphQLInputObjectType({
            name: 'UserAndExistInput',
            fields: {
              userId: {
                type: new GraphQLNonNull(GraphQLString),
              },
              exists: {
                type: GraphQLBoolean,
                defaultValue: true,
                description: `
                  When true (or not specified), return only entries with the specified user's involvement.
                  When false, return only entries that the specified user did not involve.
                `,
              },
            },
          }),
        },
        hasArticleReplyWithMorePositiveFeedback: {
          type: GraphQLBoolean,
          description: `
            When true, return only articles with any article replies that has more positive feedback than negative.
            When false, return articles with none of its article replies that has more positive feedback, including those with no replies yet.
            In both scenario, deleted article replies are not taken into account.
          `,
        },
        replyTypes: {
          type: new GraphQLList(ReplyTypeEnum),
          description: 'List the articles with replies of certain types',
        },
        articleTypes: {
          type: new GraphQLList(ArticleTypeEnum),
          description: 'List the articles with certain types',
        },
        mediaUrl: {
          type: GraphQLString,
          description: 'Show the media article similar to the input url',
        },
      }),
    },
    orderBy: {
      type: createSortType('ListArticleOrderBy', [
        '_score',
        'updatedAt',
        'createdAt',
        'replyRequestCount',
        'replyCount',
        'lastRequestedAt',
        'lastRepliedAt',
      ]),
    },
    ...pagingArgs,
  },
  async resolve(
    rootValue,
    { filter = {}, orderBy = [], ...otherParams },
    { loaders, userId, appId }
  ) {
    const body = {
      sort: getSortArgs(orderBy, {
        replyCount: o => ({ normalArticleReplyCount: { order: o } }),
        lastRepliedAt: o => ({
          'articleReplies.createdAt': {
            order: o,
            mode: 'max',
            nested: {
              path: 'articleReplies',
              filter: {
                term: {
                  'articleReplies.status': 'NORMAL',
                },
              },
            },
          },
        }),
      }),
      track_scores: true, // for _score sorting
    };

    // Collecting queries that will be used in bool queries later
    const shouldQueries = []; // Affects scores
    const filterQueries = []; // Not affects scores
    const mustNotQueries = [];

    attachCommonListFilter(filterQueries, filter, userId, appId);

    if (filter.fromUserOfArticleId) {
      let specifiedArticle;
      try {
        specifiedArticle = (await client.get({
          index: 'articles',
          type: 'doc',
          id: filter.fromUserOfArticleId,
          _source: ['userId', 'appId'],
        })).body._source;
      } catch (e) {
        if (e.statusCode && e.statusCode === 404) {
          throw new Error(
            'fromUserOfArticleId does not match any existing articles'
          );
        }

        // Re-throw unknown error
        throw e;
      }

      filterQueries.push(
        { term: { userId: specifiedArticle.userId } },
        { term: { appId: specifiedArticle.appId } }
      );
    }

    if (filter.moreLikeThis) {
      const scrapResults = (await scrapUrls(filter.moreLikeThis.like, {
        client,
        cacheLoader: loaders.urlLoader,
      })).filter(r => r);

      const likeQuery = [
        filter.moreLikeThis.like,
        ...scrapResults.map(({ title, summary }) => `${title} ${summary}`),
      ];

      shouldQueries.push(
        {
          more_like_this: {
            fields: ['text'],
            like: likeQuery,
            min_term_freq: 1,
            min_doc_freq: 1,
            minimum_should_match:
              filter.moreLikeThis.minimumShouldMatch || '10<70%',
          },
        },
        {
          nested: {
            path: 'hyperlinks',
            score_mode: 'sum',
            query: {
              more_like_this: {
                fields: ['hyperlinks.title', 'hyperlinks.summary'],
                like: likeQuery,
                min_term_freq: 1,
                min_doc_freq: 1,
                minimum_should_match:
                  filter.moreLikeThis.minimumShouldMatch || '10<70%',
              },
            },
            inner_hits: {
              highlight: {
                order: 'score',
                fields: {
                  'hyperlinks.title': {
                    number_of_fragments: 1, // Return only 1 piece highlight text
                    fragment_size: 200, // word count of highlighted fragment
                    type: 'plain',
                  },
                  'hyperlinks.summary': {
                    number_of_fragments: 1, // Return only 1 piece highlight text
                    fragment_size: 200, // word count of highlighted fragment
                    type: 'plain',
                  },
                },
                require_field_match: false,
                pre_tags: ['<HIGHLIGHT>'],
                post_tags: ['</HIGHLIGHT>'],
              },
            },
          },
        }
      );

      // Additionally, match the scrapped URLs with other article's scrapped urls
      //
      const urls = scrapResults.reduce((urls, result) => {
        if (!result) return urls;

        if (result.url) urls.push(result.url);
        if (result.canonical) urls.push(result.canonical);
        return urls;
      }, []);

      if (urls.length > 0) {
        shouldQueries.push({
          nested: {
            path: 'hyperlinks',
            score_mode: 'sum',
            query: {
              terms: {
                'hyperlinks.url': urls,
              },
            },
          },
        });
      }
    }

    if (filter.replyCount) {
      filterQueries.push({
        range: {
          normalArticleReplyCount: getRangeFieldParamFromArithmeticExpression(
            filter.replyCount
          ),
        },
      });
    }

    if (filter.replyRequestCount) {
      filterQueries.push({
        range: {
          replyRequestCount: getRangeFieldParamFromArithmeticExpression(
            filter.replyRequestCount
          ),
        },
      });
    }

    if (filter.repliedAt) {
      filterQueries.push({
        nested: {
          path: 'articleReplies',
          query: {
            bool: {
              must: [
                { match: { 'articleReplies.status': 'NORMAL' } },
                {
                  range: {
                    'articleReplies.createdAt': getRangeFieldParamFromArithmeticExpression(
                      filter.repliedAt
                    ),
                  },
                },
              ],
            },
          },
        },
      });
    }

    if (filter.categoryIds && filter.categoryIds.length) {
      filterQueries.push({
        bool: {
          should: filter.categoryIds.map(categoryId => ({
            nested: {
              path: 'articleCategories',
              query: {
                bool: {
                  must: [
                    {
                      term: {
                        'articleCategories.categoryId': categoryId,
                      },
                    },
                    {
                      term: {
                        'articleCategories.status': 'NORMAL',
                      },
                    },
                    {
                      script: {
                        script: {
                          source:
                            "doc['articleCategories.positiveFeedbackCount'].value >= doc['articleCategories.negativeFeedbackCount'].value",
                          lang: 'painless',
                        },
                      },
                    },
                  ],
                },
              },
            },
          })),
        },
      });
    }

    if (typeof filter.hasArticleReplyWithMorePositiveFeedback === 'boolean') {
      (filter.hasArticleReplyWithMorePositiveFeedback
        ? filterQueries
        : mustNotQueries
      ).push({
        nested: {
          path: 'articleReplies',
          query: {
            bool: {
              must: [
                {
                  term: {
                    'articleReplies.status': 'NORMAL',
                  },
                },
                {
                  script: {
                    script: {
                      source:
                        "doc['articleReplies.positiveFeedbackCount'].value > doc['articleReplies.negativeFeedbackCount'].value",
                      lang: 'painless',
                    },
                  },
                },
              ],
            },
          },
        },
      });
    }

    if (filter.articleRepliesFrom) {
      (filter.articleRepliesFrom.exists === false
        ? mustNotQueries
        : filterQueries
      ).push({
        nested: {
          path: 'articleReplies',
          query: {
            bool: {
              must: [
                {
                  term: {
                    'articleReplies.status': 'NORMAL',
                  },
                },
                {
                  term: {
                    'articleReplies.userId': filter.articleRepliesFrom.userId,
                  },
                },
              ],
            },
          },
        },
      });
    }

    if (filter.replyTypes) {
      filterQueries.push({
        nested: {
          path: 'articleReplies',
          query: {
            bool: {
              must: [
                {
                  term: {
                    'articleReplies.status': 'NORMAL',
                  },
                },
                {
                  terms: {
                    'articleReplies.replyType': filter.replyTypes,
                  },
                },
              ],
            },
          },
        },
      });
    }

    // FIXME: Remove else statement after implementing media article on rumor-site
    if (filter.articleTypes) {
      filterQueries.push({
        terms: {
          articleType: filter.articleTypes,
        },
      });
    } else if (!filter.mediaUrl) {
      filterQueries.push({
        term: {
          articleType: 'TEXT',
        },
      });
    }

    if (filter.mediaUrl) {
      const file = await fetch(filter.mediaUrl);
      // FIXME: Use mime or binary header to get articleType instead of manual input
      const hash = await getMediaFileHash(await file.clone().buffer(), 'IMAGE');
      filterQueries.push({
        nested: {
          path: 'attachment',
          query: {
            term: {
              'attachment.hash': hash,
            },
          },
        },
      });
    }

    body.query = {
      bool: {
        should:
          shouldQueries.length === 0 ? [{ match_all: {} }] : shouldQueries,
        filter: filterQueries,
        must_not: mustNotQueries,
        minimum_should_match: 1, // At least 1 "should" query should present
      },
    };

    // should return search context for resolveEdges & resolvePageInfo
    return {
      index: 'articles',
      type: 'doc',
      body,
      ...otherParams,
    };
  },
  type: ArticleConnection,
};
