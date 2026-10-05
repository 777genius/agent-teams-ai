import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import { validateOrigins } from '../../ci/release/assembly.ts';
import {
  MANIFEST,
  assetByName,
  canonical,
  checkMetadata,
  digest,
  fileProof,
  manifestFor,
  platformNames,
  sameProof,
  textProof,
} from '../../ci/release/contract.ts';
import { GitHubReleasePort } from '../../ci/release/github.ts';
import { readAsar, readInspectorFuse } from './archive.mts';

import type { Asset, Original, Release, StagePlan } from '../../ci/release/contract.ts';
import type { MacCommands } from './mac-loopback.mts';

const repository = '777genius/agent-teams-ai';
export const sourceSha = '395572f9ff2a261cb28224754883a39d2c3c8827';
const oldSha = '0d4ff551b80891db8e97e690ba23cfd5251e2db0';
const oldDmg = {
  arm64: {
    id: 593747171,
    size: 249860511,
    sha256: 'ffee8ea0ae14507da597a7339c1e78481d2ddaf96686e6aad32229f716cc46d7',
  },
  x64: {
    id: 593755166,
    size: 259653436,
    sha256: '7588f7e429f9a3bcbaecae1465bea621ffe001102b96e3fb19d23beb4adbefb5',
  },
};
const port = new GitHubReleasePort();
export async function captureOldMacSources(
  commands: MacCommands,
  installed: string,
  label: string
) {
  const resources = path.join(installed, 'Contents', 'Resources');
  const asar = path.join(resources, 'app.asar');
  const names = [
    'package.json',
    'dist-electron/main/index.cjs',
    'node_modules/electron-updater/package.json',
    'node_modules/electron-updater/out/AppUpdater.js',
    'node_modules/electron-updater/out/MacUpdater.js',
    'node_modules/electron-updater/out/providers/GitHubProvider.js',
    'node_modules/electron-updater/out/electronHttpExecutor.js',
  ];
  const sources = await readAsar(asar, names);
  const ledger = [];
  for (const [name, bytes] of sources) {
    await writeFile(path.join(commands.output, `${label}-${name.replaceAll('/', '__')}`), bytes);
    ledger.push({ name, size: bytes.length, sha256: digest(bytes) });
  }
  const framework = path.join(
    installed,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework'
  );
  const fuse = await readInspectorFuse(framework);
  const bytes = sources.get('package.json');
  assert(bytes);
  return {
    sources: ledger,
    packageVersion: (JSON.parse(bytes.toString()) as { version: string }).version,
    asar: await fileProof(asar, 'app.asar'),
    fuse,
    updateConfig: await readFile(path.join(resources, 'app-update.yml'), 'utf8'),
  };
}
export async function coldMacUpdaterCache(home: string, configuration: string) {
  const parsed = parse(configuration) as Record<string, unknown>;
  assert.equal(parsed.provider, 'github');
  assert.equal(parsed.owner, '777genius');
  assert.equal(parsed.repo, 'agent-teams-ai');
  const name = parsed.updaterCacheDirName;
  assert(
    typeof name === 'string' &&
      name.length > 0 &&
      path.basename(name) === name &&
      name !== '.' &&
      name !== '..'
  );
  const directory = path.join(home, 'Library', 'Caches', name);
  try {
    await lstat(directory);
    throw new Error(`Existing updater cache is forbidden: ${directory}`);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
  }
  return { directory, verifiedAbsentBefore: true, preloadLocationSeparateFromUpdaterCache: true };
}
export function sourceMacPin(plan: StagePlan, name: string) {
  const original = plan.input.originals.find(
    (item) => item.name === name && item.tag === 'v2.17.1'
  );
  assert(original);
  return original;
}
async function verifiedDownload(
  release: Release,
  asset: Asset,
  original: Original,
  destination: string
) {
  checkMetadata(asset, original);
  await port.download(repository, asset, destination);
  sameProof(await fileProof(destination, original.name), original);
  return {
    releaseId: release.id,
    tag: release.tag_name,
    assetId: asset.id,
    restDigest: asset.digest,
    originalAssetId: original.assetId,
    proof: await fileProof(destination, original.name),
  };
}
export async function prepareMacInputs(
  plan: StagePlan,
  root: string,
  mode: 'preview' | 'staged',
  architecture: 'arm64' | 'x64',
  evidence: Record<string, unknown>,
  inputReceipt: { planSha256: string; inputDigest: string; toolingSha: string }
) {
  const source = await port.release(repository, 'v2.17.1');
  await validateOrigins(port, plan, true);
  await port.publicRelease(repository, source.tag_name);
  const raw = path.join(root, 'source-latest-mac.yml');
  const feedProof = sourceMacPin(plan, 'latest-mac.yml');
  const sourceFeed = await verifiedDownload(
    source,
    assetByName(source, feedProof.name),
    feedProof,
    raw
  );
  const feed = await readFile(raw, 'utf8');
  assert.equal(feed, plan.feeds['latest-mac.yml']);
  let selected = source;
  let binding: unknown;
  if (mode === 'staged') {
    selected = await validateOrigins(port, plan, true);
    const manifest = path.join(root, MANIFEST);
    const expected = textProof(MANIFEST, `${canonical(manifestFor(plan))}\n`);
    const asset = assetByName(selected, MANIFEST);
    checkMetadata(asset, expected);
    await port.download(repository, asset, manifest);
    sameProof(await fileProof(manifest, MANIFEST), expected);
    assert.equal(await readFile(manifest, 'utf8'), `${canonical(manifestFor(plan))}\n`);
    const stagedFeed = path.join(root, 'draft-latest-mac.yml');
    const draftFeed = await verifiedDownload(
      selected,
      assetByName(selected, feedProof.name),
      feedProof,
      stagedFeed
    );
    assert.equal(await readFile(stagedFeed, 'utf8'), feed);
    for (const original of plan.input.originals.filter(
      (item) => item.tag === 'v2.17.1' && /\.(zip|dmg)$/.test(item.name)
    ))
      checkMetadata(assetByName(selected, original.name), original);
    binding = {
      manifestAssetId: asset.id,
      manifestRestDigest: asset.digest,
      manifest: expected,
      inputDigest: digest(canonical(plan.input)),
      draftFeed,
    };
  }
  const files = new Map<string, { file: string; size: number }>();
  const downloads = [];
  const [armZip, armDmg, intelZip, intelDmg] = platformNames('2.17.1').mac;
  const names =
    architecture === 'arm64' ? { zip: armZip, dmg: armDmg } : { zip: intelZip, dmg: intelDmg };
  for (const name of [names.zip, names.dmg]) {
    const original = sourceMacPin(plan, name);
    const file = path.join(root, name);
    downloads.push(await verifiedDownload(selected, assetByName(selected, name), original, file));
    files.set(name, { file, size: original.size });
  }
  const reread = await port.release(repository, selected.tag_name);
  for (const download of downloads)
    assert.deepEqual(
      assetByName(reread, download.proof.name),
      assetByName(selected, download.proof.name)
    );
  await validateOrigins(port, plan, true);
  evidence.finalPromotionFeed = mode === 'staged';
  evidence.planBindingVerified = mode === 'staged';
  evidence.inputs = {
    mode,
    sourceFeed,
    binding,
    downloads,
    draftRetrievalPerformed: mode === 'staged',
    sourceSha,
    oldSha,
    planSha256: inputReceipt.planSha256,
    inputDigest: inputReceipt.inputDigest,
    toolingSha: inputReceipt.toolingSha,
  };
  return { source, files, feed, names };
}
export async function oldMacInstaller(
  root: string,
  architecture: 'arm64' | 'x64',
  evidence: Record<string, unknown>
) {
  const old = await port.release(repository, 'v2.17.0');
  assert.equal(old.id, 397802474);
  assert(!old.draft && !old.prerelease);
  assert.equal(await port.tagSha(repository, old.tag_name), oldSha);
  await port.publicRelease(repository, old.tag_name);
  const name = `Agent.Teams.AI-2.17.0-${architecture}.dmg`;
  const asset = assetByName(old, name);
  const expected = oldDmg[architecture];
  assert.equal(asset.id, expected.id);
  assert.equal(asset.size, expected.size);
  assert.equal(asset.digest, `sha256:${expected.sha256}`);
  const file = path.join(root, name);
  await port.download(repository, asset, file);
  const proof = await fileProof(file, name);
  assert.equal(proof.sha256, expected.sha256);
  assert.equal(proof.size, expected.size);
  evidence.oldInstaller = {
    releaseId: old.id,
    assetId: asset.id,
    restDigest: asset.digest,
    applicationSha: oldSha,
    proof,
  };
  assert.deepEqual(assetByName(await port.release(repository, old.tag_name), name), asset);
  assert.equal(await port.tagSha(repository, old.tag_name), oldSha);
  return file;
}
