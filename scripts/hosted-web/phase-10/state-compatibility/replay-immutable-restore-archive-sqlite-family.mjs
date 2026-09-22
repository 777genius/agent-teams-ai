#!/usr/bin/env node

// This is deliberately a very small wrapper around the recovery authority.
// The main-process adapter gives it an already-open archive directory on fd 3
// and a freshly-created destination.  It must not learn an archive pathname
// from a restore journal: /proc/self/fd/3 continues to name the inode selected
// by the mount/archive authority even if the original name is replaced.
import { restoreStoppedStackArchive } from './stopped-stack-recovery.mjs';
import { openDirectoryBound } from './recovery-descriptor-io.mjs';

const [targetRoot, deploymentId, restoreGeneration, manifestHash, replayPlanPath, requestNonce] = process.argv.slice(2);

if (
  typeof targetRoot !== 'string' || typeof deploymentId !== 'string' ||
  !/^[1-9][0-9]*$/u.test(restoreGeneration ?? '') ||
  !/^[0-9a-f]{64}$/u.test(manifestHash ?? '') || typeof replayPlanPath !== 'string' ||
  !/^[0-9a-f]{64}$/u.test(requestNonce ?? '')
) {
  throw new Error('immutable_restore_archive_replay_arguments_invalid');
}

const archiveRoot = '/proc/self/fd/3';
const targetRootHandle = await openDirectoryBound(targetRoot);
try {
  const replayPlan = JSON.parse(await (await import('node:fs/promises')).readFile(replayPlanPath, 'utf8'));
  await restoreStoppedStackArchive({
    archiveRoot,
    targetRoot,
    targetRootHandle,
    restoreDeploymentId: deploymentId,
    restoreGeneration: Number(restoreGeneration),
    expectedManifestHash: manifestHash,
    restoreAuthorityPlan: replayPlan,
  });
  // The parent re-opens and hashes the resulting family from its retained
  // scratch descriptor. Stdout is only a nonce-bound completion response, not
  // a channel that can supply storage authority.
  process.stdout.write(`${JSON.stringify({ format: 'hosted-immutable-restore-archive-sqlite-family/v2', requestNonce })}\n`);
} finally {
  await targetRootHandle.close();
}
