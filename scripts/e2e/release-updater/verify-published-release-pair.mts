import assert from 'node:assert/strict';

import { GitHubReleasePort } from '../../ci/release/github.ts';
import {
  published219Pair,
  verifyPublished219Pair,
} from './published-release-pair.mts';

assert.equal(
  process.env.GITHUB_REPOSITORY,
  published219Pair.repository,
  'Live release proof must run in the canonical repository'
);
assert(process.env.GH_TOKEN, 'Read-only GitHub token required');

const port = new GitHubReleasePort();
const [predecessor, target, latest, predecessorTagSha, targetTagSha] = await Promise.all([
  port.release(published219Pair.repository, published219Pair.predecessor.tag),
  port.release(published219Pair.repository, published219Pair.target.tag),
  port.latest(published219Pair.repository),
  port.tagSha(published219Pair.repository, published219Pair.predecessor.tag),
  port.tagSha(published219Pair.repository, published219Pair.target.tag),
]);
const evidence = verifyPublished219Pair(
  predecessor,
  target,
  latest,
  predecessorTagSha,
  targetTagSha
);
const publicAssets = published219Pair.targetAssets;
for (const pin of publicAssets) {
  await port.publicAsset(published219Pair.repository, published219Pair.target.tag, pin.name);
}
process.stdout.write(
  JSON.stringify(
    {
      ...evidence,
      tagRefs: { predecessor: predecessorTagSha, target: targetTagSha },
      publicAssetsHeadChecked: publicAssets.map((asset) => asset.name),
      releaseMutation: false,
    },
    null,
    2
  ) + '\n'
);
