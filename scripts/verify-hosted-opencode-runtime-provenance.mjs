#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'opencode-hosted-runtime.lock.json'), 'utf8'));
const candidateManifestPath = process.argv[2] ? resolve(process.argv[2]) : null;
const failures = [];

function check(value, message) {
  if (!value) failures.push(message);
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function sha256ArchiveBinary(path, asset) {
  const archiveKind = path.endsWith('.tar.gz') ? 'tar.gz' : path.endsWith('.zip') ? 'zip' : null;
  if (archiveKind === null) throw new Error('archive-kind');
  const executable = archiveKind === 'tar.gz' ? '/usr/bin/tar' : '/usr/bin/unzip';
  const args =
    archiveKind === 'tar.gz'
      ? ['-xOzf', path, asset.binaryPath]
      : ['-p', path, asset.binaryPath];
  const child = await run(executable, args, {
    encoding: 'buffer',
    maxBuffer: Math.max(asset.binarySize + 1024, 256 * 1024 * 1024),
  });
  return createHash('sha256').update(child.stdout).digest('hex');
}

async function verifyAttestation(subjectPath, repository, platform) {
  const attestationPath = `${subjectPath}.intoto.jsonl`;
  if (!(await exists(attestationPath))) {
    failures.push(`materialized-attestation-missing:${platform}`);
    return;
  }
  try {
    await run('/usr/bin/gh', [
      'attestation',
      'verify',
      subjectPath,
      '--repo',
      repository,
      '--bundle',
      attestationPath,
    ]);
  } catch {
    failures.push(`materialized-attestation-invalid:${platform}`);
  }
}

check(candidateManifestPath !== null, 'candidate-manifest-required');
if (candidateManifestPath === null) {
  throw new Error(`hosted-opencode-provenance-invalid:${failures.join(',')}`);
}

const candidateBytes = await readFile(candidateManifestPath);
const candidate = JSON.parse(candidateBytes.toString('utf8'));
const candidateDirectory = dirname(candidateManifestPath);
const manifestDigest = createHash('sha256').update(candidateBytes).digest('hex');

check(candidate.schemaVersion === 1, 'candidate-schema');
check(candidate.release?.productionEligible === false, 'candidate-eligibility');
check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate.workflow?.repository ?? ''), 'candidate-repository');
check(typeof candidate.workflow?.workflow === 'string' && candidate.workflow.workflow.length > 0, 'candidate-workflow');
check(/^[1-9][0-9]*$/.test(candidate.workflow?.runId ?? ''), 'candidate-workflow-run');
check(/^[1-9][0-9]*$/.test(candidate.workflow?.runAttempt ?? ''), 'candidate-workflow-attempt');
check(typeof candidate.workflow?.actor === 'string' && candidate.workflow.actor.length > 0, 'candidate-workflow-actor');
check(/^refs\//.test(candidate.workflow?.ref ?? ''), 'candidate-workflow-ref');
check(/^[0-9a-f]{40}$/.test(candidate.workflow?.sha ?? ''), 'candidate-workflow-sha');
check(candidate.release?.tag === `v${candidate.release?.version}`, 'candidate-tag');
check(/^[0-9a-f]{40}$/.test(candidate.release?.sourceCommit ?? ''), 'candidate-source-commit');
check(/^[0-9a-f]{40}$/.test(candidate.release?.sourceTree ?? ''), 'candidate-source-tree');
check(/^[0-9a-f]{40}$/.test(candidate.release?.baseCommit ?? ''), 'candidate-base-commit');
check(/^[0-9a-f]{64}$/.test(candidate.release?.patchSha256 ?? ''), 'candidate-patch');
check(Array.isArray(candidate.assets) && candidate.assets.length === 5, 'candidate-assets');
await verifyAttestation(candidateManifestPath, candidate.workflow?.repository, 'release-manifest');
const patchPath = resolve(candidateDirectory, 'reviewed.patch');
if (!(await exists(patchPath))) {
  failures.push('materialized-reviewed-patch-missing');
} else {
  check((await sha256File(patchPath)) === candidate.release?.patchSha256, 'materialized-patch-hash');
}

check(lock.productionEligible === false, 'lock-eligibility');
check(lock.releaseRepository === candidate.workflow?.repository, 'lock-repository');
check(lock.version === candidate.release?.version, 'lock-version');
check(lock.tag === candidate.release?.tag, 'lock-tag');
check(lock.source?.commit === candidate.release?.sourceCommit, 'lock-source-commit');
check(lock.source?.baseCommit === candidate.release?.baseCommit, 'lock-base-commit');
check(lock.source?.reviewedPatchSha256 === candidate.release?.patchSha256, 'lock-patch');

const platforms = new Set();

for (const asset of candidate.assets ?? []) {
  const platform = `${asset.os === 'windows' ? 'win32' : asset.os}-${asset.arch}`;
  check(!platforms.has(platform), `candidate-platform-duplicate:${platform}`);
  platforms.add(platform);
  const locked = lock.platforms?.[platform];
  check(locked?.status === 'available', `lock-platform:${platform}`);
  check(locked?.file === asset.archive, `lock-archive:${platform}`);
  check(locked?.archiveSha256 === asset.archiveSha256, `lock-archive-hash:${platform}`);
  check(locked?.binaryName === basename(asset.binaryPath), `lock-binary:${platform}`);
  check(locked?.binarySha256 === asset.binarySha256, `lock-binary-hash:${platform}`);
  check(
    locked?.assetUrl ===
      `https://github.com/${candidate.workflow.repository}/releases/download/${candidate.release.tag}/${asset.archive}`,
    `lock-tag-url:${platform}`
  );
  const archivePath = resolve(candidateDirectory, asset.archive);
  if (!(await exists(archivePath))) {
    failures.push(`materialized-archive-missing:${platform}`);
    continue;
  }
  check((await sha256File(archivePath)) === asset.archiveSha256, `materialized-archive-hash:${platform}`);
  try {
    check(
      (await sha256ArchiveBinary(archivePath, asset)) === asset.binarySha256,
      `materialized-binary-hash:${platform}`
    );
  } catch {
    failures.push(`materialized-binary-unverifiable:${platform}`);
  }
  await verifyAttestation(archivePath, candidate.workflow.repository, platform);
}

if (failures.length > 0) {
  throw new Error(`hosted-opencode-provenance-invalid:${failures.join(',')}`);
}
process.stdout.write(
  `${JSON.stringify({
    verified: true,
    manifestSha256: manifestDigest,
    repository: candidate.workflow.repository,
    sourceCommit: candidate.release.sourceCommit,
    sourceTree: candidate.release.sourceTree,
    workflowRunId: candidate.workflow.runId,
    tag: candidate.release.tag,
    assets: candidate.assets.length,
  })}\n`
);
