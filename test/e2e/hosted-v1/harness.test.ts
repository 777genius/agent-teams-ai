import { execFile, spawn as spawnChild } from 'node:child_process';
import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { FileHostedPairingDrainProof } from '@features/hosted-access/main/infrastructure/NodePersonalAuthorityAdapters';
import { NodeHostedQueryContextIdentity } from '@features/hosted-query-context/main/infrastructure/NodeHostedQueryContextIdentity';
import { HostedLifecycleRunReservationOps } from '@features/internal-storage/main/infrastructure/worker/hostedLifecycleRunReservationOps';
import { HostedPromotionStorageOps } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionStorageOps';
import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { TeamIdentityStorageOps } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps';
import { projectHostedInboxMessageId } from '@features/team-message-delivery/main/composition/hostedInboxMessageIdentity';
import { parseHostedTaskIdempotencyKey } from '@features/team-task-board/contracts/hosted';
import { createHostedAccessNodePlatform } from '@main/composition/hosted/hostedAccessNodePlatform';
import { parseRunId, parseTeamId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import {
  allocateHostedV1CaddyPublishedPorts,
  assertHostedV1ExternalCoordinationReconnectProof,
  assertHostedV1ExternalCoordinationStreamProof,
  assertHostedV1ScenarioIsolation,
  boundHostedV1EvidenceUtf8,
  captureAndAssertHostedV1ExternalCoordinationReconnectProof,
  classifyHostedV1ProjectAccess,
  cleanupHostedV1SandboxRoots,
  collectHostedV1GrantEvidence,
  collectHostedV1ScannerEvidence,
  createHostedV1ExternalCoordinationReplayBudget,
  createMarkerOwnedHostedV1ScenarioSandbox,
  freezeHostedV1DiagnosticFailures,
  HOSTED_V1_EXTERNAL_COORDINATION_RECONNECT_PROOF_MAX_BYTES,
  HostedV1ArtifactPersistenceError,
  pollHostedV1ExternalCoordinationReconnectProof,
  readHostedV1CommittedArtifact,
  redactEvidence,
  runHostedV1BestEffortDiagnostic,
  sanitizePlaywrightEvidence,
  writeHostedV1AtomicArtifact,
} from '../../../scripts/e2e/hosted-v1/run';
import {
  advanceHostedV1MountGeneration,
  assertHostedV1MarkerOwnedRoot,
  createHostedV1Sandbox,
  E2E_FORBIDDEN_WORKSPACE_ID,
  E2E_PROJECT_WORKSPACE_ID,
  E2E_RUNTIME_WORKSPACE_ID,
  E2E_TEAM_NAME,
  E2E_TEAM_RUNTIME_WORKSPACE_ID,
  E2E_WORKSPACE_ID,
  type HostedV1Sandbox,
} from '../../fixtures/hosted-v1/createSandbox';
import {
  assertFakeRuntimeMountGenerationCurrent,
  createFakeRuntimeAuthDrainCoordinator,
  createFakeRuntimeAuthDrainEpochFence,
  createFakeRuntimeOwnerMutationErrorTrace,
  createFakeRuntimeReadinessLeasePublication,
  createFakeRuntimeStateMutationQueue,
  deliverFakeRuntimeInboxMessage,
  fakeRuntimeAuthorizationIdentity,
  fakeRuntimeBootstrapMountGeneration,
  fakeRuntimeLifecycleDurableCommand,
  fakeRuntimeLifecycleOwnerAdmissionManifest,
  fakeRuntimeLifecycleProof,
  fakeRuntimeLifecycleRunId,
  fakeRuntimeProjectedMessageId,
  fakeRuntimeReadinessSessionBinding,
  fakeRuntimeTaskPayloadFingerprint,
  hostedWorkspaceAccessSeedPlan,
  invalidateFakeRuntimeAuthDrainEvidence,
  isFakeRuntimeHostedTaskIdempotencyKey,
  parseFakeRuntimeAuthDrainRequest,
  persistFakeRuntimeInboxMessage,
  publishFakeRuntimeAuthDrainEvidence,
  readFakeRuntimeMountGeneration,
  recordRuntimeExecution,
  registerFakeRuntimeReadinessLeaseCleanup,
  reserveFakeRuntimeOwnerGeneration,
  sanitizeFakeRuntimeOwnerMutationError,
  seedFrozenLifecyclePromotion,
  seedProductTeamIdentity,
  startFakeRuntimeAuthDrainServer,
  verifyFakeRuntimeLifecycleRequestFrame,
} from '../../fixtures/hosted-v1/seedContainer';

const execFileAsync = promisify(execFile);
const boundedExecOptions = { timeout: 30_000, killSignal: 'SIGKILL' as const };
const roots: string[] = [];

async function sendFakeRuntimeAuthDrainRequest(
  socketPath: string,
  request: Readonly<Record<string, unknown>>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      body += chunk;
    });
    socket.once('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

function fakeRuntimeSignedLifecycleFrame(
  trustAnchor: string,
  envelope: Readonly<Record<string, unknown>>
): string {
  const serialized = JSON.stringify(envelope);
  const ownerProof = fakeRuntimeLifecycleProof(trustAnchor, 'request', serialized);
  return `${serialized.slice(0, -1)},"ownerProof":"${ownerProof}"}\n`;
}

async function sendFakeRuntimeLifecycleRequest(
  socketPath: string,
  trustAnchor: string,
  envelope: Readonly<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const body = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(fakeRuntimeSignedLifecycleFrame(trustAnchor, envelope)));
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('fake_runtime_test_lifecycle_timeout'));
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('end', () => resolve(response));
    socket.once('error', reject);
    socket.once('close', () => {
      if (!response.endsWith('\n')) reject(new Error('fake_runtime_test_response_incomplete'));
    });
  });
  if (!body.endsWith('\n')) throw new Error('fake_runtime_test_response_incomplete');
  const serialized = body.slice(0, -1);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  const proof = parsed.ownerProof;
  if (typeof proof !== 'string') throw new Error('fake_runtime_test_response_invalid');
  const suffix = `,"ownerProof":"${proof}"}`;
  if (!serialized.endsWith(suffix)) throw new Error('fake_runtime_test_response_invalid');
  const unsigned = `${serialized.slice(0, -suffix.length)}}`;
  if (fakeRuntimeLifecycleProof(trustAnchor, 'response', unsigned) !== proof) {
    throw new Error('fake_runtime_test_response_proof_invalid');
  }
  return parsed;
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  for (;;) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadlineAt) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function waitForTemporaryArtifact(directory: string): Promise<void> {
  const deadlineAt = Date.now() + 10_000;
  for (;;) {
    if ((await readdir(directory)).some((entry) => entry.endsWith('.payload'))) return;
    if (Date.now() >= deadlineAt) {
      throw new Error('hosted_v1_test_temporary_artifact_not_observed');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function openFakeRuntimeReadinessLease(input: {
  readonly socketPath: string;
  readonly trustAnchor: string;
  readonly bootstrapBinding: Record<string, unknown>;
  readonly ownerBinding: Record<string, unknown>;
}): Promise<Socket> {
  const unsigned = {
    schemaVersion: 2,
    operation: 'readiness',
    capability: 'hosted-lifecycle-command',
    socketIdentity: input.ownerBinding.socketIdentity,
    challenge: 'a'.repeat(64),
    bootstrapBinding: input.bootstrapBinding,
    expectedOwnerBinding: input.ownerBinding,
  };
  const serialized = JSON.stringify(unsigned);
  const frame = `${serialized.slice(0, -1)},"controllerProof":"${fakeRuntimeLifecycleProof(
    input.trustAnchor,
    'readiness-request',
    serialized
  )}"}\n`;
  return new Promise((resolve, reject) => {
    const socket = createConnection(input.socketPath);
    let body = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('fake_runtime_test_readiness_timeout'));
    });
    socket.once('connect', () => socket.write(frame));
    socket.on('data', (chunk) => {
      body += chunk;
      if (!body.endsWith('\n')) return;
      try {
        const response = JSON.parse(body) as Record<string, unknown>;
        if (response.kind !== 'ready') throw new Error('fake_runtime_test_readiness_invalid');
        resolve(socket);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
    socket.once('close', () => {
      if (!body.endsWith('\n')) reject(new Error('fake_runtime_test_readiness_closed'));
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('hosted v1 browser E2E sandbox', () => {
  it('reaps a writer stalled before preflight without a parent filesystem request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-hung-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    await expect(writeHostedV1AtomicArtifact({
      path, body: '{"proof":true}', timeoutMs: 100,
      testWriterProgram: 'process.stdin.resume(); setInterval(() => {}, 1_000);',
    })).rejects.toMatchObject({
      classification: 'deadline_exceeded', path,
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((entry) => entry.endsWith('.payload'))).toEqual([]);
  });

  it('bounds a stalled artifact-directory preparation inside the writer without hanging the parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-stalled-mkdir-'));
    roots.push(root);
    const path = join(root, 'not-yet-created', 'aggregate.json');
    const startedAtMs = Date.now();
    await expect(writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 100,
      testPreparationStall: true,
    })).rejects.toMatchObject({
      classification: 'deadline_exceeded', path,
    });
    expect(Date.now() - startedAtMs).toBeLessThan(1_000);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('classifies a writer-side mkdir preparation error with its diagnostic artifact path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-mkdir-error-'));
    roots.push(root);
    const blockedDirectory = join(root, 'blocked');
    await writeFile(blockedDirectory, 'not a directory');
    const path = join(blockedDirectory, 'diagnostic-attachment.json');
    await expect(writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      classification: 'preparation_failed', path,
    });
    const failures: string[] = [];
    await expect(runHostedV1BestEffortDiagnostic({
      failures,
      name: 'attach:diagnostic-attachment.json',
      operation: () => writeHostedV1AtomicArtifact({ path, body: '{"proof":true}', timeoutMs: 1_000 }),
    })).resolves.toBeNull();
    expect(failures).toEqual([
      `attach:diagnostic-attachment.json:preparation_failed:${path}`,
    ]);
  });

  it('fails closed when cleanup starts near deadline and cannot prove owned names absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-cleanup-deadline-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const result = await writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 500,
      testWriterProgram: String.raw`
        const fs = require('node:fs'); const temporary = process.argv[2];
        process.stdin.resume(); process.stdin.on('end', () => {
          process.stdout.write('preflight-ok\\n'); fs.writeFileSync(temporary, 'partial');
          setInterval(() => {}, 1_000);
        });
      `,
      testCleanupProgram: 'setInterval(() => {}, 1_000);',
    }).then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      error: expect.objectContaining<Partial<HostedV1ArtifactPersistenceError>>({
        classification: 'deadline_exceeded', path,
      }),
    });
    const cause = (result as { readonly error: Error }).error.cause;
    expect(cause).toBeInstanceOf(AggregateError);
    // A timeout is not a successful cleanup merely because the parent has
    // stopped waiting; the owned partial remains visible to this test.
    expect((await readdir(root)).some((entry) => entry.endsWith('.payload'))).toBe(true);
  });

  it('SIGKILLs and reaps a hung cleaner before diagnostic persistence settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-cleaner-reap-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const cleanerPidPath = join(root, 'cleaner.pid');
    const result = await writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 3_000,
      testWriterProgram: String.raw`
        const fs = require('node:fs'); const temporary = process.argv[2];
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.writeFileSync(temporary, 'partial'); setInterval(() => {}, 1_000);
        });
      `,
      testCleanupProgram: String.raw`
        const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(cleanerPidPath)}, String(process.pid));
        setInterval(() => {}, 1_000);
      `,
    }).then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      error: expect.objectContaining<Partial<HostedV1ArtifactPersistenceError>>({
        classification: 'deadline_exceeded', path,
      }),
    });
    const cleanerPid = Number.parseInt(await readFile(cleanerPidPath, 'utf8'), 10);
    expect(Number.isSafeInteger(cleanerPid)).toBe(true);
    expect(() => process.kill(cleanerPid, 0)).toThrow();
  });

  it('aborts an evidence writer mid-write without publishing its final path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-abort-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const controller = new AbortController();
    const writing = writeHostedV1AtomicArtifact({
      path, body: '{"proof":"mid-write"}', timeoutMs: 15_000, signal: controller.signal,
      testWriterProgram: String.raw`
        const fs = require('node:fs'); const [destination, temporary, receipt] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.writeFileSync(temporary, 'partial'); fs.linkSync(temporary, receipt);
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n' +
            'hosted-v1-artifact-v1:transaction-prepared\n'); setInterval(() => {}, 1_000);
        });
      `,
    });
    // Observe rejection before waiting for readiness so a test failure cannot
    // become an unhandled rejection.  The writer budget exceeds the bounded
    // readiness observation, leaving abort classification deterministic.
    const writingResult = writing.then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    );
    await waitForTemporaryArtifact(root);
    controller.abort();
    await expect(writingResult).resolves.toMatchObject({
      kind: 'rejected',
      error: expect.objectContaining<Partial<HostedV1ArtifactPersistenceError>>({
        classification: 'aborted', path,
      }),
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((entry) => entry.endsWith('.payload'))).toEqual([]);
  });

  it('durably receipts the exact temporary inode before body writes so a pre-body SIGKILL is cleanup-safe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-pre-body-receipt-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const identityPath = join(root, 'receipt-identity.json');
    await expect(writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 1_000,
      testWriterProgram: String.raw`
        const fs = require('node:fs');
        const nodePath = require('node:path');
        const [destination, temporary, receipt] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.closeSync(fs.openSync(receipt, 'wx', 0o600));
          fs.linkSync(receipt, temporary);
          const directory = fs.openSync(nodePath.dirname(receipt), 'r');
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
          const temporaryIdentity = fs.lstatSync(temporary, { bigint: true });
          const receiptIdentity = fs.lstatSync(receipt, { bigint: true });
          fs.writeFileSync(${JSON.stringify(identityPath)}, JSON.stringify({
            sameDevice: temporaryIdentity.dev === receiptIdentity.dev,
            sameInode: temporaryIdentity.ino === receiptIdentity.ino,
            temporaryBytes: Number(temporaryIdentity.size),
          }));
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n' +
            'hosted-v1-artifact-v1:transaction-prepared\n', () => process.kill(process.pid, 'SIGKILL'));
        });
      `,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path,
    });
    await expect(readFile(identityPath, 'utf8')).resolves.toBe(
      JSON.stringify({ sameDevice: true, sameInode: true, temporaryBytes: 0 })
    );
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((entry) => entry.endsWith('.payload'))).toEqual([]);
  });

  it('fails final persistence deterministically when the writer fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-failure-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    await expect(writeHostedV1AtomicArtifact({
      path, body: '{}', timeoutMs: 1_000, testWriterProgram: 'process.stdin.resume(); process.exitCode = 1;',
    })).rejects.toThrow(`hosted_e2e_artifact_persistence_writer_failed:${path}`);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats newline-delimited writer acknowledgements as exact destination ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-rename-failure-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const result = await writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 1_000,
      testWriterProgram: String.raw`
        const fs = require('node:fs'); const [destination, temporary] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n');
          process.stdout.write('hosted-v1-artifact-v1:transaction-prepared\n');
          fs.writeFileSync(temporary, 'published'); fs.renameSync(temporary, destination);
          process.stdout.write('hosted-v1-artifact-v1:destination-owned\n');
          process.exitCode = 1;
        });
      `,
    }).then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      error: expect.objectContaining<Partial<HostedV1ArtifactPersistenceError>>({
        classification: 'writer_failed', path,
      }),
    });
    expect((result as { readonly error: Error }).error.cause).toBeInstanceOf(AggregateError);
    // An acknowledgement is not an exclusive lock. A public name is retained
    // after a writer failure rather than being detached during cleanup.
    await expect(readFile(path, 'utf8')).resolves.toBe('published');
  });

  it('settles an acknowledged canonical commit after SIGKILL and retries it idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-killed-after-commit-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const body = '{"proof":true}';
    await expect(writeHostedV1AtomicArtifact({
      path,
      body,
      timeoutMs: 1_000,
      testWriterInterruptAfterCanonicalLink: true,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path,
    });
    // The failed writer has already made a durable canonical record. Its
    // payload must remain readable, and a retry validates that record instead
    // of failing with destination_exists or deleting the referenced payload.
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(body);
    let retryCanonicalDirectorySynced = false;
    await expect(writeHostedV1AtomicArtifact({
      path,
      body,
      timeoutMs: 1_000,
      testOnCanonicalDirectorySynced: () => { retryCanonicalDirectorySynced = true; },
    })).resolves.toBeUndefined();
    // The callback comes from the real worker's canonical retry branch after
    // its publication-directory fsync, not from public recovery observation.
    expect(retryCanonicalDirectorySynced).toBe(true);
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(body);
    expect((await readdir(root)).filter((entry) => entry.endsWith('.payload'))).toHaveLength(1);
  });

  it('refuses to delete a replacement after post-rename crash recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-replacement-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    await expect(writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 3_000,
      testWriterProgram: String.raw`
        const fs = require('node:fs');
        const [destination, temporary, receipt, capability] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.writeFileSync(temporary, 'published');
          fs.linkSync(temporary, receipt);
          fs.renameSync(temporary, destination);
          const replacement = temporary + '.replacement';
          fs.writeFileSync(replacement, 'replacement'); fs.renameSync(replacement, destination);
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n' +
            'hosted-v1-artifact-v1:transaction-prepared\n', () => process.kill(process.pid, 'SIGKILL'));
        });
      `,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path,
    });
    await expect(readFile(path, 'utf8')).resolves.toBe('replacement');
  });

  it('preserves a competing canonical artifact when cleanup is interrupted immediately after observing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-cleanup-competing-interrupt-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    let observedPublicDestination = false;
    await expect(writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 3_000,
      testCleanupInterruptAfterEncounter: true,
      testOnPublicDestinationObserved: () => { observedPublicDestination = true; },
      testWriterProgram: String.raw`
        const fs = require('node:fs');
        const [destination, temporary, receipt] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.writeFileSync(temporary, 'published');
          fs.linkSync(temporary, receipt);
          fs.renameSync(temporary, destination);
          const competing = temporary + '.competing';
          fs.writeFileSync(competing, 'competing-canonical-artifact');
          fs.renameSync(competing, destination);
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n' +
            'hosted-v1-artifact-v1:transaction-prepared\n', () => process.kill(process.pid, 'SIGKILL'));
        });
      `,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path,
    });
    // This assertion makes the test fail if the interruption hook is not
    // reached from the observation-only public recovery path.
    expect(observedPublicDestination).toBe(true);
    await expect(readFile(path, 'utf8')).resolves.toBe('competing-canonical-artifact');
    const entries = await readdir(root);
    expect(entries.filter((entry) => entry.endsWith('.payload'))).toEqual([]);
    expect(entries.filter((entry) => entry.endsWith('.receipt'))).toHaveLength(1);
  });

  it('atomically refuses a deterministic competing publication without overwriting its evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-no-replace-race-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    await expect(writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 1_000,
      testWriterProgram: String.raw`
        const fs = require('node:fs');
        const [destination, temporary, receipt] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.closeSync(fs.openSync(receipt, 'wx', 0o600));
          fs.linkSync(receipt, temporary);
          fs.writeFileSync(temporary, 'our-proof');
          fs.writeFileSync(destination, 'competing-proof', { flag: 'wx' });
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n' +
            'hosted-v1-artifact-v1:transaction-prepared\n');
          fs.linkSync(temporary, destination);
        });
      `,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path,
    });
    await expect(readFile(path, 'utf8')).resolves.toBe('competing-proof');
    expect((await readdir(root)).filter((entry) => entry.endsWith('.payload'))).toEqual([]);
  });

  it('recognizes the cleaner success acknowledgement as a newline-delimited record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-cleaner-ack-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const result = await writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":true}',
      timeoutMs: 1_000,
      testWriterProgram: String.raw`
        const fs = require('node:fs'); const [destination, temporary] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.writeFileSync(temporary, 'published'); fs.renameSync(temporary, destination);
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n' +
            'hosted-v1-artifact-v1:transaction-prepared\n' +
            'hosted-v1-artifact-v1:destination-owned\n'); process.exitCode = 1;
        });
      `,
      testCleanupProgram: String.raw`
        const fs = require('node:fs'); const [path,,,scope] = process.argv.slice(1);
        if (scope === 'private') fs.rmSync(path, { force: true });
        process.stdout.write('hosted-v1-artifact-v1:cleaner-absent\n');
      `,
    }).then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      error: expect.objectContaining({ message: `hosted_e2e_artifact_persistence_writer_failed:${path}` }),
    });
    const cleanupAwareCause = (result as { readonly error: Error }).error.cause;
    expect(cleanupAwareCause).toBeInstanceOf(AggregateError);
    expect((cleanupAwareCause as AggregateError).errors).toHaveLength(1);
    await expect(readFile(path, 'utf8')).resolves.toBe('published');
  });

  it('publishes the final aggregate atomically after fsync with no-replace linking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-success-'));
    roots.push(root);
    const path = join(root, 'hosted-v1-diagnostic-failures-final.json');
    const aggregate = JSON.stringify({ schemaVersion: 1, attachmentFailures: [], observationFailures: [] });
    await writeHostedV1AtomicArtifact({ path, body: aggregate, timeoutMs: 1_000 });
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(aggregate);
    expect((await readdir(root)).filter((entry) => entry.endsWith('.payload'))).toHaveLength(1);
  });

  it('redacts evidence before commit hashing and leaves committed payload bytes immutable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-redacted-commit-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const path = join(root, 'aggregate.json');
    const pairingCode = 'pairing-secret-must-not-survive-commit';
    const raw = JSON.stringify({ authorization: 'Bearer raw-secret', pairingCode, root: sandbox.root });
    const redacted = redactEvidence(raw, sandbox, pairingCode);

    await writeHostedV1AtomicArtifact({
      path,
      body: raw,
      sanitizeBody: (body) => redactEvidence(body, sandbox, pairingCode),
      timeoutMs: 1_000,
    });

    const commit = JSON.parse(await readFile(path, 'utf8')) as { sha256: string; payload: string };
    const payloadPath = join(root, commit.payload);
    const committedBytes = await readFile(payloadPath);
    expect(committedBytes.toString('utf8')).toBe(redacted);
    expect(committedBytes.toString('utf8')).not.toContain(pairingCode);
    expect(commit.sha256).toBe(createHash('sha256').update(committedBytes).digest('hex'));
    // This is the normal post-write read path: it validates the same immutable
    // bytes, so later runner completion cannot make the commit digest stale.
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(redacted);
    expect(await readFile(payloadPath)).toEqual(committedBytes);
  });

  it('reads, redacts, bounds, and commits path-backed evidence in the supervised writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-source-redaction-'));
    roots.push(root);
    const sourcePath = join(root, 'raw-source.json');
    const path = join(root, 'aggregate.json');
    const secret = 'source-secret-must-not-survive';
    const raw = JSON.stringify({ authorization: `Bearer ${secret}`, root, padding: '🧪'.repeat(20_000) });
    await writeFile(sourcePath, raw, 'utf8');

    await writeHostedV1AtomicArtifact({
      path,
      sourcePath,
      sourceRedaction: {
        replacements: [{ value: root, placeholder: '<sandbox-root>' }],
        maximumBytes: 16 * 1024,
      },
      timeoutMs: 1_000,
    });

    const committed = await readHostedV1CommittedArtifact(path);
    expect(committed).not.toContain(secret);
    expect(committed).not.toContain(root);
    expect(Buffer.byteLength(committed)).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.parse(committed)).toMatchObject({
      schemaVersion: 1,
      truncated: true,
      fullRedactedSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('commits equivalent inline and path-backed CLI credential redaction before hashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-equivalent-redaction-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const pairingCode = 'pairing-code-must-not-survive';
    const apiKey = 'api-key-must-not-survive';
    const credential = 'credential-must-not-survive';
    const sourcePath = join(root, 'raw-source.json');
    const inlinePath = join(root, 'inline.json');
    const pathBackedPath = join(root, 'path-backed.json');
    const raw = JSON.stringify({
      command: `runner --api-key ${apiKey} --client-secret '${credential}'`,
      authorization: `Bearer ${credential}`,
      nested: { credential, cookie: `__Host-agent-teams-session=${credential}` },
      redirect: `https://example.invalid/callback?code=${credential}&access_token=${apiKey}`,
      pairingCode,
      root: sandbox.root,
    });
    const expected = redactEvidence(raw, sandbox, pairingCode, 16 * 1024);
    await writeFile(sourcePath, raw, 'utf8');

    await writeHostedV1AtomicArtifact({
      path: inlinePath,
      body: raw,
      sanitizeBody: (value) => redactEvidence(value, sandbox, pairingCode, 16 * 1024),
      timeoutMs: 1_000,
    });
    await writeHostedV1AtomicArtifact({
      path: pathBackedPath,
      sourcePath,
      sourceRedaction: {
        replacements: [
          { value: process.cwd(), placeholder: '<repository-root>' },
          { value: sandbox.root, placeholder: '<sandbox-root>' },
          { value: '/workspaces/sandbox', placeholder: '<runtime-workspace-root>' },
          { value: '/data/.claude', placeholder: '<runtime-claude-root>' },
          { value: '/data/.agent-teams', placeholder: '<runtime-app-data-root>' },
          { value: '/run/agent-teams-orchestrator', placeholder: '<lifecycle-runtime-root>' },
          { value: '/run/agent-teams', placeholder: '<runtime-state-root>' },
          { value: sandbox.lifecycleTrustAnchor, placeholder: '<trust-anchor>' },
          { value: pairingCode, placeholder: '<pairing-code>' },
        ],
        maximumBytes: 16 * 1024,
      },
      timeoutMs: 1_000,
    });

    const inline = await readHostedV1CommittedArtifact(inlinePath);
    const pathBacked = await readHostedV1CommittedArtifact(pathBackedPath);
    expect(inline).toBe(expected);
    expect(pathBacked).toBe(expected);
    for (const secret of [apiKey, credential, pairingCode, sandbox.root]) {
      expect(pathBacked).not.toContain(secret);
    }
    const commit = JSON.parse(await readFile(pathBackedPath, 'utf8')) as { sha256: string };
    expect(commit.sha256).toBe(createHash('sha256').update(pathBacked, 'utf8').digest('hex'));
  });

  it('enforces committed attachment file and aggregate budgets before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-retention-budget-'));
    roots.push(root);
    const perFileRoot = join(root, 'per-file');
    const aggregateRoot = join(root, 'aggregate');
    await mkdir(perFileRoot);
    await mkdir(aggregateRoot);
    const perFileBudget = {
      root: perFileRoot,
      maximumFileBytes: 16 * 1024,
      maximumTotalBytes: 4 * 1024 * 1024,
    };
    const retentionBudget = {
      root: aggregateRoot,
      maximumFileBytes: 16 * 1024,
      maximumTotalBytes: 32 * 1024,
    };
    const first = join(aggregateRoot, 'first.json');
    const second = join(aggregateRoot, 'second.json');
    const overFile = join(perFileRoot, 'over-file.json');
    const overAggregate = join(aggregateRoot, 'over-aggregate.json');
    const retained = 'a'.repeat(16 * 1024);

    await writeHostedV1AtomicArtifact({
      path: overFile, body: `${retained}x`, retentionBudget: perFileBudget, timeoutMs: 1_000,
    });
    await writeHostedV1AtomicArtifact({ path: first, body: retained, retentionBudget, timeoutMs: 1_000 });
    await writeHostedV1AtomicArtifact({ path: second, body: retained, retentionBudget, timeoutMs: 1_000 });
    await writeHostedV1AtomicArtifact({
      path: overAggregate, body: retained, retentionBudget, timeoutMs: 1_000,
    });

    expect(await readHostedV1CommittedArtifact(first)).toHaveLength(16 * 1024);
    expect(await readHostedV1CommittedArtifact(second)).toHaveLength(16 * 1024);
    expect(Buffer.byteLength(await readHostedV1CommittedArtifact(overFile))).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(await readHostedV1CommittedArtifact(overFile))).toBeGreaterThan(0);
    expect(Buffer.byteLength(await readHostedV1CommittedArtifact(overAggregate))).toBe(0);
  });

  it('serializes concurrent production attachment admissions under one aggregate budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-concurrent-retention-'));
    roots.push(root);
    const retentionBudget = {
      root,
      maximumFileBytes: 4 * 1024 * 1024,
      maximumTotalBytes: 4 * 1024 * 1024,
    };
    const paths = ['first.json', 'second.json', 'third.json'].map((name) => join(root, name));
    const body = 'a'.repeat(3 * 1024 * 1024);

    // Each call uses the production writer. The shared budget lock must cover
    // scan, admission, and publication rather than merely producing a lucky
    // non-overlapping outcome after independent scans.
    await Promise.all(paths.map((path) => writeHostedV1AtomicArtifact({
      path, body, retentionBudget, timeoutMs: 5_000,
    })));

    const retainedBytes = (await Promise.all(paths.map(async (path) =>
      Buffer.byteLength(await readHostedV1CommittedArtifact(path), 'utf8')
    ))).reduce((total, byteLength) => total + byteLength, 0);
    expect(retainedBytes).toBeLessThanOrEqual(retentionBudget.maximumTotalBytes);
    expect(retainedBytes).toBeGreaterThan(0);
  });

  it('recovers one dead lock generation while concurrent writers race to admit evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-stale-lock-race-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_536 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    // This is a fully published, dead generation rather than a missing-owner
    // gap. All contenders must serialize its recovery before either can
    // publish a replacement owner.
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'dead-generation' }), 'utf8');
    const paths = ['first.json', 'second.json', 'third.json'].map((name) => join(root, name));

    await Promise.all(paths.map((path, index) => writeHostedV1AtomicArtifact({
      path, body: String(index).repeat(1_024), retentionBudget, timeoutMs: 5_000,
    })));

    const retainedBytes = (await Promise.all(paths.map(async (path) =>
      Buffer.byteLength(await readHostedV1CommittedArtifact(path), 'utf8')
    ))).reduce((total, byteLength) => total + byteLength, 0);
    expect(retainedBytes).toBeLessThanOrEqual(retentionBudget.maximumTotalBytes);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((name) => name.includes('.candidate-') || name.endsWith('.recovery'))).toEqual([]);
  });

  it('serializes two stale-gate reclaimers before a new writer publishes its owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-stale-gate-race-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_536 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    const gatePath = `${lockPath}.recovery`;
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'dead-lock-generation' }), 'utf8');
    await writeFile(gatePath, JSON.stringify({ pid: 999_999_999, token: 'dead-gate-generation' }), 'utf8');

    const paths = ['first.json', 'second.json', 'third.json'].map((name) => join(root, name));
    await Promise.all(paths.map((path, index) => writeHostedV1AtomicArtifact({
      path, body: String(index).repeat(1_024), retentionBudget, timeoutMs: 5_000,
    })));

    const retainedBytes = (await Promise.all(paths.map(async (path) =>
      Buffer.byteLength(await readHostedV1CommittedArtifact(path), 'utf8')
    ))).reduce((total, byteLength) => total + byteLength, 0);
    expect(retainedBytes).toBeLessThanOrEqual(retentionBudget.maximumTotalBytes);
    await expect(readFile(gatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((name) => name.includes('.candidate-') || name.includes('.claim-'))).toEqual([]);
  });

  it('keeps a replacement lock when concurrent reclaimers race a dead gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-concurrent-reclaimer-replacement-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    const gatePath = `${lockPath}.recovery`;
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'dead-lock-generation' }), 'utf8');
    await writeFile(gatePath, JSON.stringify({ pid: 999_999_999, token: 'dead-gate-generation' }), 'utf8');

    // Each production call has a separate supervised writer process.  The
    // shared dead gate makes both processes reclaim concurrently; old
    // pathname-reuse promotion could rename the lock one process had already
    // republished, leaving the admitted artifact without its exclusion.
    const destinations = ['replacement-a.json', 'replacement-b.json'].map((name) => join(root, name));
    await Promise.all(destinations.map((path, index) => writeHostedV1AtomicArtifact({
      path,
      body: String(index).repeat(1_024),
      retentionBudget,
      timeoutMs: 5_000,
    })));

    const retained = await Promise.all(destinations.map((path) =>
      readHostedV1CommittedArtifact(path).then((body) => Buffer.byteLength(body, 'utf8'))
    ));
    expect(retained.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(retentionBudget.maximumTotalBytes);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(gatePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let a paused reclaimer retire the live gate published after another reclaimer removes the stale generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-publisher-barrier-interleaving-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    const gatePath = `${lockPath}.recovery`;
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'dead-lock-generation' }), 'utf8');
    await writeFile(gatePath, JSON.stringify({ pid: 999_999_999, token: 'dead-gate-generation' }), 'utf8');

    const aClaimed = join(root, 'a-reclaimer-claimed');
    const aResume = join(root, 'a-reclaimer-resume');
    const aClaimReleased = join(root, 'a-reclaimer-claim-released');
    const aClaimReleasedResume = join(root, 'a-reclaimer-claim-released-resume');
    const bRetired = join(root, 'b-reclaimer-retired');
    const bRetiredResume = join(root, 'b-reclaimer-retired-resume');
    const bClaimReleased = join(root, 'b-reclaimer-claim-released');
    const bClaimReleasedResume = join(root, 'b-reclaimer-claim-released-resume');
    const publisherBarrierEncountered = join(root, 'publisher-reclaimer-barrier-encountered');
    const publisherBarrierEncounteredResume = join(root, 'publisher-reclaimer-barrier-encountered-resume');
    const publisherGatePublished = join(root, 'publisher-gate-published');
    const publisherGateResume = join(root, 'publisher-gate-resume');

    // A observes the dead public gate and publishes its destructive claim,
    // but pauses before its final generation observation.
    const a = writeHostedV1AtomicArtifact({
      path: join(root, 'a.json'), body: 'a', retentionBudget, timeoutMs: 10_000,
      testRetentionProtocol: {
        afterReclaimerClaim: { readyPath: aClaimed, resumePath: aResume },
        afterReclaimerClaimReleased: { readyPath: aClaimReleased, resumePath: aClaimReleasedResume },
      },
    });
    await waitForPath(aClaimed);

    // B is allowed to remove the stale generation while A still holds its
    // claim. It pauses immediately after releasing its claim, before it can
    // reacquire or recover any successor state.
    const b = writeHostedV1AtomicArtifact({
      path: join(root, 'b.json'), body: 'b', retentionBudget, timeoutMs: 10_000,
      testRetentionProtocol: {
        afterRecoveryGateRetired: { readyPath: bRetired, resumePath: bRetiredResume },
        afterReclaimerClaimReleased: { readyPath: bClaimReleased, resumePath: bClaimReleasedResume },
      },
    });
    await waitForPath(bRetired);
    await expect(readFile(gatePath)).rejects.toMatchObject({ code: 'ENOENT' });

    // A's final exact-generation observation must abandon the gate B already
    // retired. Keep A paused after releasing its stale claim so B is the only
    // reclaimer the publisher can encounter.
    await writeFile(aResume, '', 'utf8');
    await waitForPath(aClaimReleased);

    // The publisher's real process claims the same barrier before it can
    // create any replacement. Its acknowledgement is emitted only after it
    // observes B's now-sole live reclaimer claim, eliminating a timing-only
    // absence assertion.
    const publisher = writeHostedV1AtomicArtifact({
      path: join(root, 'publisher.json'), body: 'publisher', retentionBudget, timeoutMs: 10_000,
      testRetentionProtocol: {
        afterPublisherReclaimerBarrierEncountered: {
          readyPath: publisherBarrierEncountered,
          resumePath: publisherBarrierEncounteredResume,
        },
        afterRecoveryGatePublished: { readyPath: publisherGatePublished, resumePath: publisherGateResume },
      },
    });
    await waitForPath(publisherBarrierEncountered);

    // B cannot advance beyond the post-release pause, while the publisher
    // remains paused after its observed barrier acknowledgement.
    await writeFile(bRetiredResume, '', 'utf8');
    await waitForPath(bClaimReleased);
    // The publisher has proven it encountered B's claim, and B is now paused
    // immediately after release. No process can race from B's release into a
    // recovery/reacquire before this absence assertion.
    await expect(waitForPath(publisherGatePublished, 100)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(gatePath)).rejects.toMatchObject({ code: 'ENOENT' });

    // Release the acknowledged publisher only after B is frozen past release,
    // then prove the publisher alone creates and keeps the replacement gate.
    await writeFile(publisherBarrierEncounteredResume, '', 'utf8');
    await waitForPath(publisherGatePublished);
    await writeFile(bClaimReleasedResume, '', 'utf8');
    await writeFile(aClaimReleasedResume, '', 'utf8');

    const liveOwner = JSON.parse(await readFile(gatePath, 'utf8')) as { pid: number; token: string };
    expect(liveOwner.pid).toBeGreaterThan(0);
    expect(liveOwner.token).not.toBe('dead-lock-generation');
    // A has exited after its exact-generation re-read. The replacement remains
    // public while its publisher is deliberately paused, proving A's delayed
    // promotion cannot rename or unlink this new generation.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await expect(readFile(gatePath, 'utf8')).resolves.toContain(liveOwner.token);

    await writeFile(publisherGateResume, '', 'utf8');
    await Promise.all([publisher, b, a]);
    await expect(readHostedV1CommittedArtifact(join(root, 'publisher.json'))).resolves.toBe('publisher');
  });

  it('keeps long destination and reclaim basenames below NAME_MAX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-name-max-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'dead-lock-generation' }), 'utf8');
    const destination = join(root, `${'x'.repeat(235)}.json`);

    await writeHostedV1AtomicArtifact({ path: destination, body: 'name-max', retentionBudget, timeoutMs: 5_000 });
    await expect(readHostedV1CommittedArtifact(destination)).resolves.toBe('name-max');
    const entries = await readdir(root);
    expect(entries.every((name) => Buffer.byteLength(name, 'utf8') < 255)).toBe(true);
    const commit = JSON.parse(await readFile(destination, 'utf8')) as { payload: string };
    expect(commit.payload).toMatch(/^\.id-[0-9a-f]{64}\.[0-9a-f]{64}\.payload$/u);
  });

  it('recovers a stale gate when its prior reclaimer died after publishing the generation-unique claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-dead-gate-claim-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    const gatePath = `${lockPath}.recovery`;
    const gateOwner = { pid: 999_999_999, token: 'dead-gate-generation' };
    await writeFile(gatePath, JSON.stringify(gateOwner), 'utf8');
    const gateStat = await lstat(gatePath, { bigint: true });
    const gateIdentity = `${gateStat.dev}:${gateStat.ino}`;
    const gateKey = createHash('sha256').update(gatePath, 'utf8').digest('hex');
    // Match the writer's binary claim key exactly: UTF-8 gate digest, one NUL
    // byte, generation, one NUL byte, then the unique claimant token.
    const claimKey = Buffer.concat([
      Buffer.from(gateKey, 'utf8'),
      Buffer.from([0]),
      Buffer.from('reclaimer', 'utf8'),
      Buffer.from([0]),
      Buffer.from(gateIdentity, 'utf8'),
      Buffer.from([0]),
      Buffer.from('00000000-0000-4000-8000-000000000001', 'utf8'),
    ]);
    const claimPath = join(root, `.hosted-v1-reclaim-${createHash('sha256').update(claimKey).digest('hex')}`);
    // Model a reclaimer being killed after its create-only claim publication
    // and before it can unlink the dead gate.
    await writeFile(claimPath, JSON.stringify({
      pid: 999_999_999,
      token: '00000000-0000-4000-8000-000000000001',
      processIncarnation: 'linux-proc-start:0',
      retentionOwnerSchema: 'hosted-v1-retention-owner-v1',
      retentionOwnerRole: 'reclaimer',
      recoveryGateKey: gateKey,
      recoveryGateIdentity: gateIdentity,
      recoveryGateRole: 'reclaimer',
    }), 'utf8');
    await expect(readFile(claimPath, 'utf8')).resolves.toContain('00000000-0000-4000-8000-000000000001');

    const destination = join(root, 'recovered.json');
    await expect(writeHostedV1AtomicArtifact({
      path: destination, body: 'recovered', retentionBudget, timeoutMs: 5_000,
    })).resolves.toBeUndefined();
    await expect(readHostedV1CommittedArtifact(destination)).resolves.toBe('recovered');
    await expect(readFile(gatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    // Only exact dead-claim recovery removes this generation-specific name;
    // publication and normal private cleanup never visit it.
    await expect(readFile(claimPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform !== 'linux')('reclaims a stale owner whose pid has been reused by this live harness process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-pid-incarnation-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    // process.pid is deliberately live. Only the mismatched immutable Linux
    // start tick proves this is a stale prior incarnation rather than a lease
    // held by the current harness process.
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      token: '00000000-0000-4000-8000-000000000002',
      processIncarnation: 'linux-proc-start:0',
      retentionOwnerSchema: 'hosted-v1-retention-owner-v1',
      retentionOwnerRole: 'retention-lock',
    }), 'utf8');

    const destination = join(root, 'pid-reused.json');
    await expect(writeHostedV1AtomicArtifact({
      path: destination, body: 'reclaimed-after-pid-reuse', retentionBudget, timeoutMs: 5_000,
    })).resolves.toBeUndefined();
    await expect(readHostedV1CommittedArtifact(destination)).resolves.toBe('reclaimed-after-pid-reuse');
  });

  it('leaves user tombstone-like artifacts and malformed tombstone claims untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-tombstone-namespace-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const userArtifact = join(root, 'customer-export.tombstone-keep-me.json');
    const tombstoneRoot = join(root, '.hosted-v1-retention-tombstones');
    const malformedClaim = join(tombstoneRoot, `v1-${'0'.repeat(64)}.tombstone`);
    await writeFile(userArtifact, 'user-owned');
    await mkdir(tombstoneRoot, { mode: 0o700 });
    await writeFile(malformedClaim, JSON.stringify({ pid: 999_999_999, token: 'not-a-protocol-token' }), 'utf8');
    await writeFile(join(root, '.hosted-v1-artifact-retention.lock'), JSON.stringify({
      pid: 999_999_999,
      token: 'dead-lock-generation',
    }), 'utf8');

    await writeHostedV1AtomicArtifact({
      path: join(root, 'survives-cleanup.json'), body: 'survives-cleanup', retentionBudget, timeoutMs: 5_000,
    });
    await expect(readFile(userArtifact, 'utf8')).resolves.toBe('user-owned');
    await expect(readFile(malformedClaim, 'utf8')).resolves.toContain('not-a-protocol-token');
  });

  it('rejects symlinked artifact destinations and ancestor aliases before retention accounting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-symlink-'));
    roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-symlink-outside-'));
    roots.push(outside);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const ancestorAlias = join(root, 'outside-alias');
    const destinationAlias = join(root, 'destination-alias.json');
    const scannerAlias = join(root, 'retention-alias');
    await symlink(outside, ancestorAlias, 'dir');
    await symlink(join(outside, 'destination.json'), destinationAlias, 'file');
    await symlink(outside, scannerAlias, 'dir');

    await expect(writeHostedV1AtomicArtifact({
      path: join(ancestorAlias, 'escaped.json'), body: 'escaped', retentionBudget, timeoutMs: 1_000,
    })).rejects.toBeInstanceOf(HostedV1ArtifactPersistenceError);
    await expect(writeHostedV1AtomicArtifact({
      path: destinationAlias, body: 'escaped', retentionBudget, timeoutMs: 1_000,
    })).rejects.toBeInstanceOf(HostedV1ArtifactPersistenceError);
    await expect(writeHostedV1AtomicArtifact({
      path: join(root, 'ordinary.json'), body: 'blocked-by-scanner-alias', retentionBudget, timeoutMs: 1_000,
    })).rejects.toBeInstanceOf(HostedV1ArtifactPersistenceError);

    await expect(readFile(join(outside, 'escaped.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(outside, 'destination.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(ancestorAlias).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
    await expect(lstat(destinationAlias).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
    await expect(lstat(scannerAlias).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
  });

  it('recovers an old ownerless gate left by a crash before owner publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-ownerless-gate-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    const gatePath = `${lockPath}.recovery`;
    // Current gates are linked only after their owner is fsynced. This empty
    // regular file models the old process dying in its open-to-owner window.
    await writeFile(gatePath, '', 'utf8');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const destination = join(root, 'recovered.json');
    await expect(writeHostedV1AtomicArtifact({
      path: destination, body: 'recovered', retentionBudget, timeoutMs: 5_000,
    })).resolves.toBeUndefined();
    await expect(readHostedV1CommittedArtifact(destination)).resolves.toBe('recovered');
    await expect(readFile(gatePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reserves recovery destinations and preserves a nonempty artifact-like gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-reserved-recovery-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    const gatePath = `${lockPath}.recovery`;
    const artifactLikeGate = JSON.stringify({
      schemaVersion: 1,
      kind: 'hosted-v1-artifact-commit',
      payload: 'unrelated.payload',
      byteLength: 9,
      sha256: 'f'.repeat(64),
    });
    await writeFile(gatePath, artifactLikeGate, 'utf8');

    // A protocol pathname is rejected before the supervised publisher can
    // create a payload, receipt, or any replacement at that destination.
    await expect(writeHostedV1AtomicArtifact({
      path: gatePath, body: 'must-not-publish', retentionBudget, timeoutMs: 1_000,
    })).rejects.toThrow('hosted_e2e_artifact_writer_retention_destination_reserved');
    await expect(readFile(gatePath, 'utf8')).resolves.toBe(artifactLikeGate);

    // A nonempty regular file is not the old protocol's exact zero-byte
    // marker, so recovery leaves it intact even after it is old enough that a
    // genuine legacy marker would be eligible for reclamation.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await expect(writeHostedV1AtomicArtifact({
      path: join(root, 'blocked.json'), body: 'blocked', retentionBudget, timeoutMs: 500,
    })).rejects.toMatchObject({
      classification: 'deadline_exceeded', path: join(root, 'blocked.json'),
    });
    await expect(readFile(gatePath, 'utf8')).resolves.toBe(artifactLikeGate);
  });

  it('never recovers an owner-publication-gap directory as a stale writer lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-owner-gap-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 };
    const lockPath = join(root, '.hosted-v1-artifact-retention.lock');
    // Model the old mkdir-before-owner seam. It stays present beyond the old
    // stale threshold; a new implementation must wait, not unlink it.
    await mkdir(lockPath);
    const destination = join(root, 'blocked.json');

    await expect(writeHostedV1AtomicArtifact({
      path: destination, body: 'blocked', retentionBudget, timeoutMs: 500,
    })).rejects.toMatchObject({
      classification: 'deadline_exceeded', path: destination,
    });
    await expect(lstat(lockPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a same-body retry after its aggregate budget is full', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-full-budget-retry-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 16 * 1024, maximumTotalBytes: 16 * 1024 };
    const path = join(root, 'full.json');
    const body = 'r'.repeat(16 * 1024);

    await writeHostedV1AtomicArtifact({ path, body, retentionBudget, timeoutMs: 1_000 });
    await expect(writeHostedV1AtomicArtifact({ path, body, retentionBudget, timeoutMs: 1_000 }))
      .resolves.toBeUndefined();
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(body);
  });

  it('rejects forged candidate metadata after accepting the exact committed payload basename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-forged-candidate-'));
    roots.push(root);
    const path = join(root, 'forged.json');
    const candidate = 'candidate-A';
    const forgedPayload = 'candidate-B';
    const payloadName = `.forged.json.${createHash('sha256').update(candidate, 'utf8').digest('hex')}.payload`;
    await writeFile(join(root, payloadName), candidate, 'utf8');
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      kind: 'hosted-v1-artifact-commit',
      payload: payloadName,
      byteLength: Buffer.byteLength(candidate, 'utf8'),
      sha256: createHash('sha256').update(candidate, 'utf8').digest('hex'),
      candidateByteLength: Buffer.byteLength(candidate, 'utf8'),
      candidateSha256: createHash('sha256').update(candidate, 'utf8').digest('hex'),
      retainedMaximumBytes: Buffer.byteLength(candidate, 'utf8'),
    }), 'utf8');

    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(candidate);
    // Preserve a commit record the reader can validate, but forge the
    // candidate binding so retry admission must reject the substituted bytes.
    await writeFile(join(root, payloadName), forgedPayload, 'utf8');
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      kind: 'hosted-v1-artifact-commit',
      payload: payloadName,
      byteLength: Buffer.byteLength(forgedPayload, 'utf8'),
      sha256: createHash('sha256').update(forgedPayload, 'utf8').digest('hex'),
      candidateByteLength: Buffer.byteLength(candidate, 'utf8'),
      candidateSha256: createHash('sha256').update(candidate, 'utf8').digest('hex'),
      retainedMaximumBytes: Buffer.byteLength(candidate, 'utf8'),
    }), 'utf8');

    await expect(writeHostedV1AtomicArtifact({ path, body: candidate, timeoutMs: 1_000 }))
      .rejects.toMatchObject({
        classification: 'writer_failed', path,
      });
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(forgedPayload);
  });

  it('rejects a same-body retry whose pre-existing commit names an unrelated payload basename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-unrelated-retry-payload-'));
    roots.push(root);
    const path = join(root, 'destination.json');
    const body = 'same-body';
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    await writeFile(join(root, 'unrelated.payload'), body, 'utf8');
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      kind: 'hosted-v1-artifact-commit',
      payload: 'unrelated.payload',
      byteLength: Buffer.byteLength(body, 'utf8'),
      sha256: digest,
      candidateByteLength: Buffer.byteLength(body, 'utf8'),
      candidateSha256: digest,
      retainedMaximumBytes: Buffer.byteLength(body, 'utf8'),
    }), 'utf8');

    await expect(readHostedV1CommittedArtifact(path)).rejects.toThrow(
      `hosted_e2e_artifact_commit_payload_invalid:${path}`
    );
    await expect(writeHostedV1AtomicArtifact({ path, body, timeoutMs: 1_000 }))
      .rejects.toMatchObject({
        classification: 'writer_failed', path,
      });
    await expect(readFile(path, 'utf8')).resolves.toContain('unrelated.payload');
  });

  it('rejects a retry when its retained destination exceeds a lowered aggregate limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-lowered-retry-budget-'));
    roots.push(root);
    const path = join(root, 'retained.json');
    const body = 'r'.repeat(512);
    await writeHostedV1AtomicArtifact({
      path,
      body,
      retentionBudget: { root, maximumFileBytes: 1_024, maximumTotalBytes: 512 },
      timeoutMs: 1_000,
    });

    await expect(writeHostedV1AtomicArtifact({
      path,
      body,
      retentionBudget: { root, maximumFileBytes: 1_024, maximumTotalBytes: 511 },
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path,
    });
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(body);
  });

  it('accepts a retry whose original admission was aggregate-truncated to partial or zero bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-truncated-retry-'));
    roots.push(root);
    const partialBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 512 };
    const partialPath = join(root, 'partial.json');
    const source = 'partial-retry-'.repeat(128);
    await expect(writeHostedV1AtomicArtifact({
      path: partialPath,
      body: source,
      retentionBudget: partialBudget,
      timeoutMs: 5_000,
      testWriterInterruptAfterCanonicalLink: true,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path: partialPath,
    });
    const partial = await readHostedV1CommittedArtifact(partialPath);
    expect(Buffer.byteLength(partial, 'utf8')).toBeGreaterThan(0);
    expect(Buffer.byteLength(partial, 'utf8')).toBeLessThan(partialBudget.maximumTotalBytes);
    await expect(writeHostedV1AtomicArtifact({
      path: partialPath, body: source, retentionBudget: partialBudget, timeoutMs: 5_000,
    })).resolves.toBeUndefined();

    const zeroRoot = join(root, 'zero');
    await mkdir(zeroRoot);
    const zeroBudget = { root: zeroRoot, maximumFileBytes: 1_024, maximumTotalBytes: 32 };
    const zeroPath = join(zeroRoot, 'zero.json');
    await writeHostedV1AtomicArtifact({ path: zeroPath, body: source, retentionBudget: zeroBudget, timeoutMs: 5_000 });
    await expect(readHostedV1CommittedArtifact(zeroPath)).resolves.toBe('');
    await expect(writeHostedV1AtomicArtifact({
      path: zeroPath, body: source, retentionBudget: zeroBudget, timeoutMs: 5_000,
    })).resolves.toBeUndefined();
  });

  it('retries an aggregate-partial commit by its recorded candidate after an intervening admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-intervening-admission-retry-'));
    roots.push(root);
    const initialBudget = { root, maximumFileBytes: 2_048, maximumTotalBytes: 512 };
    const laterBudget = { root, maximumFileBytes: 2_048, maximumTotalBytes: 2_048 };
    const destination = join(root, 'partial.json');
    const source = 'r'.repeat(1_024);

    await writeHostedV1AtomicArtifact({ path: destination, body: source, retentionBudget: initialBudget, timeoutMs: 5_000 });
    const originallyCommitted = await readHostedV1CommittedArtifact(destination);
    expect(Buffer.byteLength(originallyCommitted, 'utf8')).toBeLessThan(initialBudget.maximumTotalBytes);
    // The retention policy may grow between attempts. A later admission now
    // changes today's remaining capacity, but must not rewrite the identity
    // that the original partial commit recorded.
    await writeHostedV1AtomicArtifact({
      path: join(root, 'intervening.json'), body: 'i'.repeat(1_024), retentionBudget: laterBudget, timeoutMs: 5_000,
    });
    await expect(writeHostedV1AtomicArtifact({
      path: destination, body: source, retentionBudget: laterBudget, timeoutMs: 5_000,
    })).resolves.toBeUndefined();
    await expect(readHostedV1CommittedArtifact(destination)).resolves.toBe(originallyCommitted);
  });

  it('rejects a valid pre-existing committed payload that is already over retention budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-oversized-existing-'));
    roots.push(root);
    const payloadName = 'oversized.payload';
    const payload = 'o'.repeat(1_025);
    await writeFile(join(root, payloadName), payload, 'utf8');
    await writeFile(join(root, 'existing.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'hosted-v1-artifact-commit',
      payload: payloadName,
      byteLength: Buffer.byteLength(payload, 'utf8'),
      sha256: createHash('sha256').update(payload, 'utf8').digest('hex'),
    }), 'utf8');
    const destination = join(root, 'new.json');
    const retentionBudget = { root, maximumFileBytes: 1_024, maximumTotalBytes: 2_048 };

    await expect(writeHostedV1AtomicArtifact({
      path: destination, body: 'new', retentionBudget, timeoutMs: 1_000,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path: destination,
    });
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('counts an interrupted canonical link and its private receipt as one retained payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-interrupted-retention-'));
    roots.push(root);
    const retentionBudget = { root, maximumFileBytes: 16 * 1024, maximumTotalBytes: 32 * 1024 };
    const interruptedPath = join(root, 'interrupted.json');
    const laterPath = join(root, 'later.json');
    const body = 'i'.repeat(16 * 1024);

    await expect(writeHostedV1AtomicArtifact({
      path: interruptedPath,
      body,
      retentionBudget,
      timeoutMs: 1_000,
      testWriterInterruptAfterCanonicalLink: true,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path: interruptedPath,
    });
    await expect(readHostedV1CommittedArtifact(interruptedPath)).resolves.toBe(body);

    await writeHostedV1AtomicArtifact({
      path: laterPath, body, retentionBudget, timeoutMs: 1_000,
    });
    await expect(readHostedV1CommittedArtifact(laterPath)).resolves.toBe(body);
  });

  it('retries a path-backed sanitized attachment without changing its committed bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-atomic-writer-source-retry-'));
    roots.push(root);
    const sourcePath = join(root, 'raw.txt');
    const path = join(root, 'committed.json');
    const secret = 'retry-secret-must-not-survive';
    await writeFile(sourcePath, `command --api-key ${secret}`, 'utf8');
    const input = {
      path,
      sourcePath,
      sourceRedaction: { replacements: [], maximumBytes: 16 * 1024 },
      timeoutMs: 1_000,
    } as const;
    await expect(writeHostedV1AtomicArtifact({ ...input, testWriterInterruptAfterCanonicalLink: true }))
      .rejects.toMatchObject({ classification: 'writer_failed', path });
    await writeHostedV1AtomicArtifact(input);
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe('command --api-key <sensitive-value>');
  });

  it('does not accept or strand a canonical artifact when killed after private payload visibility before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-commit-before-visibility-crash-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const visiblePayload = join(root, 'payload-visible-before-commit');
    await expect(writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":"first"}',
      timeoutMs: 1_000,
      testWriterProgram: String.raw`
        const fs = require('node:fs'); const [destination, payload] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.writeFileSync(payload, 'private-uncommitted-payload');
          fs.writeFileSync(${JSON.stringify(visiblePayload)}, payload);
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n' +
            'hosted-v1-artifact-v1:transaction-prepared\n', () => process.kill(process.pid, 'SIGKILL'));
        });
      `,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path,
    });
    // The marker proves the payload became visible to the interrupted writer,
    // while the canonical commit record never did.
    await expect(readFile(visiblePayload, 'utf8')).resolves.toContain('.payload');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readHostedV1CommittedArtifact(path)).rejects.toThrow(
      `hosted_e2e_artifact_commit_missing:${path}`
    );
    await expect(writeHostedV1AtomicArtifact({
      path, body: '{"proof":"retry"}', timeoutMs: 1_000,
    })).resolves.toBeUndefined();
    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe('{"proof":"retry"}');
  });

  it('preserves competing canonical evidence and allows an independent retry to commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-commit-competing-evidence-'));
    roots.push(root);
    const path = join(root, 'aggregate.json');
    const retryPath = join(root, 'aggregate-retry.json');
    await expect(writeHostedV1AtomicArtifact({
      path,
      body: '{"proof":"ours"}',
      timeoutMs: 1_000,
      testWriterProgram: String.raw`
        const fs = require('node:fs'); const [destination, payload] = process.argv.slice(1);
        process.stdin.resume(); process.stdin.on('end', () => {
          fs.writeFileSync(payload, 'private-payload');
          fs.writeFileSync(destination, 'competing-canonical-evidence', { flag: 'wx' });
          process.stdout.write('hosted-v1-artifact-v1:writer-preflight\n' +
            'hosted-v1-artifact-v1:transaction-prepared\n', () => process.kill(process.pid, 'SIGKILL'));
        });
      `,
    })).rejects.toMatchObject({
      classification: 'writer_failed', path,
    });
    await expect(readFile(path, 'utf8')).resolves.toBe('competing-canonical-evidence');
    await expect(readHostedV1CommittedArtifact(path)).rejects.toThrow(
      `hosted_e2e_artifact_commit_invalid:${path}`
    );
    await expect(writeHostedV1AtomicArtifact({
      path: retryPath, body: '{"proof":"retry"}', timeoutMs: 1_000,
    })).resolves.toBeUndefined();
    await expect(readHostedV1CommittedArtifact(retryPath)).resolves.toBe('{"proof":"retry"}');
    await expect(readFile(path, 'utf8')).resolves.toBe('competing-canonical-evidence');
  });

  it('preserves the target identity across the external coordination boundary', () => {
    expect(() => assertHostedV1ExternalCoordinationStreamProof({
      launchBoundaryEventIds: ['event_before_boundary'],
      launchBoundaryFrameIndex: 2,
      opens: 1,
      reconnects: 0,
      error: null,
      heartbeatStreamIds: [1, 1],
      heartbeatFrameIndexes: [0, 1],
      events: [
        { eventId: 'event_before_boundary', eventSequence: 6, frameIndex: 1, streamId: 1, observedAtMs: 900 },
        { eventId: 'event_target', eventSequence: 7, frameIndex: 2, streamId: 1, observedAtMs: 1_000 },
      ],
      targetEventId: 'event_target',
    })).not.toThrow();
  });

  it('rejects a target identity observed before the external coordination boundary', () => {
    expect(() => assertHostedV1ExternalCoordinationStreamProof({
      launchBoundaryEventIds: ['event_target'],
      launchBoundaryFrameIndex: 2,
      opens: 1,
      reconnects: 0,
      error: null,
      heartbeatStreamIds: [1, 1],
      heartbeatFrameIndexes: [0, 1],
      events: [{ eventId: 'event_target', eventSequence: 7, frameIndex: 2, streamId: 1, observedAtMs: 1_000 }],
      targetEventId: 'event_target',
    })).toThrow('hosted_e2e_external_coordination_target_before_boundary');
  });

  it('records failures for every proof-diagnostic attachment without replacing proof work', async () => {
    const failures: string[] = [];
    const diagnosticNames = [
      'attach:initial-event-stream-response.json',
      'attach:personal-lifecycle-launch-response.json',
      'attach:personal-lifecycle-launch-runtime-state.json',
      'attach:personal-lifecycle-launch-runtime-trace.json',
      'attach:personal-controller-shutdown.json',
      'page_evaluate:personal-event-stream-reconnect',
      'attach:personal-event-stream-reconnect.json',
      'attach:oidc-owner-lifecycle-launch-response.json',
      'attach:owner-mutation-error-trace-unavailable.json',
    ];
    for (const name of diagnosticNames) {
      await expect(runHostedV1BestEffortDiagnostic({
        failures,
        name,
        operation: async () => { throw new Error(`${name} failed`); },
      })).resolves.toBeNull();
    }
    await expect(runHostedV1BestEffortDiagnostic({
      failures,
      name: 'proof',
      operation: async () => 'still-runs',
    })).resolves.toBe('still-runs');
    expect(failures).toEqual(diagnosticNames.map((name) => `${name}:Error`));
    const immutableFailures = freezeHostedV1DiagnosticFailures(failures);
    failures.push('attach:later.json:Error');
    expect(Object.isFrozen(immutableFailures)).toBe(true);
    expect(immutableFailures).toEqual(diagnosticNames.map((name) => `${name}:Error`));
  });

  it('returns after the one-second boundary when a diagnostic ignores abort', async () => {
    const failures: string[] = [];
    let observedAbort = false;
    await expect(runHostedV1BestEffortDiagnostic({
      failures,
      name: 'attach:hung-shutdown.json',
      timeoutMs: 1,
      operation: (signal) => new Promise<string>(() => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
        }, { once: true });
      }),
    })).resolves.toBeNull();
    expect(observedAbort).toBe(true);
    expect(failures).toEqual(['attach:hung-shutdown.json:TimeoutError']);
  });

  it('does not invoke a diagnostic operation after its parent has aborted', async () => {
    const failures: string[] = [];
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    await expect(runHostedV1BestEffortDiagnostic({
      failures, name: 'page:aborted-before-await', signal: controller.signal,
      operation: async () => { invoked = true; return 'unexpected'; },
    })).resolves.toBeNull();
    expect(invoked).toBe(false);
    expect(failures).toEqual(['page:aborted-before-await:AbortError']);
  });

  it('makes file and page diagnostics discard results after abort', async () => {
    const failures: string[] = [];
    const controller = new AbortController();
    let published = false;
    const diagnostic = runHostedV1BestEffortDiagnostic({
      failures, name: 'file:aborted-after-await', signal: controller.signal,
      operation: async (signal) => {
        await Promise.resolve();
        controller.abort();
        if (!signal.aborted) published = true;
        return 'late';
      },
    });
    await expect(diagnostic).resolves.toBeNull();
    expect(published).toBe(false);
    expect(failures).toEqual(['file:aborted-after-await:AbortError']);
  });

  it('rejects a target duplicate delayed beyond one second but before replay completion', () => {
    expect(() => assertHostedV1ExternalCoordinationReconnectProof({
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      observedAtMs: 31_000,
      baselineCursor: 'cursor_target',
      baselineOpens: 1,
      baselineReconnects: 0,
      baselineStreamId: 1,
      activeStreamId: 2,
      opens: 2,
      reconnects: 1,
      error: null,
      reconnectStreamId: 2,
      targetEventId: 'event_target',
      targetEventSequence: 7,
      heartbeatFrameIndexes: [1, 3, 5],
      heartbeatStreamIds: [1, 2, 2],
      heartbeatObservedAtMs: [2_000, 10_000, 30_000],
      heartbeatCursors: ['cursor_target', 'cursor_target', 'cursor_target'],
      heartbeatEventCounts: [1, 1, 1],
      events: [
        { eventId: 'event_target', eventSequence: 7, frameIndex: 0, streamId: 1, observedAtMs: 1_500 },
        // This arrives two seconds after the pre-replay heartbeat, so a 1s
        // quiet window would miss it; the second heartbeat is the boundary.
        { eventId: 'event_target', eventSequence: 7, frameIndex: 4, streamId: 2, observedAtMs: 12_000 },
      ],
    })).toThrow('hosted_e2e_external_reconnect_target_not_exactly_once');
  });

  it('accepts the original one-generation reconnect after two stable heartbeats', () => {
    const baseline = { cursor: 'cursor_target', reconnects: 0, streamGeneration: 1 } as const;
    const capture = captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => ({
        activeStreamId: 2,
        error: null,
        events: [
          { eventId: 'event_target', eventSequence: 7, frameIndex: 0, streamId: 1, observedAtMs: 1_500 },
        ],
        heartbeatCursors: ['cursor_target', 'cursor_target', 'cursor_target'],
        heartbeatEventCounts: [1, 1, 1],
        heartbeatFrameIndexes: [1, 2, 3],
        heartbeatObservedAtMs: [2_000, 10_000, 30_000],
        heartbeatStreamIds: [1, 2, 2],
        opens: 2,
        reconnects: 1,
      }),
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    });
    expect(capture).not.toBeNull();
  });

  it('rejects a closed generation even when its retry has cleared the transient error', () => {
    const baseline = { cursor: 'cursor_target', reconnects: 0, streamGeneration: 1 } as const;
    expect(captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => ({
        // Generation 2 delivered both heartbeats, then its reader closed.
        // The replacement fetch is pending, so browser retry has cleared the
        // error but no successful response is currently active.
        activeStreamId: null,
        error: null,
        events: [{ eventId: 'event_target', eventSequence: 7, frameIndex: 0, streamId: 1, observedAtMs: 1_500 }],
        heartbeatCursors: ['cursor_target', 'cursor_target', 'cursor_target'],
        heartbeatEventCounts: [1, 1, 1],
        heartbeatFrameIndexes: [1, 2, 3],
        heartbeatObservedAtMs: [2_000, 10_000, 20_000],
        heartbeatStreamIds: [1, 2, 2],
        opens: 2,
        reconnects: 2,
      }),
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    })).toBeNull();
  });

  it('activates only the exact replacement response generation', () => {
    const baseline = { cursor: 'cursor_target', reconnects: 0, streamGeneration: 1 } as const;
    const replacement = {
      error: null,
      events: [{ eventId: 'event_target', eventSequence: 7, frameIndex: 0, streamId: 1, observedAtMs: 1_500 }],
      heartbeatCursors: ['cursor_target', 'cursor_target', 'cursor_target', 'cursor_target'],
      heartbeatEventCounts: [1, 1, 1, 1],
      heartbeatFrameIndexes: [1, 2, 3, 4],
      heartbeatObservedAtMs: [2_000, 10_000, 20_000, 30_000],
      heartbeatStreamIds: [1, 2, 2, 3],
      opens: 3,
      reconnects: 2,
    };
    // A prior response cannot remain active after response 3 opened.
    expect(captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => ({ ...replacement, activeStreamId: 2 }),
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    })).toBeNull();
    // Once response 3 opens, only its own two heartbeats complete the proof.
    expect(captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => ({ ...replacement, activeStreamId: 3, heartbeatStreamIds: [1, 2, 3, 3] }),
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    })).not.toBeNull();
  });

  it('keeps an atomically captured final proof valid after its reader later closes', () => {
    const baseline = { cursor: 'cursor_target', reconnects: 0, streamGeneration: 1 } as const;
    const state = {
      activeStreamId: 3 as number | null,
      error: null,
      events: [
        { eventId: 'event_target', eventSequence: 7, frameIndex: 0, streamId: 1, observedAtMs: 1_500 },
      ],
      heartbeatCursors: ['cursor_target', 'cursor_target', 'cursor_target', 'cursor_target'],
      heartbeatEventCounts: [1, 1, 1, 1],
      heartbeatFrameIndexes: [1, 2, 3, 4],
      heartbeatObservedAtMs: [2_000, 10_000, 20_000, 30_000],
      heartbeatStreamIds: [1, 2, 3, 3],
      opens: 3,
      reconnects: 2,
    };
    const capture = captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => state,
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    });
    expect(capture).not.toBeNull();
    expect(JSON.parse(capture!.serializedState)).toMatchObject({ opens: 3, reconnects: 2 });

    // A later transport handoff is outside the selected atomic snapshot.
    state.opens = 4;
    state.reconnects = 3;
    state.activeStreamId = null;
    expect(() => captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => JSON.parse(capture!.serializedState),
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    })).not.toThrow();
  });

  it('does not combine heartbeats from transient and final reconnect generations', () => {
    const baseline = { cursor: 'cursor_target', reconnects: 0, streamGeneration: 1 } as const;
    const common = {
      activeStreamId: 3,
      error: null,
      events: [
        { eventId: 'event_target', eventSequence: 7, frameIndex: 0, streamId: 1, observedAtMs: 1_500 },
      ],
      heartbeatCursors: ['cursor_target', 'cursor_target'],
      heartbeatEventCounts: [1, 1],
      heartbeatFrameIndexes: [1, 2],
      heartbeatObservedAtMs: [10_000, 20_000],
      opens: 3,
      reconnects: 2,
    };
    expect(captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => ({ ...common, heartbeatStreamIds: [2, 3] }),
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    })).toBeNull();
    expect(captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => ({ ...common, heartbeatStreamIds: [2, 2] }),
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    })).toBeNull();
  });

  it('rejects duplicate delivery in a final generation after transient reconnects', () => {
    const baseline = { cursor: 'cursor_target', reconnects: 0, streamGeneration: 1 } as const;
    expect(() => captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline,
      stateReader: () => ({
        activeStreamId: 3,
        error: null,
        events: [
          {
            eventId: 'event_target', eventSequence: 7, frameIndex: 0, streamId: 1, observedAtMs: 1_500,
          },
          {
            eventId: 'event_target', eventSequence: 7, frameIndex: 1, streamId: 3, observedAtMs: 2_000,
          },
        ],
        heartbeatCursors: ['cursor_target', 'cursor_target'],
        heartbeatEventCounts: [2, 2],
        heartbeatFrameIndexes: [2, 3],
        heartbeatObservedAtMs: [10_000, 20_000],
        heartbeatStreamIds: [3, 3],
        opens: 3,
        reconnects: 2,
      }),
      originMs: 1_000,
      replayDeadlineMs: 40_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    })).toThrow('hosted_e2e_external_reconnect_target_not_exactly_once');
  });

  it('uses the production async poll wrapper to retain the 31s second heartbeat across a 42s transport failure', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const replayBudget = createHostedV1ExternalCoordinationReplayBudget({
        handoffBudgetMs: 10_000,
        heartbeatIntervalMs: 15_000,
        marginMs: 1_000,
      });
      const deadlines = replayBudget.deadlinesFrom(Date.now());
      const baseline = { cursor: 'cursor_target', reconnects: 0, streamGeneration: 1 } as const;
      const browserState = {
        activeStreamId: baseline.streamGeneration as number | null,
        cursor: baseline.cursor,
        opens: baseline.streamGeneration,
        reconnects: baseline.reconnects,
        error: null as string | null,
        events: [
          {
            eventId: 'event_target',
            eventSequence: 7,
            frameIndex: 0,
            streamId: 1,
            observedAtMs: 1_500,
          },
        ],
        heartbeatCursors: ['cursor_target'],
        heartbeatEventCounts: [1],
        heartbeatFrameIndexes: [1],
        heartbeatObservedAtMs: [2_000],
        heartbeatStreamIds: [1],
      };
      const recordHeartbeat = (streamId: number): void => {
        browserState.heartbeatStreamIds.push(streamId);
        browserState.heartbeatFrameIndexes.push(browserState.heartbeatFrameIndexes.length + 1);
        browserState.heartbeatObservedAtMs.push(Date.now());
        browserState.heartbeatCursors.push(browserState.cursor ?? baseline.cursor);
        browserState.heartbeatEventCounts.push(browserState.events.length);
      };

      browserState.opens += 1;
      browserState.activeStreamId = browserState.opens;
      browserState.reconnects += 1;
      await vi.advanceTimersByTimeAsync(15_000);
      recordHeartbeat(2);
      let reads = 0;
      const readAtMs: number[] = [];
      const capturedProof = await pollHostedV1ExternalCoordinationReconnectProof({
        baseline,
        originMs: 1_000,
        replayDeadlineMs: deadlines.replayDeadlineMs,
        targetEventId: 'event_target',
        targetEventSequence: 7,
        timeoutMs: replayBudget.requireRemainingAt(deadlines.replayDeadlineMs, Date.now()),
        stateReader: async () => {
          reads += 1;
          readAtMs.push(Date.now());
          return browserState;
        },
        poll: async (predicate) => {
          expect(await predicate()).toBeNull();
          await vi.advanceTimersByTimeAsync(15_000);
          recordHeartbeat(2);
          expect(Date.now()).toBe(31_000);
          expect(await predicate()).not.toBeNull();

          // This occurs after the 42s deadline, after the real poll adapter
          // has selected its result. A boolean poll followed by a browser
          // reread (or a Date.now assertion) would now reject the proof.
          await vi.advanceTimersByTimeAsync(11_001);
          expect(Date.now()).toBe(42_001);
          browserState.opens += 1;
          browserState.activeStreamId = null;
          browserState.error = 'coordination_stream_closed';
        },
      });
      expect(capturedProof).not.toBeNull();
      // The capture-to-assertion path may read browser state only once. A
      // later read after the poll returns would be the race this proof prevents.
      expect(reads).toBe(2);
      expect(readAtMs).toEqual([16_000, 31_000]);
      const capturedProofState = JSON.parse(capturedProof.serializedState) as typeof browserState;
      const capturedResumedHeartbeatIndexes = capturedProofState.heartbeatStreamIds.flatMap(
        (streamId, index) => (streamId === 2 ? [index] : [])
      );
      const capturedCompletionHeartbeatIndex = capturedResumedHeartbeatIndexes[1];
      expect(capturedCompletionHeartbeatIndex).toBe(2);
      expect(capturedProof.observedAtMs).toBe(31_000);

      expect(() => captureAndAssertHostedV1ExternalCoordinationReconnectProof({
        baseline,
        stateReader: () => capturedProofState,
        originMs: 1_000,
        replayDeadlineMs: deadlines.replayDeadlineMs,
        targetEventId: 'event_target',
        targetEventSequence: 7,
      })).not.toThrow();
      expect(() => captureAndAssertHostedV1ExternalCoordinationReconnectProof({
        baseline,
        stateReader: () => ({
        ...capturedProofState,
        events: [
          ...capturedProofState.events,
          {
            eventId: 'event_target',
            eventSequence: 7,
            frameIndex: 4,
            streamId: 2,
            observedAtMs: 12_000,
          },
        ],
        }),
        originMs: 1_000,
        replayDeadlineMs: deadlines.replayDeadlineMs,
        targetEventId: 'event_target',
        targetEventSequence: 7,
      })).toThrow('hosted_e2e_external_reconnect_target_not_exactly_once');
      expect(captureAndAssertHostedV1ExternalCoordinationReconnectProof({
        baseline,
        stateReader: () => browserState,
        originMs: 1_000,
        replayDeadlineMs: deadlines.replayDeadlineMs,
        targetEventId: 'event_target',
        targetEventSequence: 7,
      })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects reconnect state above the 64KiB capture bound', () => {
    const state = {
      activeStreamId: 2,
      error: null,
      events: [],
      heartbeatCursors: [],
      heartbeatEventCounts: [],
      heartbeatFrameIndexes: [],
      heartbeatObservedAtMs: [],
      heartbeatStreamIds: [],
      opens: 2,
      reconnects: 1,
      padding: 'x'.repeat(HOSTED_V1_EXTERNAL_COORDINATION_RECONNECT_PROOF_MAX_BYTES),
    };
    expect(() => captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline: { cursor: 'cursor_target', reconnects: 0, streamGeneration: 1 },
      stateReader: () => state,
      originMs: 0,
      replayDeadlineMs: 42_000,
      targetEventId: 'event_target',
      targetEventSequence: 7,
    })).toThrow('hosted_e2e_external_reconnect_state_too_large');
  });

  it('derives the external coordination replay window from an explicit clock origin', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const startedAtMs = Date.now();
      const budget = createHostedV1ExternalCoordinationReplayBudget({
        handoffBudgetMs: 10_000,
        heartbeatIntervalMs: 15_000,
        marginMs: 1_000,
      });
      const deadlines = budget.deadlinesFrom(startedAtMs);
      const deadlineMs = deadlines.replayDeadlineMs - startedAtMs;

      await vi.advanceTimersByTimeAsync(deadlineMs);

      expect(Date.now() - startedAtMs).toBe(deadlineMs);
      expect(deadlines).toEqual({ handoffDeadlineMs: 10_000, replayDeadlineMs: 41_000 });
      expect(Date.now()).toBe(deadlines.replayDeadlineMs);
      expect(() => budget.requireRemainingAt(deadlines.replayDeadlineMs, Date.now())).toThrow(
        'hosted_e2e_external_replay_deadline_exhausted'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes auth drain evidence only from a serialized empty runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-auth-drain-'));
    roots.push(root);
    const path = join(root, 'drain-proof.json');
    const state = {
      schemaVersion: 1 as const,
      activeRuns: [],
      commands: [],
      eventIds: [],
      messageLedger: [],
    };

    await expect(
      publishFakeRuntimeAuthDrainEvidence({ state, resetGeneration: 7, observedAt: 1_000, path })
    ).resolves.toEqual({ resetGeneration: 7 });
    await expect(readFile(path, 'utf8').then(JSON.parse)).resolves.toEqual({
      format: 'agent-teams-runtime-drain/v1',
      deploymentId: 'deployment_hosted-v1-e2e',
      restoreGeneration: 0,
      purpose: 'host_reset',
      resetGeneration: 7,
      outcome: 'drained',
      evidenceRef: 'fake-runtime:drain:host-reset-7',
      observedAt: 1_000,
      expiresAt: 61_000,
    });

    await expect(
      publishFakeRuntimeAuthDrainEvidence({
        state: { ...state, activeRuns: [{ teamId: 'team_active', runId: 'run_active' }] },
        resetGeneration: 8,
        observedAt: 2_000,
        path,
      })
    ).rejects.toThrow('hosted_e2e_auth_drain_unconfirmed');
    await expect(readFile(path, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      resetGeneration: 7,
    });
  });

  it('rejects coerced drain generations and invalidates stale owner proof on restart', async () => {
    for (const resetGeneration of ['7', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(() =>
        parseFakeRuntimeAuthDrainRequest({ operation: 'auth_drain', resetGeneration })
      ).toThrow('hosted_e2e_auth_drain_request_invalid');
    }
    expect(parseFakeRuntimeAuthDrainRequest({ operation: 'auth_drain', resetGeneration: 7 })).toEqual(
      { operation: 'auth_drain', resetGeneration: 7 }
    );

    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-stale-auth-drain-'));
    roots.push(root);
    const path = join(root, 'drain-proof.json');
    await writeFile(path, 'stale predecessor proof\n', { mode: 0o600 });
    await invalidateFakeRuntimeAuthDrainEvidence(path);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('permanently denies execute, revalidate, and release for pre-drain authorizations', async () => {
    const fence = createFakeRuntimeAuthDrainEpochFence();
    const issued = new Map<string, { readonly drainEpoch: number }>();
    let authorizationGeneration = 0;
    const authorize = (): string => {
      authorizationGeneration += 1;
      const key = `authorization-${authorizationGeneration}`;
      issued.set(key, { drainEpoch: fence.issue() });
      return key;
    };
    const admitted = (key: string): boolean => {
      const authorization = issued.get(key);
      return authorization !== undefined && fence.isCurrent(authorization.drainEpoch);
    };
    const preDrainAuthorization = authorize();
    expect({
      execute: admitted(preDrainAuthorization),
      revalidate: admitted(preDrainAuthorization),
      release: admitted(preDrainAuthorization),
    }).toEqual({
      execute: true,
      revalidate: true,
      release: true,
    });

    const coordinator = createFakeRuntimeAuthDrainCoordinator({
      publish: () => Promise.resolve(),
      invalidate: () => Promise.resolve(),
      advanceEpoch: () => {
        fence.drain();
      },
      revokeIssued: () => issued.clear(),
    });
    await coordinator.handle({ operation: 'auth_drain', resetGeneration: 2 });
    await coordinator.handle({ operation: 'auth_drain_release', resetGeneration: 2 });

    expect({
      execute: admitted(preDrainAuthorization),
      revalidate: admitted(preDrainAuthorization),
      release: admitted(preDrainAuthorization),
    }).toEqual({
      execute: false,
      revalidate: false,
      release: false,
    });
    expect(admitted(authorize())).toBe(true);
  });

  it('serializes overlapping drain and release frames on the real owner socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-auth-drain-socket-'));
    roots.push(root);
    const socketPath = join(root, 'auth-drain.sock');
    const sequence: string[] = [];
    let publishStarted: (() => void) | undefined;
    let finishPublication: (() => void) | undefined;
    const publicationStarted = new Promise<void>((resolve) => {
      publishStarted = resolve;
    });
    const publicationGate = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    const coordinator = createFakeRuntimeAuthDrainCoordinator({
      publish: async () => {
        sequence.push('publish:start');
        publishStarted?.();
        await publicationGate;
        sequence.push('publish:end');
      },
      invalidate: async () => {
        sequence.push('invalidate');
      },
      advanceEpoch: () => {
        sequence.push('advance-epoch');
      },
      revokeIssued: () => {
        sequence.push('revoke-issued');
      },
    });
    const server = await startFakeRuntimeAuthDrainServer({
      socketPath,
      queue: createFakeRuntimeStateMutationQueue(),
      coordinator,
    });
    try {
      expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
      const drain = sendFakeRuntimeAuthDrainRequest(socketPath, {
        operation: 'auth_drain',
        resetGeneration: 9,
      });
      await publicationStarted;
      const release = sendFakeRuntimeAuthDrainRequest(socketPath, {
        operation: 'auth_drain_release',
        resetGeneration: 9,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sequence).toEqual(['publish:start']);

      finishPublication?.();
      await expect(drain).resolves.toEqual({
        ok: true,
        value: { resetGeneration: 9 },
      });
      await expect(release).resolves.toEqual({ ok: true, value: { released: true } });
      expect(sequence).toEqual([
        'publish:start',
        'publish:end',
        'advance-epoch',
        'revoke-issued',
        'invalidate',
      ]);
      expect(coordinator.isDrained()).toBe(false);
    } finally {
      finishPublication?.();
      await server.close();
    }
  });

  it('keeps the coordinator fenced until proof invalidation is durable', async () => {
    let proofPresent = false;
    let invalidateFails = true;
    const issued: number[] = [0];
    const coordinator = createFakeRuntimeAuthDrainCoordinator({
      publish: async () => {
        proofPresent = true;
      },
      invalidate: async () => {
        if (invalidateFails) throw new Error('fsync_failed');
        proofPresent = false;
      },
      advanceEpoch: () => undefined,
      revokeIssued: () => issued.splice(0),
    });
    await expect(coordinator.handle({ operation: 'auth_drain', resetGeneration: 3 })).resolves.toEqual(
      { resetGeneration: 3 }
    );
    expect(coordinator.isDrained()).toBe(true);
    await expect(
      coordinator.handle({ operation: 'auth_drain_release', resetGeneration: 3 })
    ).rejects.toThrow('fsync_failed');
    expect(coordinator.isDrained()).toBe(true);
    expect(proofPresent).toBe(true);
    invalidateFails = false;
    await expect(
      coordinator.handle({ operation: 'auth_drain_release', resetGeneration: 3 })
    ).resolves.toEqual({ released: true });
    expect(coordinator.isDrained()).toBe(false);
    expect(proofPresent).toBe(false);
    expect(issued).toEqual([]);
  });

  it('requires confirmed publication and revocation before releasing an indeterminate drain', async () => {
    let proofPresent = false;
    let publishFails = true;
    let invalidateFails = true;
    const issued = new Set(['pre-drain-authorization']);
    let drainEpoch = 0;
    const coordinator = createFakeRuntimeAuthDrainCoordinator({
      publish: async () => {
        // Model rename having made proof bytes visible before the directory fsync reports failure.
        proofPresent = true;
        if (publishFails) throw new Error('publish_fsync_failed');
      },
      invalidate: async () => {
        if (invalidateFails) throw new Error('invalidate_fsync_failed');
        proofPresent = false;
      },
      advanceEpoch: () => {
        drainEpoch += 1;
      },
      revokeIssued: () => issued.clear(),
    });
    await expect(coordinator.handle({ operation: 'auth_drain', resetGeneration: 4 })).rejects.toThrow(
      'publish_fsync_failed'
    );
    expect(coordinator.isDrained()).toBe(true);
    expect(proofPresent).toBe(true);
    expect(drainEpoch).toBe(0);
    expect(issued).toEqual(new Set(['pre-drain-authorization']));

    await expect(
      coordinator.handle({ operation: 'auth_drain_release', resetGeneration: 4 })
    ).rejects.toThrow('hosted_e2e_auth_drain_unconfirmed');
    expect(coordinator.isDrained()).toBe(true);
    expect(proofPresent).toBe(true);
    expect(drainEpoch).toBe(0);
    expect(issued).toEqual(new Set(['pre-drain-authorization']));

    publishFails = false;
    await expect(coordinator.handle({ operation: 'auth_drain', resetGeneration: 4 })).resolves.toEqual(
      { resetGeneration: 4 }
    );
    expect(coordinator.isDrained()).toBe(true);
    expect(proofPresent).toBe(true);
    expect(drainEpoch).toBe(1);
    expect(issued).toEqual(new Set());

    invalidateFails = false;
    await expect(
      coordinator.handle({ operation: 'auth_drain_release', resetGeneration: 4 })
    ).resolves.toEqual({ released: true });
    expect(coordinator.isDrained()).toBe(false);
    expect(proofPresent).toBe(false);
  });

  it('creates private proof storage accepted by the production read-only consumer', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-v1-proof-reader-')));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const proofDirectory = join(sandbox.fakeRuntimeStateDir, 'auth-drain');
    const proofPath = join(proofDirectory, 'drain-proof.json');
    expect((await lstat(proofDirectory)).mode & 0o777).toBe(0o700);
    await publishFakeRuntimeAuthDrainEvidence({
      state: { schemaVersion: 1, activeRuns: [], commands: [], eventIds: [], messageLedger: [] },
      resetGeneration: 5,
      observedAt: 1_000,
      path: proofPath,
    });
    expect((await lstat(proofPath)).mode & 0o777).toBe(0o600);
    const reader = new FileHostedPairingDrainProof(
      proofPath,
      { noRuntimeMutationAtStartup: false, now: () => 1_100 },
      createHostedAccessNodePlatform()
    );
    await expect(
      reader.confirmDrained({
        binding: { deploymentId: 'deployment_hosted-v1-e2e' as never, restoreGeneration: 0 },
        purpose: 'host_reset',
        resetGeneration: 5,
      })
    ).resolves.toEqual({
      status: 'drained',
      evidenceRef: 'fake-runtime:drain:host-reset-5',
    });
    await invalidateFakeRuntimeAuthDrainEvidence(proofPath);
    await expect(
      reader.confirmDrained({
        binding: { deploymentId: 'deployment_hosted-v1-e2e' as never, restoreGeneration: 0 },
        purpose: 'host_reset',
        resetGeneration: 5,
      })
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('fences persisted release replay and a live authorization through the real sockets', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-v1-release-drain-replay-')));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const issuer = 'https://oidc-v1-e2e.localhost:54321';
    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'seed'],
      {
        ...boundedExecOptions,
        env: {
          ...process.env,
          E2E_SEED_APP_DATA_ROOT: sandbox.appDataDir,
          E2E_SEED_AUTH_MODE: 'personal',
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
          E2E_SEED_MARKER_PATH: sandbox.markerPath,
          E2E_SEED_OIDC_ISSUER: issuer,
          E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
        },
      }
    );
    const teamIdentity = JSON.parse(
      await readFile(join(sandbox.claudeDir, 'teams', E2E_TEAM_NAME, 'team.identity.json'), 'utf8')
    ) as Record<string, unknown>;
    const ownerEffectFence = {
      grantRevision: hostedWorkspaceAccessSeedPlan('personal', issuer).workspaces.find(
        (workspace) => workspace.publicWorkspaceId === E2E_WORKSPACE_ID
      )!.grantRevision,
      identityChecksum: createHash('sha256')
        .update(`${JSON.stringify(teamIdentity, null, 2)}\n`)
        .digest('hex'),
    };
    const socketRoot = await mkdtemp('/tmp/hv1-r5-');
    roots.push(socketRoot);
    const lifecycleSocket = join(socketRoot, 'orchestrator-lifecycle.sock');
    // Keep the independently owned test socket below Darwin's Unix-domain path limit.
    // Production uses the likewise short /run/agent-teams-auth-drain mount.
    const authDrainRoot = await mkdtemp('/tmp/hv1-ad-');
    roots.push(authDrainRoot);
    const drainSocket = join(authDrainRoot, 'auth-drain.sock');
    const proofPath = join(authDrainRoot, 'drain-proof.json');
    const runtimeEnvironment = {
      ...process.env,
      E2E_SEED_APP_DATA_ROOT: sandbox.appDataDir,
      E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
      E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
      E2E_LIFECYCLE_RUN_ROOT: socketRoot,
      E2E_AUTH_DRAIN_ROOT: authDrainRoot,
      E2E_LIFECYCLE_TRUST_ROOT: sandbox.lifecycleTrustDir,
      E2E_LIFECYCLE_LAUNCHER_ROOT: sandbox.lifecycleLauncherDir,
      E2E_AUTH_DRAIN_INDETERMINATE_ONCE: '1',
      E2E_BOOT_ID: `boot_hosted-v1-e2e-${sandbox.marker}`,
      AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: sandbox.bootstrap,
      HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET: lifecycleSocket,
      HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE: join(socketRoot, 'lifecycle-owner-admission.json'),
      HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE: join(
        sandbox.lifecycleTrustDir,
        'trust-anchor'
      ),
      HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE: join(
        sandbox.lifecycleTrustDir,
        'release-owner-pin.json'
      ),
    };
    const runtime = spawnChild(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'fake-runtime'],
      { cwd: process.cwd(), env: runtimeEnvironment, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let runtimeStderr = '';
    let stage = 'spawned';
    runtime.stderr.setEncoding('utf8');
    runtime.stderr.on('data', (chunk) => {
      runtimeStderr += chunk;
    });
    let readinessLease: Socket | null = null;
    try {
      stage = 'waiting-for-owner-files';
      await Promise.all([
        waitForPath(lifecycleSocket),
        waitForPath(drainSocket),
        waitForPath(join(socketRoot, 'lifecycle-owner-admission.json')),
      ]);
      expect((await readdir(socketRoot)).sort()).toEqual([
        'lifecycle-owner-admission.json',
        'orchestrator-lifecycle.sock',
      ]);
      const manifestEnvelope = JSON.parse(
        await readFile(join(socketRoot, 'lifecycle-owner-admission.json'), 'utf8')
      ) as { payload: string };
      const manifestPayload = JSON.parse(manifestEnvelope.payload) as {
        bootstrapBinding: Record<string, unknown>;
        ownerBinding: Record<string, unknown>;
      };
      const ownerBinding = manifestPayload.ownerBinding;
      stage = 'readiness';
      readinessLease = await openFakeRuntimeReadinessLease({
        socketPath: lifecycleSocket,
        trustAnchor: sandbox.lifecycleTrustAnchor,
        bootstrapBinding: manifestPayload.bootstrapBinding,
        ownerBinding,
      });
      const context = {
        actorId: 'actor_hosted-v1-release-drain-replay',
        sessionId: 'session_hosted-v1-release-drain-replay',
        deploymentId: 'deployment_hosted-v1-e2e',
        bootId: `boot_hosted-v1-e2e-${sandbox.marker}`,
        requestId: 'request_hosted-v1-release-drain-replay',
        authorizedScope: 'hosted.command',
        deadlineAtMs: Date.now() + 30_000,
      };
      const command = {
        schemaVersion: 1,
        action: 'launch',
        commandId: 'lifecycle-command_release-drain-replay',
        idempotencyKey: 'idempotency_release-drain-replay',
        workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
        teamId: `team_${'a'.repeat(32)}`,
        expectedRevision: (JSON.parse(await readFile(join(sandbox.fakeRuntimeStateDir, 'runtime-state.json'), 'utf8')) as {
          lifecycleInitialRevision: string;
        }).lifecycleInitialRevision,
      };
      const authority = {
        actorId: context.actorId,
        workspaceId: command.workspaceId,
        teamId: command.teamId,
        deploymentId: context.deploymentId,
        restoreGeneration: 0,
        mountGeneration: 1,
        bootId: context.bootId,
        resourceRevision: command.expectedRevision,
        ownerEffectFence,
      };
      const request = (
        operation: 'control_state' | 'authorize' | 'execute' | 'revalidate' | 'release',
        payload: Record<string, unknown>,
        suffix: string
      ) => ({
        schemaVersion: 2,
        exchangeId: `lifecycle-request_${suffix.padEnd(32, '0')}`,
        operation,
        provenance: {
          from: {
            kind: 'controller',
            deploymentId: context.deploymentId,
            bootId: context.bootId,
            actorId: context.actorId,
            sessionId: context.sessionId,
          },
          to: {
            kind: 'owner',
            ownerAuthority: ownerBinding.ownerAuthority,
            ownerGeneration: ownerBinding.ownerGeneration,
            ownerSessionId: ownerBinding.ownerSessionId,
          },
          target: {
            capability: 'hosted-lifecycle-command',
            exchangeId: `lifecycle-request_${suffix.padEnd(32, '0')}`,
            operation,
            workspaceId: command.workspaceId,
            teamId: command.teamId,
          },
        },
        ownerBinding,
        ownerEffectFence,
        payload,
      });
      const controlAuthority = { ...authority, resourceRevision: null };
      const initialControlState = await sendFakeRuntimeLifecycleRequest(
        lifecycleSocket,
        sandbox.lifecycleTrustAnchor,
        request(
          'control_state',
          {
            request: {
              schemaVersion: 1,
              workspaceId: command.workspaceId,
              teamId: command.teamId,
            },
            context,
            authority: controlAuthority,
          },
          '0'
        )
      );
      expect(initialControlState.payload).toEqual({
        schemaVersion: 1,
        kind: 'control_state',
        workspaceId: command.workspaceId,
        teamId: command.teamId,
        deploymentId: context.deploymentId,
        bootId: context.bootId,
        runId: null,
        resourceRevision: command.expectedRevision,
        availableActions: ['launch'],
      });
      const authorizeReleased = await sendFakeRuntimeLifecycleRequest(
        lifecycleSocket,
        sandbox.lifecycleTrustAnchor,
        request('authorize', { command, context, authority }, '1')
      );
      stage = 'authorized';
      const releasedAuthorization = (
        authorizeReleased.payload as { authorization: Record<string, unknown> }
      ).authorization;
      const releasedAuthorizationPayload = {
        command,
        authorization: releasedAuthorization,
        context,
        authority,
      };
      const released = await sendFakeRuntimeLifecycleRequest(
        lifecycleSocket,
        sandbox.lifecycleTrustAnchor,
        request('release', releasedAuthorizationPayload, '2')
      );
      stage = 'released';
      expect(released.payload).toMatchObject({ kind: 'released' });
      const durableState = JSON.parse(
        await readFile(join(sandbox.fakeRuntimeStateDir, 'runtime-state.json'), 'utf8')
      ) as { lifecycleReleaseLedger: Array<Record<string, unknown>> };
      expect(durableState.lifecycleReleaseLedger).toMatchObject([{ drainEpoch: 0 }]);

      const authorizeLive = await sendFakeRuntimeLifecycleRequest(
        lifecycleSocket,
        sandbox.lifecycleTrustAnchor,
        request('authorize', { command, context, authority }, '3')
      );
      const liveAuthorization = (
        authorizeLive.payload as { authorization: Record<string, unknown> }
      ).authorization;
      const liveAuthorizationPayload = {
        command,
        authorization: liveAuthorization,
        context,
        authority,
      };
      const liveRevalidation = await sendFakeRuntimeLifecycleRequest(
        lifecycleSocket,
        sandbox.lifecycleTrustAnchor,
        request('revalidate', liveAuthorizationPayload, '4')
      );
      expect(liveRevalidation.payload).toMatchObject({
        kind: 'valid',
        authorization: liveAuthorization,
      });
      const liveExecutePayload = {
        ...liveAuthorizationPayload,
        durableCommand: fakeRuntimeLifecycleDurableCommand(command, context, authority),
      };
      stage = 'live-authorization-validated';

      await expect(
        sendFakeRuntimeAuthDrainRequest(drainSocket, {
          operation: 'auth_drain',
          resetGeneration: 11,
        })
      ).resolves.toEqual({ ok: false, code: 'request_invalid' });
      stage = 'indeterminate-drain';
      await expect(readFile(proofPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
        resetGeneration: 11,
        outcome: 'drained',
      });
      await expect(
        sendFakeRuntimeAuthDrainRequest(drainSocket, {
          operation: 'auth_drain_release',
          resetGeneration: 11,
        })
      ).resolves.toEqual({ ok: false, code: 'drain_unconfirmed' });
      await expect(
        sendFakeRuntimeAuthDrainRequest(drainSocket, {
          operation: 'auth_drain',
          resetGeneration: 11,
        })
      ).resolves.toMatchObject({ ok: true, value: { resetGeneration: 11 } });
      stage = 'confirmed-drain';
      await chmod(proofPath, 0o400);
      await chmod(authDrainRoot, 0o500);
      try {
        const reader = new FileHostedPairingDrainProof(
          proofPath,
          { noRuntimeMutationAtStartup: false, now: Date.now },
          createHostedAccessNodePlatform()
        );
        await expect(
          reader.confirmDrained({
            binding: { deploymentId: 'deployment_hosted-v1-e2e' as never, restoreGeneration: 0 },
            purpose: 'host_reset',
            resetGeneration: 11,
          })
        ).resolves.toMatchObject({ status: 'drained' });
      } finally {
        await chmod(authDrainRoot, 0o700);
        await chmod(proofPath, 0o600);
      }
      await expect(
        sendFakeRuntimeAuthDrainRequest(drainSocket, {
          operation: 'auth_drain_release',
          resetGeneration: 11,
        })
      ).resolves.toMatchObject({ ok: true, value: { released: true } });
      stage = 'drain-released';
      const deniedRelease = await sendFakeRuntimeLifecycleRequest(
        lifecycleSocket,
        sandbox.lifecycleTrustAnchor,
        request('release', releasedAuthorizationPayload, '5')
      );
      stage = 'replay-denied';
      expect(deniedRelease.payload).toMatchObject({ kind: 'operator_required' });
      const deniedRevalidate = await sendFakeRuntimeLifecycleRequest(
        lifecycleSocket,
        sandbox.lifecycleTrustAnchor,
        request('revalidate', liveAuthorizationPayload, '6')
      );
      expect(deniedRevalidate.payload).toMatchObject({
        kind: 'conflict',
        reason: 'authorization_changed',
      });
      await expect(
        sendFakeRuntimeLifecycleRequest(
          lifecycleSocket,
          sandbox.lifecycleTrustAnchor,
          request('execute', liveExecutePayload, '7')
        )
      ).rejects.toThrow('fake_runtime_test_response_incomplete');
    } finally {
      readinessLease?.destroy();
      runtime.kill('SIGTERM');
      const [exitCode] = await Promise.race([
        new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
          runtime.once('close', (code, signal) => resolve([code, signal]))
        ),
        new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
          setTimeout(() => {
            runtime.kill('SIGKILL');
            resolve([null, 'SIGKILL']);
          }, 2_000)
        ),
      ]);
      expect(exitCode, `${stage}: ${runtimeStderr}`).toBe(0);
    }
  }, 30_000);

  it('shares the independent raw-key readiness golden vectors with the fake owner', () => {
    const key = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const request =
      '{"schemaVersion":2,"operation":"readiness","capability":"hosted-lifecycle-command","socketIdentity":{"device":"253","inode":"7001","uid":1000,"gid":1000,"mode":384},"challenge":"1212121212121212121212121212121212121212121212121212121212121212","bootstrapBinding":{"deploymentId":"deployment_golden","bootId":"boot_golden","workspaceId":"workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mountGeneration":7,"bootstrapDigest":"1111111111111111111111111111111111111111111111111111111111111111","ownerArtifactDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","proofKeyId":"630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"},"expectedOwnerBinding":{"ownerAuthority":"owner-authority_golden-vector","ownerGeneration":41,"ownerSessionId":"owner-session_golden-vector-0001","socketIdentity":{"device":"253","inode":"7001","uid":1000,"gid":1000,"mode":384}}}';
    const response =
      '{"schemaVersion":2,"kind":"ready","capability":"hosted-lifecycle-command","challenge":"1212121212121212121212121212121212121212121212121212121212121212","bootstrapDigest":"1111111111111111111111111111111111111111111111111111111111111111","ownerBinding":{"ownerAuthority":"owner-authority_golden-vector","ownerGeneration":41,"ownerSessionId":"owner-session_golden-vector-0001","socketIdentity":{"device":"253","inode":"7001","uid":1000,"gid":1000,"mode":384}}}';

    expect(fakeRuntimeLifecycleProof(key, 'readiness-request', request)).toBe(
      '36fa206ae60f126add109619c408389d14d05cf1d44de7fc6e3c4eb6e3b208bb'
    );
    expect(fakeRuntimeLifecycleProof(key, 'readiness', response)).toBe(
      'c7059f3ffcbf29080eb57b9e504236577137d63eb384029d1087be6f980d5e1e'
    );
  });

  it('builds the exact canonical release-pinned launcher manifest for a fresh socket owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-owner-manifest-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const releasePin = JSON.parse(
      await readFile(join(sandbox.lifecycleTrustDir, 'release-owner-pin.json'), 'utf8')
    ) as {
      artifact: Parameters<typeof fakeRuntimeLifecycleOwnerAdmissionManifest>[0]['artifact'];
      launcher: { algorithm: string; publicKey: string; keyId: string };
    };
    const launcherPrivateKey = await readFile(
      join(sandbox.lifecycleLauncherDir, 'owner-admission-private-key.pem'),
      'utf8'
    );
    const socketIdentity = { device: '253', inode: '7001', uid: 1000, gid: 1000, mode: 0o600 };

    const admission = fakeRuntimeLifecycleOwnerAdmissionManifest({
      artifact: releasePin.artifact,
      bootstrap: sandbox.bootstrap,
      launcherKeyId: releasePin.launcher.keyId,
      launcherPrivateKey,
      launcherPublicKey: releasePin.launcher.publicKey,
      mountGeneration: 1,
      ownerGeneration: 7,
      socketIdentity,
      trustAnchor: sandbox.lifecycleTrustAnchor,
    });
    const serialized = admission.serializedManifest.slice(0, -1);
    const envelope = JSON.parse(serialized) as {
      format: string;
      payload: string;
      authentication: { algorithm: string; launcherKeyId: string; signature: string };
    };

    expect(JSON.stringify(envelope)).toBe(serialized);
    expect(envelope.format).toBe('agent-teams.hosted-lifecycle-owner-admission/v3');
    expect(JSON.parse(envelope.payload)).toMatchObject({
      artifact: releasePin.artifact,
      ownerBinding: {
        ownerGeneration: 7,
        socketIdentity,
      },
      bootstrapBinding: {
        mountGeneration: 1,
        bootstrapDigest: createHash('sha256').update(sandbox.bootstrap).digest('hex'),
        ownerArtifactDigest: releasePin.artifact.artifactDigest,
      },
      socketPath: '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock',
      approvalAdmission: { state: 'provisioning' },
      approvalSnapshot: null,
    });
    expect(envelope.authentication).toMatchObject({
      algorithm: 'ed25519',
      launcherKeyId: releasePin.launcher.keyId,
    });
    expect(
      verify(
        null,
        Buffer.from(
          `agent-teams.hosted-lifecycle-owner-admission/v3\u0000${envelope.payload}`,
          'utf8'
        ),
        createPublicKey({
          key: { kty: 'OKP', crv: 'Ed25519', x: releasePin.launcher.publicKey },
          format: 'jwk',
        }),
        Buffer.from(envelope.authentication.signature, 'base64url')
      )
    ).toBe(true);
  });

  it('uses a deterministic canonical run id for synthetic lifecycle launches', () => {
    const teamId = `team_${'a'.repeat(32)}`;
    const commandFingerprint = 'b'.repeat(64);
    const runId = fakeRuntimeLifecycleRunId(teamId, commandFingerprint);

    expect(runId).toBe(
      `run_${createHash('sha256')
        .update(
          JSON.stringify({
            domain: 'agent-teams.hosted-v1-e2e.lifecycle-run/v2',
            teamId,
            commandFingerprint,
          })
        )
        .digest('hex')
        .slice(0, 32)}`
    );
    expect(fakeRuntimeLifecycleRunId(teamId, 'c'.repeat(64))).not.toBe(runId);
    expect(fakeRuntimeLifecycleRunId(teamId, commandFingerprint)).toBe(runId);
    expect(parseRunId(runId)).toBe(runId);
  });

  it('binds a fake Owner launch fingerprint and durable resource to the Product reserved run', () => {
    const command = {
      schemaVersion: 1,
      action: 'launch',
      commandId: 'lifecycle-command_reserved-e2e',
      idempotencyKey: 'idempotency_reserved-e2e',
      workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
      teamId: `team_${'a'.repeat(32)}`,
      expectedRevision: `revision_${'1'.repeat(64)}`,
    };
    const context = {
      deploymentId: 'deployment_hosted-v1-e2e',
      actorId: `actor_${'2'.repeat(64)}`,
      bootId: `boot_${'3'.repeat(32)}`,
    };
    const authority = {
      restoreGeneration: 0,
      mountGeneration: 1,
      ownerEffectFence: { grantRevision: '4'.repeat(64), identityChecksum: '5'.repeat(64) },
    };
    const reserved = fakeRuntimeLifecycleDurableCommand(
      command,
      context,
      authority,
      `run_${'6'.repeat(32)}`
    );
    expect(reserved.resource.runId).toBe(`run_${'6'.repeat(32)}`);
    expect(reserved.commandFingerprint.digest).not.toBe(
      fakeRuntimeLifecycleDurableCommand(command, context, authority).commandFingerprint.digest
    );
    expect(() => fakeRuntimeLifecycleDurableCommand(command, context, authority, 'run_wrong'))
      .toThrow('fake_runtime_lifecycle_run_reservation_invalid');
  });

  it('binds restarted authorization identities to the exact owner session', () => {
    const common = {
      ownerAuthority: 'owner-authority_hosted-v1-e2e',
      ownerGeneration: 7,
      socketIdentity: { device: '1', inode: '2', uid: 0, gid: 0, mode: 0o600 },
    };
    const first = fakeRuntimeAuthorizationIdentity(
      { ...common, ownerSessionId: 'owner-session_hosted-v1-first' },
      1
    );
    const restarted = fakeRuntimeAuthorizationIdentity(
      { ...common, ownerGeneration: 8, ownerSessionId: 'owner-session_hosted-v1-restarted' },
      1
    );
    expect(restarted).not.toEqual(first);
    expect(
      fakeRuntimeAuthorizationIdentity(
        { ...common, ownerSessionId: 'owner-session_hosted-v1-first' },
        1
      )
    ).toEqual(first);
  });

  it('reuses one admitted readiness value while isolating connection lease identity', () => {
    const admitted = {
      ownerAuthority: 'owner-authority_hosted-v1-e2e-stable',
      ownerGeneration: 17,
      ownerSessionId: 'owner-session_hosted-v1-e2e-stable',
      socketIdentity: { device: '1', inode: '2', uid: 1000, gid: 1000, mode: 0o600 },
    };

    const first = fakeRuntimeReadinessSessionBinding(admitted, structuredClone(admitted));
    const retry = fakeRuntimeReadinessSessionBinding(admitted, structuredClone(admitted));

    expect(first).toEqual(admitted);
    expect(retry).toEqual(admitted);
    expect(retry).not.toBe(first);
    expect(retry.socketIdentity).not.toBe(first.socketIdentity);
    expect(() =>
      fakeRuntimeReadinessSessionBinding(admitted, { ...admitted, ownerGeneration: 18 })
    ).toThrow('fake_runtime_authenticated_owner_handoff_mismatch');
  });

  it('installs readiness revocation before post-publication awaits and isolates retry cleanup', async () => {
    const owner: { binding: Record<string, unknown> | null } = { binding: null };
    const firstBinding = { ownerSessionId: 'owner-session_cleanup-first' };
    const firstLease = createFakeRuntimeReadinessLeasePublication(owner);
    const failedTrace = (async () => {
      firstLease.publish(firstBinding);
      await Promise.resolve();
      throw new Error('fake_runtime_readiness_trace_failed');
    })();

    firstLease.close();
    await expect(failedTrace).rejects.toThrow('fake_runtime_readiness_trace_failed');
    expect(owner.binding).toBeNull();

    const closedBeforePublication = createFakeRuntimeReadinessLeasePublication(owner);
    closedBeforePublication.close();
    expect(() => closedBeforePublication.publish(firstBinding)).toThrow(
      'fake_runtime_readiness_connection_closed'
    );

    const oldLease = createFakeRuntimeReadinessLeasePublication(owner);
    const retryLease = createFakeRuntimeReadinessLeasePublication(owner);
    const retryBinding = { ownerSessionId: 'owner-session_cleanup-retry' };
    oldLease.publish(firstBinding);
    retryLease.publish(retryBinding);
    oldLease.close();
    expect(owner.binding).toBe(retryBinding);
    retryLease.close();
    expect(owner.binding).toBeNull();
  });

  it.each(['close', 'error'] as const)(
    'revokes a published readiness binding when socket %s races deferred trace persistence',
    async (event) => {
      const owner: { binding: Record<string, unknown> | null } = { binding: null };
      const binding = { ownerSessionId: `owner-session_cleanup-${event}` };
      const socket = new EventEmitter();
      const lease = createFakeRuntimeReadinessLeasePublication(owner);
      registerFakeRuntimeReadinessLeaseCleanup(socket, lease.close);

      let finishTrace: (() => void) | undefined;
      const trace = new Promise<void>((resolve) => {
        finishTrace = resolve;
      });
      const publication = (async () => {
        lease.publish(binding);
        await trace;
      })();
      expect(owner.binding).toBe(binding);

      if (event === 'error') socket.emit('error', new Error('synthetic-readiness-socket-error'));
      else socket.emit('close');
      expect(owner.binding).toBeNull();

      finishTrace?.();
      await publication;
      // The later companion terminal event is harmless and cannot revoke a successor lease.
      if (event === 'error') socket.emit('close');
      expect(owner.binding).toBeNull();
    }
  );

  it('authenticates exact raw lifecycle frame bytes and rejects normalization or trailing data', () => {
    const trustAnchor = 'a'.repeat(64);
    const unsigned = JSON.stringify({
      schemaVersion: 2,
      exchangeId: `lifecycle-request_${'b'.repeat(32)}`,
      operation: 'authorize',
      ownerBinding: { ownerSessionId: 'owner-session_exact-wire-proof' },
      payload: { value: 'escaped\\nbytes' },
    });
    const proof = createHmac('sha256', Buffer.from(trustAnchor, 'hex'))
      .update(`agent-teams.hosted-lifecycle.owner-proof/v1\u0000request\u0000${unsigned}`)
      .digest('hex');
    const frame = `${unsigned.slice(0, -1)},"ownerProof":"${proof}"}\n`;
    expect(
      verifyFakeRuntimeLifecycleRequestFrame(frame, trustAnchor).serializedUnsignedEnvelope
    ).toBe(unsigned);
    expect(() =>
      verifyFakeRuntimeLifecycleRequestFrame(
        frame.replace('"schemaVersion":2', '"schemaVersion": 2'),
        trustAnchor
      )
    ).toThrow('fake_runtime_owner_proof_invalid');
    expect(() =>
      verifyFakeRuntimeLifecycleRequestFrame(`${frame}{"delayed":true}\n`, trustAnchor)
    ).toThrow('fake_runtime_lifecycle_signed_frame_invalid');
    expect(() => verifyFakeRuntimeLifecycleRequestFrame(frame.slice(0, -1), trustAnchor)).toThrow(
      'fake_runtime_lifecycle_signed_frame_invalid'
    );
    const duplicateUnsigned = unsigned.replace(
      '"schemaVersion":2',
      '"schemaVersion":2,"schemaVersion":2'
    );
    const duplicateProof = createHmac('sha256', Buffer.from(trustAnchor, 'hex'))
      .update(`agent-teams.hosted-lifecycle.owner-proof/v1\u0000request\u0000${duplicateUnsigned}`)
      .digest('hex');
    expect(() =>
      verifyFakeRuntimeLifecycleRequestFrame(
        `${duplicateUnsigned.slice(0, -1)},"ownerProof":"${duplicateProof}"}\n`,
        trustAnchor
      )
    ).toThrow('fake_runtime_lifecycle_signed_frame_invalid');
  });

  it('persists strictly monotonic owner generations across restarts and fails closed on substitution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-owner-generation-'));
    roots.push(root);
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot, { mode: 0o700 });
    const marker = 'a'.repeat(48);
    const bootId = `boot_hosted-v1-e2e-${marker}`;
    const environment = {
      ...process.env,
      E2E_BOOT_ID: bootId,
      E2E_FAKE_RUNTIME_STATE_ROOT: stateRoot,
    };
    const reserveInProcess = () => reserveFakeRuntimeOwnerGeneration(bootId, stateRoot);
    await expect(
      Promise.all([reserveInProcess(), reserveInProcess(), reserveInProcess()])
    ).resolves.toEqual([1, 2, 3]);
    const reserveAfterRestart = () =>
      execFileAsync(
        process.execPath,
        ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'reserve-owner-generation'],
        { ...boundedExecOptions, cwd: process.cwd(), env: environment }
      );
    const firstRestart = await reserveAfterRestart();
    const secondRestart = await reserveAfterRestart();
    expect(firstRestart.stderr).toBe('');
    expect(secondRestart.stderr).toBe('');
    expect([JSON.parse(firstRestart.stdout), JSON.parse(secondRestart.stdout)]).toEqual([4, 5]);

    const terminalState = `${JSON.stringify({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-v1-e2e.owner-generation/v1',
      marker,
      generation: Number.MAX_SAFE_INTEGER - 1,
    })}\n`;
    await writeFile(join(stateRoot, 'owner-generation.json'), terminalState, { mode: 0o600 });
    await expect(reserveInProcess()).rejects.toThrow(
      'hosted_e2e_fake_runtime_owner_generation_exhausted'
    );
    await expect(readFile(join(stateRoot, 'owner-generation.json'), 'utf8')).resolves.toBe(
      terminalState
    );

    await writeFile(
      join(stateRoot, 'owner-generation.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        purpose: 'agent-teams.hosted-v1-e2e.owner-generation/v1',
        marker: 'b'.repeat(48),
        generation: 999,
      })}\n`,
      { mode: 0o600 }
    );
    await expect(reserveAfterRestart()).rejects.toThrow(
      'hosted_e2e_fake_runtime_owner_generation_invalid'
    );

    await writeFile(join(stateRoot, 'owner-generation.json'), '{"schemaVersion":1}\n', {
      mode: 0o600,
    });
    await expect(reserveAfterRestart()).rejects.toThrow(
      'hosted_e2e_fake_runtime_owner_generation_invalid'
    );
  });

  it('advances mount generation only for a fresh complete restart and rejects stale bootstrap reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-mount-generation-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const statePath = join(sandbox.fakeRuntimeStateDir, 'mount-generation.json');
    const bootId = `boot_hosted-v1-e2e-${sandbox.marker}`;
    expect(await readFakeRuntimeMountGeneration(bootId, sandbox.fakeRuntimeStateDir)).toBe(1);
    expect(() =>
      assertFakeRuntimeMountGenerationCurrent({
        expectedMountGeneration: 1,
        receivedMountGeneration: 1,
      })
    ).not.toThrow();
    expect(() =>
      assertFakeRuntimeMountGenerationCurrent({
        expectedMountGeneration: 2,
        receivedMountGeneration: 1,
      })
    ).toThrow('fake_runtime_mount_generation_stale');
    expect(
      (
        JSON.parse(sandbox.bootstrap) as {
          workspaceManifest: { registrations: [{ mountBinding: { mountGeneration: number } }] };
        }
      ).workspaceManifest.registrations[0].mountBinding.mountGeneration
    ).toBe(1);

    const foreignRoot = await mkdtemp(join(tmpdir(), 'hosted-v1-foreign-mount-generation-'));
    roots.push(foreignRoot);
    const foreignSandbox = await createHostedV1Sandbox(foreignRoot);
    const generationOneBytes = await readFile(statePath, 'utf8');
    await expect(
      advanceHostedV1MountGeneration({
        bootstrap: foreignSandbox.bootstrap,
        fakeRuntimeStateDir: sandbox.fakeRuntimeStateDir,
        markerPath: sandbox.markerPath,
        nowMs: 1_800_000_000_000,
        root: sandbox.root,
      })
    ).rejects.toThrow('hosted_e2e_mount_generation_bootstrap_invalid');
    expect(await readFile(statePath, 'utf8')).toBe(generationOneBytes);

    const concurrentAdvances = await Promise.allSettled([
      advanceHostedV1MountGeneration({
        bootstrap: sandbox.bootstrap,
        fakeRuntimeStateDir: sandbox.fakeRuntimeStateDir,
        markerPath: sandbox.markerPath,
        nowMs: 1_800_000_000_000,
        root: sandbox.root,
      }),
      advanceHostedV1MountGeneration({
        bootstrap: sandbox.bootstrap,
        fakeRuntimeStateDir: sandbox.fakeRuntimeStateDir,
        markerPath: sandbox.markerPath,
        nowMs: 1_800_000_000_001,
        root: sandbox.root,
      }),
    ]);
    const fulfilledAdvances = concurrentAdvances.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    const rejectedReasons = concurrentAdvances.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    expect(fulfilledAdvances).toHaveLength(1);
    expect(rejectedReasons).toHaveLength(1);
    expect(rejectedReasons[0]).toEqual(
      expect.objectContaining({ message: 'hosted_e2e_mount_generation_stale' })
    );
    const second = fulfilledAdvances[0]!;
    expect(second.mountGeneration).toBe(2);
    expect(await readFakeRuntimeMountGeneration(bootId, sandbox.fakeRuntimeStateDir)).toBe(2);
    await expect(
      lstat(join(sandbox.fakeRuntimeStateDir, 'mount-generation.lock'))
    ).rejects.toThrow();
    const generationTwoBytes = await readFile(statePath, 'utf8');
    const ownerGenerationPath = join(sandbox.fakeRuntimeStateDir, 'owner-generation.json');
    const ownerGenerationBytes = `${JSON.stringify({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-v1-e2e.owner-generation/v1',
      marker: sandbox.marker,
      generation: 9,
    })}\n`;
    await writeFile(ownerGenerationPath, ownerGenerationBytes, { mode: 0o600 });
    const staleBootstrapMountGeneration = fakeRuntimeBootstrapMountGeneration(
      sandbox.bootstrap,
      bootId
    );
    expect(staleBootstrapMountGeneration).toBe(1);
    expect(() =>
      assertFakeRuntimeMountGenerationCurrent({
        expectedMountGeneration: second.mountGeneration,
        receivedMountGeneration: staleBootstrapMountGeneration,
      })
    ).toThrow('fake_runtime_mount_generation_stale');
    expect(await readFile(ownerGenerationPath, 'utf8')).toBe(ownerGenerationBytes);

    await expect(
      advanceHostedV1MountGeneration({
        bootstrap: sandbox.bootstrap,
        fakeRuntimeStateDir: sandbox.fakeRuntimeStateDir,
        markerPath: sandbox.markerPath,
        nowMs: 1_800_000_060_000,
        root: sandbox.root,
      })
    ).rejects.toThrow('hosted_e2e_mount_generation_stale');
    expect(await readFile(statePath, 'utf8')).toBe(generationTwoBytes);

    const third = await advanceHostedV1MountGeneration({
      bootstrap: second.bootstrap,
      fakeRuntimeStateDir: sandbox.fakeRuntimeStateDir,
      markerPath: sandbox.markerPath,
      nowMs: 1_800_000_120_000,
      root: sandbox.root,
    });
    expect(third.mountGeneration).toBe(3);
    expect(await readFakeRuntimeMountGeneration(bootId, sandbox.fakeRuntimeStateDir)).toBe(3);

    const generationThreeBytes = await readFile(statePath, 'utf8');
    await expect(
      advanceHostedV1MountGeneration({
        bootstrap: third.bootstrap,
        fakeRuntimeStateDir: sandbox.fakeRuntimeStateDir,
        markerPath: sandbox.markerPath,
        nowMs: Number.MAX_SAFE_INTEGER,
        root: sandbox.root,
      })
    ).rejects.toThrow('hosted_e2e_mount_generation_time_invalid');
    expect(await readFile(statePath, 'utf8')).toBe(generationThreeBytes);

    const validState = await readFile(statePath, 'utf8');
    await writeFile(statePath, validState.replace(sandbox.marker, 'b'.repeat(48)), { mode: 0o600 });
    await expect(
      advanceHostedV1MountGeneration({
        bootstrap: third.bootstrap,
        fakeRuntimeStateDir: sandbox.fakeRuntimeStateDir,
        markerPath: sandbox.markerPath,
        nowMs: 1_800_000_180_000,
        root: sandbox.root,
      })
    ).rejects.toThrow('hosted_e2e_mount_generation_state_invalid');
  });

  it('preserves a successful task ledger entry across a lifecycle state rewrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-ledger-lifecycle-'));
    roots.push(root);
    const statePath = join(root, 'runtime-state.json');
    const taskLedger = [
      {
        key: [
          `team_${'a'.repeat(32)}`,
          `generation_${'6'.repeat(64)}`,
          'idempotency_lifecycle_restart',
        ].join('\u0000'),
        fingerprint: '5'.repeat(64),
        receipt: {
          schemaVersion: 1,
          outcome: 'committed',
          commandId: 'command_lifecycle_restart',
          teamId: `team_${'a'.repeat(32)}`,
          sourceGeneration: `generation_${'6'.repeat(64)}`,
          revision: `revision_${'7'.repeat(64)}`,
          affectedTaskIds: [`task_${'8'.repeat(32)}`],
        },
      },
    ] as const;
    await writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        activeRuns: [{ teamId: `team_${'a'.repeat(32)}`, runId: 'run_lifecycle_restart' }],
        commands: [],
        eventIds: [],
        messageLedger: [],
        taskLedger,
      })}\n`
    );

    await recordRuntimeExecution(
      {
        action: 'stop',
        commandId: 'lifecycle-command_preserve-task-ledger',
        teamId: `team_${'a'.repeat(32)}`,
        workspaceId: `workspace_${'b'.repeat(32)}`,
        expectedRevision: `revision_${'9'.repeat(64)}`,
      },
      'run_lifecycle_restart',
      statePath
    );

    const afterLifecycle = JSON.parse(await readFile(statePath, 'utf8')) as {
      activeRuns: unknown[];
      commands: { action: string }[];
      taskLedger: unknown[];
    };
    expect(afterLifecycle).toMatchObject({
      activeRuns: [],
      commands: [{ action: 'stop' }],
    });
    expect(afterLifecycle.taskLedger).toEqual(taskLedger);
  });

  it('keeps fake task idempotency validation identical to the canonical production grammar', () => {
    const uiIdempotencyKey = 'mutation_01234567-89ab-4def-8123-456789abcdef';
    for (const accepted of ['a', 'A0._:-', uiIdempotencyKey, 'a'.repeat(128)]) {
      expect(parseHostedTaskIdempotencyKey(accepted)).toBe(accepted);
      expect(isFakeRuntimeHostedTaskIdempotencyKey(accepted)).toBe(true);
    }
    for (const rejected of [
      '',
      '_leading-punctuation',
      '.leading-punctuation',
      ':leading-punctuation',
      '-leading-punctuation',
      'mutation/01234567-89ab-4def-8123-456789abcdef',
      'mutation with spaces',
      'mutation_ünicode',
      'a'.repeat(129),
    ]) {
      expect(() => parseHostedTaskIdempotencyKey(rejected)).toThrow(
        'hosted-task-board-idempotency-key-invalid'
      );
      expect(isFakeRuntimeHostedTaskIdempotencyKey(rejected)).toBe(false);
    }
  });

  it('admits a UI-shaped task mutation through durable ledger replay and fails closed otherwise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-idempotency-contract-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/hosted-v1/seedContainer.ts',
        'prove-task-idempotency-contract',
      ],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
        },
      }
    );

    expect(stderr).toBe('');
    const proof = JSON.parse(stdout) as {
      command: {
        commandId: string;
        expectedSourceGeneration: string;
        idempotencyKey: string;
        teamId: string;
      };
      fingerprint: string;
      committed: {
        schemaVersion: number;
        kind: string;
        currentSourceGeneration: string;
        payloadFingerprint: string;
        receipt: Record<string, unknown> & { outcome: string };
      };
      replay: Record<string, unknown>;
      durableLedger: {
        key: string;
        fingerprint: string;
        receipt: Record<string, unknown>;
        wal: {
          key: string;
          fingerprint: string;
          commandId: string;
          command: Record<string, unknown>;
        };
      };
      replayStateByteStable: boolean;
      invalid: {
        keys: string[];
        requestErrors: string[];
        ledgerError: string;
        runtimeStateByteStable: boolean;
        boardRevisionStable: boolean;
        walAbsent: boolean;
      };
    };
    const expectedLedgerKey = [
      proof.command.teamId,
      proof.command.expectedSourceGeneration,
      proof.command.idempotencyKey,
    ].join('\u0000');

    expect(proof.command.idempotencyKey).toBe('mutation_01234567-89ab-4def-8123-456789abcdef');
    expect(parseHostedTaskIdempotencyKey(proof.command.idempotencyKey)).toBe(
      proof.command.idempotencyKey
    );
    expect(proof.committed).toMatchObject({
      schemaVersion: 1,
      kind: 'committed',
      currentSourceGeneration: proof.command.expectedSourceGeneration,
      payloadFingerprint: proof.fingerprint,
      receipt: {
        outcome: 'committed',
        commandId: proof.command.commandId,
        teamId: proof.command.teamId,
        sourceGeneration: proof.command.expectedSourceGeneration,
      },
    });
    expect(proof.durableLedger).toEqual({
      key: expectedLedgerKey,
      fingerprint: proof.fingerprint,
      receipt: proof.committed.receipt,
      wal: {
        key: expectedLedgerKey,
        fingerprint: proof.fingerprint,
        commandId: proof.command.commandId,
        command: expect.objectContaining(proof.command),
      },
    });
    expect(proof.replay).toEqual({
      schemaVersion: 1,
      kind: 'idempotent_replay',
      currentSourceGeneration: proof.command.expectedSourceGeneration,
      payloadFingerprint: proof.fingerprint,
      receipt: { ...proof.committed.receipt, outcome: 'idempotent_replay' },
    });
    expect(proof.replayStateByteStable).toBe(true);
    expect(proof.invalid.requestErrors).toEqual(
      proof.invalid.keys.map(() => 'fake_runtime_task_request_invalid')
    );
    expect(proof.invalid).toMatchObject({
      ledgerError: 'fake_runtime_task_ledger_invalid',
      runtimeStateByteStable: true,
      boardRevisionStable: true,
      walAbsent: true,
    });
  });

  it('bounds and sanitizes retained fake-owner task mutation error traces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-owner-mutation-trace-'));
    roots.push(root);
    const tracePath = join(root, 'owner-mutation-error-trace.json');
    const trace = createFakeRuntimeOwnerMutationErrorTrace(tracePath);
    const sensitiveValue = 'fixture-sensitive-value-must-not-be-retained';

    expect(
      sanitizeFakeRuntimeOwnerMutationError(new Error('fake_runtime_task_request_invalid'))
    ).toBe('fake_runtime_task_request_invalid');
    expect(sanitizeFakeRuntimeOwnerMutationError(new Error(`unexpected ${sensitiveValue}`))).toBe(
      'fake_runtime_task_mutation_internal_error'
    );
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        trace.record(
          index === 39
            ? new Error('fake_runtime_task_ledger_invalid')
            : new Error(`unexpected ${sensitiveValue} ${index}`)
        )
      )
    );

    const serialized = await readFile(tracePath, 'utf8');
    const entries = JSON.parse(serialized) as {
      sequence: number;
      operation: string;
      stage: string;
      reason: string;
    }[];
    expect(entries).toHaveLength(32);
    expect(entries[0]).toEqual({
      sequence: 9,
      operation: 'task_mutate',
      stage: 'error',
      reason: 'fake_runtime_task_mutation_internal_error',
    });
    expect(entries.at(-1)).toEqual({
      sequence: 40,
      operation: 'task_mutate',
      stage: 'error',
      reason: 'fake_runtime_task_ledger_invalid',
    });
    expect(serialized).not.toContain(sensitiveValue);
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('message');
  });

  it('serializes an overlapping lifecycle rewrite after a deferred task commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-runtime-state-overlap-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/hosted-v1/seedContainer.ts',
        'prove-state-mutation-overlap',
      ],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
        },
      }
    );

    expect(stderr).toBe('');
    const proof = JSON.parse(stdout) as {
      committed: Record<string, unknown>;
      replay: Record<string, unknown>;
      mismatch: Record<string, unknown>;
      commands: { action: string; commandId: string }[];
      taskLedger: { receipt: { revision: string } }[];
      taskOwner: unknown;
      invalidCreate: Record<string, unknown>;
      invalidCreateWasByteStable: boolean;
    };
    expect(proof).toMatchObject({
      committed: { kind: 'committed' },
      replay: { kind: 'idempotent_replay' },
      mismatch: { kind: 'conflict', reason: 'idempotency_mismatch' },
      commands: [{ action: 'stop', commandId: 'lifecycle-command_concurrent_task' }],
      taskOwner: 'member_ffffffffffffffffffffffffffffffff',
      invalidCreate: {
        kind: 'conflict',
        reason: 'state_conflict',
      },
      invalidCreateWasByteStable: true,
    });
    expect(proof.taskLedger).toHaveLength(1);
    expect(proof.replay).toMatchObject({
      receipt: { revision: proof.taskLedger[0]?.receipt.revision },
    });
  });

  it('scopes task idempotency to the exact source generation resource tuple', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-generation-reuse-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/hosted-v1/seedContainer.ts',
        'prove-task-generation-reuse',
      ],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
        },
      }
    );

    expect(stderr).toBe('');
    const proof = JSON.parse(stdout) as {
      first: Record<string, unknown>;
      second: Record<string, unknown>;
      ledgerKeys: string[];
      finalOwner: unknown;
    };
    expect(proof).toMatchObject({
      first: { kind: 'committed' },
      second: { kind: 'committed' },
      finalOwner: null,
    });
    expect(proof.ledgerKeys).toHaveLength(2);
    expect(new Set(proof.ledgerKeys).size).toBe(2);
    expect(proof.ledgerKeys[0]).toContain(`\u0000generation_${'a'.repeat(64)}\u0000`);
    expect(proof.ledgerKeys[1]).toContain(`\u0000generation_${'b'.repeat(64)}\u0000`);
  });

  it('preserves a provider write between WAL preimage validation and atomic target detach', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-newer-writer-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/hosted-v1/seedContainer.ts',
        'prove-task-newer-writer-fence',
      ],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
        },
      }
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      mutationError: 'fake_runtime_task_wal_target_raced',
      secondMutationError: 'fake_runtime_task_wal_target_raced',
      recoveryError: 'fake_runtime_task_wal_target_raced',
      publishFenceExercised: true,
      newerWriterPreserved: true,
      publicationArtifactsRetained: false,
      walRetained: true,
      walByteStable: true,
      taskLedgerCount: 0,
    });
  });

  it('retains WAL and refuses replay when a target changes after the task ledger fsync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-ledger-postimage-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/hosted-v1/seedContainer.ts',
        'prove-task-ledger-postimage-fence',
      ],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
        },
      }
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      mutationError: 'fake_runtime_task_wal_postimage_raced',
      retryError: 'fake_runtime_task_wal_target_raced',
      substitutedWriterPreserved: true,
      walRetained: true,
      walByteStable: true,
      taskLedgerCount: 1,
    });
  });

  it('rejects duplicate and well-shaped substituted task ledger rows without writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-ledger-validation-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/hosted-v1/seedContainer.ts',
        'prove-task-ledger-validation',
      ],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
        },
      }
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      duplicateError: 'fake_runtime_task_ledger_invalid',
      substitutedError: 'fake_runtime_task_ledger_invalid',
      historicalSubstitutedError: 'fake_runtime_task_ledger_invalid',
      taskBytesStable: true,
      walAbsent: true,
    });
  });

  it('applies update_relationship symmetrically with replay, conflict, and remove parity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-relationship-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'prove-update-relationship'],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_FAKE_RUNTIME_STATE_ROOT: sandbox.fakeRuntimeStateDir,
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
        },
      }
    );

    expect(stderr).toBe('');
    const proof = JSON.parse(stdout) as Record<string, unknown>;
    expect(proof).toMatchObject({
      add: { kind: 'committed' },
      replay: { kind: 'idempotent_replay' },
      duplicate: { kind: 'conflict', reason: 'relationship_conflict' },
      remove: { kind: 'committed' },
      afterAdd: { sourceBlocks: ['2'], targetBlockedBy: ['1'] },
      afterRemove: { sourceBlocks: [], targetBlockedBy: [] },
      related: {
        add: { kind: 'committed' },
        replay: { kind: 'idempotent_replay' },
        duplicate: { kind: 'conflict', reason: 'relationship_conflict' },
        remove: { kind: 'committed' },
        afterAdd: { sourceRelated: ['2'], targetRelated: ['1'] },
        afterRemove: { sourceRelated: [], targetRelated: [] },
      },
      crashRecovery: {
        error: 'fake_runtime_relationship_first_write_crash',
        replay: { kind: 'idempotent_replay' },
        sourceBlocks: ['2'],
        targetBlockedBy: ['1'],
      },
      asymmetric: {
        result: { kind: 'conflict', reason: 'relationship_conflict' },
        sourceRelated: ['2'],
        targetRelated: [],
      },
    });
  });

  it('recovers the durable lifecycle ledger without double execution or fabricated settlement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-lifecycle-durable-ledger-'));
    roots.push(root);
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot, { recursive: true });
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/hosted-v1/seedContainer.ts',
        'prove-lifecycle-durable-ledger',
      ],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: { ...process.env, E2E_FAKE_RUNTIME_STATE_ROOT: stateRoot },
      }
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      initialFences: {
        wrongRevision: {
          kind: 'stale_revision',
          currentRevision: `revision_${'0'.repeat(64)}`,
        },
        stopWithoutRun: { kind: 'not_found' },
        recoverWithoutHistory: { kind: 'not_found' },
      },
      fresh: { kind: 'settled', replayed: false },
      replay: { kind: 'settled', replayed: true },
      recovered: { kind: 'settled', replayed: true, commandCount: 2 },
      effectFenceSubstitution: {
        grantRevision: 'idempotency_mismatch',
        identityChecksum: 'idempotency_mismatch',
      },
      admission: {
        exactReplay: { kind: 'admit', exactReplay: true },
        staleNewKey: {
          kind: 'stale_revision',
          currentRevision: expect.stringMatching(/^revision_[0-9a-f]{64}$/u),
        },
        staleOldRun: {
          kind: 'stale_run',
          currentRevision: expect.stringMatching(/^revision_[0-9a-f]{64}$/u),
        },
      },
      historicalReplay: { kind: 'settled', replayed: true, commandCount: 3 },
      missingPostimage: { kind: 'operator_required', ledgerState: 'operator_required' },
      duplicatePostimage: 'operator_required',
      substitutedRunPostimage: 'operator_required',
      tamperedResultRejected: true,
      collision: 'idempotency_mismatch',
      orphan: { kind: 'operator_required', ledgerState: 'operator_required' },
      finalCommandCount: 2,
    });
  });

  it('rechecks the serialized owner fence after the started ledger fsync and before any effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-lifecycle-pre-effect-fence-'));
    roots.push(root);
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot, { recursive: true });
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/hosted-v1/seedContainer.ts',
        'prove-lifecycle-pre-effect-fence',
      ],
      {
        ...boundedExecOptions,
        cwd: process.cwd(),
        env: { ...process.env, E2E_FAKE_RUNTIME_STATE_ROOT: stateRoot },
      }
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      error: 'fake_runtime_pre_effect_fence_rejected',
      commandCount: 1,
      activeRuns: [{ teamId: `team_${'a'.repeat(32)}`, runId: 'run_pre-effect-fence-0001' }],
      ledgerState: 'started',
      launchAfterImport: {
        error: 'fake_runtime_launch_deadline_expired_after_import',
        fenceChecks: 3,
        commandCount: 0,
        eventCount: 0,
        activeRuns: [],
        ledgerState: 'started',
      },
      postEffect: {
        error: 'fake_runtime_post_effect_fence_rejected',
        fenceChecks: 4,
        commandCount: 2,
        activeRuns: [],
        ledgerState: 'started',
        recovery: {
          kind: 'settled',
          replayed: true,
          commandCount: 2,
          ledgerState: 'settled',
        },
      },
    });
  });

  it('freezes a legacy task placement when updating status without dropping extension data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-status-placement-'));
    roots.push(root);
    const claudeRoot = join(root, 'claude');
    const stateRoot = join(root, 'state');
    const taskDirectory = join(claudeRoot, 'tasks', E2E_TEAM_NAME);
    const teamDirectory = join(claudeRoot, 'teams', E2E_TEAM_NAME);
    await Promise.all([
      mkdir(taskDirectory, { recursive: true }),
      mkdir(teamDirectory, { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
    ]);
    const taskPath = join(taskDirectory, '1.json');
    const kanbanPath = join(teamDirectory, 'kanban-state.json');
    await writeFile(
      taskPath,
      `${JSON.stringify(
        {
          id: '1',
          subject: 'Legacy task',
          status: 'pending',
          blockedBy: [],
          blocks: [],
          related: [],
          extension: { preserved: true },
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      kanbanPath,
      `${JSON.stringify(
        {
          tasks: {
            archived: { column: 'review', extension: { preserved: true } },
          },
          version: 1,
          columnOrder: {
            todo: ['1'],
            in_progress: [],
            review: [],
            approved: [],
            done: [],
          },
          extension: { preserved: true },
        },
        null,
        2
      )}\n`
    );
    const runProof = (attempt: string) =>
      execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          'test/fixtures/hosted-v1/seedContainer.ts',
          'prove-update-status-placement',
          attempt,
        ],
        {
          ...boundedExecOptions,
          cwd: process.cwd(),
          env: {
            ...process.env,
            E2E_FAKE_RUNTIME_STATE_ROOT: stateRoot,
            E2E_SEED_CLAUDE_ROOT: claudeRoot,
          },
        }
      );

    const { stdout, stderr } = await runProof('initial');
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      result: { kind: 'committed' },
      task: { status: 'completed', extension: { preserved: true } },
      kanban: {
        tasks: {
          '1': { column: 'todo' },
          archived: { column: 'review', extension: { preserved: true } },
        },
        columnOrder: { todo: ['1'], done: [] },
        extension: { preserved: true },
      },
    });

    const stableFiles = await Promise.all([
      readFile(taskPath, 'utf8'),
      readFile(kanbanPath, 'utf8'),
      readFile(join(stateRoot, 'runtime-state.json'), 'utf8'),
    ]);
    const noop = await runProof('noop');
    expect(noop.stderr).toBe('');
    expect(JSON.parse(noop.stdout)).toMatchObject({
      result: { kind: 'conflict', reason: 'state_conflict' },
    });
    await expect(
      Promise.all([
        readFile(taskPath, 'utf8'),
        readFile(kanbanPath, 'utf8'),
        readFile(join(stateRoot, 'runtime-state.json'), 'utf8'),
      ])
    ).resolves.toEqual(stableFiles);
  });

  it('forward-recovers an interrupted task WAL on restart without weakening replay or mismatch state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-task-wal-restart-'));
    roots.push(root);
    const claudeRoot = join(root, 'claude');
    const stateRoot = join(root, 'state');
    const taskDirectory = join(claudeRoot, 'tasks', E2E_TEAM_NAME);
    const teamDirectory = join(claudeRoot, 'teams', E2E_TEAM_NAME);
    await Promise.all([
      mkdir(taskDirectory, { recursive: true }),
      mkdir(teamDirectory, { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
    ]);
    const taskPath = join(taskDirectory, '1.json');
    const kanbanPath = join(teamDirectory, 'kanban-state.json');
    const walPath = join(stateRoot, 'task-mutation.wal.json');
    const statePath = join(stateRoot, 'runtime-state.json');
    const sourceGeneration = `generation_${'1'.repeat(64)}`;
    const teamId = `team_${'a'.repeat(32)}`;
    const taskId = `task_${createHash('sha256')
      .update(JSON.stringify({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId: '1' }))
      .digest('hex')
      .slice(0, 32)}`;
    const preimageTaskText = `${JSON.stringify(
      {
        id: '1',
        subject: 'Recovered task',
        status: 'pending',
        owner: 'member_ffffffffffffffffffffffffffffffff',
        blockedBy: [],
        blocks: [],
        related: [],
      },
      null,
      2
    )}\n`;
    const taskText = preimageTaskText.replace('"status": "pending"', '"status": "completed"');
    const kanbanText = `${JSON.stringify(
      {
        tasks: { '1': { column: 'todo' } },
        version: 1,
        columnOrder: {
          todo: ['1'],
          in_progress: [],
          review: [],
          approved: [],
          done: [],
        },
      },
      null,
      2
    )}\n`;
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
    const rosterFiles = [
      ['config.json', null],
      ['members.meta.json', null],
    ] as const;
    const preimageRevision = `revision_${sha256(
      JSON.stringify({
        domain: 'hosted-task-board-revision/v3',
        sourceGeneration,
        taskFiles: [['1.json', sha256(preimageTaskText)]],
        kanban: sha256(kanbanText),
        roster: rosterFiles,
      })
    )}`;
    const command = {
      schemaVersion: 1,
      kind: 'update_status',
      commandId: 'command_interrupted_restart',
      teamId,
      idempotencyKey: 'idempotency_interrupted_restart',
      expectedSourceGeneration: sourceGeneration,
      expectedRevision: preimageRevision,
      taskId,
      status: 'completed',
    } as const;
    const fingerprint = fakeRuntimeTaskPayloadFingerprint(command);
    const key = [teamId, sourceGeneration, command.idempotencyKey].join('\u0000');
    const wal = {
      schemaVersion: 3,
      operation: 'task_mutate',
      key,
      fingerprint,
      commandId: command.commandId,
      teamId,
      sourceGeneration,
      command,
      timestamp: '2026-08-09T12:00:00.000Z',
      preimage: {
        taskFiles: [['1.json', preimageTaskText]],
        kanbanText,
        rosterFiles,
      },
      affectedTaskIds: [taskId],
      writes: [
        [taskPath, taskText],
        [kanbanPath, kanbanText],
      ],
    };
    await Promise.all([
      writeFile(taskPath, taskText),
      writeFile(kanbanPath, kanbanText),
      writeFile(walPath, `${JSON.stringify(wal, null, 2)}\n`),
      writeFile(
        statePath,
        `${JSON.stringify({
          schemaVersion: 1,
          activeRuns: [],
          commands: [],
          eventIds: [],
          messageLedger: [],
          taskLedger: [],
        })}\n`
      ),
    ]);
    const recover = () =>
      execFileAsync(
        process.execPath,
        ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'recover-task-wal'],
        {
          ...boundedExecOptions,
          cwd: process.cwd(),
          env: {
            ...process.env,
            E2E_FAKE_RUNTIME_STATE_ROOT: stateRoot,
            E2E_SEED_CLAUDE_ROOT: claudeRoot,
          },
        }
      );

    const substitutedMembershipPath = join(taskDirectory, 'attacker-extra.json');
    await writeFile(
      substitutedMembershipPath,
      `${JSON.stringify({ id: 'attacker-extra', subject: 'Injected task' })}\n`
    );
    await expect(recover()).rejects.toThrow('fake_runtime_task_wal_membership_raced');
    await rm(substitutedMembershipPath, { force: true });

    const thirdStateTaskText = taskText.replace('Recovered task', 'Unrelated third state');
    await writeFile(taskPath, thirdStateTaskText);
    await expect(recover()).rejects.toThrow('fake_runtime_task_wal_target_raced');
    await expect(readFile(taskPath, 'utf8')).resolves.toBe(thirdStateTaskText);
    await expect(readFile(kanbanPath, 'utf8')).resolves.toBe(kanbanText);
    await writeFile(taskPath, taskText);

    await expect(recover()).resolves.toMatchObject({ stderr: '' });
    await expect(readFile(kanbanPath, 'utf8')).resolves.toBe(kanbanText);
    await expect(readFile(walPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const recoveredState = JSON.parse(await readFile(statePath, 'utf8')) as {
      taskLedger: {
        key: string;
        fingerprint: string;
        receipt: Record<string, unknown>;
        wal: Record<string, unknown>;
      }[];
    };
    const expectedRevision = `revision_${sha256(
      JSON.stringify({
        domain: 'hosted-task-board-revision/v3',
        sourceGeneration,
        taskFiles: [['1.json', sha256(taskText)]],
        kanban: sha256(kanbanText),
        roster: [
          ['config.json', null],
          ['members.meta.json', null],
        ],
      })
    )}`;
    expect(recoveredState.taskLedger).toEqual([
      {
        key,
        fingerprint,
        receipt: {
          schemaVersion: 1,
          outcome: 'committed',
          commandId: wal.commandId,
          teamId: wal.teamId,
          sourceGeneration,
          revision: expectedRevision,
          affectedTaskIds: wal.affectedTaskIds,
        },
        wal,
      },
    ]);
    expect(JSON.parse(await readFile(taskPath, 'utf8'))).toMatchObject({
      owner: 'member_ffffffffffffffffffffffffffffffff',
    });

    await writeFile(walPath, `${JSON.stringify(wal, null, 2)}\n`);
    await expect(recover()).resolves.toMatchObject({ stderr: '' });
    const replayState = JSON.parse(await readFile(statePath, 'utf8')) as {
      taskLedger: unknown[];
    };
    expect(replayState.taskLedger).toHaveLength(1);
    await writeFile(
      walPath,
      `${JSON.stringify({ ...wal, fingerprint: '4'.repeat(64) }, null, 2)}\n`
    );
    await expect(recover()).rejects.toThrow('fake_runtime_task_wal_fingerprint_invalid');
    await expect(readFile(walPath, 'utf8')).resolves.toContain('"fingerprint"');

    await writeFile(
      walPath,
      `${JSON.stringify(
        {
          ...wal,
          preimage: {
            ...wal.preimage,
            taskFiles: [
              ['1.json', preimageTaskText.replace('Recovered task', 'Substituted preimage task')],
            ],
          },
        },
        null,
        2
      )}\n`
    );
    await expect(recover()).rejects.toThrow('fake_runtime_task_wal_preimage_revision_invalid');

    await writeFile(
      walPath,
      `${JSON.stringify({ ...wal, command: { ...command, ignoredExtra: true } }, null, 2)}\n`
    );
    await expect(recover()).rejects.toThrow('fake_runtime_task_wal_command_invalid');

    const tamperedTaskText = taskText.replace('Recovered task', 'Attacker postimage');
    await writeFile(
      walPath,
      `${JSON.stringify(
        {
          ...wal,
          writes: [
            [taskPath, tamperedTaskText],
            [kanbanPath, kanbanText],
          ],
        },
        null,
        2
      )}\n`
    );
    await expect(recover()).rejects.toThrow('fake_runtime_task_wal_postimage_invalid');
    await expect(readFile(taskPath, 'utf8')).resolves.toBe(taskText);

    const laterTaskText = taskText.replace('Recovered task', 'Later committed task');
    await Promise.all([
      writeFile(taskPath, laterTaskText),
      writeFile(walPath, `${JSON.stringify(wal, null, 2)}\n`),
    ]);
    await expect(recover()).rejects.toThrow('fake_runtime_task_wal_target_raced');
    await expect(readFile(taskPath, 'utf8')).resolves.toBe(laterTaskText);
  });

  it('recovers a message persist crash after the inbox rename without duplicating the operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-message-persist-'));
    roots.push(root);
    const runtimeStatePath = join(root, 'runtime-state.json');
    const inboxPath = join(root, 'inboxes', 'team-lead.json');
    const operation = {
      runtimeStatePath,
      inboxPath,
      actorId: 'actor_hosted-v1-message-persist',
      workspaceId: `workspace_${'b'.repeat(32)}`,
      teamId: `team_${'a'.repeat(32)}`,
      clientMessageId: `client_message_${'c'.repeat(32)}`,
      text: 'Crash-atomic hosted message',
      timestamp: '2026-08-09T00:00:00.000Z',
    } as const;

    await expect(
      persistFakeRuntimeInboxMessage({
        ...operation,
        afterInboxRename: () => {
          throw new Error('deterministic-failure-after-inbox-rename');
        },
      })
    ).rejects.toThrow('deterministic-failure-after-inbox-rename');

    const afterCrash = JSON.parse(await readFile(inboxPath, 'utf8')) as unknown[];
    expect(afterCrash).toHaveLength(1);
    await expect(readFile(runtimeStatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // A fresh helper call models the restarted fake runtime: only durable files survive.
    const replay = await persistFakeRuntimeInboxMessage(operation);
    expect(replay.kind).toBe('idempotent_replay');
    if (replay.kind === 'conflict') throw new Error('unexpected conflict');
    const inboxAfterRestartReplayBytes = await readFile(inboxPath, 'utf8');
    const stateAfterRestartReplayBytes = await readFile(runtimeStatePath, 'utf8');
    const secondReplay = await persistFakeRuntimeInboxMessage(operation);
    expect(secondReplay).toEqual(replay);
    expect(await readFile(inboxPath, 'utf8')).toBe(inboxAfterRestartReplayBytes);
    expect(await readFile(runtimeStatePath, 'utf8')).toBe(stateAfterRestartReplayBytes);
    expect(JSON.parse(inboxAfterRestartReplayBytes)).toHaveLength(1);

    await expect(
      persistFakeRuntimeInboxMessage({ ...operation, text: 'Changed hosted message' })
    ).resolves.toEqual({ kind: 'conflict' });
    expect(await readFile(inboxPath, 'utf8')).toBe(inboxAfterRestartReplayBytes);
    expect(await readFile(runtimeStatePath, 'utf8')).toBe(stateAfterRestartReplayBytes);
    const state = JSON.parse(stateAfterRestartReplayBytes) as {
      messageLedger: unknown[];
    };
    expect(state.messageLedger).toHaveLength(1);
  });

  it('serializes concurrent message appends and replays the exact two durable rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-message-concurrent-append-'));
    roots.push(root);
    const queue = createFakeRuntimeStateMutationQueue();
    const common = {
      runtimeStatePath: join(root, 'runtime-state.json'),
      inboxPath: join(root, 'inboxes', 'team-lead.json'),
      actorId: 'actor_hosted-v1-message-concurrent',
      workspaceId: `workspace_${'b'.repeat(32)}`,
      teamId: `team_${'a'.repeat(32)}`,
      timestamp: '2026-08-09T00:00:00.000Z',
    } as const;
    const first = {
      ...common,
      clientMessageId: `client_message_${'1'.repeat(32)}`,
      text: 'First concurrent message',
    } as const;
    const second = {
      ...common,
      clientMessageId: `client_message_${'2'.repeat(32)}`,
      text: 'Second concurrent message',
    } as const;
    let signalFirstRead: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
      signalFirstRead = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstCommit = queue.run(() =>
      persistFakeRuntimeInboxMessage({
        ...first,
        afterInboxRead: async () => {
          signalFirstRead?.();
          await firstReleased;
        },
      })
    );
    await firstRead;
    const secondCommit = queue.run(() => persistFakeRuntimeInboxMessage(second));
    releaseFirst?.();
    await expect(Promise.all([firstCommit, secondCommit])).resolves.toMatchObject([
      { kind: 'persisted' },
      { kind: 'persisted' },
    ]);
    await expect(
      Promise.all([
        queue.run(() => persistFakeRuntimeInboxMessage(first)),
        queue.run(() => persistFakeRuntimeInboxMessage(second)),
      ])
    ).resolves.toMatchObject([{ kind: 'idempotent_replay' }, { kind: 'idempotent_replay' }]);
    const rows = JSON.parse(await readFile(common.inboxPath, 'utf8')) as Record<string, unknown>[];
    expect(rows.map((row) => row.text)).toEqual([first.text, second.text]);
    expect(new Set(rows.map((row) => row.messageId)).size).toBe(2);
    const state = JSON.parse(await readFile(common.runtimeStatePath, 'utf8')) as {
      messageLedger: { clientMessageId: string }[];
    };
    expect(state.messageLedger.map((entry) => entry.clientMessageId)).toEqual([
      first.clientMessageId,
      second.clientMessageId,
    ]);
  });

  it('fails closed when an inbox row changes during message ledger reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-message-ledger-race-'));
    roots.push(root);
    const operation = {
      runtimeStatePath: join(root, 'runtime-state.json'),
      inboxPath: join(root, 'inboxes', 'team-lead.json'),
      actorId: 'actor_hosted-v1-message-ledger-race',
      workspaceId: `workspace_${'b'.repeat(32)}`,
      teamId: `team_${'a'.repeat(32)}`,
      clientMessageId: `client_message_${'a'.repeat(32)}`,
      text: 'Do not acknowledge a substituted durable row',
      timestamp: '2026-08-09T00:00:00.000Z',
    } as const;

    await expect(
      persistFakeRuntimeInboxMessage({
        ...operation,
        afterLedgerWrite: () => writeFile(operation.inboxPath, '[]\n'),
      })
    ).rejects.toThrow('hosted_e2e_fake_runtime_inbox_raced');
    await expect(persistFakeRuntimeInboxMessage(operation)).rejects.toThrow(
      'hosted_e2e_fake_runtime_message_ledger_orphaned'
    );
    expect(JSON.parse(await readFile(operation.inboxPath, 'utf8'))).toEqual([]);
    const state = JSON.parse(await readFile(operation.runtimeStatePath, 'utf8')) as {
      messageLedger: unknown[];
    };
    expect(state.messageLedger).toHaveLength(1);
  });

  it('rejects a tampered durable message row instead of trusting its replay marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-message-marker-tamper-'));
    roots.push(root);
    const operation = {
      runtimeStatePath: join(root, 'runtime-state.json'),
      inboxPath: join(root, 'inboxes', 'team-lead.json'),
      actorId: 'actor_hosted-v1-message-marker-tamper',
      workspaceId: `workspace_${'b'.repeat(32)}`,
      teamId: `team_${'a'.repeat(32)}`,
      clientMessageId: `client_message_${'e'.repeat(32)}`,
      text: 'Original durable hosted message',
      timestamp: '2026-08-09T00:00:00.000Z',
    } as const;
    await expect(
      persistFakeRuntimeInboxMessage({
        ...operation,
        afterInboxRename: () => {
          throw new Error('crash-before-message-ledger');
        },
      })
    ).rejects.toThrow('crash-before-message-ledger');
    const rows = JSON.parse(await readFile(operation.inboxPath, 'utf8')) as Record<
      string,
      unknown
    >[];
    const tamper = [
      (row: Record<string, unknown>) => {
        row.text = 'Substituted durable hosted message';
      },
      (row: Record<string, unknown>) => {
        row.from = 'attacker';
      },
      (row: Record<string, unknown>) => {
        row.source = 'attacker_sent';
      },
      (row: Record<string, unknown>) => {
        row.timestamp = 'not-an-iso-timestamp';
      },
      (row: Record<string, unknown>) => {
        row.untrustedExtension = true;
      },
    ];
    for (const mutate of tamper) {
      const candidate = structuredClone(rows);
      mutate(candidate[0]!);
      await writeFile(operation.inboxPath, `${JSON.stringify(candidate, null, 2)}\n`);
      await expect(persistFakeRuntimeInboxMessage(operation)).rejects.toThrow(
        'hosted_e2e_fake_runtime_operation_marker_invalid'
      );
      await expect(readFile(operation.runtimeStatePath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('reports delivery only after a durable recipient acknowledgement and repairs it on replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-message-delivery-'));
    roots.push(root);
    const operation = {
      runtimeStatePath: join(root, 'runtime-state.json'),
      inboxPath: join(root, 'inboxes', 'team-lead.json'),
      actorId: 'actor_hosted-v1-message-delivery',
      workspaceId: `workspace_${'b'.repeat(32)}`,
      teamId: `team_${'a'.repeat(32)}`,
      clientMessageId: `client_message_${'d'.repeat(32)}`,
      text: 'Crash-atomic hosted delivery',
    } as const;
    const persistence = await persistFakeRuntimeInboxMessage(operation);
    if (persistence.kind === 'conflict') throw new Error('unexpected conflict');
    const projectedMessageId = projectHostedInboxMessageId({
      teamId: parseTeamId(operation.teamId),
      rawMessageId: persistence.entry.messageId,
      from: 'user',
      to: 'team-lead',
    });
    expect(
      fakeRuntimeProjectedMessageId({
        teamId: operation.teamId,
        rawMessageId: persistence.entry.messageId,
        from: 'user',
        to: 'team-lead',
      })
    ).toBe(projectedMessageId);
    const delivery = {
      ...operation,
      messageId: projectedMessageId,
    };

    await expect(
      deliverFakeRuntimeInboxMessage({
        ...delivery,
        afterInboxRename: () => {
          throw new Error('deterministic-failure-after-delivery-ack');
        },
      })
    ).rejects.toThrow('deterministic-failure-after-delivery-ack');
    const afterCrash = JSON.parse(await readFile(operation.inboxPath, 'utf8')) as {
      hostedDelivery?: unknown;
    }[];
    expect(afterCrash).toHaveLength(1);
    expect(afterCrash[0]?.hostedDelivery).toMatchObject({
      recipient: 'team-lead',
      acknowledgement: 'durable',
      messageId: persistence.entry.messageId,
    });
    const beforeReplay = JSON.parse(await readFile(operation.runtimeStatePath, 'utf8')) as {
      messageLedger: { delivered: boolean }[];
    };
    expect(beforeReplay.messageLedger).toEqual([expect.objectContaining({ delivered: false })]);
    const durableInboxBytes = await readFile(operation.inboxPath, 'utf8');

    await expect(deliverFakeRuntimeInboxMessage(delivery)).resolves.toBe('delivered');
    expect(await readFile(operation.inboxPath, 'utf8')).toBe(durableInboxBytes);
    const deliveredStateBytes = await readFile(operation.runtimeStatePath, 'utf8');
    await expect(deliverFakeRuntimeInboxMessage(delivery)).resolves.toBe('delivered');
    expect(await readFile(operation.inboxPath, 'utf8')).toBe(durableInboxBytes);
    expect(await readFile(operation.runtimeStatePath, 'utf8')).toBe(deliveredStateBytes);
    const afterReplay = JSON.parse(await readFile(operation.runtimeStatePath, 'utf8')) as {
      messageLedger: { delivered: boolean }[];
    };
    expect(afterReplay.messageLedger).toEqual([expect.objectContaining({ delivered: true })]);
    expect(JSON.parse(await readFile(operation.inboxPath, 'utf8'))).toHaveLength(1);
  });

  it('does not repair a delivery row removed after its delivered ledger fsync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-message-delivery-ledger-race-'));
    roots.push(root);
    const operation = {
      runtimeStatePath: join(root, 'runtime-state.json'),
      inboxPath: join(root, 'inboxes', 'team-lead.json'),
      actorId: 'actor_hosted-v1-message-delivery-ledger-race',
      workspaceId: `workspace_${'b'.repeat(32)}`,
      teamId: `team_${'a'.repeat(32)}`,
      clientMessageId: `client_message_${'b'.repeat(32)}`,
      text: 'Delivery ledger final fence',
      timestamp: '2026-08-09T00:00:00.000Z',
    } as const;
    const persistence = await persistFakeRuntimeInboxMessage(operation);
    if (persistence.kind === 'conflict') throw new Error('unexpected conflict');
    const persistedInbox = await readFile(operation.inboxPath, 'utf8');
    const delivery = {
      ...operation,
      messageId: fakeRuntimeProjectedMessageId({
        teamId: operation.teamId,
        rawMessageId: persistence.entry.messageId,
        from: 'user',
        to: 'team-lead',
      }),
    };
    await expect(
      deliverFakeRuntimeInboxMessage({
        ...delivery,
        afterLedgerWrite: () => writeFile(operation.inboxPath, persistedInbox),
      })
    ).rejects.toThrow('hosted_e2e_fake_runtime_inbox_raced');
    await expect(deliverFakeRuntimeInboxMessage(delivery)).resolves.toBe('operator_required');
    expect(await readFile(operation.inboxPath, 'utf8')).toBe(persistedInbox);
  });

  it('runs a valid message mutation after malformed input and I/O failures', async () => {
    const queue = createFakeRuntimeStateMutationQueue();
    await expect(
      queue.run(async () => JSON.parse('{malformed-message-operation'))
    ).rejects.toThrow();
    await expect(
      queue.run(() => Promise.reject(new Error('deterministic-message-io-failure')))
    ).rejects.toThrow('deterministic-message-io-failure');
    await expect(queue.run(() => Promise.resolve('valid-operation-ran'))).resolves.toBe(
      'valid-operation-ran'
    );
  });

  it('uses the production image and the CI-preinstalled browser without a divergent app build', async () => {
    const [compose, runner, spec, seed, workflow] = await Promise.all([
      readFile('docker/docker-compose.e2e.yml', 'utf8'),
      readFile('scripts/e2e/hosted-v1/run.ts', 'utf8'),
      readFile('test/e2e/hosted-v1/hosted-v1.spec.ts', 'utf8'),
      readFile('test/fixtures/hosted-v1/seedContainer.ts', 'utf8'),
      readFile('.github/workflows/ci.yml', 'utf8'),
    ]);
    const securitySpec = await readFile('test/e2e/hosted-v1/phase-6-security.spec.ts', 'utf8');
    expect(compose).toContain('dockerfile: docker/Dockerfile');
    expect(compose).not.toContain('docker/e2e/Dockerfile');
    expect(compose).toContain('COMPOSE_PROJECT_NAME');
    expect(compose).toContain('E2E_APP_IMAGE');
    expect(compose).toContain('HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET');
    expect(compose.match(/HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE/gu)).toHaveLength(2);
    expect(compose).not.toMatch(/HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR:/u);
    expect(compose.match(/HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE/gu)).toHaveLength(2);
    expect(compose.match(/HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE/gu)).toHaveLength(2);
    expect(compose).toContain('E2E_LIFECYCLE_LAUNCHER_DIR');
    expect(compose.match(/\/run\/agent-teams-lifecycle-launcher:ro/gu)).toHaveLength(1);
    expect(compose).toContain('E2E_LIFECYCLE_RUN_DIR');
    expect(compose).toContain(
      'E2E_FAKE_RUNTIME_STATE_DIR:?Set marker-owned fake runtime state}/auth-drain:/run/agent-teams-auth-drain:ro'
    );
    expect(compose).toContain(
      'E2E_FAKE_RUNTIME_STATE_DIR:?Set marker-owned fake runtime state}/auth-drain:/run/agent-teams-auth-drain'
    );
    expect(compose).toContain(
      'AUTH_DRAIN_EVIDENCE_FILE: /run/agent-teams-auth-drain/drain-proof.json'
    );
    expect(seed).toContain(
      'const AUTH_DRAIN_SOCKET_PATH = `${AUTH_DRAIN_ROOT}/auth-drain.sock`;'
    );
    expect(seed).not.toContain(
      'const AUTH_DRAIN_SOCKET_PATH = `${LIFECYCLE_RUN_ROOT}/auth-drain.sock`;'
    );
    expect(securitySpec).toContain(
      "createConnection('/run/agent-teams-auth-drain/auth-drain.sock')"
    );
    expect(securitySpec).not.toContain(
      "createConnection('/run/agent-teams-orchestrator/auth-drain.sock')"
    );
    expect(compose).toContain('E2E_LIFECYCLE_TRUST_DIR');
    expect(compose).toContain('agent-teams-lifecycle-trust-init:');
    expect(compose).toContain(
      "command: ['/usr/local/bin/hosted-volume-init', 'lifecycle-trust-anchor']"
    );
    expect(compose).toContain('condition: service_completed_successfully');
    expect(
      compose.match(/agent-teams-lifecycle-trust:\/run\/agent-teams-lifecycle-trust:ro/gu)
    ).toHaveLength(2);
    expect(compose).not.toMatch(
      /E2E_LIFECYCLE_TRUST_DIR[^\n]*:\/run\/agent-teams-lifecycle-trust/u
    );
    expect(compose).toContain('lifecycle_orchestrator_trust_anchor:');
    expect(compose).toContain('lifecycle_owner_release_pin:');
    expect(compose).toContain('E2E_LIFECYCLE_HIGH_WATER_DIR');
    expect(compose).toContain('/run/agent-teams-orchestrator/orchestrator-lifecycle.sock');
    const parsedCompose = YAML.parse(compose) as {
      services: {
        caddy: { ports: unknown };
        'hosted-controller': { volumes: string[] };
        'fake-runtime': { command: string[]; volumes: string[] };
        'synthetic-oidc': { command: string[]; volumes: string[] };
      };
    };
    const parsedHostedVolumes = parsedCompose.services['hosted-controller'].volumes;
    const parsedOwnerVolumes = parsedCompose.services['fake-runtime'].volumes;
    expect(parsedHostedVolumes).toContain(
      '${E2E_FAKE_RUNTIME_STATE_DIR:?Set marker-owned fake runtime state}/auth-drain:/run/agent-teams-auth-drain:ro'
    );
    expect(parsedHostedVolumes).not.toContain(
      '${E2E_FAKE_RUNTIME_STATE_DIR:?Set marker-owned fake runtime state}/auth-drain:/run/agent-teams-auth-drain'
    );
    expect(parsedOwnerVolumes).toContain(
      '${E2E_FAKE_RUNTIME_STATE_DIR:?Set marker-owned fake runtime state}/auth-drain:/run/agent-teams-auth-drain'
    );
    expect(parsedCompose.services.caddy.ports).toEqual([
      {
        host_ip: '127.0.0.1',
        protocol: 'tcp',
        published: '${E2E_CADDY_PUBLISHED_PORT:?Set the marker-derived Caddy host port}',
        target: 443,
      },
    ]);
    expect(parsedCompose.services['fake-runtime'].command).toEqual([
      '--experimental-strip-types',
      '/app/e2e/seedContainer.ts',
      'fake-runtime',
    ]);
    expect(parsedCompose.services['synthetic-oidc'].command).toEqual([
      '--experimental-strip-types',
      '/app/e2e/seedContainer.ts',
      'oidc-provider',
    ]);
    for (const service of ['fake-runtime', 'synthetic-oidc'] as const) {
      expect(parsedCompose.services[service].volumes).toContain(
        './../test/fixtures/hosted-v1/seedContainer.ts:/app/e2e/seedContainer.ts:ro'
      );
    }
    expect(runner).not.toMatch(/playwright["', ]+install/u);
    expect(runner).toContain('PLAYWRIGHT_BROWSERS_PATH');
    expect(runner).toContain('COMPOSE_FILE: composeFile');
    expect(spec).toContain('composeFile !== runtime.composeFile');
    expect(spec).toContain('composeProject !== runtime.composeProject');
    expect(spec).toContain('runtimeState.activeRuns).toEqual([])');
    expect(spec).toContain("'launch',\n    'recover',\n    'stop',\n  ]);");
    expect(spec).toContain("lifecycleCommand('recover', 4, finalStopRevision)");
    expect(spec).toContain(
      "status: 409,\n    body: {\n      schemaVersion: 1,\n      kind: 'operator_required',\n      action: 'recover',"
    );
    expect(seed).not.toContain('event_hosted-v1-e2e-seeded');
    expect(seed).toMatch(
      /const respond = \(responsePayload: unknown, resourceRevision: unknown\): void => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*assertLifecycleEffectFence\(operationOwnerBinding, context, authority\);/u
    );
    const serveFakeRuntime = seed.slice(seed.indexOf('async function serveFakeRuntime'));
    expect(serveFakeRuntime.indexOf('fakeRuntimeBootstrapMountGeneration(')).toBeGreaterThanOrEqual(
      0
    );
    expect(serveFakeRuntime.indexOf('fakeRuntimeBootstrapMountGeneration(')).toBeLessThan(
      serveFakeRuntime.indexOf('await rm(socketPath')
    );
    expect(serveFakeRuntime.indexOf('fakeRuntimeBootstrapMountGeneration(')).toBeLessThan(
      serveFakeRuntime.indexOf('await reserveFakeRuntimeOwnerGeneration(bootId)')
    );
    expect(workflow).toContain('hosted-v1-e2e:');
    const hostedWorkflow = workflow.slice(
      workflow.indexOf('  hosted-v1-e2e:'),
      workflow.indexOf('\n  lint:')
    );
    expect(hostedWorkflow.indexOf('Install dependencies')).toBeLessThan(
      hostedWorkflow.indexOf('Rebuild test SQLite native module for Node')
    );
    expect(hostedWorkflow.indexOf('Rebuild test SQLite native module for Node')).toBeLessThan(
      hostedWorkflow.indexOf('Cache Chromium')
    );
    expect(workflow).toContain('Install Chromium once');
    expect(workflow).toContain(
      'sudo --preserve-env=CI,PATH,CADDY_IMAGE_DIGEST,HOSTED_E2E_ARTIFACT_DIR,HOSTED_E2E_SUITE,KEYCLOAK_IMAGE_DIGEST,NODE_IMAGE_DIGEST,PLAYWRIGHT_BROWSERS_PATH'
    );
    expect(workflow).toContain('"$(command -v pnpm)" test:hosted:e2e');
    expect(workflow.match(/'docker\/\*\*'/gu)).toHaveLength(2);
    expect(runner).toContain('await chown(canonical, artifactOwner.uid, artifactOwner.gid)');
    expect(runner).toContain('await chmod(canonical, 0o700)');
    expect(runner).toContain("join(input.appDataDir, 'data', 'storage', 'app.db')");
    expect(runner).not.toContain("join(input.appDataDir, 'storage', 'app.db')");
    expect(runner).toContain("await import('better-sqlite3-node')");
    expect(runner).not.toContain("await import('better-sqlite3')");
    expect(runner).toContain("'controller.log'");
    expect(runner).toContain("'project-scanner.json'");
    expect(runner).toContain("'project-grant.json'");
    expect(spec).toContain('projectCount: projectValues.length');
    expect(spec).toContain('projectValues[0]?.id === runtime.projectWorkspaceId');
    expect(spec).toContain("projectValues[0]?.name === 'sandbox'");
    expect(spec).not.toContain('projectIds:');
    expect(spec.match(/process\.kill\(controllerPid, 'SIGTERM'\)/gu)).toHaveLength(1);
    expect(spec).toContain("'personal-controller-shutdown.json'");
    expect(spec).toContain("toMatchObject({ Error: '', ExitCode: 0, OOMKilled: false })");
    expect(spec).toContain("docker('inspect', '--format', '{{json .State}}', controllerId)");
    expect(spec).not.toContain("join(runtime.runDir, 'drain-proof.json')");
  });

  it('rejects a non-sandbox root before changing it', async () => {
    const outsideBase = process.platform === 'win32' ? dirname(tmpdir()) : '/var/tmp';
    const outsideRoot = await mkdtemp(join(outsideBase, 'hosted-v1-outside-temp-'));
    try {
      await expect(createHostedV1Sandbox(outsideRoot)).rejects.toThrow(
        'hosted_e2e_root_outside_temp'
      );
      expect(await readdir(outsideRoot)).toEqual([]);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each(['022', '077'])('keeps fixture directories private under umask %s', async (mask) => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-private-custody-'));
    try {
      // Only the isolated child changes umask; Vitest's process-wide state stays untouched.
      await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
            import { createHostedV1Sandbox } from './test/fixtures/hosted-v1/createSandbox.ts';
            process.umask(Number.parseInt(process.argv[2], 8));
            await createHostedV1Sandbox(process.argv[1]);
          `,
          root,
          mask,
        ],
        { ...boundedExecOptions, cwd: process.cwd() }
      );
      for (const path of [join(root, 'claude'), join(root, 'claude', 'teams')]) {
        const stat = await lstat(path);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.mode & 0o7777).toBe(0o700);
      }
    } finally {
      const markerPath = join(root, '.agent-teams-hosted-v1-e2e-owner.json');
      const { marker } = JSON.parse(await readFile(markerPath, 'utf8')) as { marker: string };
      await assertHostedV1MarkerOwnedRoot(root, markerPath, marker);
      await rm(root, { recursive: true });
    }
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 40_000);

  it('creates only fresh marker-owned state and a committed sandbox repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-harness-test-'));
    roots.push(root);

    const sandbox = await createHostedV1Sandbox(root);
    const marker = JSON.parse(await readFile(sandbox.markerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(marker).toMatchObject({ schemaVersion: 1, purpose: 'hosted-v1-browser-e2e' });
    expect(marker.marker).toMatch(/^[0-9a-f]{48}$/);
    expect(sandbox.marker).toBe(marker.marker);
    expect(sandbox.lifecycleTrustAnchor).toMatch(/^[0-9a-f]{64}$/);
    await expect(lstat(sandbox.lifecycleTrustDir).then((stat) => stat.mode & 0o777)).resolves.toBe(
      0o700
    );
    await expect(
      lstat(join(sandbox.lifecycleTrustDir, 'trust-anchor')).then((stat) => stat.mode & 0o777)
    ).resolves.toBe(0o400);
    await expect(
      lstat(join(sandbox.lifecycleTrustDir, 'release-owner-pin.json')).then(
        (stat) => stat.mode & 0o777
      )
    ).resolves.toBe(0o400);
    await expect(
      readFile(join(sandbox.lifecycleTrustDir, 'release-owner-pin.json'), 'utf8')
    ).resolves.toMatch(/^\{"format":"agent-teams\.hosted-lifecycle-owner-release-pin\/v2"/u);
    await expect(
      lstat(sandbox.lifecycleLauncherDir).then((stat) => stat.mode & 0o777)
    ).resolves.toBe(0o700);
    await expect(
      lstat(join(sandbox.lifecycleLauncherDir, 'owner-admission-private-key.pem')).then(
        (stat) => stat.mode & 0o777
      )
    ).resolves.toBe(0o400);
    await expect(
      assertHostedV1MarkerOwnedRoot(sandbox.root, sandbox.markerPath, sandbox.marker)
    ).resolves.toBeUndefined();
    await expect(
      assertHostedV1MarkerOwnedRoot(sandbox.root, sandbox.markerPath, '0'.repeat(48))
    ).rejects.toThrow('hosted_e2e_cleanup_marker_invalid');
    await expect(readFile(join(sandbox.workspaceDir, 'README.md'), 'utf8')).resolves.toContain(
      'Marker-owned'
    );
    await expect(
      readFile(join(sandbox.claudeDir, 'tasks', E2E_TEAM_NAME, '1.json'), 'utf8')
    ).resolves.toContain('Marker-owned browser E2E task');
    await expect(
      lstat(join(sandbox.claudeDir, 'tasks', E2E_TEAM_NAME)).then((stat) =>
        stat.isDirectory()
      )
    ).resolves.toBe(true);
    await expect(
      lstat(join(sandbox.appDataDir, 'logs')).then((stat) => stat.isDirectory())
    ).resolves.toBe(true);
    await expect(
      lstat(join(sandbox.oidcAppDataDir, 'logs')).then((stat) => stat.isDirectory())
    ).resolves.toBe(true);
    await expect(lstat(sandbox.caddyDataDir).then((stat) => stat.isDirectory())).resolves.toBe(
      true
    );
    await expect(
      execFileAsync('git', ['status', '--porcelain=v1'], {
        ...boundedExecOptions,
        cwd: sandbox.workspaceDir,
      })
    ).resolves.toMatchObject({ stdout: '' });

    const bootstrap = JSON.parse(sandbox.bootstrap) as Record<string, unknown>;
    expect(JSON.stringify(bootstrap)).not.toContain(root);
    expect(bootstrap).toMatchObject({
      workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
      runtimeInstance: {
        claudeRoot: { reference: '/data/.claude' },
        appDataRoot: { reference: '/data/.agent-teams' },
        workspaceRoots: [{ reference: '/workspaces/sandbox' }],
      },
    });
    expect(E2E_RUNTIME_WORKSPACE_ID).toBe('-workspaces-sandbox');
    expect(E2E_TEAM_RUNTIME_WORKSPACE_ID).not.toBe(E2E_WORKSPACE_ID);
  });

  it('allocates Personal, OIDC owner, and viewer independent mutable roots, projects, and ports', async () => {
    const authModes = ['personal', 'oidc', 'oidc-viewer'] as const;
    const sandboxes = await Promise.all(
      authModes.map(async (authMode) => {
        const root = await mkdtemp(join(tmpdir(), `hosted-v1-${authMode}-isolation-`));
        roots.push(root);
        return createHostedV1Sandbox(root);
      })
    );
    const ports = allocateHostedV1CaddyPublishedPorts(sandboxes.map((sandbox) => sandbox.marker));
    const scenarios = authModes.map((authMode, index) => ({
      authMode,
      sandbox: sandboxes[index]!,
      composeProject: `at-hosted-v1-${sandboxes[index]!.marker.slice(0, 24)}`,
      caddyPublishedPort: ports[index]!,
    }));

    expect(() => assertHostedV1ScenarioIsolation(scenarios)).not.toThrow();
    for (const key of [
      'root',
      'appDataDir',
      'oidcAppDataDir',
      'claudeDir',
      'fakeRuntimeStateDir',
      'caddyDataDir',
      'lifecycleHighWaterDir',
      'lifecycleLauncherDir',
      'lifecycleRunDir',
      'lifecycleTrustDir',
      'runDir',
      'workspaceDir',
      'lifecycleTrustAnchor',
    ] as const) {
      expect(new Set(sandboxes.map((sandbox) => sandbox[key])).size).toBe(authModes.length);
    }
    expect(new Set(scenarios.map(({ composeProject }) => composeProject)).size).toBe(
      authModes.length
    );
    expect(new Set(ports).size).toBe(authModes.length);
  });

  it.each(['oidc', 'oidc-viewer'] as const)(
    'removes a marker-owned %s scenario root when sandbox construction fails',
    async (authMode) => {
      const root = await mkdtemp(join(tmpdir(), `hosted-v1-${authMode}-construction-failure-`));
      await expect(
        createMarkerOwnedHostedV1ScenarioSandbox(root, async (candidateRoot) => {
          await createHostedV1Sandbox(candidateRoot);
          throw new Error(`injected_${authMode}_sandbox_construction_failure`);
        })
      ).rejects.toThrow(`injected_${authMode}_sandbox_construction_failure`);
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('continues marker-owned sandbox cleanup after failures without deleting unproved roots', async () => {
    const sandboxes = await Promise.all(
      ['unproved', 'remove-failure', 'retained', 'removable'].map(async (label) => {
        const scenarioRoot = await mkdtemp(join(tmpdir(), `hosted-v1-cleanup-${label}-`));
        return createHostedV1Sandbox(scenarioRoot);
      })
    );
    const [unproved, removeFailureSandbox, retained, removable] = sandboxes;
    if (!unproved || !removeFailureSandbox || !retained || !removable) {
      throw new Error('cleanup test sandbox missing');
    }
    const proofFailure = new Error('marker proof failed');
    const removalFailure = new Error('root removal failed');
    const attemptedRemovals: string[] = [];
    const assertMarkerOwned = vi.fn(async (candidate: (typeof sandboxes)[number]) => {
      if (candidate.root === unproved.root) throw proofFailure;
      await assertHostedV1MarkerOwnedRoot(candidate.root, candidate.markerPath, candidate.marker);
    });

    try {
      const result = await cleanupHostedV1SandboxRoots({
        sandboxes,
        retainedRoots: new Set([retained.root]),
        assertMarkerOwned,
        removeRoot: async (candidateRoot) => {
          attemptedRemovals.push(candidateRoot);
          if (candidateRoot === removeFailureSandbox.root) throw removalFailure;
          await rm(candidateRoot, { recursive: true });
        },
      });

      expect(result.cleanupError?.errors).toEqual([proofFailure, removalFailure]);
      expect(result.removedMarkers).toEqual([removable.marker]);
      expect(result.retainedMarkers).toEqual([
        unproved.marker,
        removeFailureSandbox.marker,
        retained.marker,
      ]);
      expect(attemptedRemovals).toEqual([removeFailureSandbox.root, removable.root]);
      expect(assertMarkerOwned).not.toHaveBeenCalledWith(retained);
      await expect(lstat(removable.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(unproved.root)).resolves.toBeDefined();
      await expect(lstat(removeFailureSandbox.root)).resolves.toBeDefined();
      await expect(lstat(retained.root)).resolves.toBeDefined();
    } finally {
      await Promise.all(
        [unproved, removeFailureSandbox, retained].map((candidate) =>
          rm(candidate.root, { recursive: true, force: true })
        )
      );
    }
  });

  it('seeds exact personal and OIDC principal grants for the admitted runtime workspace', () => {
    const issuer = 'https://oidc-v1-e2e.localhost:54321';

    for (const authMode of ['personal', 'oidc'] as const) {
      const plan = hostedWorkspaceAccessSeedPlan(authMode, issuer);
      expect(plan.workspaces).toContainEqual(
        expect.objectContaining({
          runtimeWorkspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
          publicWorkspaceId: E2E_WORKSPACE_ID,
          displayName: 'Hosted v1 E2E sandbox',
          grantRevision: expect.stringMatching(/^[0-9a-f]{64}$/u),
        })
      );
      expect(plan.issuer).toBe(authMode === 'oidc' ? issuer : null);
      expect(plan.userId).toMatch(/^user_[0-9a-f]{32}$/);
    }
  });

  it('seeds a frozen published plan that the Product run writer can resolve', () => {
    const database = new Database(':memory:');
    try {
      runInternalStorageMigrations(database);
      const userId = `user_${'1'.repeat(32)}`;
      const fingerprint = 'ab'.repeat(32);
      const identityChecksum = 'cd'.repeat(32);
      seedProductTeamIdentity(new TeamIdentityStorageOps(() => database), {
        directoryFingerprint: fingerprint,
        identityChecksum,
      });
      seedFrozenLifecyclePromotion(database, {
        userId,
        directoryFingerprint: fingerprint,
        freezePromotion: (binding) =>
          new HostedPromotionStorageOps(
            () => database,
            Date.now,
            () => ({ retainForCommit: () => ({ release() {} }) })
          ).begin(binding),
      });
      const actorId = new NodeHostedQueryContextIdentity().projectActorId(userId as never);
      const generation = new HostedLifecycleRunReservationOps(
        () => database,
        Date.now,
        () => undefined
      ).currentPlanGeneration({
        workspaceId: E2E_WORKSPACE_ID,
        teamId: `team_${'a'.repeat(32)}`,
        actorId,
        deploymentId: 'deployment_hosted-v1-e2e',
      });
      expect(generation).toMatch(/^plan-generation_[a-f0-9]{64}$/u);
      const reserved = new HostedLifecycleRunReservationOps(
        () => database,
        Date.now,
        () => ({ retainForCommit: () => ({ release() {} }) })
      ).reserve({
        schemaVersion: 1,
        workspaceId: E2E_WORKSPACE_ID,
        runtimeWorkspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
        teamId: `team_${'a'.repeat(32)}`,
        actorId,
        deploymentId: 'deployment_hosted-v1-e2e',
        bootId: `boot_${'1'.repeat(32)}`,
        commandId: 'lifecycle-command_seed-run-test',
        idempotencyKey: 'idempotency_seed-run-test',
        expectedRevision: `revision_${'2'.repeat(64)}`,
        expectedPlanGeneration: generation!,
        ownerAuthority: 'owner-authority_seed-run-test',
        ownerGeneration: 1,
        ownerSessionId: 'owner-session_seed-run-test',
        restoreGeneration: 0,
        mountGeneration: 1,
        ownerEffectFence: { grantRevision: 'ef'.repeat(32), identityChecksum },
        authorityEvidence: { userId, sessionId: 'session_seed-run-test', grantGeneration: 0 },
        deadlineAtMs: Number.MAX_SAFE_INTEGER,
      });
      expect(reserved.kind).toBe('reserved');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM hosted_promotion_roster_bindings').get()
      ).toEqual({ count: 1 });
      expect(
        database.prepare(`SELECT state, directory_fingerprint AS fingerprint
          FROM hosted_team_configuration_publications WHERE team_id = ?`).get(`team_${'a'.repeat(32)}`)
      ).toEqual({ state: 'published', fingerprint });
    } finally {
      database.close();
    }
  });

  it('keeps the launch event write lock after its authority read closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-launch-lock-test-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'seed'],
      {
        ...boundedExecOptions,
        env: {
          ...process.env,
          E2E_SEED_APP_DATA_ROOT: sandbox.appDataDir,
          E2E_SEED_AUTH_MODE: 'personal',
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
          E2E_SEED_MARKER_PATH: sandbox.markerPath,
        },
      }
    );

    const { default: Database } = await import('better-sqlite3');
    const databasePath = join(sandbox.appDataDir, 'data', 'storage', 'app.db');
    const contender = new Database(databasePath, { timeout: 0 });
    try {
      contender.exec('CREATE TABLE fake_runtime_lock_probe (value INTEGER NOT NULL)');
      let fenceChecks = 0;
      let contenderBlocked = false;
      await recordRuntimeExecution(
        {
          action: 'launch',
          commandId: 'lifecycle-command_lock-probe',
          teamId: `team_${'a'.repeat(32)}`,
          workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
          expectedRevision: `revision_${'9'.repeat(64)}`,
        },
        'run_launch_lock_probe',
        join(root, 'runtime-state-lock-probe.json'),
        databasePath,
        undefined,
        undefined,
        () => {
          fenceChecks += 1;
          if (fenceChecks !== 4) return;
          const authorityReader = new Database(databasePath, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            authorityReader.prepare('SELECT COUNT(*) FROM hosted_workspace_grants').get();
          } finally {
            authorityReader.close();
          }
          try {
            contender.prepare('INSERT INTO fake_runtime_lock_probe (value) VALUES (1)').run();
          } catch (error) {
            if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
            contenderBlocked = true;
          }
        }
      );
      expect(fenceChecks).toBe(5);
      expect(contenderBlocked).toBe(true);
      expect(contender.prepare('SELECT COUNT(*) AS count FROM fake_runtime_lock_probe').get()).toEqual({
        count: 0,
      });
    } finally {
      contender.close();
    }
  });

  it('persists the exact fixture grants for both authenticated principals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-registry-grant-test-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const issuer = 'https://oidc-v1-e2e.localhost:54321';

    for (const [authMode, appDataDir] of [
      ['personal', sandbox.appDataDir],
      ['oidc', sandbox.oidcAppDataDir],
    ] as const) {
      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'seed'],
        {
          ...boundedExecOptions,
          env: {
            ...process.env,
            E2E_SEED_APP_DATA_ROOT: appDataDir,
            E2E_SEED_AUTH_MODE: authMode,
            E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
            E2E_SEED_MARKER_PATH: sandbox.markerPath,
            E2E_SEED_OIDC_ISSUER: issuer,
          },
        }
      );
      const lifecycleRunId = fakeRuntimeLifecycleRunId(`team_${'a'.repeat(32)}`, '9'.repeat(64));
      await recordRuntimeExecution(
        {
          action: 'launch',
          commandId: `lifecycle-command_fixture-storage-${authMode}`,
          teamId: `team_${'a'.repeat(32)}`,
          workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
          expectedRevision: `revision_${'9'.repeat(64)}`,
        },
        lifecycleRunId,
        join(root, `runtime-state-${authMode}.json`),
        join(appDataDir, 'data', 'storage', 'app.db')
      );
      const { default: Database } = await import('better-sqlite3');
      const authDatabase = new Database(join(appDataDir, 'data', 'storage', 'app.db'), {
        readonly: true,
      });
      const teamIdentityDatabase = new Database(join(appDataDir, 'storage', 'app.db'), {
        readonly: true,
      });
      try {
        const plan = hostedWorkspaceAccessSeedPlan(authMode, issuer);
        const grants = authDatabase
          .prepare(
            `SELECT grants.user_id AS userId,
                    workspaces.runtime_workspace_id AS runtimeWorkspaceId,
                    workspaces.public_workspace_id AS publicWorkspaceId,
                    grants.grant_revision AS grantRevision
             FROM hosted_workspace_grants AS grants
             JOIN hosted_workspaces AS workspaces
               ON workspaces.runtime_workspace_id = grants.runtime_workspace_id
             ORDER BY workspaces.runtime_workspace_id`
          )
          .all();
        expect(grants).toEqual(
          plan.workspaces.map((workspace) => ({
            userId: plan.userId,
            runtimeWorkspaceId: workspace.runtimeWorkspaceId,
            publicWorkspaceId: workspace.publicWorkspaceId,
            grantRevision: workspace.grantRevision,
          }))
        );
        expect(
          authMode === 'personal'
            ? authDatabase.prepare('SELECT user_id AS userId FROM personal_owners').get()
            : authDatabase
                .prepare(
                  `SELECT user_id AS userId FROM external_identities
                   WHERE issuer = ? AND subject = 'hosted-v1-e2e-owner'`
                )
                .get(issuer)
        ).toEqual({ userId: plan.userId });

        expect(
          teamIdentityDatabase
            .prepare(
              'SELECT team_id AS teamId, workspace_id AS workspaceId FROM team_identity_records'
            )
            .get()
        ).toEqual({ teamId: `team_${'a'.repeat(32)}`, workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID });
        const coordinationTables = authDatabase
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('coordination_event_journal', 'coordination_event_journal_metadata')
             ORDER BY name`
          )
          .all() as { name: string }[];
        expect(coordinationTables).toEqual([
          { name: 'coordination_event_journal' },
          { name: 'coordination_event_journal_metadata' },
        ]);
        const coordinationEvent = authDatabase
          .prepare(
            `SELECT event_id AS eventId, body_json AS bodyJson
             FROM coordination_event_journal`
          )
          .get() as { eventId: string; bodyJson: string };
        expect(coordinationEvent.eventId).toBe('event_hosted-v1-e2e-launch-1');
        expect(JSON.parse(coordinationEvent.bodyJson)).toMatchObject({
          workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
          teamId: `team_${'a'.repeat(32)}`,
          runId: lifecycleRunId,
        });
        const misplacedCoordinationTables = teamIdentityDatabase
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('coordination_event_journal', 'coordination_event_journal_metadata')
             ORDER BY name`
          )
          .all();
        expect(misplacedCoordinationTables).toEqual([]);
        const teamTables = teamIdentityDatabase
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN ('users', 'hosted_workspaces', 'hosted_workspace_grants')
             ORDER BY name`
          )
          .all() as { name: string }[];
        expect(teamTables).toEqual([]);
      } finally {
        authDatabase.close();
        teamIdentityDatabase.close();
      }
    }
  });

  it('keeps aggregate runtime and public workspace identities distinct', () => {
    expect(E2E_TEAM_RUNTIME_WORKSPACE_ID).toBe(`workspace_${'b'.repeat(32)}`);
    expect(E2E_WORKSPACE_ID).toBe(`workspace_${'c'.repeat(32)}`);
    expect(E2E_PROJECT_WORKSPACE_ID).toBe(`workspace_${'d'.repeat(32)}`);
    expect(E2E_FORBIDDEN_WORKSPACE_ID).toBe(`workspace_${'e'.repeat(32)}`);
  });

  it('executes ProjectScanner and requires the controller to expose exactly public workspace d', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-scanner-proof-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const evidence = await collectHostedV1ScannerEvidence(sandbox);

    expect(evidence).toMatchObject({
      expectedProjectFound: true,
      expectedRuntimeWorkspaceId: E2E_RUNTIME_WORKSPACE_ID,
      projectCount: 1,
      projects: [{ runtimeWorkspaceId: E2E_RUNTIME_WORKSPACE_ID, sessionCount: 1 }],
    });
    const admittedInput = {
      scannerProjectFound: true,
      controllerProjectCount: 1,
      controllerProjectStatus: 'observed' as const,
      controllerExactExpectedProjectOnly: true,
      registrationStatus: 'active',
      publicWorkspaceMapped: true,
      fixturePrincipalGrantFound: true,
    };
    expect(classifyHostedV1ProjectAccess({ ...admittedInput, scannerProjectFound: false })).toBe(
      'scanner_empty'
    );
    expect(
      classifyHostedV1ProjectAccess({ ...admittedInput, registrationStatus: 'disabled' })
    ).toBe('registration_inactive');
    expect(classifyHostedV1ProjectAccess({ ...admittedInput, publicWorkspaceMapped: false })).toBe(
      'public_mapping_mismatch'
    );
    expect(
      classifyHostedV1ProjectAccess({ ...admittedInput, fixturePrincipalGrantFound: false })
    ).toBe('grant_null');
    expect(
      classifyHostedV1ProjectAccess({ ...admittedInput, controllerProjectStatus: 'unavailable' })
    ).toBe('scanner_unavailable');
    expect(
      classifyHostedV1ProjectAccess({
        ...admittedInput,
        controllerExactExpectedProjectOnly: false,
      })
    ).toBe('scanner_empty');
    expect(classifyHostedV1ProjectAccess({ ...admittedInput, controllerProjectCount: 2 })).toBe(
      'scanner_empty'
    );
    expect(classifyHostedV1ProjectAccess(admittedInput)).toBe('project_admitted');
  });

  it('binds OIDC grant evidence to exact issuer, provider and subject and rejects a wrong issuer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-oidc-grant-proof-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const issuer = 'https://oidc-v1-e2e.localhost:54321';
    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'seed'],
      {
        ...boundedExecOptions,
        env: {
          ...process.env,
          E2E_SEED_APP_DATA_ROOT: sandbox.oidcAppDataDir,
          E2E_SEED_AUTH_MODE: 'oidc',
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
          E2E_SEED_MARKER_PATH: sandbox.markerPath,
          E2E_SEED_OIDC_ISSUER: issuer,
        },
      }
    );
    const observationFile = join(sandbox.runDir, 'controller-projects-oidc.json');
    await writeFile(
      observationFile,
      `${JSON.stringify({
        status: 'observed',
        projectCount: 1,
        exactExpectedPublicProject: true,
        rawRuntimeIdentityAbsent: true,
        rawRuntimePathAbsent: true,
      })}\n`,
      { mode: 0o600 }
    );
    const scannerEvidence = await collectHostedV1ScannerEvidence(sandbox);
    const input = {
      appDataDir: sandbox.oidcAppDataDir,
      authMode: 'oidc' as const,
      controllerProjectObservationFile: observationFile,
      scannerEvidence,
    };

    await expect(
      collectHostedV1GrantEvidence({ ...input, expectedOidcIssuer: issuer })
    ).resolves.toMatchObject({
      classification: 'project_admitted',
      fixturePrincipalFound: true,
      fixturePrincipalGrantFound: true,
      controllerProjectEvidence: {
        exactExpectedPublicProject: true,
        projectCount: 1,
        rawRuntimeIdentityAbsent: true,
        rawRuntimePathAbsent: true,
      },
    });
    await expect(
      collectHostedV1GrantEvidence({
        ...input,
        expectedOidcIssuer: 'https://wrong-issuer.invalid',
      })
    ).resolves.toMatchObject({
      classification: 'grant_null',
      fixturePrincipalFound: false,
      fixturePrincipalGrantFound: false,
    });
    await writeFile(
      observationFile,
      `${JSON.stringify({
        status: 'observed',
        projectCount: 2,
        exactExpectedPublicProject: false,
        rawRuntimeIdentityAbsent: true,
        rawRuntimePathAbsent: true,
      })}\n`,
      { mode: 0o600 }
    );
    await expect(
      collectHostedV1GrantEvidence({ ...input, expectedOidcIssuer: issuer })
    ).resolves.toMatchObject({
      classification: 'scanner_empty',
      controllerProjectEvidence: { exactExpectedPublicProject: false, projectCount: 2 },
    });
  });

  it('sanitizes controller evidence without embedding token-like test literals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-redaction-proof-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const synthetic = (fragment: string): string => [fragment, 'value'].join('-').repeat(8);
    const pairing = synthetic('pairing');
    const authorizationScalar = synthetic('authorization-scalar');
    const authorizationArrayOne = synthetic('authorization-array-one');
    const authorizationArrayTwo = synthetic('authorization-array-two');
    const csrfScalar = synthetic('csrf-scalar');
    const csrfArrayOne = synthetic('csrf-array-one');
    const csrfArrayTwo = synthetic('csrf-array-two');
    const productCsrfScalar = synthetic('product-csrf-scalar');
    const productCsrfArray = synthetic('product-csrf-array');
    const cookieScalar = synthetic('cookie-scalar');
    const cookieArrayOne = synthetic('cookie-array-one');
    const cookieArrayTwo = synthetic('cookie-array-two');
    const setCookieScalar = synthetic('set-cookie-scalar');
    const setCookieArrayOne = synthetic('set-cookie-array-one');
    const setCookieArrayTwo = synthetic('set-cookie-array-two');
    const oidc = synthetic('oidc');
    const jwtPart = synthetic('jwt');
    const jwt = [jwtPart, jwtPart, jwtPart].join('.');
    const opaqueToken = 'opaque-token:/+=☃-私密';
    const opaqueSecret = 'opaque-secret:/+=🧪-私密';
    const opaquePassword = 'opaque password / += 🔐';
    const opaqueTrustAnchor = 'opaque-trust-anchor:/+=☃';
    const jsonEvidence = JSON.stringify({
      authorization: `Bearer ${authorizationScalar}`,
      Authorization: [authorizationArrayOne, authorizationArrayTwo],
      csrf: csrfScalar,
      'x-csrf-token': [csrfArrayOne, csrfArrayTwo],
      requestHeaders: { 'x-agent-teams-csrf': productCsrfScalar },
      responseHeaders: { 'x-agent-teams-csrf': [productCsrfArray] },
      cookie: `session=${cookieScalar}`,
      Cookie: [`session=${cookieArrayOne}`, `device=${cookieArrayTwo}`],
      'set-cookie': `session=${setCookieScalar}`,
      'Set-Cookie': [`session=${setCookieArrayOne}`, `device=${setCookieArrayTwo}`],
      code: oidc,
      accessToken: opaqueToken,
      client_secret: opaqueSecret,
      databasePassword: opaquePassword,
      lifecycleTrustAnchor: opaqueTrustAnchor,
      nested: { credentials: { value: opaqueSecret }, state: oidc, jwt },
    });
    const evidence = redactEvidence(
      [
        sandbox.root,
        '/workspaces/sandbox',
        pairing,
        `__Host-agent-teams-session=${cookieScalar}`,
        `csrfToken:${csrfScalar}`,
        `authorization: Bearer ${authorizationScalar}`,
        `code=${oidc}`,
        jwt,
        `access_token=${opaqueToken}`,
        `client-secret='${opaqueSecret}'`,
        `password='${opaquePassword}'`,
        `trust-anchor=${opaqueTrustAnchor}`,
        `command --api-key ${opaqueToken}`,
        sandbox.lifecycleTrustAnchor,
      ].join('\n'),
      sandbox,
      pairing
    );
    const redactedJson = redactEvidence(jsonEvidence, sandbox, pairing);
    const parsed = JSON.parse(redactedJson) as Record<string, unknown>;

    for (const secret of [
      sandbox.root,
      '/workspaces/sandbox',
      pairing,
      authorizationScalar,
      authorizationArrayOne,
      authorizationArrayTwo,
      csrfScalar,
      csrfArrayOne,
      csrfArrayTwo,
      productCsrfScalar,
      productCsrfArray,
      cookieScalar,
      cookieArrayOne,
      cookieArrayTwo,
      setCookieScalar,
      setCookieArrayOne,
      setCookieArrayTwo,
      oidc,
      jwtPart,
      jwt,
      opaqueToken,
      opaqueSecret,
      opaquePassword,
      opaqueTrustAnchor,
      sandbox.lifecycleTrustAnchor,
    ]) {
      expect(evidence).not.toContain(secret);
      expect(redactedJson).not.toContain(secret);
    }
    expect(parsed).toMatchObject({
      authorization: '<authorization>',
      Authorization: ['<authorization>', '<authorization>'],
      csrf: '<csrf-token>',
      'x-csrf-token': ['<csrf-token>', '<csrf-token>'],
      requestHeaders: { 'x-agent-teams-csrf': '<csrf-token>' },
      responseHeaders: { 'x-agent-teams-csrf': ['<csrf-token>'] },
      cookie: '<cookie>',
      Cookie: ['<cookie>', '<cookie>'],
      'set-cookie': '<cookie>',
      'Set-Cookie': ['<cookie>', '<cookie>'],
      code: '<oidc-value>',
      accessToken: '<token>',
      client_secret: '<secret>',
      databasePassword: '<password>',
      lifecycleTrustAnchor: '<trust-anchor>',
      nested: { credentials: '<secret>', state: '<oidc-value>', jwt: '<jwt>' },
    });
  });

  it('bounds evidence by encoded UTF-8 bytes without splitting a high-bit code point', () => {
    expect(boundHostedV1EvidenceUtf8(`a🧪`, 5)).toBe(`a🧪`);
    expect(boundHostedV1EvidenceUtf8(`a🧪`, 4)).toBe('a');
    expect(Buffer.byteLength(boundHostedV1EvidenceUtf8('🧪'.repeat(10), 17))).toBe(16);
  });

  it('redacts Unicode and delimiter-safe credential keys with bounded large-Unicode scanning', () => {
    const root = '/tmp/hosted-v1-unicode-redaction';
    const sandbox = {
      root,
      lifecycleTrustAnchor: root + '/trust-anchor.pem',
    } as Pick<HostedV1Sandbox, 'root' | 'lifecycleTrustAnchor'>;
    const largeSecret = '🧪'.repeat(100_000);
    const input = [
      '秘密token: ' + largeSecret,
      'token/秘密=slash-secret',
      '普通🧪=keep-me',
    ].join('\n');
    const started = performance.now();
    const redacted = redactEvidence(input, sandbox, null);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(redacted).toContain('秘密token: <token>');
    expect(redacted).toContain('token/秘密=<token>');
    expect(redacted).toContain('普通🧪=keep-me');
    expect(redacted).not.toContain(largeSecret);
    expect(redacted).not.toContain('slash-secret');
  });

  it('redacts and bounds every retained Playwright artifact while removing binary captures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-browser-artifact-proof-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const artifacts = join(root, 'browser-evidence');
    await mkdir(artifacts);
    const pairingCode = 'pairing-secret-must-not-survive';
    const rawResults = JSON.stringify({
      attachment: pairingCode,
      path: sandbox.root,
      padding: '🧪'.repeat(20_000),
    });
    await writeFile(join(artifacts, 'results.json'), rawResults);
    await writeFile(join(artifacts, 'test-failure.png'), Buffer.from(pairingCode));

    await sanitizePlaywrightEvidence(artifacts, sandbox, pairingCode);

    const retained = await readFile(join(artifacts, 'results.json'), 'utf8');
    expect(retained).not.toContain(pairingCode);
    expect(retained).not.toContain(sandbox.root);
    expect(retained).not.toContain('\uFFFD');
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(16 * 1024);
    const parsedRetained = JSON.parse(retained) as Record<string, unknown>;
    const fullRedacted = redactEvidence(rawResults, sandbox, pairingCode, 1024 * 1024);
    expect(parsedRetained).toMatchObject({
      schemaVersion: 1,
      kind: 'json',
      fullRedactedBytes: Buffer.byteLength(fullRedacted),
      fullRedactedSha256: createHash('sha256').update(fullRedacted).digest('hex'),
      truncated: true,
      preview: expect.any(String),
    });
    await expect(lstat(join(artifacts, 'test-failure.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not rewrite valid committed attachment bytes during final evidence post-processing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-v1-committed-evidence-postprocess-'));
    roots.push(root);
    const sandbox = await createHostedV1Sandbox(root);
    const artifacts = join(root, 'browser-evidence');
    await mkdir(artifacts);
    const path = join(artifacts, 'committed-diagnostic.json');
    const raw = JSON.stringify({ authorization: 'Bearer raw-secret', root: sandbox.root });
    const redacted = redactEvidence(raw, sandbox, null);
    await writeHostedV1AtomicArtifact({
      path,
      body: raw,
      sanitizeBody: (body) => redactEvidence(body, sandbox, null),
      retentionBudget: {
        root: artifacts,
        maximumFileBytes: 16 * 1024,
        maximumTotalBytes: 4 * 1024 * 1024,
      },
      timeoutMs: 1_000,
    });
    const commit = JSON.parse(await readFile(path, 'utf8')) as { payload: string };
    const payloadPath = join(artifacts, commit.payload);
    const before = await readFile(payloadPath);

    await sanitizePlaywrightEvidence(artifacts, sandbox, null);

    await expect(readHostedV1CommittedArtifact(path)).resolves.toBe(redacted);
    expect(await readFile(payloadPath)).toEqual(before);
  });
});
