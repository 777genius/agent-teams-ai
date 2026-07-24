/* eslint-disable @typescript-eslint/require-await -- Async fakes intentionally implement asynchronous port contracts. */
import {
  type ExternalFileObservationCatalog,
  type ExternalFileObservationSource,
  type ExternalFileReconciliationRequest,
  type ExternalFileReconciliationResult,
  type ExternalFileRegistration,
  type ExternalFileStat,
  type ExternalWriterObservationStateStore,
  ExternalWriterObserver,
  type ExternalWriterScope,
  type ExternalWriterWatchCallbacks,
  type FileObservationStateCheckpoint,
  type VerifiedRunEvidencePort,
} from '@features/external-writer-coordination';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId('team_22222222222222222222222222222222');
const otherTeamId = parseTeamId('team_33333333333333333333333333333333');
const scope = { teamId, featureKey: 'tasks' } as const;
const otherScope = { teamId: otherTeamId, featureKey: 'inboxes' } as const;

const bytes = (value: string): Uint8Array =>
  new Uint8Array([...value].map((character) => character.codePointAt(0)!));

const checksum = (content: Uint8Array): string => `sum:${[...content].join(',')}`;

const fileStat = (content: Uint8Array, stamp = '1'): ExternalFileStat => ({
  kind: 'file',
  contained: true,
  byteLength: content.byteLength,
  device: 'device-1',
  inode: 'inode-1',
  modifiedTimeNs: stamp,
  changedTimeNs: stamp,
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

class MemoryStateStore implements ExternalWriterObservationStateStore {
  checkpoint: FileObservationStateCheckpoint | null = null;
  readonly saves: FileObservationStateCheckpoint[] = [];

  async load(): Promise<FileObservationStateCheckpoint | null> {
    return this.checkpoint;
  }

  async save(checkpoint: FileObservationStateCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
    this.saves.push(checkpoint);
  }
}

class FakeClock {
  now = 0;

  nowMs(): number {
    return this.now;
  }

  async sleep(delayMs: number): Promise<void> {
    this.now += delayMs;
  }
}

interface HarnessOptions {
  scopes?: readonly ExternalWriterScope[];
  registrations?: readonly ExternalFileRegistration[];
  source?: ExternalFileObservationSource;
  stateStore?: MemoryStateStore;
  verifiedRunEvidence?: VerifiedRunEvidencePort;
  onWatchStart?: (callbacks: ExternalWriterWatchCallbacks) => void;
  reconcile?: (request: ExternalFileReconciliationRequest) => Promise<{
    outcome: string;
    sourceGeneration?: number;
    featureRevision?: number;
    diagnosticCode?: string;
    blocksDependentMutations?: boolean;
  }>;
  getReconciliationResult?: (
    reconciliationId: string
  ) => Promise<ExternalFileReconciliationResult | null>;
}

const createHarness = (options: HarnessOptions = {}) => {
  const order: string[] = [];
  let callbacks: ExternalWriterWatchCallbacks | null = null;
  const defaultRegistration: ExternalFileRegistration = {
    scope,
    fileKey: 'task-1',
    maxBytes: 1_024,
    attributionPolicy: 'external_file_only',
  };
  const registrations = options.registrations ?? [defaultRegistration];
  const contents = new Map<string, Uint8Array>([
    ['task-1', bytes('{"owner":"forged","runId":"forged"}')],
    ['inbox-1', bytes('inbox')],
  ]);
  const source: ExternalFileObservationSource =
    options.source ??
    ({
      async stat(registration) {
        const content = contents.get(registration.fileKey);
        return content
          ? fileStat(content)
          : {
              kind: 'missing',
              contained: true,
              byteLength: 0,
              device: null,
              inode: null,
              modifiedTimeNs: null,
              changedTimeNs: null,
            };
      },
      async read(registration) {
        return contents.get(registration.fileKey)!;
      },
      async confirmAbsentByParentRescan() {
        return true;
      },
    } satisfies ExternalFileObservationSource);
  const catalog: ExternalFileObservationCatalog = {
    async listScopes() {
      order.push('catalog:list-scopes');
      return options.scopes ?? [scope];
    },
    async listRegistrations(requestedScope) {
      order.push(`catalog:list:${requestedScope.featureKey}`);
      return registrations.filter(
        (registration) =>
          registration.scope.teamId === requestedScope.teamId &&
          registration.scope.featureKey === requestedScope.featureKey
      );
    },
  };
  const reconciliations: ExternalFileReconciliationRequest[] = [];
  const reconciliationResults = new Map<string, ExternalFileReconciliationResult>();
  let generation = 0;
  const stateStore = options.stateStore ?? new MemoryStateStore();
  const observer = new ExternalWriterObserver(
    {
      watch: {
        async start(watchCallbacks) {
          order.push('watch:start');
          callbacks = watchCallbacks;
          options.onWatchStart?.(watchCallbacks);
          return { close: vi.fn(async () => undefined) };
        },
      },
      catalog,
      source,
      checksums: { checksum },
      reconciliation: {
        async getResult(reconciliationId) {
          if (options.getReconciliationResult) {
            return options.getReconciliationResult(reconciliationId);
          }
          return reconciliationResults.get(reconciliationId) ?? null;
        },
        async reconcile(request) {
          order.push('reconcile');
          reconciliations.push(request);
          if (options.reconcile) {
            const result = await options.reconcile(request);
            if (
              result.outcome === 'accepted_change' ||
              result.outcome === 'semantic_noop' ||
              result.outcome === 'invalid' ||
              result.outcome === 'conflict'
            ) {
              reconciliationResults.set(
                request.reconciliationId,
                result as ExternalFileReconciliationResult
              );
            }
            return result as never;
          }
          generation += 1;
          const result: ExternalFileReconciliationResult = {
            outcome: 'accepted_change',
            sourceGeneration: generation,
            featureRevision: generation,
          };
          reconciliationResults.set(request.reconciliationId, result);
          return result;
        },
      },
      stateStore,
      clock: new FakeClock(),
      verifiedRunEvidence: options.verifiedRunEvidence,
    },
    {
      retryDelayMs: 1,
      atomicReplaceDebounceMs: 1,
      stableReadDeadlineMs: 100,
      shutdownDrainDeadlineMs: 100,
    }
  );
  return {
    observer,
    order,
    get callbacks() {
      return callbacks!;
    },
    contents,
    reconciliations,
    stateStore,
  };
};

describe('ExternalWriterObserver', () => {
  it('registers the watch before scanning and retries a hostile stat/read/stat replacement', async () => {
    const oldContent = bytes('old');
    const newContent = bytes('new');
    let statCalls = 0;
    const source: ExternalFileObservationSource = {
      async stat() {
        statCalls += 1;
        return fileStat(statCalls === 1 ? oldContent : newContent, statCalls === 1 ? '1' : '2');
      },
      async read() {
        return newContent;
      },
      async confirmAbsentByParentRescan() {
        return false;
      },
    };
    const harness = createHarness({
      source,
      onWatchStart(callbacks) {
        callbacks.onNotification({ kind: 'change', scope, fileKey: 'task-1' });
      },
    });

    await harness.observer.start();

    expect(harness.order[0]).toBe('watch:start');
    expect(harness.order.indexOf('watch:start')).toBeLessThan(
      harness.order.indexOf('catalog:list-scopes')
    );
    expect(harness.order.indexOf('catalog:list:tasks')).toBeLessThan(
      harness.order.indexOf('reconcile')
    );
    expect(statCalls).toBe(4);
    expect(harness.reconciliations).toHaveLength(1);
    expect(harness.reconciliations[0]).toMatchObject({
      fingerprint: { checksum: checksum(newContent) },
      actor: { kind: 'external_file', teamId },
      fileWriterEpoch: 1,
    });
    expect(harness.reconciliations[0].actor).not.toHaveProperty('runId');
  });

  it('uses checksum self-write suppression and still observes the immediate crossing external write', async () => {
    const harness = createHarness();
    await harness.observer.start();
    expect(harness.reconciliations).toHaveLength(1);

    const selfContent = bytes('self-write');
    await harness.observer.recordSelfWriteIntent({
      intentId: 'self-1',
      scope,
      fileKey: 'task-1',
      expectedChecksum: checksum(selfContent),
      sourceGeneration: 2,
      fileWriterEpoch: 1,
      expiresAtMs: 1_000,
    });
    harness.contents.set('task-1', selfContent);
    harness.callbacks.onNotification({ kind: 'rename', scope, fileKey: 'task-1' });
    await harness.observer.rescanScope(scope);
    expect(harness.reconciliations).toHaveLength(1);

    const hostileContent = bytes('external-after-self');
    harness.contents.set('task-1', hostileContent);
    harness.callbacks.onNotification({ kind: 'change', scope, fileKey: 'task-1' });
    await harness.observer.rescanScope(scope);

    expect(harness.reconciliations).toHaveLength(2);
    expect(harness.reconciliations[1]).toMatchObject({
      fingerprint: { checksum: checksum(hostileContent) },
      actor: { kind: 'external_file' },
    });
  });

  it('re-drains a newer notification coalesced while reconciliation is awaiting', async () => {
    const reconciliationEntered = deferred<void>();
    const releaseReconciliation = deferred<{
      outcome: 'accepted_change';
      sourceGeneration: number;
      featureRevision: number;
    }>();
    let call = 0;
    const harness = createHarness({
      async reconcile() {
        call += 1;
        if (call === 2) {
          reconciliationEntered.resolve();
          return releaseReconciliation.promise;
        }
        return {
          outcome: 'accepted_change',
          sourceGeneration: call,
          featureRevision: call,
        };
      },
    });
    await harness.observer.start();

    const firstExternalWrite = bytes('first-external-write');
    harness.contents.set('task-1', firstExternalWrite);
    harness.callbacks.onNotification({ kind: 'change', scope, fileKey: 'task-1' });
    await reconciliationEntered.promise;

    const crossingExternalWrite = bytes('crossing-external-write');
    harness.contents.set('task-1', crossingExternalWrite);
    harness.callbacks.onNotification({ kind: 'rename', scope, fileKey: 'task-1' });
    releaseReconciliation.resolve({
      outcome: 'accepted_change',
      sourceGeneration: 2,
      featureRevision: 2,
    });

    const handoff = await harness.observer.shutdown(1_000);
    expect(harness.reconciliations.map((request) => request.fingerprint.checksum)).toEqual([
      checksum(bytes('{"owner":"forged","runId":"forged"}')),
      checksum(firstExternalWrite),
      checksum(crossingExternalWrite),
    ]);
    expect(handoff.pendingObservationCount).toBe(0);
    expect(handoff.persistedWatermark).toBe(handoff.capturedSequence);
  });

  it('recovers after restart from commit-then-throw without committing twice', async () => {
    const durableResults = new Map<string, ExternalFileReconciliationResult>();
    const stateStore = new MemoryStateStore();
    let resultLookupAvailable = false;
    let durableCommitCount = 0;
    const reconciliationIds: string[] = [];
    const reconciliation = {
      async getReconciliationResult(reconciliationId) {
        if (!resultLookupAvailable) {
          throw new Error('durable result store temporarily unavailable');
        }
        return durableResults.get(reconciliationId) ?? null;
      },
      async reconcile(request) {
        reconciliationIds.push(request.reconciliationId);
        const result: ExternalFileReconciliationResult = {
          outcome: 'accepted_change',
          sourceGeneration: 1,
          featureRevision: 1,
        };
        durableResults.set(request.reconciliationId, result);
        durableCommitCount += 1;
        throw new Error('response lost after durable commit');
      },
    } satisfies Pick<HarnessOptions, 'getReconciliationResult' | 'reconcile'>;
    const first = createHarness({ ...reconciliation, stateStore });

    const interrupted = await first.observer.start();
    const handoff = await first.observer.shutdown(1_000);

    expect(durableCommitCount).toBe(1);
    expect(reconciliationIds).toHaveLength(1);
    expect(durableResults.get(reconciliationIds[0]!)).toEqual({
      outcome: 'accepted_change',
      sourceGeneration: 1,
      featureRevision: 1,
    });
    expect(interrupted.readiness).toBe('dirty');
    expect(handoff.status).toBe('dirty');
    expect(handoff.pendingObservationCount).toBe(1);
    expect(
      stateStore.saves.some(
        (saved) =>
          saved.pendingObservations[0]?.reconciliation?.reconciliationId === reconciliationIds[0]
      )
    ).toBe(true);

    resultLookupAvailable = true;
    const restarted = createHarness({ ...reconciliation, stateStore });
    const recovered = await restarted.observer.start();

    expect(durableCommitCount).toBe(1);
    expect(restarted.reconciliations).toHaveLength(0);
    expect(recovered.readiness).toBe('clean');
    expect(recovered.checkpoint.pendingObservations).toHaveLength(0);
    expect(recovered.checkpoint.observedFiles).toHaveLength(1);
  });

  it('drains and persists a notification accepted during the startup final save', async () => {
    const finalSaveEntered = deferred<void>();
    const releaseFinalSave = deferred<void>();
    class BlockingStartupStateStore extends MemoryStateStore {
      private blockedFinalSave = false;

      override async save(checkpoint: FileObservationStateCheckpoint): Promise<void> {
        await super.save(checkpoint);
        if (!this.blockedFinalSave && checkpoint.pendingObservations.length === 0) {
          this.blockedFinalSave = true;
          finalSaveEntered.resolve();
          await releaseFinalSave.promise;
        }
      }
    }
    const stateStore = new BlockingStartupStateStore();
    const harness = createHarness({ stateStore });
    const starting = harness.observer.start();
    await finalSaveEntered.promise;

    const duringSave = bytes('arrived-during-startup-save');
    harness.contents.set('task-1', duringSave);
    harness.callbacks.onNotification({ kind: 'change', scope, fileKey: 'task-1' });
    releaseFinalSave.resolve();
    await starting;

    await harness.observer.recordSelfWriteIntent({
      intentId: 'post-start-barrier',
      scope,
      fileKey: 'task-1',
      expectedChecksum: 'not-the-observed-checksum',
      sourceGeneration: 2,
      fileWriterEpoch: 1,
      expiresAtMs: 1_000,
    });
    expect(harness.reconciliations.at(-1)?.fingerprint.checksum).toBe(checksum(duringSave));
    expect(harness.stateStore.checkpoint).toMatchObject({
      pendingObservations: [],
      observationWatermark: harness.stateStore.checkpoint?.lastObservationSequence,
    });
  });

  it('automatically catches up an overflow that lands inside the startup scan', async () => {
    let call = 0;
    const holder: { current: ReturnType<typeof createHarness> | null } = { current: null };
    const postOverflowContent = bytes('write-hidden-by-startup-overflow');
    const harness = createHarness({
      async reconcile() {
        call += 1;
        if (call === 1) {
          holder.current!.contents.set('task-1', postOverflowContent);
          holder.current!.callbacks.onOverflow({ scopes: [scope] });
        }
        return {
          outcome: 'accepted_change',
          sourceGeneration: call,
          featureRevision: call,
        };
      },
    });
    holder.current = harness;

    await harness.observer.start();
    await harness.observer.recordSelfWriteIntent({
      intentId: 'startup-catch-up-barrier',
      scope,
      fileKey: 'task-1',
      expectedChecksum: 'different-checksum',
      sourceGeneration: 2,
      fileWriterEpoch: 1,
      expiresAtMs: 1_000,
    });

    expect(harness.reconciliations.map((request) => request.fingerprint.checksum)).toEqual([
      checksum(bytes('{"owner":"forged","runId":"forged"}')),
      checksum(postOverflowContent),
    ]);
    expect(harness.observer.getSnapshot().checkpoint.dirtyScopes).toHaveLength(0);
    expect(harness.stateStore.checkpoint).toMatchObject({
      pendingObservations: [],
      dirtyScopes: [],
      observationWatermark: harness.stateStore.checkpoint?.lastObservationSequence,
    });
  });

  it('repairs notification loss and overflow with only the affected scoped catalog scan', async () => {
    const registrations: ExternalFileRegistration[] = [
      {
        scope,
        fileKey: 'task-1',
        maxBytes: 1_024,
        attributionPolicy: 'external_file_only',
      },
      {
        scope: otherScope,
        fileKey: 'inbox-1',
        maxBytes: 1_024,
        attributionPolicy: 'external_file_only',
      },
    ];
    const harness = createHarness({ scopes: [scope, otherScope], registrations });
    await harness.observer.start();
    const initialOtherScans = harness.order.filter(
      (entry) => entry === 'catalog:list:inboxes'
    ).length;

    harness.contents.set('task-1', bytes('missed-native-event'));
    await harness.observer.rescanScope(scope);
    expect(harness.reconciliations.at(-1)?.fingerprint.checksum).toBe(
      checksum(bytes('missed-native-event'))
    );

    harness.callbacks.onOverflow({ scopes: [scope] });
    const handoff = await harness.observer.shutdown();
    const finalOtherScans = harness.order.filter(
      (entry) => entry === 'catalog:list:inboxes'
    ).length;

    expect(finalOtherScans).toBe(initialOtherScans);
    expect(
      harness.stateStore.saves.some((saved) =>
        saved.dirtyScopes.some((dirty) => dirty.reasons.includes('notification_overflow'))
      )
    ).toBe(true);
    expect(handoff.status).toBe('clean');
  });

  it('persists corrupt/unstable dirty handoff and repairs it during watch-before-scan restart', async () => {
    let unstable = false;
    let stamp = 0;
    const content = bytes('stable');
    const source: ExternalFileObservationSource = {
      async stat() {
        stamp += 1;
        return fileStat(content, unstable ? String(stamp) : 'stable');
      },
      async read() {
        return content;
      },
      async confirmAbsentByParentRescan() {
        return false;
      },
    };
    const stateStore = new MemoryStateStore();
    const first = createHarness({ source, stateStore });
    await first.observer.start();
    unstable = true;
    first.callbacks.onNotification({ kind: 'change', scope, fileKey: 'task-1' });
    const dirtyHandoff = await first.observer.shutdown(1_000);

    expect(dirtyHandoff.status).toBe('dirty');
    expect(dirtyHandoff.dirtyScopes[0]?.reasons).toContain('unstable');
    expect(stateStore.checkpoint?.dirtyScopes).not.toHaveLength(0);

    unstable = false;
    const restarted = createHarness({ source, stateStore });
    const recovered = await restarted.observer.start();
    expect(recovered.checkpoint.dirtyScopes).toHaveLength(0);
    expect(recovered.checkpoint.observationWatermark).toBe(
      recovered.checkpoint.lastObservationSequence
    );
  });

  it('retains the last valid projection through repeated corrupt reads, then clears only after repair', async () => {
    let valid = false;
    const harness = createHarness({
      async reconcile() {
        return valid
          ? { outcome: 'accepted_change', sourceGeneration: 1, featureRevision: 1 }
          : {
              outcome: 'invalid',
              diagnosticCode: 'partial_json',
              blocksDependentMutations: true,
            };
      },
    });

    const started = await harness.observer.start();
    expect(started.readiness).toBe('dirty');
    expect(started.checkpoint.observedFiles).toHaveLength(0);
    expect(started.checkpoint.dirtyScopes[0]?.reasons).toContain('corrupt');

    const stillCorrupt = await harness.observer.rescanScope(scope);
    expect(stillCorrupt.checkpoint.observedFiles).toHaveLength(0);
    expect(stillCorrupt.checkpoint.dirtyScopes[0]?.latestSequence).toBeGreaterThan(1);

    valid = true;
    const repaired = await harness.observer.rescanScope(scope);
    expect(repaired.readiness).toBe('clean');
    expect(repaired.checkpoint.dirtyScopes).toHaveLength(0);
    expect(repaired.checkpoint.observedFiles).toHaveLength(1);
    expect(repaired.checkpoint.observationWatermark).toBe(
      repaired.checkpoint.lastObservationSequence
    );
  });

  it('fails closed when reconciliation returns an unknown future discriminator', async () => {
    const harness = createHarness({
      async reconcile() {
        return {
          outcome: 'future_automatic_acceptance',
          sourceGeneration: 1,
          featureRevision: 1,
        };
      },
    });

    const started = await harness.observer.start();
    expect(started.readiness).toBe('dirty');
    expect(started.checkpoint.observedFiles).toHaveLength(0);
    expect(started.checkpoint.dirtyScopes[0]?.reasons).toContain('reconciliation_conflict');
    expect(harness.reconciliations).toHaveLength(1);
  });

  it('rejects catalog attribution policies outside the exact allowed set', async () => {
    const registration = {
      scope,
      fileKey: 'task-1',
      maxBytes: 1_024,
      attributionPolicy: 'trust_claimed_run_fields',
    } as unknown as ExternalFileRegistration;
    const harness = createHarness({ registrations: [registration] });

    const started = await harness.observer.start();
    expect(started.readiness).toBe('dirty');
    expect(started.checkpoint.dirtyScopes[0]?.reasons).toContain('catalog_changed');
    expect(harness.reconciliations).toHaveLength(0);
  });

  it('confirms deletion by parent rescan and converges across delete/recreate at the same mtime', async () => {
    let content: Uint8Array | null = bytes('before-delete');
    const confirmAbsentByParentRescan = vi.fn(async () => content === null);
    const source: ExternalFileObservationSource = {
      async stat() {
        return content
          ? fileStat(content, 'unchanged-mtime')
          : {
              kind: 'missing',
              contained: true,
              byteLength: 0,
              device: null,
              inode: null,
              modifiedTimeNs: null,
              changedTimeNs: null,
            };
      },
      async read() {
        return content!;
      },
      confirmAbsentByParentRescan,
    };
    const harness = createHarness({ source });
    await harness.observer.start();

    content = null;
    harness.callbacks.onNotification({ kind: 'delete', scope, fileKey: 'task-1' });
    await harness.observer.rescanScope(scope);
    expect(confirmAbsentByParentRescan).toHaveBeenCalled();
    expect(harness.reconciliations.at(-1)).toMatchObject({
      content: null,
      fingerprint: { exists: false, checksum: null },
    });

    content = bytes('recreated-with-same-mtime');
    harness.callbacks.onNotification({ kind: 'rename', scope, fileKey: 'task-1' });
    await harness.observer.rescanScope(scope);
    expect(harness.reconciliations.at(-1)).toMatchObject({
      fingerprint: { exists: true, checksum: checksum(content) },
      actor: { kind: 'external_file' },
    });
  });

  it('advances fileWriterEpoch only from a fresh bounded quiescence proof', async () => {
    const harness = createHarness();
    await harness.observer.start();

    const quiescence = await harness.observer.quiesceTeam(teamId, 1_000);
    expect(quiescence.outcome).toBe('quiesced');
    if (quiescence.outcome !== 'quiesced') {
      throw new Error('expected quiescence proof');
    }
    await expect(
      harness.observer.advanceFileWriterEpoch({
        teamId,
        expectedEpoch: quiescence.proof.fileWriterEpoch,
        observationWatermark: quiescence.proof.observationWatermark,
      })
    ).resolves.toBe(2);
    expect(harness.stateStore.checkpoint?.fileWriterEpochs).toContainEqual({ teamId, epoch: 2 });
  });

  it('revalidates Team-local state when a notification arrives during quiescence persistence', async () => {
    const persistenceEntered = deferred<void>();
    const releasePersistence = deferred<void>();
    class BlockingQuiescenceStateStore extends MemoryStateStore {
      blockNextSave = false;

      override async save(checkpoint: FileObservationStateCheckpoint): Promise<void> {
        await super.save(checkpoint);
        if (this.blockNextSave) {
          this.blockNextSave = false;
          persistenceEntered.resolve();
          await releasePersistence.promise;
        }
      }
    }
    const stateStore = new BlockingQuiescenceStateStore();
    const harness = createHarness({ stateStore });
    await harness.observer.start();
    stateStore.blockNextSave = true;

    const quiescing = harness.observer.quiesceTeam(teamId, 1_000);
    await persistenceEntered.promise;
    const persistedSequence = stateStore.checkpoint!.lastObservationSequence;
    const duringPersistence = bytes('notification-during-quiescence-persistence');
    harness.contents.set('task-1', duringPersistence);
    harness.callbacks.onNotification({ kind: 'change', scope, fileKey: 'task-1' });
    const notificationSequence = harness.observer.getSnapshot().checkpoint.lastObservationSequence;
    expect(notificationSequence).toBeGreaterThan(persistedSequence);
    releasePersistence.resolve();

    const quiescence = await quiescing;
    expect(quiescence.outcome).toBe('quiesced');
    if (quiescence.outcome !== 'quiesced') {
      throw new Error('expected refreshed quiescence proof');
    }
    const liveCheckpoint = harness.observer.getSnapshot().checkpoint;
    const teamWatermark = liveCheckpoint.teamObservationWatermarks.find(
      (record) => record.teamId === teamId
    );
    expect(quiescence.proof.observationWatermark).toBeGreaterThanOrEqual(notificationSequence);
    expect(teamWatermark).toMatchObject({
      lastObservationSequence: quiescence.proof.observationWatermark,
      observationWatermark: quiescence.proof.observationWatermark,
    });
    expect(
      liveCheckpoint.pendingObservations.filter((pending) => pending.scope.teamId === teamId)
    ).toHaveLength(0);
    expect(harness.reconciliations.at(-1)?.fingerprint.checksum).toBe(checksum(duringPersistence));
  });

  it('quiesces Team A and advances its epoch while dirty Team B blocks the global watermark', async () => {
    const registrations: ExternalFileRegistration[] = [
      {
        scope,
        fileKey: 'task-1',
        maxBytes: 1_024,
        attributionPolicy: 'external_file_only',
      },
      {
        scope: otherScope,
        fileKey: 'inbox-1',
        maxBytes: 1_024,
        attributionPolicy: 'external_file_only',
      },
    ];
    const harness = createHarness({
      scopes: [scope, otherScope],
      registrations,
      async reconcile(request) {
        return request.registration.scope.teamId === otherTeamId
          ? {
              outcome: 'invalid',
              diagnosticCode: 'team_b_corrupt',
              blocksDependentMutations: true,
            }
          : {
              outcome: 'accepted_change',
              sourceGeneration: 1,
              featureRevision: 1,
            };
      },
    });
    const started = await harness.observer.start();
    expect(started.checkpoint.dirtyScopes).toEqual([
      expect.objectContaining({ scope: otherScope, reasons: ['corrupt'] }),
    ]);

    const quiescence = await harness.observer.quiesceTeam(teamId, 1_000);

    expect(quiescence.outcome).toBe('quiesced');
    if (quiescence.outcome !== 'quiesced') {
      throw new Error('expected Team A quiescence proof');
    }
    const beforeAdvance = harness.observer.getSnapshot().checkpoint;
    expect(quiescence.proof.observationWatermark).toBeGreaterThan(
      beforeAdvance.observationWatermark
    );
    expect(beforeAdvance.dirtyScopes).toEqual([expect.objectContaining({ scope: otherScope })]);
    await expect(
      harness.observer.advanceFileWriterEpoch({
        teamId,
        expectedEpoch: quiescence.proof.fileWriterEpoch,
        observationWatermark: quiescence.proof.observationWatermark,
      })
    ).resolves.toBe(2);
    expect(harness.stateStore.checkpoint?.dirtyScopes).toEqual([
      expect.objectContaining({ scope: otherScope }),
    ]);
  });

  it('uses verified-run attribution only after exact provider evidence validates', async () => {
    const registration: ExternalFileRegistration = {
      scope,
      fileKey: 'task-1',
      maxBytes: 1_024,
      attributionPolicy: 'verified_run_evidence',
    };
    const verify = vi
      .fn<VerifiedRunEvidencePort['verify']>()
      .mockResolvedValueOnce({
        kind: 'verified_run',
        teamId: otherTeamId,
        runId: 'forged-run',
        runGeneration: 9,
        memberId: 'forged-member',
        evidenceRef: 'wrong-team-evidence',
      })
      .mockResolvedValue({
        kind: 'verified_run',
        teamId,
        runId: 'run-proven-by-provider',
        runGeneration: 3,
        memberId: 'member-proven-by-provider',
        evidenceRef: 'provider-manifest:3',
      });
    const harness = createHarness({
      registrations: [registration],
      verifiedRunEvidence: { verify },
    });

    await harness.observer.start();
    expect(harness.reconciliations[0].actor).toMatchObject({ kind: 'external_file', teamId });

    harness.contents.set('task-1', bytes('provider-verified-change'));
    harness.callbacks.onNotification({ kind: 'change', scope, fileKey: 'task-1' });
    await harness.observer.rescanScope(scope);

    expect(harness.reconciliations.at(-1)?.actor).toEqual({
      kind: 'verified_run',
      teamId,
      runId: 'run-proven-by-provider',
      runGeneration: 3,
      memberId: 'member-proven-by-provider',
      evidenceRef: 'provider-manifest:3',
    });
  });
});
