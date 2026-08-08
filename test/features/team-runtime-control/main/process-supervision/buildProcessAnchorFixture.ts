import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  parseOwnedProcessRef,
  parseSpawnNonce,
  type ProcessOwnershipScope,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  type CompositeRuntimePlanHash,
  type HostedChildEnvironmentPolicy,
  parseExecutionUnitId,
  parseRuntimeBinaryId,
  type ResolvedRuntimeBinaryPolicy,
} from '@features/team-runtime-control/contracts/runtimePlan';
import {
  computeCanonicalArgvDigest,
  computeCanonicalPolicyDigest,
  createSpawnIntent,
} from '@features/team-runtime-control/core/domain/process-supervision';
import {
  NodeAnchorLaunchMaterializer,
  NodeAnchorSpawner,
  type NodeAnchorSpawnerOptions,
  type NodeRegisteredWorkdirEvidence,
} from '@features/team-runtime-control/main/infrastructure/process-supervision';
import { parseRunId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import type {
  ResolvedEnvironmentAuthorityRef,
  ResolvedExecutableAuthorityRef,
  ResolvedWorkdirAuthorityRef,
  RuntimeCancellation,
  WorkspaceExecutionGrant,
  WorkspaceExecutionGrantId,
} from '@features/team-runtime-control/core/application/ports';
import type { AnchorSpawnRequest } from '@features/team-runtime-control/main/adapters/output/process-supervision';

const execFileAsync = promisify(execFile);
const SANDBOX_PREFIX = 'agent-teams-process-anchor-e2e-';
const OWNER_FILE = '.process-anchor-test-owner';
const PORTABLE_O_CLOEXEC =
  (constants as Readonly<Record<string, number | undefined>>).O_CLOEXEC ?? 0;

export interface ProcessAnchorFixture {
  readonly sandboxPath: string;
  readonly workdirPath: string;
  readonly anchorExecutablePath: string;
  readonly fakeRuntimePath: string;
  readonly runtimeMarkerPath: string;
  dispose(): Promise<void>;
}

export interface FakeRuntimeMarkerEvent {
  readonly event: string;
  readonly role: string;
  readonly pid: number;
  readonly ppid: number;
  readonly cwd: string;
  readonly environmentNames: readonly string[];
  readonly descriptors: readonly Readonly<{ descriptor: number; target: string }>[];
}

export interface ProcessAnchorSpawnHarness {
  readonly spawner: NodeAnchorSpawner;
  readonly cancellation: RuntimeCancellation;
  readonly registeredRootEvidence: NodeRegisteredWorkdirEvidence;
  createSpawner(
    options?: Partial<
      Pick<NodeAnchorSpawnerOptions, 'maxLaunchFrameBytes' | 'monotonicNow' | 'spawnProcess'>
    >
  ): NodeAnchorSpawner;
  request(mode: string): AnchorSpawnRequest;
}

export interface ProcessAnchorSpawnHarnessOptions {
  readonly registeredRootEvidence?: NodeRegisteredWorkdirEvidence;
}

export async function buildProcessAnchorFixture(): Promise<ProcessAnchorFixture> {
  if (process.platform !== 'linux') {
    throw new Error('process-anchor-fixture-linux-only');
  }
  const sandboxPath = await mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX));
  const ownerToken = randomUUID();
  const ownerPath = path.join(sandboxPath, OWNER_FILE);
  const workdirPath = path.join(sandboxPath, 'registered-workdir');
  const anchorExecutablePath = path.join(sandboxPath, 'agent-teams-process-anchor');
  const runtimeMarkerPath = path.join(sandboxPath, 'fake-runtime.ndjson');
  const sourcePath = path.resolve(
    process.cwd(),
    'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c'
  );
  const fakeRuntimePath = path.resolve(
    process.cwd(),
    'test/features/team-runtime-control/main/process-supervision/fixtures/fakeRuntimeProcess.mjs'
  );

  await writeFile(ownerPath, `${ownerToken}\n`, { encoding: 'utf8', mode: 0o600 });
  await mkdir(workdirPath, { mode: 0o700 });
  try {
    await execFileAsync(
      'cc',
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-pedantic',
        sourcePath,
        '-o',
        anchorExecutablePath,
      ],
      { cwd: sandboxPath, timeout: 30_000, maxBuffer: 1024 * 1024 }
    );
  } catch (error) {
    await disposeOwnedSandbox(sandboxPath, ownerToken);
    throw error;
  }

  let disposed = false;
  return Object.freeze({
    sandboxPath,
    workdirPath,
    anchorExecutablePath,
    fakeRuntimePath,
    runtimeMarkerPath,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await disposeOwnedSandbox(sandboxPath, ownerToken);
    },
  });
}

export async function readFakeRuntimeMarkerEvents(
  fixture: ProcessAnchorFixture
): Promise<readonly FakeRuntimeMarkerEvent[]> {
  let contents: string;
  try {
    contents = await readFile(fixture.runtimeMarkerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeRuntimeMarkerEvent);
}

export async function createProcessAnchorSpawnHarness(
  fixture: ProcessAnchorFixture,
  options: ProcessAnchorSpawnHarnessOptions = {}
): Promise<ProcessAnchorSpawnHarness> {
  const executableRef = 'executable-authority-process-anchor' as ResolvedExecutableAuthorityRef;
  const workdirRef = 'workdir-authority-process-anchor' as ResolvedWorkdirAuthorityRef;
  const environmentRef = 'environment-authority-process-anchor' as ResolvedEnvironmentAuthorityRef;
  const workspaceBinding = Object.freeze({
    workspaceId: parseWorkspaceId(`workspace_${'a'.repeat(32)}`),
    registrationRevision: 1,
    bindingGeneration: 2,
    mountGeneration: 3,
  });
  const grant: WorkspaceExecutionGrant = Object.freeze({
    grantId: 'workspace-grant-process-anchor' as WorkspaceExecutionGrantId,
    ...workspaceBinding,
    permission: 'execute_process',
  });
  const binaryPolicy: ResolvedRuntimeBinaryPolicy = Object.freeze({
    policy: 'registered_exact_binary',
    binaryId: parseRuntimeBinaryId('runtime-binary-process-anchor'),
    binaryRevision: 1,
    binaryHash: await sha256File(process.execPath),
  });
  const environmentPolicy: HostedChildEnvironmentPolicy = Object.freeze({
    policy: 'explicit_allowlist',
    variables: Object.freeze([
      Object.freeze({ name: 'FAKE_ALLOWED', provenance: 'runtime_metadata' as const }),
    ]),
  });
  const scope: ProcessOwnershipScope = Object.freeze({
    planRef: Object.freeze({
      teamId: parseTeamId(`team_${'b'.repeat(32)}`),
      runId: parseRunId(`run_${'c'.repeat(32)}`),
      generation: 1,
      planHash: `sha256:${'d'.repeat(64)}` as CompositeRuntimePlanHash,
    }),
    executionUnitId: parseExecutionUnitId('process-anchor-unit'),
  });
  const registeredRootEvidence =
    options.registeredRootEvidence ?? (await inspectRegisteredRoot(fixture.workdirPath));
  const materializer = new NodeAnchorLaunchMaterializer({
    executables: [{ executableRef, executablePath: process.execPath, binaryPolicy }],
    workdirs: [
      {
        workdirRef,
        workdirPath: fixture.workdirPath,
        grant,
        registeredRootEvidence,
      },
    ],
    environments: [
      {
        environmentRef,
        policy: environmentPolicy,
        values: { FAKE_ALLOWED: 'fixture-runtime' },
      },
    ],
  });
  const createSpawner: ProcessAnchorSpawnHarness['createSpawner'] = (options = {}) =>
    new NodeAnchorSpawner({
      anchorExecutablePath: fixture.anchorExecutablePath,
      neutralWorkingDirectory: fixture.sandboxPath,
      materializer,
      ...options,
    });
  const spawner = createSpawner();
  const cancellation: RuntimeCancellation = Object.freeze({
    cancellationId: 'process-anchor-cancellation-active' as RuntimeCancellation['cancellationId'],
    isCancellationRequested: () => false,
  });

  return Object.freeze({
    spawner,
    cancellation,
    registeredRootEvidence,
    createSpawner,
    request(mode: string): AnchorSpawnRequest {
      const argv = Object.freeze([
        fixture.fakeRuntimePath,
        mode,
        fixture.runtimeMarkerPath,
        fixture.sandboxPath,
      ]);
      return Object.freeze({
        intent: createSpawnIntent({
          scope,
          processRef: parseOwnedProcessRef(`process-ref:${randomUUID()}`),
          spawnNonce: parseSpawnNonce(`spawn-nonce:${randomUUID()}`),
          workspaceBinding,
          binaryBinding: binaryPolicy,
          argv,
          callerArgvDigest: computeCanonicalArgvDigest(argv),
          environmentPolicyDigest: computeCanonicalPolicyDigest(environmentPolicy),
          relayScopeDigest: computeCanonicalPolicyDigest({ lane: 'fixture' }),
        }),
        executableAuthority: executableRef,
        argv,
        workdirAuthority: { workdirRef, grant },
        environmentAuthority: { environmentRef, policy: environmentPolicy },
        resourcePolicy: {
          maxRuntimeMs: 5_000,
          gracefulStopMs: 150,
          maxOutputBytes: 64 * 1_024,
          maxProcessCount: 16,
        },
        shell: false,
        inheritParentEnvironment: false,
        closeUndeclaredDescriptors: true,
      });
    },
  });
}

async function disposeOwnedSandbox(sandboxPath: string, ownerToken: string): Promise<void> {
  const resolvedSandbox = await realpath(sandboxPath);
  const expectedPrefix = path.join(await realpath(os.tmpdir()), SANDBOX_PREFIX);
  if (!resolvedSandbox.startsWith(expectedPrefix)) {
    throw new Error('process-anchor-fixture-cleanup-scope');
  }
  const actualOwner = await readFile(path.join(resolvedSandbox, OWNER_FILE), 'utf8');
  if (actualOwner !== `${ownerToken}\n`) {
    throw new Error('process-anchor-fixture-cleanup-owner');
  }
  await rm(resolvedSandbox, { recursive: true, force: false });
}

async function sha256File(filePath: string): Promise<`sha256:${string}`> {
  const digest = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) =>
      digest.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    );
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return `sha256:${digest.digest('hex')}`;
}

async function inspectRegisteredRoot(rootPath: string): Promise<NodeRegisteredWorkdirEvidence> {
  const handle = await open(
    rootPath,
    constants.O_RDONLY | PORTABLE_O_CLOEXEC | constants.O_NOFOLLOW | constants.O_DIRECTORY
  );
  try {
    const stats = await handle.stat({ bigint: true });
    // The descriptor comes from this marker-owned fixture; the numeric fd is not user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fdInfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    const mountId = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(fdInfo)?.[1];
    if (!mountId) throw new Error('process-anchor-fixture-mount-id-unavailable');
    return Object.freeze({
      device: stats.dev,
      inode: stats.ino,
      mountId: BigInt(mountId),
    });
  } finally {
    await handle.close();
  }
}
