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
const publicAssets = [
  'Agent.Teams.AI.Setup.2.19.0.exe',
  'Agent.Teams.AI.Setup.2.19.0-arm64.exe',
  'Agent.Teams.AI-2.19.0-arm64.dmg',
  'Agent.Teams.AI-2.19.0-x64.dmg',
  'Agent.Teams.AI-2.19.0.AppImage',
  'agent-teams-ai_2.19.0_amd64.deb',
  'agent-teams-ai-2.19.0.x86_64.rpm',
  'agent-teams-ai-2.19.0.pacman',
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
];
for (const name of publicAssets) {
  const pin = published219Pair.targetAssets.find((asset) => asset.name === name);
  assert(pin, 'Missing public URL pin: ' + name);
  await port.publicAsset(published219Pair.repository, published219Pair.target.tag, name);
}
process.stdout.write(
  JSON.stringify(
    {
      ...evidence,
      tagRefs: { predecessor: predecessorTagSha, target: targetTagSha },
      publicAssetsHeadChecked: publicAssets,
      releaseMutation: false,
    },
    null,
    2
  ) + '\n'
);
