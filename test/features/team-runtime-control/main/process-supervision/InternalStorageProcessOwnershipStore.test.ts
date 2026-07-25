import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  type ProcessOwnershipStorageCallContext,
  type ProcessOwnershipStorageCompareAndSwapRequest,
  type ProcessOwnershipStorageCompareAndSwapResult,
  type ProcessOwnershipStorageGateway,
  type ProcessOwnershipStorageLoadResult,
  type ProcessOwnershipStorageScope,
  type StoredProcessOwnershipState,
} from '@features/internal-storage/main';
import { InternalStorageWorkerClient } from '@features/internal-storage/main/infrastructure/InternalStorageWorkerClient';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import {
  parseInternalStorageWorkerResponse,
  parseProcessOwnershipWorkerResult,
} from '@features/internal-storage/main/infrastructure/worker/internalStorageWorkerProtocol';
import {
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseMainProcessIdentityRef,
  parseOwnedProcessRef,
  parseOwningProcessIdentityRef,
  parseProcessControllerInstanceId,
  parseSpawnNonce,
  PROCESS_OWNER_ATTESTATION_VERSION,
  type ProcessOwnershipScope,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  type CompositeRuntimePlanHash,
  parseExecutionUnitId,
  parseRuntimeBinaryId,
  type Sha256Hash,
} from '@features/team-runtime-control/contracts/runtimePlan';
import {
  CommitProcessOwnership,
  createProcessSupervisionDeadline,
  CreateSpawnIntent,
  type LiveProcessChannelInspection,
  type MonotonicClockPort,
  type OwnedProcessControlPort,
  type ProcessOwnershipStoreContext,
  RecoverProcessOwnership,
  StopOwnedProcess,
  type StopOwnedProcessEffectResult,
} from '@features/team-runtime-control/core/application/process-supervision';
import {
  computeCanonicalArgvDigest,
  computeCanonicalPolicyDigest,
  createSpawnIntent,
  initializeProcessOwnershipState,
  type LiveProcessOwnershipState,
  markProcessOwnershipUnclassified,
  type ProcessOwnershipState,
  spawnNonceDigest,
} from '@features/team-runtime-control/core/domain/process-supervision';
import {
  encodeProcessOwnershipState,
  InternalStorageProcessOwnershipStore,
} from '@features/team-runtime-control/main/adapters/output/process-supervision';
import { parseRunId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type {
  RuntimeCancellation,
  RuntimeCancellationId,
} from '@features/team-runtime-control/core/application/ports';

const hash = (character: string): Sha256Hash => `sha256:${character.repeat(64)}`;
const requireFromTest = createRequire(import.meta.url);
const nativeBindingDirectory = buildNodeSqliteBinding();
const nativeBinding = path.join(nativeBindingDirectory, 'build', 'Release', 'better_sqlite3.node');

function buildNodeSqliteBinding(): string {
  const packageRoot = path.dirname(requireFromTest.resolve('better-sqlite3-node/package.json'));
  const electronRebuildRequire = createRequire(requireFromTest.resolve('@electron/rebuild'));
  const nodeGypPath = electronRebuildRequire.resolve('node-gyp/bin/node-gyp.js');
  const nodeInstallRoot = path.dirname(path.dirname(process.execPath));
  const buildDirectory = mkdtempSync(path.join(os.tmpdir(), 'better-sqlite3-node-binding-'));
  for (const entry of ['binding.gyp', 'deps', 'src'] as const) {
    cpSync(path.join(packageRoot, entry), path.join(buildDirectory, entry), { recursive: true });
  }
  execFileSync(
    process.execPath,
    [nodeGypPath, 'rebuild', '--release', `--nodedir=${nodeInstallRoot}`],
    {
      cwd: buildDirectory,
      env: {
        ...process.env,
        npm_config_arch: process.arch,
        npm_config_runtime: 'node',
      },
      stdio: 'pipe',
    }
  );
  return buildDirectory;
}

function openDatabase(
  file: string,
  options: { readonly?: boolean; fileMustExist?: boolean } = {}
): Database.Database {
  return new Database(file, {
    ...options,
    nativeBinding,
  });
}

class TestClock implements MonotonicClockPort {
  value = 0;
  now(): number {
    return this.value;
  }
}

class CoreProcessOwnershipGateway implements ProcessOwnershipStorageGateway {
  constructor(readonly core: InternalStorageWorkerCore) {}

  async loadProcessOwnershipByScope(
    scope: ProcessOwnershipStorageScope,
    _context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageLoadResult> {
    await Promise.resolve();
    return this.core.handle('processOwnership.loadByScope', {
      scope,
    }) as ProcessOwnershipStorageLoadResult;
  }

  async loadProcessOwnershipByProcessRef(
    processRef: string,
    _context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageLoadResult> {
    await Promise.resolve();
    return this.core.handle('processOwnership.loadByProcessRef', {
      processRef,
    }) as ProcessOwnershipStorageLoadResult;
  }

  async listProcessOwnershipRecords(
    _context: ProcessOwnershipStorageCallContext
  ): Promise<readonly StoredProcessOwnershipState[]> {
    await Promise.resolve();
    return this.core.handle('processOwnership.list', {}) as StoredProcessOwnershipState[];
  }

  async compareAndSwapProcessOwnership(
    request: ProcessOwnershipStorageCompareAndSwapRequest,
    context: ProcessOwnershipStorageCallContext
  ): Promise<ProcessOwnershipStorageCompareAndSwapResult> {
    await Promise.resolve();
    return this.core.handle('processOwnership.compareAndSwap', {
      request,
      admission: { deadlineAtMs: context.deadlineAtMs },
    }) as ProcessOwnershipStorageCompareAndSwapResult;
  }
}

class TestControl implements OwnedProcessControlPort {
  inspection: LiveProcessChannelInspection = { status: 'live' };
  stopResult: StopOwnedProcessEffectResult = { status: 'unavailable' };
  inspections = 0;
  stops = 0;

  async inspectLiveChannel(): Promise<LiveProcessChannelInspection> {
    await Promise.resolve();
    this.inspections += 1;
    return this.inspection;
  }

  async stopAndDrain(): Promise<StopOwnedProcessEffectResult> {
    await Promise.resolve();
    this.stops += 1;
    return this.stopResult;
  }
}

function scope(suffix = 'a'): ProcessOwnershipScope {
  return {
    planRef: {
      teamId: parseTeamId(`team_${suffix.repeat(32)}`),
      runId: parseRunId(`run_${suffix.repeat(32)}`),
      generation: 1,
      planHash: hash(suffix) as CompositeRuntimePlanHash,
    },
    executionUnitId: parseExecutionUnitId(`unit-${suffix}`),
  };
}

function activeCancellation(): RuntimeCancellation {
  return {
    cancellationId: 'ownership-test-cancellation' as RuntimeCancellationId,
    isCancellationRequested: () => false,
  };
}

function context(clock = new TestClock()): ProcessOwnershipStoreContext {
  return {
    deadline: createProcessSupervisionDeadline(clock, 1_000),
    clock,
    cancellation: activeCancellation(),
  };
}

function createRequest(
  storeContext: ProcessOwnershipStoreContext,
  options: {
    scope?: ProcessOwnershipScope;
    processRef?: string;
    spawnNonce?: string;
    argv?: readonly string[];
  } = {}
) {
  const argv = options.argv ?? ['run'];
  return {
    scope: options.scope ?? scope(),
    processRef: parseOwnedProcessRef(options.processRef ?? 'process-ref-0000000000000001'),
    spawnNonce: parseSpawnNonce(options.spawnNonce ?? 'spawn-nonce-0000000000000001'),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
      registrationRevision: 1,
      bindingGeneration: 2,
      mountGeneration: 3,
    },
    binaryBinding: {
      policy: 'registered_exact_binary' as const,
      binaryId: parseRuntimeBinaryId('binary-safe'),
      binaryRevision: 1,
      binaryHash: hash('c'),
    },
    argv,
    callerArgvDigest: computeCanonicalArgvDigest(argv),
    environmentPolicyDigest: computeCanonicalPolicyDigest({ names: ['ALLOWED_NAME'] }),
    relayScopeDigest: computeCanonicalPolicyDigest({ members: ['first', 'second'] }),
    context: storeContext,
  };
}

function readyProof(state: Extract<ProcessOwnershipState, { phase: 'spawn_intent' }>) {
  const { intent } = state;
  return {
    processRef: intent.processRef,
    scope: intent.scope,
    workspaceBinding: intent.workspaceBinding,
    spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
    controllerInstanceId: parseProcessControllerInstanceId('controller-instance-00000001'),
    ownerAttestation: Object.freeze({
      attestationVersion: PROCESS_OWNER_ATTESTATION_VERSION,
      processRef: intent.processRef,
      scope: intent.scope,
      workspaceBinding: intent.workspaceBinding,
      spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
      channelRef: parseAnchorChannelRef('channel-ref-000000000000001'),
      owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-0000000000001'),
      anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-00000000001'),
    }),
    mainProcessIdentityRef: parseMainProcessIdentityRef('main-identity-0000000000001'),
    statusSequence: 1 as const,
  };
}

function storedState(state: ProcessOwnershipState): StoredProcessOwnershipState {
  return {
    scope: {
      teamId: state.intent.scope.planRef.teamId,
      runId: state.intent.scope.planRef.runId,
      planGeneration: state.intent.scope.planRef.generation,
      planHash: state.intent.scope.planRef.planHash,
      executionUnitId: state.intent.scope.executionUnitId,
    },
    processRef: state.intent.processRef,
    codecVersion: 1,
    stateVersion: state.stateVersion,
    revision: state.revision,
    phase: state.phase,
    stateJson: encodeProcessOwnershipState(state),
  };
}

describe('InternalStorageProcessOwnershipStore', () => {
  const directories: string[] = [];
  const cores: InternalStorageWorkerCore[] = [];

  afterAll(async () => {
    await fs.rm(nativeBindingDirectory, { recursive: true, force: true });
  });

  async function databasePath(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'process-ownership-store-'));
    directories.push(directory);
    return path.join(directory, 'storage', 'app.db');
  }

  function makeCore(databaseFile: string): InternalStorageWorkerCore {
    const core = new InternalStorageWorkerCore({
      databasePath: databaseFile,
      createDatabase: (file) => openDatabase(file),
    });
    cores.push(core);
    return core;
  }

  function makeStore(databaseFile: string): {
    core: InternalStorageWorkerCore;
    gateway: CoreProcessOwnershipGateway;
    store: InternalStorageProcessOwnershipStore;
  } {
    const core = makeCore(databaseFile);
    const gateway = new CoreProcessOwnershipGateway(core);
    return { core, gateway, store: new InternalStorageProcessOwnershipStore(gateway) };
  }

  afterEach(async () => {
    for (const core of cores.splice(0)) {
      try {
        core.close();
      } catch {
        // The test may already have restarted this worker core.
      }
    }
    await Promise.all(
      directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  it('durably records spawn intent before an effect and survives worker/gateway restart', async () => {
    const file = await databasePath();
    const first = makeStore(file);
    const clock = new TestClock();
    const argvCanary = 'argv-plaintext-must-not-be-stored';
    let spawnEffectObserved = false;
    const created = await new CreateSpawnIntent(first.store).execute(
      createRequest(context(clock), { argv: ['run', argvCanary] })
    );
    expect(created.status).toBe('created');

    const beforeEffect = await first.store.load(scope(), context(clock));
    expect(beforeEffect).toMatchObject({ status: 'found', state: { phase: 'spawn_intent' } });
    spawnEffectObserved = true;
    expect(spawnEffectObserved).toBe(true);

    const raw = openDatabase(file, { readonly: true });
    const durableBytes = JSON.stringify(
      raw.prepare('SELECT * FROM process_ownership_records').get()
    );
    raw.close();
    expect(durableBytes).not.toContain(argvCanary);
    expect(durableBytes).not.toMatch(/"argv":|"env":|"cwd":|"pid":|"pgid":|"secret":/i);

    first.core.close();
    const restarted = makeStore(file);
    await expect(restarted.store.load(scope(), context(clock))).resolves.toMatchObject({
      status: 'found',
      state: { phase: 'spawn_intent', revision: 1 },
    });
  });

  it('creates only from null, updates only the exact revision, and preserves newer CAS state', async () => {
    const file = await databasePath();
    const { store } = makeStore(file);
    const clock = new TestClock();
    const created = await new CreateSpawnIntent(store).execute(createRequest(context(clock)));
    if (created.status !== 'created') throw new Error('expected created intent');

    const duplicateCreate = await store.compareAndSwap({
      scope: scope(),
      expectedRevision: null,
      next: created.state,
      context: context(clock),
    });
    expect(duplicateCreate).toEqual({ status: 'conflict' });

    const committed = await new CommitProcessOwnership(store).execute({
      scope: scope(),
      proof: readyProof(created.state),
      context: context(clock),
    });
    if (committed.status === 'rejected') throw new Error('expected ownership commit');
    const stale = markProcessOwnershipUnclassified(created.state, 'stale-write');
    await expect(
      store.compareAndSwap({
        scope: scope(),
        expectedRevision: created.state.revision,
        next: stale,
        context: context(clock),
      })
    ).resolves.toEqual({ status: 'conflict' });
    await expect(store.load(scope(), context(clock))).resolves.toMatchObject({
      status: 'found',
      state: { phase: 'owned', revision: committed.state.revision },
    });
  });

  it('drops queued ownership mutations after caller cancellation or deadline expiry', async () => {
    const file = await databasePath();
    const workerFile = path.join(path.dirname(path.dirname(file)), 'delayed-worker.cjs');
    await fs.writeFile(
      workerFile,
      `const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
parentPort.on('message', (message) => {
  if (message.op === 'ping') {
    setTimeout(() => parentPort.postMessage({ id: message.id, ok: true, result: {} }), 50);
    return;
  }
  if (message.op === 'processOwnership.compareAndSwap') {
    fs.mkdirSync(path.dirname(workerData.databasePath), { recursive: true });
    fs.appendFileSync(workerData.databasePath + '.cas', 'executed');
    parentPort.postMessage({ id: message.id, ok: true, result: { status: 'conflict' } });
    return;
  }
  parentPort.postMessage({ id: message.id, ok: true, result: null });
});`
    );
    const next = storedState(
      initializeProcessOwnershipState(createSpawnIntent(createRequest(context())))
    );

    for (const mode of ['cancelled', 'timed_out'] as const) {
      const databaseFile = `${file}-${mode}`;
      const client = new InternalStorageWorkerClient({ databasePath: databaseFile });
      Object.defineProperty(client, 'workerPath', { value: workerFile });
      let cancelled = false;
      try {
        const blocker = client.ping();
        const mutation = client.compareAndSwapProcessOwnership(
          {
            scope: next.scope,
            expectedRevision: null,
            expectedCurrent: null,
            next,
          },
          {
            deadlineAtMs: Date.now() + (mode === 'timed_out' ? 10 : 1_000),
            isCancellationRequested: () => cancelled,
          }
        );
        if (mode === 'cancelled') cancelled = true;
        await expect(mutation).rejects.toThrow('admission-expired');
        await blocker;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await expect(fs.readFile(`${databaseFile}.cas`, 'utf8')).rejects.toThrow();
      } finally {
        await client.close();
      }
    }
  });

  it('rejects malformed ownership requests and worker result envelopes at runtime', async () => {
    expect(() => parseInternalStorageWorkerResponse({ id: 'response-id', ok: true })).toThrow(
      'response-fields-invalid'
    );
    expect(() =>
      parseProcessOwnershipWorkerResult('processOwnership.compareAndSwap', {
        status: 'applied',
        record: { revision: 1 },
      })
    ).toThrow('ownership-record-fields-invalid');
    const sparseOwnershipResult: unknown[] = [];
    sparseOwnershipResult.length = 1;
    expect(() =>
      parseProcessOwnershipWorkerResult('processOwnership.list', sparseOwnershipResult)
    ).toThrow('ownership-list-result-invalid');

    const file = await databasePath();
    const workerFile = path.join(path.dirname(path.dirname(file)), 'malformed-worker.cjs');
    await fs.writeFile(
      workerFile,
      `const { parentPort } = require('node:worker_threads');
parentPort.on('message', (message) => {
  parentPort.postMessage({
    id: message.id,
    ok: true,
    result: { status: 'applied', record: { revision: 1 } },
  });
});`
    );
    const client = new InternalStorageWorkerClient({ databasePath: file });
    Object.defineProperty(client, 'workerPath', { value: workerFile });
    const next = storedState(
      initializeProcessOwnershipState(createSpawnIntent(createRequest(context())))
    );
    await expect(
      client.compareAndSwapProcessOwnership(
        {
          scope: next.scope,
          expectedRevision: null,
          expectedCurrent: null,
          next,
        },
        {
          deadlineAtMs: Date.now() + 1_000,
          isCancellationRequested: () => false,
        }
      )
    ).rejects.toThrow('ownership-record-fields-invalid');
    await client.close();

    const core = makeCore(file);
    expect(() =>
      core.handle('processOwnership.compareAndSwap', {
        request: {
          scope: next.scope,
          expectedRevision: null,
          expectedCurrent: null,
          next,
        },
        admission: { deadlineAtMs: Date.now() - 1 },
      })
    ).toThrow('process-ownership-storage-deadline-expired');
    expect(() =>
      core.handle('processOwnership.compareAndSwap', {
        scope: storedState(
          initializeProcessOwnershipState(createSpawnIntent(createRequest(context())))
        ).scope,
        expectedRevision: null,
        next: {},
      } as never)
    ).toThrow('ownership-cas-fields-invalid');
  });

  it('enforces independent uniqueness for immutable scope and opaque processRef', async () => {
    const file = await databasePath();
    const { store } = makeStore(file);
    const clock = new TestClock();
    const created = await new CreateSpawnIntent(store).execute(createRequest(context(clock)));
    expect(created.status).toBe('created');

    const sameScope = initializeProcessOwnershipState(
      createSpawnIntent(
        createRequest(context(clock), {
          processRef: 'process-ref-0000000000000002',
          spawnNonce: 'spawn-nonce-0000000000000002',
        })
      )
    );
    await expect(
      store.compareAndSwap({
        scope: scope(),
        expectedRevision: null,
        next: sameScope,
        context: context(clock),
      })
    ).resolves.toEqual({ status: 'conflict' });

    const otherScope = initializeProcessOwnershipState(
      createSpawnIntent(
        createRequest(context(clock), {
          scope: scope('d'),
          processRef: 'process-ref-0000000000000001',
          spawnNonce: 'spawn-nonce-0000000000000003',
        })
      )
    );
    await expect(
      store.compareAndSwap({
        scope: scope('d'),
        expectedRevision: null,
        next: otherScope,
        context: context(clock),
      })
    ).resolves.toEqual({ status: 'conflict' });
  });

  it('maps unknown codec state and damaged uniqueness metadata to unavailable, never missing', async () => {
    const file = await databasePath();
    const first = makeStore(file);
    const clock = new TestClock();
    const created = await new CreateSpawnIntent(first.store).execute(createRequest(context(clock)));
    if (created.status !== 'created') throw new Error('expected created intent');
    first.core.close();

    const raw = openDatabase(file);
    const original = raw.prepare('SELECT state_json FROM process_ownership_records').get() as {
      readonly state_json: string;
    };
    raw
      .prepare('UPDATE process_ownership_records SET state_json = ?')
      .run(
        '{"codecVersion":1,"state":{"intent":{},"phase":"spawn_intent","revision":1,"stateVersion":1}}'
      );
    raw.close();
    const malformed = makeStore(file);
    await expect(malformed.store.load(scope(), context(clock))).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(
      malformed.store.compareAndSwap({
        scope: scope(),
        expectedRevision: 1,
        next: markProcessOwnershipUnclassified(created.state, 'corrupt-row'),
        context: context(clock),
      })
    ).resolves.toEqual({ status: 'unavailable' });
    malformed.core.close();

    const unknownRaw = openDatabase(file);
    unknownRaw
      .prepare('UPDATE process_ownership_records SET state_json = ?')
      .run('{"codecVersion":999,"state":{}}');
    unknownRaw.close();
    const unknown = makeStore(file);
    await expect(unknown.store.load(scope(), context(clock))).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(
      unknown.store.compareAndSwap({
        scope: scope(),
        expectedRevision: 1,
        next: markProcessOwnershipUnclassified(created.state, 'unknown-row'),
        context: context(clock),
      })
    ).resolves.toEqual({ status: 'unavailable' });
    unknown.core.close();

    const damaged = openDatabase(file);
    damaged.prepare('UPDATE process_ownership_records SET state_json = ?').run(original.state_json);
    damaged.exec('DROP INDEX idx_process_ownership_immutable_scope');
    damaged.exec('DROP INDEX idx_process_ownership_opaque_ref');
    damaged.exec(
      `INSERT INTO process_ownership_records (
        team_id, run_id, plan_generation, plan_hash, execution_unit_id, process_ref,
        codec_version, state_version, revision, phase, state_json
      )
      SELECT team_id, run_id, plan_generation, plan_hash, execution_unit_id, process_ref,
        codec_version, state_version, revision, phase, state_json
      FROM process_ownership_records`
    );
    damaged.close();
    const reopened = makeStore(file);
    await expect(reopened.store.load(scope(), context(clock))).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('persists a fail-closed ownership marker after database corruption recovery', async () => {
    const file = await databasePath();
    const first = makeStore(file);
    const clock = new TestClock();
    await new CreateSpawnIntent(first.store).execute(createRequest(context(clock)));
    first.core.close();
    await fs.writeFile(file, Buffer.from('not-a-sqlite-database'));

    const recovered = makeStore(file);
    await expect(recovered.store.load(scope(), context(clock))).resolves.toEqual({
      status: 'unavailable',
    });
    recovered.core.close();

    const raw = openDatabase(file, { readonly: true });
    expect(raw.prepare('SELECT reason FROM process_ownership_corruption_markers').get()).toEqual({
      reason: 'database_corruption_recovery',
    });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM process_ownership_records').get()).toEqual({
      count: 0,
    });
    raw.close();
  });

  it('persists residual evidence immutably and exposes only a read-only typed projection', async () => {
    const file = await databasePath();
    const first = makeStore(file);
    const clock = new TestClock();
    const created = await new CreateSpawnIntent(first.store).execute(createRequest(context(clock)));
    if (created.status === 'rejected') throw new Error('expected durable intent');
    first.core.close();

    const restarted = makeStore(file);
    const control = new TestControl();
    const recovered = await new RecoverProcessOwnership(restarted.store, control, clock).execute({
      ...scope(),
      timeoutMs: 1_000,
      cancellation: activeCancellation(),
    });
    expect(recovered).toEqual({ status: 'operator_required' });
    const evidence = await restarted.store.readResidualEvidence(context(clock));
    expect(evidence).toMatchObject({
      status: 'available',
      residuals: [{ phase: 'unclassified_residual', terminalReason: 'spawn-effect-ambiguous' }],
    });
    if (evidence.status !== 'available') throw new Error('expected residual evidence');
    expect(Object.isFrozen(evidence.residuals)).toBe(true);

    const residual = evidence.residuals[0];
    const attemptedMutation = {
      ...residual,
      revision: residual.revision + 1,
      terminalReason: 'operator-cleared',
    } as const;
    await expect(
      restarted.store.compareAndSwap({
        scope: scope(),
        expectedRevision: residual.revision,
        next: attemptedMutation,
        context: context(clock),
      })
    ).resolves.toEqual({ status: 'conflict' });
    await expect(restarted.store.load(scope(), context(clock))).resolves.toMatchObject({
      status: 'found',
      state: {
        phase: 'unclassified_residual',
        revision: residual.revision,
        terminalReason: 'spawn-effect-ambiguous',
      },
    });
    const raw = openDatabase(file);
    expect(() => raw.prepare('DELETE FROM process_ownership_records').run()).toThrow(
      'process-ownership-residual-immutable'
    );
    raw.close();
  });

  it('runs stop and typed drain through the real SQLite store and persists terminal state', async () => {
    const file = await databasePath();
    const first = makeStore(file);
    const clock = new TestClock();
    const created = await new CreateSpawnIntent(first.store).execute(createRequest(context(clock)));
    if (created.status !== 'created') throw new Error('expected created intent');
    const committed = await new CommitProcessOwnership(first.store).execute({
      scope: scope(),
      proof: readyProof(created.state),
      context: context(clock),
    });
    if (committed.status === 'rejected') throw new Error('expected ownership commit');
    const control = new TestControl();
    control.stopResult = drainResult(committed.state);

    await expect(
      new StopOwnedProcess(first.store, control, clock).execute({
        ...scope(),
        processRef: committed.state.intent.processRef,
        mode: 'graceful',
        timeoutMs: 1_000,
        cancellation: activeCancellation(),
      })
    ).resolves.toEqual({ status: 'drained' });
    expect(control.stops).toBe(1);
    first.core.close();

    const restarted = makeStore(file);
    await expect(restarted.store.load(scope(), context(clock))).resolves.toMatchObject({
      status: 'found',
      state: { phase: 'drained', revision: 4 },
    });
  });

  it('applies the existing database-wide backup fence before ownership mutations', async () => {
    const file = await databasePath();
    const { core, store } = makeStore(file);
    core.handle('ping', {});
    const raw = openDatabase(file);
    raw
      .prepare(
        `INSERT INTO coordination_backup_runs (
          backup_run_id, deployment_id, state, revision, fence_completion_status,
          record_json, requested_at, updated_at
        ) VALUES (?, ?, ?, 1, NULL, '{}', ?, ?)`
      )
      .run('backup-process-ownership', 'deployment-process-ownership', 'capturing', 'now', 'now');
    raw
      .prepare(
        `INSERT INTO coordination_backup_writer_fences (
          deployment_id, generation, admitted_run_id, lease_id, status, disposition,
          acquired_at, completed_at
        ) VALUES (?, 1, ?, ?, 'active', NULL, ?, NULL)`
      )
      .run(
        'deployment-process-ownership',
        'backup-process-ownership',
        'lease-process-ownership',
        'now'
      );
    raw.close();

    await expect(new CreateSpawnIntent(store).execute(createRequest(context()))).resolves.toEqual({
      status: 'rejected',
      reason: 'store_unavailable',
    });
    await expect(store.load(scope(), context())).resolves.toEqual({ status: 'missing' });
  });

  it('upgrades an existing schema-v10 database before admitting ownership writes', async () => {
    const file = await databasePath();
    const initial = makeStore(file);
    initial.core.handle('ping', {});
    initial.core.close();
    const legacy = openDatabase(file);
    legacy.exec('DROP TRIGGER trg_process_ownership_residual_update_immutable');
    legacy.exec('DROP TRIGGER trg_process_ownership_residual_delete_immutable');
    legacy.exec('DROP TABLE process_ownership_records');
    legacy.exec('DROP TABLE process_ownership_corruption_markers');
    legacy.pragma('user_version = 10');
    legacy.close();

    const migrated = makeStore(file);
    const info = migrated.core.handle('ping', {}) as { schemaVersion: number };
    expect(info.schemaVersion).toBe(11);
    await expect(
      new CreateSpawnIntent(migrated.store).execute(createRequest(context()))
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('refuses the v11 migration while a persisted backup fence is active', async () => {
    const file = await databasePath();
    const initial = makeStore(file);
    initial.core.handle('ping', {});
    initial.core.close();
    const legacy = openDatabase(file);
    legacy.exec('DROP TRIGGER trg_process_ownership_residual_update_immutable');
    legacy.exec('DROP TRIGGER trg_process_ownership_residual_delete_immutable');
    legacy.exec('DROP TABLE process_ownership_records');
    legacy.exec('DROP TABLE process_ownership_corruption_markers');
    legacy.pragma('user_version = 10');
    legacy
      .prepare(
        `INSERT INTO coordination_backup_runs (
          backup_run_id, deployment_id, state, revision, fence_completion_status,
          record_json, requested_at, updated_at
        ) VALUES ('backup-v11-fence', 'deployment-v11-fence', 'capturing', 1, NULL, '{}', 'now', 'now')`
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO coordination_backup_writer_fences (
          deployment_id, generation, admitted_run_id, lease_id, status, disposition,
          acquired_at, completed_at
        ) VALUES (
          'deployment-v11-fence', 1, 'backup-v11-fence', 'lease-v11-fence',
          'active', NULL, 'now', NULL
        )`
      )
      .run();
    legacy.close();

    const fenced = makeStore(file);
    expect(() => fenced.core.handle('ping', {})).toThrow(
      'internal-storage-v11-migration-backup-fenced'
    );
    const unchanged = openDatabase(file, { readonly: true });
    expect(unchanged.pragma('user_version', { simple: true })).toBe(10);
    expect(
      unchanged
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'process_ownership_records'`
        )
        .get()
    ).toBeUndefined();
    unchanged.close();
  });
});

function drainResult(state: LiveProcessOwnershipState): StopOwnedProcessEffectResult {
  return {
    status: 'drained',
    proof: {
      processRef: state.ownership.processRef,
      scope: state.ownership.scope,
      spawnNonceDigest: state.ownership.spawnNonceDigest,
      ownerAttestation: state.ownership.ownerAttestation,
      ownedProcessEof: {
        processRef: state.ownership.processRef,
        ownerAttestation: state.ownership.ownerAttestation,
        observed: true,
      },
      statusSequence: 2,
      outcome: 'drained',
      residuals: [],
    },
  };
}
