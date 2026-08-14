#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'opencode-hosted-runtime.lock.json'), 'utf8'));
const provenance = JSON.parse(
  await readFile(resolve(root, 'opencode-hosted-runtime.provenance.json'), 'utf8')
);
const candidatePath = process.argv[2] ? resolve(process.argv[2]) : null;

function invariant(value, message) {
  if (!value) throw new Error(`hosted-opencode-provenance-invalid:${message}`);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

invariant(provenance.schemaVersion === 1, 'schema');
invariant(provenance.assets.length === 5, 'asset-count');
invariant(lock.productionEligible === false, 'eligibility');
invariant(provenance.release.productionEligible === false, 'provenance-eligibility');
invariant(lock.releaseRepository === provenance.release.repository, 'repository');
invariant(lock.version === provenance.release.version, 'version');
invariant(lock.tag === provenance.release.tag && lock.tag === `v${lock.version}`, 'tag');
invariant(lock.source.commit === provenance.release.sourceCommit, 'source-commit');
invariant(lock.source.baseCommit === provenance.release.baseCommit, 'base-commit');
invariant(lock.source.reviewedPatchSha256 === provenance.release.patchSha256, 'patch');

for (const asset of provenance.assets) {
  const locked = lock.platforms[asset.platform];
  invariant(locked?.status === 'available', `lock-platform:${asset.platform}`);
  invariant(locked.file === asset.archive, `archive-name:${asset.platform}`);
  invariant(locked.archiveSha256 === asset.archiveSha256, `archive-hash:${asset.platform}`);
  invariant(locked.binaryName === asset.binary, `binary-name:${asset.platform}`);
  invariant(locked.binarySha256 === asset.binarySha256, `binary-hash:${asset.platform}`);
  invariant(
    locked.assetUrl ===
      `https://github.com/${provenance.release.repository}/releases/download/${provenance.release.tag}/${asset.archive}`,
    `tag-url:${asset.platform}`
  );
}

if (candidatePath) {
  const candidateBytes = await readFile(candidatePath);
  invariant(
    createHash('sha256').update(candidateBytes).digest('hex') ===
      provenance.candidateManifestSha256,
    'candidate-manifest-hash'
  );
  const candidate = JSON.parse(candidateBytes.toString('utf8'));
  invariant(candidate.release.sourceCommit === provenance.release.sourceCommit, 'candidate-commit');
  invariant(candidate.release.sourceTree === provenance.release.sourceTree, 'candidate-tree');
  invariant(candidate.release.baseCommit === provenance.release.baseCommit, 'candidate-base');
  invariant(candidate.release.patchSha256 === provenance.release.patchSha256, 'candidate-patch');
  invariant(candidate.release.tag === provenance.release.tag, 'candidate-tag');
  invariant(candidate.release.productionEligible === false, 'candidate-eligibility');
  const candidateAssets = new Map(
    candidate.assets.map((asset) => [
      `${asset.os === 'windows' ? 'win32' : asset.os}-${asset.arch}`,
      asset,
    ])
  );
  for (const expected of provenance.assets) {
    const actual = candidateAssets.get(expected.platform);
    invariant(actual?.archive === expected.archive, `candidate-archive:${expected.platform}`);
    invariant(
      actual.archiveSha256 === expected.archiveSha256,
      `candidate-archive-hash:${expected.platform}`
    );
    invariant(actual.binaryPath === expected.binary, `candidate-binary:${expected.platform}`);
    invariant(
      actual.binarySha256 === expected.binarySha256,
      `candidate-binary-hash:${expected.platform}`
    );
  }
  const candidateDirectory = dirname(candidatePath);
  for (const expected of provenance.assets) {
    const archivePath = resolve(candidateDirectory, expected.archive);
    try {
      await access(archivePath);
      invariant(
        (await sha256File(archivePath)) === expected.archiveSha256,
        `materialized-archive:${expected.platform}`
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const linuxBinary = resolve(candidateDirectory, 'opencode');
  try {
    await access(linuxBinary);
    const expected = provenance.assets.find((asset) => asset.platform === 'linux-x64');
    invariant(
      (await sha256File(linuxBinary)) === expected.binarySha256,
      'materialized-linux-x64-binary'
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

process.stdout.write(
  `${JSON.stringify({
    verified: true,
    assets: provenance.assets.length,
    candidate: candidatePath !== null,
  })}\n`
);
