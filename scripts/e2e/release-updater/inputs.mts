import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const repository = '777genius/agent-teams-ai';
export const applicationSha = '359417f642abb97429aa6eb1a92f3ce52254e5f4';
// Independently downloaded and hashed official release bytes, 2026-10-04.
export const pins = [
  { file: 'old.AppImage', tag: 'v2.17.1', name: 'Agent.Teams.AI-2.17.1.AppImage', size: 273263953, sha256: '02c35d4497f019e02d6fca113ad25ffbd9b63c6ca3c7ae71286cd8af309799e6' },
  { file: 'target.AppImage', tag: 'v2.17.2', name: 'Agent.Teams.AI-2.17.2.AppImage', size: 278777768, sha256: '21ee04fac11e8436cc3a6fee9c3691435ce0a19abc367e0db8336ad2698efbb9' },
  { file: 'old.deb', tag: 'v2.17.1', name: 'agent-teams-ai_2.17.1_amd64.deb', size: 193985224, sha256: 'd2daf11bc93fde813d1df2fef25bfc5d6beebd419f7d47b8082d8da9e0ccf6ec' },
];
export const linuxFeedAssets = [
  { name: 'Agent.Teams.AI-2.17.2.AppImage', size: 278777768, sha512: 'V7FuO7sCr39aoi/LNxeT7eyNQgBAQBL2JXBAP7RE1XbRm8b4N0P5MkW7p+k8gfzjCw+7VJ8KLL780mYc/WRu2Q==' },
  { name: 'agent-teams-ai_2.17.2_amd64.deb', size: 202913732, sha512: 'cvqY9NHjvrnrH3/J+H37g5XzIEJRzhU70syk5AniDY2mu0qVtltrnU4anVkXTe953Z7CI0jcxutQu8vhiHfMsw==' },
  { name: 'agent-teams-ai-2.17.2.x86_64.rpm', size: 168608109, sha512: 'pYurx2PhOFI8iy17AxRq+hOeYNAUINj9K8akx4mmvfsymDZiwT0ax8G5Kk9vncgUCg+YSBj8VXct+Bgc6RMlaw==' },
  { name: 'agent-teams-ai-2.17.2.pacman', size: 179952652, sha512: 'PWH98Cqw12oDIPxjCyloMTmuw+2EuHbmcQV+3jn1I5rql58Ot+Bo2yWVYQKDQhwUu1yCzGKzgu8Rizg3zVMgIA==' },
];
export interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  name: string | null;
  body: string | null;
  created_at: string;
  assets: { name: string; size: number; digest?: string }[];
}

export async function hashFile(file: string) {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) {
    assert(Buffer.isBuffer(chunk), 'File stream must emit Buffers');
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { size: (await stat(file)).size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

export async function loadInputs(directory: string) {
  const catalog = JSON.parse(await readFile(path.join(directory, 'input-catalog.json'), 'utf8')) as {
    repository: string; targetTag: string; targetApplicationSha: string; feasibilityOnly: boolean;
    linuxFeedAssets: typeof linuxFeedAssets;
  };
  assert.equal(catalog.repository, repository);
  assert.equal(catalog.targetTag, 'v2.17.2');
  assert.equal(catalog.targetApplicationSha, applicationSha);
  assert.equal(catalog.feasibilityOnly, true, 'Final promotion outputs require a separate native harness');
  assert.deepEqual(catalog.linuxFeedAssets, linuxFeedAssets, 'Unexpected feasibility feed snapshot');
  const verified = [];
  for (const pin of pins) {
    const actual = await hashFile(path.join(directory, pin.file));
    assert.equal(actual.size, pin.size, `${pin.file}: size`);
    assert.equal(actual.sha256, pin.sha256, `${pin.file}: independent SHA256`);
    verified.push({ ...pin, ...actual });
  }
  const targetHash = verified.find(item => item.file === 'target.AppImage');
  assert.equal(targetHash?.sha512, linuxFeedAssets[0]?.sha512, 'Real target SHA512 must match feed');
  const draft = JSON.parse(await readFile(path.join(directory, 'draft-api.json'), 'utf8')) as Release;
  const source = JSON.parse(await readFile(path.join(directory, 'source-api.json'), 'utf8')) as Release;
  assert.equal(draft.id, 401358336);
  assert.equal(draft.tag_name, 'v2.17.2');
  assert.equal(draft.target_commitish, applicationSha);
  assert.equal(draft.draft, true);
  assert.equal(draft.prerelease, false);
  assert.equal(source.tag_name, 'v2.17.1');
  assert.equal(source.draft, false);
  assert.equal(source.prerelease, false);
  assert(Number.isFinite(Date.parse(draft.created_at)) && typeof draft.body === 'string');
  for (const release of [draft, source]) {
    for (const pin of pins.filter(item => item.tag === release.tag_name)) {
      const asset = release.assets.find(item => item.name === pin.name);
      assert.equal(asset?.size, pin.size, `${pin.name}: API size`);
      assert.equal(asset?.digest, `sha256:${pin.sha256}`, `${pin.name}: API digest`);
    }
  }
  const first = linuxFeedAssets[0];
  assert(first);
  const files = linuxFeedAssets.map(item => `  - url: ${item.name}\n    sha512: ${item.sha512}\n    size: ${item.size}\n`).join('');
  const feed = `version: 2.17.2\nfiles:\n${files}path: ${first.name}\nsha512: ${first.sha512}\nreleaseDate: '${draft.created_at}'\n`;
  return { verified, draft, source, feed, inputDigest: createHash('sha256').update(JSON.stringify({ pins, catalog, draft, source })).digest('hex') };
}

// Workflow writes a disposable catalog; binaries and snapshots never enter Git.
if (process.argv[2] === '--write-catalog') {
  assert(process.argv[3], 'Missing input directory');
  await writeFile(path.join(process.argv[3], 'input-catalog.json'), JSON.stringify({
    repository, targetTag: 'v2.17.2', targetApplicationSha: applicationSha, feasibilityOnly: true, linuxFeedAssets,
  }, null, 2));
}
