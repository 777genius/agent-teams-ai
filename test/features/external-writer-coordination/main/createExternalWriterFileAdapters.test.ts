import { mkdirSync, renameSync, watch, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ExternalFileReconciliationRequest,
  ExternalWriterObserver,
  type FileObservationStateCheckpoint,
} from '@features/external-writer-coordination';
import {
  createExternalWriterFileAdapters,
  type ExternalWriterFileAdapters,
  NodeExternalContentChecksum,
  NodeExternalFileObservationSource,
  type NodeExternalWriterNativeWatcher,
  type NodeExternalWriterWatchFactory,
  NodeExternalWriterWatchPort,
  RegisteredExternalFileCatalog,
  RegisteredExternalFileCatalogError,
} from '@features/external-writer-coordination/main';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId('team_11111111111111111111111111111111');

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

class FakeNativeWatcher implements NodeExternalWriterNativeWatcher {
  on(): NodeExternalWriterNativeWatcher {
    return this;
  }

  readonly close = vi.fn();
}

const createObserver = (
  adapters: ExternalWriterFileAdapters,
  reconciliations: ExternalFileReconciliationRequest[],
  onReconcile?: (request: ExternalFileReconciliationRequest) => void
): ExternalWriterObserver =>
  new ExternalWriterObserver(
    {
      ...adapters,
      reconciliation: {
        getResult: vi.fn().mockResolvedValue(null),
        async reconcile(request) {
          reconciliations.push(request);
          onReconcile?.(request);
          return {
            outcome: 'accepted_change',
            sourceGeneration: reconciliations.length,
            featureRevision: reconciliations.length,
          };
        },
      },
      stateStore: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
      },
      clock: {
        nowMs: () => Date.now(),
        sleep: async (delayMs) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        },
      },
    },
    {
      atomicReplaceDebounceMs: 0,
      retryDelayMs: 0,
    }
  );

describe('createExternalWriterFileAdapters', () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'external-writer-file-adapters-'));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  it('builds frozen real Node ports that integrate with the core startup scan', async () => {
    const filePath = join(fixtureRoot, 'task.json');
    await writeFile(filePath, 'abc');
    const adapters = createExternalWriterFileAdapters({
      files: [
        {
          rootPath: fixtureRoot,
          filePath,
          registration: {
            scope: { teamId, featureKey: 'tasks' },
            fileKey: 'task-1',
            maxBytes: 1_024,
            attributionPolicy: 'external_file_only',
          },
        },
      ],
      watchOptions: { persistent: false },
    });
    let checkpoint: FileObservationStateCheckpoint | null = null;
    const reconciliations: ExternalFileReconciliationRequest[] = [];
    const observer = new ExternalWriterObserver(
      {
        ...adapters,
        reconciliation: {
          getResult: vi.fn().mockResolvedValue(null),
          async reconcile(request) {
            reconciliations.push(request);
            return {
              outcome: 'accepted_change',
              sourceGeneration: 1,
              featureRevision: 1,
            };
          },
        },
        stateStore: {
          async load() {
            return checkpoint;
          },
          async save(nextCheckpoint) {
            checkpoint = nextCheckpoint;
          },
        },
        clock: {
          nowMs: () => Date.now(),
          sleep: async (delayMs) => {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, delayMs);
            });
          },
        },
      },
      {
        atomicReplaceDebounceMs: 0,
        retryDelayMs: 0,
      }
    );

    const started = await observer.start();

    expect(Object.isFrozen(adapters)).toBe(true);
    expect(adapters.catalog).toBeInstanceOf(RegisteredExternalFileCatalog);
    expect(adapters.watch).toBeInstanceOf(NodeExternalWriterWatchPort);
    expect(adapters.source).toBeInstanceOf(NodeExternalFileObservationSource);
    expect(adapters.checksums).toBeInstanceOf(NodeExternalContentChecksum);
    expect(started).toMatchObject({
      phase: 'running',
      acceptingNotifications: true,
      readiness: 'clean',
    });
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]).toMatchObject({
      content: new Uint8Array(Buffer.from('abc')),
      fingerprint: {
        exists: true,
        checksum: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
      actor: {
        kind: 'external_file',
        teamId,
        featureKey: 'tasks',
        fileKey: 'task-1',
      },
    });
    await expect(observer.shutdown(Date.now() + 2_000)).resolves.toMatchObject({
      status: 'clean',
      pendingObservationCount: 0,
    });
  });

  it('publishes deterministic SHA-256 checksums for byte content', () => {
    const checksum = new NodeExternalContentChecksum();

    expect(checksum.checksum(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(checksum.checksum(new Uint8Array(Buffer.from('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('reconciles the current parent after an A-to-B-to-A race while attaching fs.watch', async () => {
    const watchedParent = join(fixtureRoot, 'team');
    const originalWhileDetached = join(fixtureRoot, 'team-original');
    const decoyAfterAttach = join(fixtureRoot, 'team-decoy');
    mkdirSync(watchedParent);
    const filePath = join(watchedParent, 'task.json');
    writeFileSync(filePath, 'original-v1');
    const scope = { teamId, featureKey: 'tasks' } as const;
    let nativeWatchInput!: Parameters<NodeExternalWriterWatchFactory>[0];
    const watchFactory: NodeExternalWriterWatchFactory = (input) => {
      nativeWatchInput = input;
      // Attach to transient inode B, then restore catalogued inode A before
      // NodeExternalWriterWatchPort can run its post-watch identity check.
      renameSync(watchedParent, originalWhileDetached);
      mkdirSync(watchedParent);
      writeFileSync(join(watchedParent, 'task.json'), 'decoy');
      const nativeWatcher = watch(
        input.parentPath,
        { encoding: 'utf8', persistent: false, recursive: false },
        input.onEvent
      );
      renameSync(watchedParent, decoyAfterAttach);
      renameSync(originalWhileDetached, watchedParent);
      return nativeWatcher;
    };
    const adapters = createExternalWriterFileAdapters({
      files: [
        {
          rootPath: fixtureRoot,
          filePath,
          registration: {
            scope,
            fileKey: 'task-1',
            maxBytes: 1_024,
            attributionPolicy: 'external_file_only',
          },
        },
      ],
      watchOptions: { watchFactory, persistent: false },
    });
    const reconciliations: ExternalFileReconciliationRequest[] = [];
    const observer = createObserver(adapters, reconciliations);
    await observer.start();

    // Explicitly exercise and clear an ordinary recoverable overflow. The
    // attachment ABA is still invisible to both catalog identity checks.
    nativeWatchInput.onEvent('rename', null);
    await observer.rescanScope(scope);
    expect(observer.getSnapshot().readiness).toBe('clean');
    expect(adapters.watch.getInvalidations()).toEqual([]);
    expect(reconciliations.map(({ content }) => Buffer.from(content ?? []).toString())).toEqual([
      'original-v1',
    ]);

    await writeFile(filePath, 'original-v2');
    await vi.waitFor(
      () => {
        expect(reconciliations.map(({ content }) => Buffer.from(content ?? []).toString())).toEqual(
          ['original-v1', 'original-v2']
        );
        expect(observer.getSnapshot().readiness).toBe('clean');
      },
      { interval: 20, timeout: 2_500 }
    );

    expect(adapters.watch.getInvalidations()).toEqual([]);
    expect(observer.getSnapshot().readiness).toBe('clean');
    expect(reconciliations.map(({ content }) => Buffer.from(content ?? []).toString())).toEqual([
      'original-v1',
      'original-v2',
    ]);
    await expect(observer.shutdown(Date.now() + 2_000)).resolves.toMatchObject({
      status: 'clean',
    });
  });

  it('coalesces blocked periodic rescans and retains one reconciliation-bearing trailing edge', async () => {
    vi.useFakeTimers();
    try {
      const filePath = join(fixtureRoot, 'task.json');
      await writeFile(filePath, 'initial');
      const scope = { teamId, featureKey: 'tasks' } as const;
      const adapters = createExternalWriterFileAdapters({
        files: [
          {
            rootPath: fixtureRoot,
            filePath,
            registration: {
              scope,
              fileKey: 'task-1',
              maxBytes: 1_024,
              attributionPolicy: 'external_file_only',
            },
          },
        ],
        watchOptions: {
          watchFactory: () => new FakeNativeWatcher(),
        },
      });
      let catalogScanCount = 0;
      const catalog = {
        listScopes: () => adapters.catalog.listScopes(),
        listRegistrations(requestedScope: typeof scope) {
          catalogScanCount += 1;
          return adapters.catalog.listRegistrations(requestedScope);
        },
      };
      const firstPeriodicReconciliationEntered = deferred<void>();
      const releaseFirstPeriodicReconciliation = deferred<void>();
      const trailingReconciliationEntered = deferred<void>();
      const reconciledContents: string[] = [];
      const persistedReadiness: Array<'clean' | 'dirty'> = [];
      let reconciliationCall = 0;
      const observer = new ExternalWriterObserver(
        {
          ...adapters,
          catalog,
          reconciliation: {
            getResult: vi.fn().mockResolvedValue(null),
            async reconcile(request) {
              reconciliationCall += 1;
              const content = Buffer.from(request.content ?? []).toString();
              reconciledContents.push(content);
              if (reconciliationCall === 2) {
                firstPeriodicReconciliationEntered.resolve();
                await releaseFirstPeriodicReconciliation.promise;
              } else if (reconciliationCall === 3) {
                trailingReconciliationEntered.resolve();
              }
              return {
                outcome: 'accepted_change',
                sourceGeneration: reconciliationCall,
                featureRevision: reconciliationCall,
              };
            },
          },
          stateStore: {
            load: vi.fn().mockResolvedValue(null),
            async save(checkpoint) {
              persistedReadiness.push(
                checkpoint.dirtyScopes.length === 0 && checkpoint.pendingObservations.length === 0
                  ? 'clean'
                  : 'dirty'
              );
            },
          },
          clock: {
            nowMs: () => Date.now(),
            sleep: async (delayMs) => {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, delayMs);
              });
            },
          },
        },
        {
          atomicReplaceDebounceMs: 0,
          retryDelayMs: 0,
        }
      );
      await observer.start();
      const startupCatalogScanCount = catalogScanCount;
      persistedReadiness.length = 0;

      await writeFile(filePath, 'first-periodic-change');
      await vi.advanceTimersByTimeAsync(1_000);
      await firstPeriodicReconciliationEntered.promise;

      await writeFile(filePath, 'trailing-periodic-change');
      // Invoke the same watch group's periodic callback well beyond the
      // regression threshold while its first reconciliation remains blocked.
      for (let tick = 0; tick < 12; tick += 1) {
        vi.advanceTimersByTime(1_000);
      }
      expect(observer.getSnapshot().readiness).toBe('dirty');

      releaseFirstPeriodicReconciliation.resolve();
      await trailingReconciliationEntered.promise;
      await observer.recordSelfWriteIntent({
        intentId: 'post-periodic-drain-barrier',
        scope,
        fileKey: 'task-1',
        expectedChecksum: 'not-the-observed-checksum',
        sourceGeneration: 4,
        fileWriterEpoch: 1,
        expiresAtMs: Date.now() + 1_000,
      });

      expect(reconciledContents).toEqual([
        'initial',
        'first-periodic-change',
        'trailing-periodic-change',
      ]);
      expect(catalogScanCount - startupCatalogScanCount).toBe(4);
      expect(observer.getSnapshot().readiness).toBe('clean');
      const firstCleanPersistence = persistedReadiness.indexOf('clean');
      expect(firstCleanPersistence).toBeGreaterThanOrEqual(0);
      expect(persistedReadiness.slice(firstCleanPersistence)).toEqual(
        persistedReadiness.slice(firstCleanPersistence).map(() => 'clean')
      );
      await expect(observer.shutdown(Date.now() + 2_000)).resolves.toMatchObject({
        status: 'clean',
        pendingObservationCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a replaced-parent observer dirty until fresh adapters observe every later change', async () => {
    const registeredParent = join(fixtureRoot, 'team');
    const detachedParent = join(fixtureRoot, 'team-detached');
    const filePath = join(registeredParent, 'task.json');
    await mkdir(registeredParent);
    await writeFile(filePath, 'before-replacement');
    const registration = {
      scope: { teamId, featureKey: 'tasks' },
      fileKey: 'task-1',
      maxBytes: 1_024,
      attributionPolicy: 'external_file_only' as const,
    };
    const oldWatches: Parameters<NodeExternalWriterWatchFactory>[0][] = [];
    const invalidations = vi.fn();
    const oldAdapters = createExternalWriterFileAdapters({
      files: [{ rootPath: fixtureRoot, filePath, registration }],
      watchOptions: {
        onInvalidation: invalidations,
        watchFactory(input) {
          oldWatches.push(input);
          return new FakeNativeWatcher();
        },
      },
    });
    const oldReconciliations: ExternalFileReconciliationRequest[] = [];
    const oldObserver = createObserver(oldAdapters, oldReconciliations);
    await oldObserver.start();
    expect(
      oldReconciliations.map(({ content }) => content && Buffer.from(content).toString())
    ).toEqual(['before-replacement']);

    await rename(registeredParent, detachedParent);
    await mkdir(registeredParent);
    await writeFile(filePath, 'first-after-replacement');
    oldWatches[0].onEvent('rename', 'task.json');

    expect(invalidations).toHaveBeenCalledTimes(1);
    expect(invalidations).toHaveBeenCalledWith({
      kind: 'terminal_invalidation',
      reason: 'watched_identity_replaced',
      reestablishment: 'construct_and_start_fresh_catalog_and_port',
      scopes: [registration.scope],
    });
    await expect(oldObserver.rescanScope(registration.scope)).rejects.toThrowError(
      new RegisteredExternalFileCatalogError('watch_invalidated')
    );
    expect(oldObserver.getSnapshot()).toMatchObject({
      phase: 'running',
      readiness: 'dirty',
      checkpoint: {
        dirtyScopes: [
          expect.objectContaining({
            scope: registration.scope,
            reasons: expect.arrayContaining(['notification_overflow']),
          }),
        ],
      },
    });

    await writeFile(filePath, 'second-after-replacement');
    oldWatches[0].onEvent('change', 'task.json');
    expect(
      oldReconciliations.map(({ content }) => content && Buffer.from(content).toString())
    ).toEqual(['before-replacement']);

    const freshWatches: Parameters<NodeExternalWriterWatchFactory>[0][] = [];
    const freshAdapters = createExternalWriterFileAdapters({
      files: [{ rootPath: fixtureRoot, filePath, registration }],
      watchOptions: {
        watchFactory(input) {
          freshWatches.push(input);
          return new FakeNativeWatcher();
        },
      },
    });
    const freshReconciliations: ExternalFileReconciliationRequest[] = [];
    let resolveThirdObservation!: () => void;
    const thirdObservation = new Promise<void>((resolve) => {
      resolveThirdObservation = resolve;
    });
    const freshObserver = createObserver(freshAdapters, freshReconciliations, (request) => {
      if (
        request.content &&
        Buffer.from(request.content).toString() === 'third-after-replacement'
      ) {
        resolveThirdObservation();
      }
    });
    await freshObserver.start();
    expect(
      freshReconciliations.map(({ content }) => content && Buffer.from(content).toString())
    ).toEqual(['second-after-replacement']);

    await writeFile(filePath, 'third-after-replacement');
    freshWatches[0].onEvent('change', 'task.json');
    await thirdObservation;
    expect(
      freshReconciliations.map(({ content }) => content && Buffer.from(content).toString())
    ).toEqual(['second-after-replacement', 'third-after-replacement']);

    await expect(oldObserver.shutdown(Date.now() + 2_000)).resolves.toMatchObject({
      status: 'dirty',
    });
    await expect(freshObserver.shutdown(Date.now() + 2_000)).resolves.toMatchObject({
      status: 'clean',
    });
  });
});
