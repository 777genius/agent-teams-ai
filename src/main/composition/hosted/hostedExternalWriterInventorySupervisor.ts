import { createHash } from 'node:crypto';

import {
  type ExternalFileReconciliationPort,
  type ExternalWriterCleanHandoffEligibilityPlan,
  type ExternalWriterObservationStateStore,
  ExternalWriterObserver,
  type ExternalWriterObserverClock,
  type ExternalWriterObserverOptions,
  type ExternalWriterObserverSnapshot,
  type ExternalWriterScope,
  type ExternalWriterShutdownHandoff,
  type FileObservationStateCheckpoint,
  type VerifiedRunEvidencePort,
} from '@features/external-writer-coordination';
// eslint-disable-next-line no-restricted-imports -- Hosted composition owns the exact Node file adapters.
import { createExternalWriterFileAdapters } from '@features/external-writer-coordination/main/hosted';

import type { HostedExternalWriterStageTracker } from './hostedExternalWriterStageTracker';
import type {
  NodeExternalWriterWatchPortOptions,
  RegisteredExternalFileDefinition,
} from '@features/external-writer-coordination/main';
import type { TeamIdentityRecord } from '@features/internal-storage/contracts';

export type { HostedExternalWriterTaskInventoryOptions } from './hostedExternalWriterTaskInventory';
export { HostedExternalWriterTaskInventory } from './hostedExternalWriterTaskInventory';

const DEFAULT_CONVERGENCE_INTERVAL_MS = 1_000;
const DEFAULT_REBUILD_DRAIN_MS = 5_000;
/**
 * An observer generation holds its open self-write operations only in memory, so a rebuild while
 * one is open would lose it. A rebuild waits this long at most: a stuck Owner exchange or release
 * then only costs an external-write classification of those files, which invalidates the board.
 */
const DEFAULT_SELF_WRITE_REBUILD_HOLD_MS = 30_000;

export type HostedExternalWriterSupervisorPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'dirty'
  | 'stopping'
  | 'stopped';

export interface HostedExternalWriterInventorySnapshot {
  readonly catalogToken: string;
  readonly definitions: readonly RegisteredExternalFileDefinition[];
  readonly retiredTeams: readonly HostedExternalWriterRetiredTeamProof[];
}

export interface HostedExternalWriterRetiredTeamProof {
  readonly teamId: TeamIdentityRecord['teamId'];
  readonly identityChecksum: NonNullable<TeamIdentityRecord['identityChecksum']>;
  readonly tombstonedAt: NonNullable<TeamIdentityRecord['tombstonedAt']>;
}

export interface HostedExternalWriterInventorySource {
  capture(
    retirementCandidates?: readonly TeamIdentityRecord['teamId'][]
  ): Promise<HostedExternalWriterInventorySnapshot>;
}

export interface HostedExternalWriterObserverHandle {
  start(): Promise<ExternalWriterObserverSnapshot>;
  rescanScope(scope: ExternalWriterScope): Promise<ExternalWriterObserverSnapshot>;
  shutdown(
    deadlineMs?: number,
    cleanHandoffPlan?: ExternalWriterCleanHandoffEligibilityPlan
  ): Promise<ExternalWriterShutdownHandoff>;
  retryCleanHandoffEligibility(): Promise<ExternalWriterShutdownHandoff>;
  getSnapshot(): ExternalWriterObserverSnapshot;
  beginSelfWriteOperation?(operationId: string, scope: ExternalWriterScope): Promise<void>;
  completeSelfWriteOperation?(
    operationId: string,
    effects: readonly { readonly fileKey: string; readonly expectedChecksum: string }[]
  ): Promise<void>;
  abortSelfWriteOperation?(operationId: string): Promise<void>;
}

export interface HostedExternalWriterInventorySupervisorSnapshot {
  readonly phase: HostedExternalWriterSupervisorPhase;
  readonly catalogRevision: number;
  readonly registeredFileCount: number;
  readonly observer: ExternalWriterObserverSnapshot | null;
  readonly dirtyHandoff: ExternalWriterShutdownHandoff | null;
  readonly diagnosticCode: string | null;
}

export interface HostedExternalWriterInventorySupervisorDependencies {
  readonly inventory: HostedExternalWriterInventorySource;
  readonly reconciliation: ExternalFileReconciliationPort;
  /** Must be backed by the durable hosted storage owner. */
  readonly stateStore: ExternalWriterObservationStateStore;
  readonly clock: ExternalWriterObserverClock;
  readonly verifiedRunEvidence?: VerifiedRunEvidencePort;
  readonly observerOptions?: Partial<ExternalWriterObserverOptions>;
  readonly watchOptions?: NodeExternalWriterWatchPortOptions;
  readonly convergenceIntervalMs?: number;
  /** Optional production throttle for unchanged-catalog safety rescans. Inventory still converges each interval. */
  readonly stableCatalogRescanIntervalMs?: number;
  readonly rebuildDrainMs?: number;
  readonly selfWriteRebuildHoldMs?: number;
  /** Hang diagnostics: fixed operation/stage codes and the observer port calls still pending. */
  readonly diagnostics?: HostedExternalWriterStageTracker;
  readonly observerFactory?: (
    definitions: readonly RegisteredExternalFileDefinition[]
  ) => HostedExternalWriterObserverHandle;
}

function handoffId(oldCatalogToken: string, next: HostedExternalWriterInventorySnapshot): string {
  return createHash('sha256')
    .update(
      ['hosted-external-writer-handoff/v1', oldCatalogToken, next.catalogToken].join('\0'),
      'utf8'
    )
    .digest('hex');
}

function cleanHandoffFromCheckpoint(
  checkpoint: FileObservationStateCheckpoint
): ExternalWriterShutdownHandoff {
  return Object.freeze({
    status: 'clean',
    capturedSequence: checkpoint.lastObservationSequence,
    persistedWatermark: checkpoint.observationWatermark,
    dirtyScopes: Object.freeze([]),
    pendingObservationCount: 0,
  });
}

function validDuration(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 1) {
    throw new TypeError('hosted-external-writer-supervisor-duration-invalid');
  }
  return selected;
}

/** Owns exactly one long-lived observer generation and rebuilds it only at a clean checkpoint. */
export class HostedExternalWriterInventorySupervisor {
  private phase: HostedExternalWriterSupervisorPhase = 'idle';
  private observer: HostedExternalWriterObserverHandle | null = null;
  private inventory: HostedExternalWriterInventorySnapshot | null = null;
  private catalogRevision = 0;
  private dirtyHandoff: ExternalWriterShutdownHandoff | null = null;
  private diagnosticCode: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private stopRequested = false;
  private shutdownPromise: Promise<ExternalWriterShutdownHandoff | null> | null = null;
  private pendingReplacement: {
    readonly inventory: HostedExternalWriterInventorySnapshot;
    readonly sealingObserver: HostedExternalWriterObserverHandle | null;
    readonly handoff: ExternalWriterShutdownHandoff | null;
    attempts: number;
  } | null = null;
  private readonly convergenceIntervalMs: number;
  private readonly stableCatalogRescanIntervalMs: number | null;
  private readonly rebuildDrainMs: number;
  private readonly selfWriteRebuildHoldMs: number;
  private lastStableCatalogRescanAtMs: number | null = null;
  /** Open self-write operations of the current observer generation and when each was opened. */
  private readonly openSelfWrites = new Map<string, number>();

  constructor(private readonly dependencies: HostedExternalWriterInventorySupervisorDependencies) {
    this.convergenceIntervalMs = validDuration(
      dependencies.convergenceIntervalMs,
      DEFAULT_CONVERGENCE_INTERVAL_MS
    );
    this.stableCatalogRescanIntervalMs =
      dependencies.stableCatalogRescanIntervalMs === undefined
        ? null
        : validDuration(dependencies.stableCatalogRescanIntervalMs, 30_000);
    this.rebuildDrainMs = validDuration(dependencies.rebuildDrainMs, DEFAULT_REBUILD_DRAIN_MS);
    this.selfWriteRebuildHoldMs = validDuration(
      dependencies.selfWriteRebuildHoldMs,
      DEFAULT_SELF_WRITE_REBUILD_HOLD_MS
    );
  }

  start(): Promise<HostedExternalWriterInventorySupervisorSnapshot> {
    if (this.phase !== 'idle') throw new Error('hosted-external-writer-supervisor-already-started');
    this.phase = 'starting';
    this.dependencies.diagnostics?.startWatchdog();
    return this.schedule('start', async () => {
      try {
        await this.dependencies.stateStore.consumeCleanHandoffEligibility();
        const hotTeamIds = await this.dependencies.stateStore.listHotTeamIds();
        const inventory = await this.dependencies.inventory.capture(hotTeamIds);
        if (inventory.retiredTeams.length > 0) {
          throw new Error('hosted-external-writer-retirement-handoff-unproven');
        }
        if (this.stopRequested) {
          this.phase = 'stopped';
          return this.getSnapshot();
        }
        await this.startGeneration(inventory);
        if (this.stopRequested) {
          const handoff = this.observer
            ? await this.observer.shutdown(this.dependencies.clock.nowMs() + this.rebuildDrainMs)
            : this.dirtyHandoff;
          this.observer = null;
          this.dirtyHandoff = handoff ?? this.dirtyHandoff;
          this.phase = 'stopped';
          return this.getSnapshot();
        }
        this.phase = 'running';
        this.armPeriodicConvergence();
        return this.getSnapshot();
      } catch (error) {
        this.phase = 'dirty';
        this.diagnosticCode = 'startup_failed';
        throw error;
      }
    });
  }

  convergeNow(): Promise<HostedExternalWriterInventorySupervisorSnapshot> {
    if (
      (this.phase !== 'running' && this.phase !== 'dirty') ||
      (this.observer === null && this.pendingReplacement === null)
    ) {
      return Promise.reject(new Error('hosted-external-writer-supervisor-not-running'));
    }
    return this.schedule('converge-now', () => this.converge('convergence_failed', true));
  }

  beginTaskSelfWrite(operationId: string, teamId: TeamIdentityRecord['teamId']): Promise<void> {
    return this.schedule('self-write-begin', async () => {
      const observer = this.observer;
      if (!observer?.beginSelfWriteOperation) {
        throw new Error('hosted-external-writer-self-write-unavailable');
      }
      this.mark('observer-begin');
      await observer.beginSelfWriteOperation(operationId, { teamId, featureKey: 'tasks' });
      this.openSelfWrites.set(operationId, this.dependencies.clock.nowMs());
    });
  }

  completeTaskSelfWrite(
    operationId: string,
    effects: readonly { readonly fileKey: string; readonly expectedChecksum: string }[]
  ): Promise<void> {
    return this.schedule('self-write-complete', async () => {
      const observer = this.observer;
      if (!observer?.completeSelfWriteOperation) {
        throw new Error('hosted-external-writer-self-write-unavailable');
      }
      this.mark('observer-complete');
      try {
        await observer.completeSelfWriteOperation(operationId, effects);
      } finally {
        this.openSelfWrites.delete(operationId);
      }
      this.mark('self-write-converge');
      await this.converge('self_write_convergence_failed', true);
    });
  }

  abortTaskSelfWrite(operationId: string): Promise<void> {
    return this.schedule('self-write-abort', async () => {
      this.mark('observer-abort');
      this.openSelfWrites.delete(operationId);
      await this.observer?.abortSelfWriteOperation?.(operationId);
    });
  }

  shutdown(deadlineMs?: number): Promise<ExternalWriterShutdownHandoff | null> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.phase === 'stopped') return Promise.resolve(this.dirtyHandoff);
    if (this.phase !== 'starting' && this.phase !== 'running' && this.phase !== 'dirty') {
      return Promise.reject(new Error('hosted-external-writer-supervisor-not-running'));
    }
    this.stopRequested = true;
    this.phase = 'stopping';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.shutdownPromise = this.schedule('shutdown', async () => {
      try {
        const pending = this.pendingReplacement;
        let handoff = pending?.handoff ?? this.dirtyHandoff;
        if (pending?.sealingObserver) {
          // The original seal response may have failed before commit. One exact retry is the
          // bounded shutdown fence; it preserves the final drained checkpoint for restart.
          try {
            handoff = await pending.sealingObserver.retryCleanHandoffEligibility();
          } catch {
            // A second lost response may still mean the marker committed. Consume once to prove
            // that exact durable checkpoint before falling back to an explicit dirty checkpoint.
            const consumed = await this.dependencies.stateStore
              .consumeCleanHandoffEligibility()
              .catch(() => null);
            if (consumed) {
              handoff = cleanHandoffFromCheckpoint(consumed);
            } else {
              const checkpoint = pending.sealingObserver.getSnapshot().checkpoint;
              await this.dependencies.stateStore.save(checkpoint);
              handoff = Object.freeze({
                status: 'dirty' as const,
                capturedSequence: checkpoint.lastObservationSequence,
                persistedWatermark: checkpoint.observationWatermark,
                dirtyScopes: checkpoint.dirtyScopes,
                pendingObservationCount: checkpoint.pendingObservations.length,
              });
            }
          }
        } else if (!pending && this.observer) {
          handoff = await this.observer.shutdown(
            deadlineMs ?? this.dependencies.clock.nowMs() + this.rebuildDrainMs
          );
        }
        this.observer = null;
        this.pendingReplacement = null;
        this.dirtyHandoff = handoff;
        this.phase = 'stopped';
        this.dependencies.diagnostics?.stopWatchdog();
        return handoff;
      } catch (error) {
        // Preserve the exact pending generation so a later idempotent shutdown retry can finish.
        this.phase = 'dirty';
        this.diagnosticCode = 'shutdown_failed';
        this.shutdownPromise = null;
        throw error;
      }
    });
    return this.shutdownPromise;
  }

  getSnapshot(): HostedExternalWriterInventorySupervisorSnapshot {
    return Object.freeze({
      phase: this.phase,
      catalogRevision: this.catalogRevision,
      registeredFileCount: this.inventory?.definitions.length ?? 0,
      observer: this.observer?.getSnapshot() ?? null,
      dirtyHandoff: this.dirtyHandoff,
      diagnosticCode: this.diagnosticCode,
    });
  }

  private createObserver(
    definitions: readonly RegisteredExternalFileDefinition[]
  ): HostedExternalWriterObserverHandle {
    if (this.dependencies.observerFactory) return this.dependencies.observerFactory(definitions);
    const adapters = createExternalWriterFileAdapters({
      files: definitions,
      watchOptions: this.dependencies.watchOptions,
    });
    const track = <T extends object>(name: string, port: T): T =>
      this.dependencies.diagnostics?.trackPort(name, port) ?? port;
    return new ExternalWriterObserver(
      {
        catalog: track('catalog', adapters.catalog),
        watch: track('watch', adapters.watch),
        source: track('source', adapters.source),
        checksums: track('checksums', adapters.checksums),
        reconciliation: this.dependencies.reconciliation,
        stateStore: this.dependencies.stateStore,
        clock: this.dependencies.clock,
        ...(this.dependencies.verifiedRunEvidence
          ? { verifiedRunEvidence: this.dependencies.verifiedRunEvidence }
          : {}),
      },
      this.dependencies.observerOptions
    );
  }

  private async startGeneration(inventory: HostedExternalWriterInventorySnapshot): Promise<void> {
    if (this.stopRequested) return;
    const observer = this.createObserver(inventory.definitions);
    await observer.start();
    if (this.stopRequested) {
      const handoff = await observer.shutdown(
        this.dependencies.clock.nowMs() + this.rebuildDrainMs
      );
      this.dirtyHandoff = handoff;
      return;
    }
    this.observer = observer;
    // Operations opened on a previous generation cannot complete on this one.
    this.openSelfWrites.clear();
    this.inventory = inventory;
    this.catalogRevision += 1;
    this.lastStableCatalogRescanAtMs = this.dependencies.clock.nowMs();
    this.dirtyHandoff = null;
    this.diagnosticCode = null;
  }

  private async replaceGeneration(next: HostedExternalWriterInventorySnapshot): Promise<void> {
    const current = this.observer;
    if (!current) throw new Error('hosted-external-writer-supervisor-observer-missing');
    if (!this.inventory) throw new Error('hosted-external-writer-supervisor-inventory-missing');
    // The old exact catalog is the only generation that can prove a removed last file.
    // Drain its scopes before teardown, then persist the shutdown handoff before rebuilding.
    this.mark('rebuild-rescan-old-scopes');
    await this.rescanCurrentScopes(this.inventory);
    if (this.phase === 'dirty') {
      this.diagnosticCode = 'catalog_rebuild_old_scope_dirty';
      return;
    }
    if (this.stopRequested) return;
    const plan: ExternalWriterCleanHandoffEligibilityPlan = {
      handoffId: handoffId(this.inventory.catalogToken, next),
      oldCatalogToken: this.inventory.catalogToken,
      nextCatalogToken: next.catalogToken,
      retainedRegistrations: next.definitions.map(({ registration }) => ({
        scope: registration.scope,
        fileKey: registration.fileKey,
      })),
      retirementProofs: next.retiredTeams,
      createdAt: new Date(this.dependencies.clock.nowMs()).toISOString(),
    };
    let handoff: ExternalWriterShutdownHandoff;
    try {
      this.mark('rebuild-observer-shutdown');
      handoff = await current.shutdown(this.dependencies.clock.nowMs() + this.rebuildDrainMs, plan);
    } catch (error) {
      this.pendingReplacement = {
        inventory: next,
        sealingObserver: current,
        handoff: null,
        attempts: 0,
      };
      await this.resumePendingReplacement(error);
      return;
    }
    this.observer = null;
    if (handoff.status !== 'clean') {
      await this.restartAfterDirtyHandoff(next, handoff);
      return;
    }
    this.pendingReplacement = {
      inventory: next,
      sealingObserver: null,
      handoff,
      attempts: 0,
    };
    if (this.stopRequested) {
      this.dirtyHandoff = handoff;
      return;
    }
    await this.resumePendingReplacement();
  }

  private async resumePendingReplacement(originalError?: unknown): Promise<void> {
    let pending = this.pendingReplacement;
    if (!pending || this.stopRequested) return;
    try {
      // Each convergence performs a bounded number of durable operations. Failures leave the
      // exact next inventory frozen in memory and are retried by a capped periodic backoff.
      this.mark('rebuild-handoff-consume');
      let consumed = await this.dependencies.stateStore.consumeCleanHandoffEligibility();
      if (consumed) {
        this.observer = null;
        pending = {
          ...pending,
          sealingObserver: null,
          handoff: pending.handoff ?? cleanHandoffFromCheckpoint(consumed),
        };
        this.pendingReplacement = pending;
      }
      if (this.stopRequested) return;
      if (!consumed && pending.sealingObserver) {
        const handoff = await pending.sealingObserver.retryCleanHandoffEligibility();
        pending = { ...pending, handoff, sealingObserver: null };
        this.pendingReplacement = pending;
        this.observer = null;
        if (handoff.status !== 'clean') {
          await this.restartAfterDirtyHandoff(pending.inventory, handoff);
          return;
        }
        if (this.stopRequested) return;
        consumed = await this.dependencies.stateStore.consumeCleanHandoffEligibility();
        if (consumed) {
          pending = {
            ...pending,
            handoff: pending.handoff ?? cleanHandoffFromCheckpoint(consumed),
          };
          this.pendingReplacement = pending;
        }
      }
      if (this.stopRequested) return;
      if (!consumed) {
        throw new Error('hosted-external-writer-clean-handoff-marker-missing');
      }
      this.observer = null;
      this.pendingReplacement = null;
      this.mark('rebuild-generation-start');
      await this.startGeneration(pending.inventory);
      if (this.stopRequested) return;
      if (this.observer === null) {
        throw new Error('hosted-external-writer-replacement-not-started');
      }
      this.phase = 'running';
    } catch (error) {
      if (this.stopRequested) return;
      if (this.pendingReplacement) this.pendingReplacement.attempts += 1;
      this.phase = 'dirty';
      this.dirtyHandoff = this.pendingReplacement?.handoff ?? this.dirtyHandoff;
      this.diagnosticCode = 'catalog_rebuild_handoff_persist_failed';
      throw originalError ?? error;
    }
  }

  /**
   * A dirty handoff cannot prove a clean rebuild, but the old generation has already persisted its
   * checkpoint with the dirty scopes. Starting the next generation from it is exactly what a process
   * restart does: the startup scan repairs those scopes. Stopping here instead would leave task
   * writes unobserved and every self-write unavailable until a restart. Retirement still needs a
   * clean handoff, as on startup.
   */
  private async restartAfterDirtyHandoff(
    next: HostedExternalWriterInventorySnapshot,
    handoff: ExternalWriterShutdownHandoff
  ): Promise<void> {
    this.observer = null;
    this.pendingReplacement = null;
    this.phase = 'dirty';
    this.dirtyHandoff = handoff;
    this.diagnosticCode = 'catalog_rebuild_handoff_dirty';
    if (this.stopRequested) return;
    if (next.retiredTeams.length > 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    this.mark('dirty-handoff-generation-start');
    await this.startGeneration(next);
    if (this.stopRequested || this.observer === null) return;
    this.phase = 'running';
  }

  private async rescanCurrentScopes(
    inventory: HostedExternalWriterInventorySnapshot
  ): Promise<void> {
    const observer = this.observer;
    if (!observer) throw new Error('hosted-external-writer-supervisor-observer-missing');
    const scopes = new Map<string, ExternalWriterScope>();
    for (const definition of inventory.definitions) {
      const scope = definition.registration.scope;
      scopes.set(`${scope.teamId}\0${scope.featureKey}`, scope);
    }
    for (const scope of scopes.values()) await observer.rescanScope(scope);
    const snapshot = observer.getSnapshot();
    if (snapshot.readiness === 'dirty') {
      if (this.phase !== 'stopping') this.phase = 'dirty';
      this.diagnosticCode = 'observer_scope_dirty';
    } else {
      if (this.phase !== 'stopping') this.phase = 'running';
      this.diagnosticCode = null;
    }
  }

  private armPeriodicConvergence(): void {
    if (
      (this.phase !== 'running' && this.phase !== 'dirty') ||
      (this.observer === null && this.pendingReplacement === null) ||
      this.timer
    ) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.schedule('periodic-converge', () =>
          this.converge('periodic_convergence_failed', false)
        )
          .catch(() => undefined)
          .finally(() => this.armPeriodicConvergence());
      },
      this.pendingReplacement
        ? Math.min(
            this.convergenceIntervalMs * 2 ** Math.min(this.pendingReplacement.attempts, 5),
            30_000
          )
        : this.convergenceIntervalMs
    );
    this.timer.unref?.();
  }

  private async converge(
    failureDiagnostic: string,
    forceStableCatalogRescan: boolean
  ): Promise<HostedExternalWriterInventorySupervisorSnapshot> {
    try {
      if (this.pendingReplacement) {
        await this.resumePendingReplacement();
        return this.getSnapshot();
      }
      const checkpoint = this.observer?.getSnapshot().checkpoint;
      const retirementCandidates = checkpoint
        ? [
            ...new Set([
              ...checkpoint.fileWriterEpochs.map(({ teamId }) => teamId),
              ...checkpoint.teamObservationWatermarks.map(({ teamId }) => teamId),
              ...checkpoint.pendingObservations.map(({ scope }) => scope.teamId),
              ...checkpoint.dirtyScopes.map(({ scope }) => scope.teamId),
              ...checkpoint.selfWriteIntents.map(({ scope }) => scope.teamId),
              ...checkpoint.observedFiles.map(({ scope }) => scope.teamId),
            ]),
          ]
        : [];
      this.mark('inventory-capture');
      const next = await this.dependencies.inventory.capture(retirementCandidates);
      if (this.stopRequested) return this.getSnapshot();
      if (next.catalogToken !== this.inventory?.catalogToken) {
        if (this.selfWriteHoldsRebuild()) {
          this.diagnosticCode = 'catalog_rebuild_self_write_open';
          return this.getSnapshot();
        }
        await this.replaceGeneration(next);
      } else if (forceStableCatalogRescan || this.stableCatalogRescanDue()) {
        this.mark('stable-rescan');
        await this.rescanCurrentScopes(next);
        this.lastStableCatalogRescanAtMs = this.dependencies.clock.nowMs();
      } else {
        this.phase = 'running';
        this.diagnosticCode = null;
      }
      return this.getSnapshot();
    } catch (error) {
      if (this.phase !== 'stopping' && this.observer !== null) {
        this.phase = 'dirty';
        this.diagnosticCode = failureDiagnostic;
      }
      throw error;
    }
  }

  private selfWriteHoldsRebuild(): boolean {
    const now = this.dependencies.clock.nowMs();
    for (const [operationId, openedAtMs] of this.openSelfWrites) {
      if (now - openedAtMs < this.selfWriteRebuildHoldMs) return true;
      // Past the hold the rebuild proceeds and this generation's operation is gone with it.
      this.openSelfWrites.delete(operationId);
    }
    return false;
  }

  private stableCatalogRescanDue(): boolean {
    if (this.phase === 'dirty' || this.stableCatalogRescanIntervalMs === null) return true;
    const now = this.dependencies.clock.nowMs();
    return (
      this.lastStableCatalogRescanAtMs === null ||
      now - this.lastStableCatalogRescanAtMs >= this.stableCatalogRescanIntervalMs
    );
  }

  private mark(stage: string): void {
    this.dependencies.diagnostics?.mark(stage);
  }

  private schedule<T>(op: string, operation: () => Promise<T>): Promise<T> {
    const diagnostics = this.dependencies.diagnostics;
    const run = diagnostics ? () => diagnostics.run(op, operation) : operation;
    const result = this.operationTail.then(run, run);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
