/* eslint no-console: off, import/no-extraneous-dependencies: off */

import 'util/catchUnhandledRejection';
import Progress from 'progress';
import client, { processMeta } from 'util/client';
import getIn from 'util/getInFactory';
import GraphQL from '../util/GraphQL';

async function main() {
  // Get all rummors with answer specified.
  //
  const allRumors = getIn(await client.search({
    index: 'rumors',
    body: {
      size: 10000,

      // https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-script-query.html
      //
      query: { bool: { must: { script: { script: {
        lang: 'painless',
        inline: "doc['answerIds'].length > 0",
      } } } } },
    },
  }))(['hits', 'hits'], []).map(processMeta);

  console.log('Querying rumors in DB...');
  const progress = new Progress('[:bar] :current/:total :etas', { total: allRumors.length });

  const allResults = await Promise.all(allRumors.map(({ text }) => GraphQL({
    query: `
      query ($text: String) {
        Search(text: $text, findInCrawled: false) {
          rumors {
            score
            doc {
              id
              text
              answers {
                versions {
                  text
                }
              }
            }
          }
          suggestedResult {
            __typename
            ... on Rumor {
              id
              text
            }
          }
        }
      }
    `,
    variables: {
      text,
    },
  }).then((data) => {
    progress.tick();
    return data;
  })));

  let invalidCount = 0;
  allResults.forEach(({ data }, i) => {
    const rumor = allRumors[i];
    if (data.Search.suggestedResult === null || data.Search.suggestedResult.id !== rumor.id) {
      invalidCount += 1;
      console.log(rumor.id, data.Search.suggestedResult && data.Search.suggestedResult.id);
    }
  });

  console.log('---- Summary ----');
  console.log(`${allRumors.length - invalidCount}/${allRumors.length} correct`);
  console.log(`${(100 * ((allRumors.length - invalidCount) / allRumors.length)).toFixed(2)} % correct.`);
}

main();
