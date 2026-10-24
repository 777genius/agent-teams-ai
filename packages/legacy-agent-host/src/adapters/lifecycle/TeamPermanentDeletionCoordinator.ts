import { quietLifecycleDiagnostics } from './lifecycleRoots.js';
import { isOwnerPurgeRequest, sameOwnerPurgeRequest } from './ownerPurgeRequest.js';
import type { OwnerPurgeRequest } from './ownerPurgeRequest.js';
import type { LifecycleDirectories, LifecycleDiagnostics } from './lifecycleRoots.js';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  atomicWriteAsync,
  type DurablePathIdentity,
  type DurablePathRemovalProofHooks,
  getDurablePathIdentity,
} from './lifecycleIo.js';

import {
  type IdentityMarkerOwnership,
  TeamPermanentDeletionIdentity,
} from './TeamPermanentDeletionIdentity.js';
import { TeamPermanentDeletionIntentStore } from './TeamPermanentDeletionIntentStore.js';
import { TeamPermanentDeletionLock } from './TeamPermanentDeletionLock.js';
import {
  assertSafeTeamName,
  BackupPublicationFencedError,
  isExactDurablePathIdentity,
  PERMANENT_DELETION_TARGETS,
  type PermanentDeletionTarget,
  type PermanentDeletionTargetRemovalProof,
  type TeamPermanentDeletionIntent,
} from './TeamPermanentDeletionTypes.js';
import { TeamWorkSyncIdentityAccess } from './TeamWorkSyncIdentityAccess.js';
import { observeTeamWorkSyncPriorIdentity } from './TeamWorkSyncPriorIdentity.js';
import { isTeamWorkSyncRestoreReady } from './TeamWorkSyncRestoreReadiness.js';

import type { BackupRegistryEntryPort, TeamPermanentDeletionCoordinatorPorts } from './permanentDeletionPorts.js';
export type { TeamPermanentDeletionCoordinatorPorts } from './permanentDeletionPorts.js';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isValidConfig(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.name === 'string' && parsed.name.trim() !== '';
  } catch {
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TeamPermanentDeletionCoordinator {
  readonly lock: TeamPermanentDeletionLock;
  private readonly store: TeamPermanentDeletionIntentStore;
  private readonly preBoundaryDeletionClaims = new Map<string, Map<symbol, string>>();
  private readonly identity: TeamPermanentDeletionIdentity;

  constructor(private readonly ports: TeamPermanentDeletionCoordinatorPorts, private readonly roots: LifecycleDirectories, diagnostics: LifecycleDiagnostics = quietLifecycleDiagnostics) {
    this.lock = new TeamPermanentDeletionLock(roots);
    this.store = new TeamPermanentDeletionIntentStore(this.lock, roots, diagnostics);
    this.identity = new TeamPermanentDeletionIdentity((name, id) => this.isIdentityClaimedForDeletion(name, id), roots, name => ports.invalidateTeamConfig?.(name));
    this.workSyncIdentity = new TeamWorkSyncIdentityAccess({
    withFence: this.withTeamIdentityFence.bind(this),
    isFenced: this.isPermanentDeletionFenced.bind(this),
    isRestoreReady: (name) => isTeamWorkSyncRestoreReady(name, this.ports, this.roots.backups),
    observePriorIdentity: (name) => observeTeamWorkSyncPriorIdentity(name, this.ports, this.roots.backups),
    claimMarker: (name, id) => this.identity.claimIdentityMarker(name, id, true),
  }, this.roots.teams);
  }

  readonly workSyncIdentity: TeamWorkSyncIdentityAccess;

  async initialize(): Promise<void> {
    await this.store.loadPermanentDeletionIntents();
    await this.store.rollbackPreparedPermanentDeletionIntents();
    await this.store.cleanupCompletedPermanentDeletionIntents();
  }

  withSharedLock<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    return this.lock.withLock(scope, operation);
  }

  async beginPermanentDeletion(
    teamName: string,
    options: { draft?: boolean; ownerRequest?: OwnerPurgeRequest } = {}
  ): Promise<TeamPermanentDeletionIntent> {
    assertSafeTeamName(teamName);
    if (options.ownerRequest && (!isOwnerPurgeRequest(options.ownerRequest) || options.ownerRequest.binding.teamName !== teamName || options.draft)) throw new Error('Invalid owner deletion scope');
    let deletionOwnerIdentity = this.ports.isInitialized()
      ? this.getDeletionRequestIdentityOwner(teamName)
      : undefined;
    let claimToken = deletionOwnerIdentity
      ? this.addPreBoundaryDeletionClaim(teamName, deletionOwnerIdentity)
      : null;
    try {
      await this.ports.awaitInitialization();
      if (this.ports.isShuttingDown()) {
        throw new Error('Cannot begin permanent deletion while backup service is shutting down');
      }

      deletionOwnerIdentity ??= this.getDeletionRequestIdentityOwner(teamName);
      claimToken ??= deletionOwnerIdentity
        ? this.addPreBoundaryDeletionClaim(teamName, deletionOwnerIdentity)
        : null;

      return await this.withTeamIdentityFence(teamName, () =>
        this.ports.withTeamMutex(teamName, async () => {
          const existing = this.store.intents.get(teamName);
          if (existing) {
            const expected = existing.targets['team-data'];
            const observed = await this.identity.observePermanentDeletionTarget(
              this.identity.getPermanentDeletionTargetPath(teamName, 'team-data')
            );
            const replacementExists =
              observed.status === 'present' &&
              (expected.status === 'absent' ||
                !isExactDurablePathIdentity(observed.identity, expected.identity));
            if (!replacementExists) {
              if (!sameOwnerPurgeRequest(existing.ownerRequest, options.ownerRequest)) throw new Error('Original deletion request differs');
              return existing;
            }
          }

          const identityId = await this.resolveOrCreatePermanentDeletionIdentity(
            teamName,
            options.draft === true,
            deletionOwnerIdentity
          );
          const targets = await this.identity.observePermanentDeletionTargets(teamName);
          if (options.ownerRequest && options.ownerRequest.binding.teamId !== identityId) throw new Error('Owner deletion identity differs');
          const timestamp = nowIso();
          const intent: TeamPermanentDeletionIntent = {
            version: 2,
            teamName,
            identityId,
            transactionId: crypto.randomUUID(),
            identityKind: options.draft === true ? 'draft' : 'team',
            targets,
            targetRemovalProofs: {},
            completedTargets: [],
            cleanupCompleted: PERMANENT_DELETION_TARGETS.every(
              (target) => targets[target].status === 'absent'
            ),
            phase: 'prepared',
            requestedAt: timestamp,
            updatedAt: timestamp,
            ...(options.ownerRequest ? { ownerRequest: structuredClone(options.ownerRequest) } : {}),
          };
          await this.store.savePermanentDeletionIntent(intent);
          this.store.intents.set(teamName, intent);
          return intent;
        })
      );
    } finally {
      this.removePreBoundaryDeletionClaim(teamName, claimToken);
    }
  }

  async commitPermanentDeletionBoundary(
    intent: TeamPermanentDeletionIntent,
    assertCurrent?: () => void
  ): Promise<TeamPermanentDeletionIntent> {
    await this.ports.awaitInitialization();
    return this.withTeamIdentityFence(intent.teamName, () =>
      this.ports.withTeamMutex(intent.teamName, async () => {
        const current = this.requireCurrentPermanentDeletionIntent(intent);
        if (current.phase === 'deleting' || current.phase === 'deleted') return current;
        const deletingIntent: TeamPermanentDeletionIntent = {
          ...current,
          phase: 'deleting',
          updatedAt: nowIso(),
        };
        await this.store.savePermanentDeletionIntent(deletingIntent, assertCurrent);
        this.store.intents.set(intent.teamName, deletingIntent);
        return deletingIntent;
      })
    );
  }

  async abortPreparedPermanentDeletion(intent: TeamPermanentDeletionIntent): Promise<void> {
    await this.ports.awaitInitialization();
    await this.withTeamIdentityFence(intent.teamName, () =>
      this.ports.withTeamMutex(intent.teamName, async () => {
        const current = this.store.intents.get(intent.teamName);
        if (
          current?.identityId !== intent.identityId ||
          current.transactionId !== intent.transactionId
        ) {
          return;
        }
        if (current.phase !== 'prepared') {
          throw new Error(
            `Cannot abort permanent deletion after destructive boundary: ${intent.teamName}`
          );
        }
        await this.store.removePermanentDeletionIntent(current);
      })
    );
  }

  /** Exact original request lookup is available after Team data has been removed; it never advances deletion. */
  async lookupOwnerPermanentDeletion(request: OwnerPurgeRequest): Promise<TeamPermanentDeletionIntent | null> {
    if (!isOwnerPurgeRequest(request)) throw new Error('Invalid owner deletion request');
    await this.ports.awaitInitialization();
    return this.withTeamIdentityFence(request.binding.teamName, async () => {
      await this.store.reloadPermanentDeletionIntent(request.binding.teamName);
      const intent = this.store.intents.get(request.binding.teamName);
      return intent && sameOwnerPurgeRequest(intent.ownerRequest, request) ? structuredClone(intent) : null;
    });
  }

  /** Trusted retention qualification reads the same parsed original proof, never a metadata-stopped inference. */
  readOwnerDeletionIntentSync(teamName: string, identityId: string): TeamPermanentDeletionIntent | null {
    this.isPermanentDeletionFencedSync(teamName, identityId);
    const intent = this.store.intents.get(teamName);
    return intent?.identityId === identityId && intent.ownerRequest ? structuredClone(intent) : null;
  }

  async listPendingPermanentDeletions(): Promise<TeamPermanentDeletionIntent[]> {
    await this.ports.awaitInitialization();
    return [...this.store.intents.values()]
      .filter((intent) => intent.phase === 'deleting')
      .map((intent) => ({ ...intent }));
  }

  async isPermanentDeletionTargetCurrent(intent: TeamPermanentDeletionIntent): Promise<boolean> {
    await this.ports.awaitInitialization();
    await this.store.reloadPermanentDeletionIntent(intent.teamName);
    return this.isPermanentDeletionTargetCurrentInternal(intent);
  }

  async reconcilePermanentDeletionProgress(
    intent: TeamPermanentDeletionIntent
  ): Promise<TeamPermanentDeletionIntent> {
    await this.ports.awaitInitialization();
    return this.withTeamIdentityFence(intent.teamName, () =>
      this.ports.withTeamMutex(intent.teamName, () =>
        this.reconcilePermanentDeletionProgressInternal(intent)
      )
    );
  }

  async completePermanentDeletion(intent: TeamPermanentDeletionIntent): Promise<void> {
    await this.ports.awaitInitialization();
    await this.withTeamIdentityFence(intent.teamName, () =>
      this.ports.withTeamMutex(intent.teamName, () =>
        this.completePermanentDeletionInternal(intent)
      )
    );
  }

  async withTeamIdentityFence<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    assertSafeTeamName(teamName);
    return this.lock.withLock(`team:${teamName}`, async () => {
      await this.store.reloadPermanentDeletionIntent(teamName);
      return operation();
    });
  }

  async withPermanentDeletionTargetFence(
    intent: TeamPermanentDeletionIntent,
    operation: (
      isTargetCurrent: (
        target?: PermanentDeletionTarget,
        detachedPath?: string
      ) => Promise<boolean>,
      getTargetProofHooks: (target: PermanentDeletionTarget) => DurablePathRemovalProofHooks,
      isTargetCompleted: (target: PermanentDeletionTarget) => boolean
    ) => Promise<boolean>
  ): Promise<boolean> {
    await this.ports.awaitInitialization();
    return this.withTeamIdentityFence(intent.teamName, async () => {
      let current = await this.reconcilePermanentDeletionProgressInternal(intent);
      const isTargetCurrent = (
        target: PermanentDeletionTarget = 'team-data',
        detachedPath?: string
      ): Promise<boolean> =>
        this.isDurablePermanentDeletionTargetCurrent(intent, target, detachedPath);
      const isTargetCompleted = (target: PermanentDeletionTarget): boolean =>
        current.targets[target].status === 'absent' ||
        current.targetRemovalProofs[target]?.state === 'removed';
      const getTargetProofHooks = (
        target: PermanentDeletionTarget
      ): DurablePathRemovalProofHooks => {
        const expected = current.targets[target];
        if (expected.status !== 'present') {
          throw new Error(`Permanent deletion target did not exist at prepare: ${target}`);
        }
        return {
          detachedPath: this.identity.getPermanentDeletionDetachedTargetPath(current, target),
          onDetachedValidated: async (detachedPath, identity) => {
            current = await this.savePermanentDeletionTargetRemovalProof(
              current,
              target,
              identity,
              'detached',
              detachedPath
            );
          },
          onRemovalDurable: async (detachedPath, identity) => {
            current = await this.savePermanentDeletionTargetRemovalProof(
              current,
              target,
              identity,
              'removed',
              detachedPath
            );
          },
        };
      };
      return operation(isTargetCurrent, getTargetProofHooks, isTargetCompleted);
    });
  }

  private getDeletionRequestIdentityOwner(teamName: string): string | undefined {
    const registryEntry = this.ports.registry()[teamName];
    if (registryEntry?.status === 'active') return registryEntry.identityId;
    const intent = this.store.intents.get(teamName);
    return intent?.phase === 'prepared' || intent?.phase === 'deleting'
      ? intent.identityId
      : undefined;
  }

  private addPreBoundaryDeletionClaim(teamName: string, identityId: string): symbol {
    const token = Symbol(teamName);
    const claims = this.preBoundaryDeletionClaims.get(teamName) ?? new Map<symbol, string>();
    claims.set(token, identityId);
    this.preBoundaryDeletionClaims.set(teamName, claims);
    return token;
  }

  private removePreBoundaryDeletionClaim(teamName: string, token: symbol | null): void {
    if (!token) return;
    const claims = this.preBoundaryDeletionClaims.get(teamName);
    if (!claims) return;
    claims.delete(token);
    if (claims.size === 0) this.preBoundaryDeletionClaims.delete(teamName);
  }

  isIdentityClaimedForDeletion(teamName: string, identityId: string): boolean {
    const inMemoryClaim = [...(this.preBoundaryDeletionClaims.get(teamName)?.values() ?? [])].some(
      (claimedIdentityId) => claimedIdentityId === identityId
    );
    if (inMemoryClaim) return true;
    return this.store.intents.get(teamName)?.identityId === identityId;
  }

  private requireCurrentPermanentDeletionIntent(
    intent: TeamPermanentDeletionIntent
  ): TeamPermanentDeletionIntent {
    const current = this.store.intents.get(intent.teamName);
    if (
      current?.identityId !== intent.identityId ||
      current.transactionId !== intent.transactionId
    ) {
      throw new Error(`Permanent deletion intent changed for ${intent.teamName}`);
    }
    return current;
  }

  private async resolveOrCreatePermanentDeletionIdentity(
    teamName: string,
    draft: boolean,
    deletionOwnerIdentity?: string
  ): Promise<string> {
    const configPath = path.join(this.roots.teams, teamName, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      if (!isValidConfig(raw)) {
        throw new Error(`Team config is not valid: ${teamName}`);
      }
      if (draft) {
        throw new Error(`Cannot delete draft with config.json: ${teamName}`);
      }
      const config = JSON.parse(raw) as Record<string, unknown>;
      if (deletionOwnerIdentity) {
        return deletionOwnerIdentity;
      }
      if (typeof config._backupIdentityId === 'string' && config._backupIdentityId) {
        return config._backupIdentityId;
      }

      const identityId = crypto.randomUUID();
      const ownership = await this.identity.claimIdentityMarker(teamName, identityId, true);
      if (ownership.status === 'unavailable') {
        throw new Error(`Team identity changed while preparing deletion: ${teamName}`);
      }
      return ownership.identityId;
    } catch (error) {
      if (!isEnoent(error)) throw error;
      if (!draft) throw new Error(`Team not found: ${teamName}`);
    }

    const markerPath = this.identity.getDraftDeletionIdentityPath(teamName);
    try {
      const parsed = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as {
        identityId?: unknown;
      };
      if (typeof parsed.identityId === 'string' && parsed.identityId) {
        return parsed.identityId;
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }

    const identityId = crypto.randomUUID();
    await atomicWriteAsync(
      markerPath,
      JSON.stringify({ version: 1, teamName, identityId }, null, 2),
      { durability: 'strict', syncDirectory: true }
    );
    return identityId;
  }

  private async isPermanentDeletionTargetCurrentInternal(
    intent: TeamPermanentDeletionIntent
  ): Promise<boolean> {
    const current = this.requireCurrentPermanentDeletionIntent(intent);
    const expected = current.targets['team-data'];
    const publicPath = this.identity.getPermanentDeletionTargetPath(current.teamName, 'team-data');
    const observed = await this.identity.observePermanentDeletionTarget(publicPath);
    if (current.targetRemovalProofs['team-data']?.state === 'removed') {
      return observed.status === 'absent';
    }
    if (expected.status !== 'present') {
      return false;
    }

    let currentPath: string;
    if (
      observed.status === 'present' &&
      isExactDurablePathIdentity(observed.identity, expected.identity)
    ) {
      currentPath = publicPath;
    } else {
      // A crash can happen after the exact source tree is renamed to its
      // transaction-owned path but before the detached receipt is durable.
      // Resume only that deterministic path and exact prepared identity. Do
      // not scan siblings or infer deletion from a missing public pathname.
      if (current.phase !== 'deleting') return false;
      const detachedPath = this.identity.getPermanentDeletionDetachedTargetPath(
        current,
        'team-data'
      );
      const detached = await this.identity.observePermanentDeletionTarget(detachedPath);
      if (
        detached.status !== 'present' ||
        !isExactDurablePathIdentity(detached.identity, expected.identity)
      ) {
        return false;
      }
      currentPath = detachedPath;
    }

    const source = await this.identity.readPermanentDeletionSourceIdentity(
      intent.teamName,
      currentPath
    );
    return source.status === 'identified' && source.identityId === intent.identityId;
  }

  private async savePermanentDeletionTargetRemovalProof(
    intent: TeamPermanentDeletionIntent,
    target: PermanentDeletionTarget,
    identity: DurablePathIdentity,
    state: PermanentDeletionTargetRemovalProof['state'],
    detachedPath: string
  ): Promise<TeamPermanentDeletionIntent> {
    const current = this.requireCurrentPermanentDeletionIntent(intent);
    if (current.phase === 'deleted') return current;
    if (current.phase !== 'deleting') {
      throw new Error(
        `Permanent deletion has not crossed destructive boundary: ${intent.teamName}`
      );
    }

    const expected = current.targets[target];
    if (expected.status !== 'present' || !isExactDurablePathIdentity(identity, expected.identity)) {
      throw new Error(`Permanent deletion target identity changed: ${target}`);
    }
    const expectedDetachedPath = this.identity.getPermanentDeletionDetachedTargetPath(
      current,
      target
    );
    if (path.resolve(detachedPath) !== path.resolve(expectedDetachedPath)) {
      throw new Error(`Permanent deletion detached target path changed: ${target}`);
    }

    const existing = current.targetRemovalProofs[target];
    if (existing) {
      if (
        existing.transactionId !== current.transactionId ||
        existing.target !== target ||
        !isExactDurablePathIdentity(existing.targetIdentity, expected.identity)
      ) {
        throw new Error(`Permanent deletion target proof changed: ${target}`);
      }
      if (existing.state === 'removed' || state === 'detached') return current;
    } else if (state === 'removed') {
      throw new Error(`Permanent deletion target was not durably detached: ${target}`);
    }

    if (state === 'detached') {
      if (!(await this.isDurablePermanentDeletionTargetCurrent(current, target, detachedPath))) {
        throw new Error(`Permanent deletion detached target is not current: ${target}`);
      }
    } else {
      const [publicObservation, detachedObservation] = await Promise.all([
        this.identity.observePermanentDeletionTarget(
          this.identity.getPermanentDeletionTargetPath(current.teamName, target)
        ),
        this.identity.observePermanentDeletionTarget(detachedPath),
      ]);
      if (
        detachedObservation.status !== 'absent' ||
        (publicObservation.status === 'present' &&
          isExactDurablePathIdentity(publicObservation.identity, expected.identity))
      ) {
        throw new Error(`Permanent deletion exact removal is not durable: ${target}`);
      }
    }

    const timestamp = nowIso();
    const proof: PermanentDeletionTargetRemovalProof = {
      version: 1,
      transactionId: current.transactionId,
      target,
      targetIdentity: expected.identity,
      state,
      detachedAt: existing?.detachedAt ?? timestamp,
      ...(state === 'removed' ? { removedAt: timestamp } : {}),
    };
    const targetRemovalProofs = {
      ...current.targetRemovalProofs,
      [target]: proof,
    };
    const completedTargets = PERMANENT_DELETION_TARGETS.filter(
      (candidate) => targetRemovalProofs[candidate]?.state === 'removed'
    );
    const cleanupCompleted = PERMANENT_DELETION_TARGETS.every(
      (candidate) =>
        current.targets[candidate].status === 'absent' ||
        targetRemovalProofs[candidate]?.state === 'removed'
    );
    const updated: TeamPermanentDeletionIntent = {
      ...current,
      targetRemovalProofs,
      completedTargets,
      cleanupCompleted,
      updatedAt: timestamp,
    };
    await this.store.savePermanentDeletionIntent(updated);
    this.store.intents.set(updated.teamName, updated);
    return updated;
  }

  private async reconcilePermanentDeletionProgressInternal(
    intent: TeamPermanentDeletionIntent
  ): Promise<TeamPermanentDeletionIntent> {
    let current = this.requireCurrentPermanentDeletionIntent(intent);
    if (current.phase !== 'deleting' || current.cleanupCompleted) return current;

    for (const target of PERMANENT_DELETION_TARGETS) {
      const expected = current.targets[target];
      const proof = current.targetRemovalProofs[target];
      if (expected.status !== 'present' || proof?.state !== 'detached') {
        continue;
      }

      const publicObservation = await this.identity.observePermanentDeletionTarget(
        this.identity.getPermanentDeletionTargetPath(current.teamName, target)
      );
      if (
        publicObservation.status === 'present' &&
        isExactDurablePathIdentity(publicObservation.identity, expected.identity)
      ) {
        continue;
      }

      const detachedObservation = await this.identity.observePermanentDeletionTarget(
        this.identity.getPermanentDeletionDetachedTargetPath(current, target)
      );
      if (detachedObservation.status === 'present') {
        if (!isExactDurablePathIdentity(detachedObservation.identity, expected.identity)) {
          throw new Error(`Permanent deletion detached target identity changed: ${target}`);
        }
        continue;
      }

      current = await this.savePermanentDeletionTargetRemovalProof(
        current,
        target,
        expected.identity,
        'removed',
        this.identity.getPermanentDeletionDetachedTargetPath(current, target)
      );
    }
    return current;
  }

  private async isDurablePermanentDeletionTargetCurrent(
    intent: TeamPermanentDeletionIntent,
    target: PermanentDeletionTarget,
    detachedPath?: string
  ): Promise<boolean> {
    let persisted: TeamPermanentDeletionIntent;
    try {
      const raw = await fs.promises.readFile(this.store.getIntentPath(intent.teamName), 'utf8');
      const parsed = this.store.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
      if (
        parsed?.teamName !== intent.teamName ||
        parsed.identityId !== intent.identityId ||
        parsed.transactionId !== intent.transactionId ||
        parsed.phase !== 'deleting'
      ) {
        return false;
      }
      persisted = parsed;
    } catch {
      return false;
    }

    const expectedTarget = persisted.targets[target];
    if (expectedTarget.status !== 'present') return false;
    const observedTarget = await this.identity.observePermanentDeletionTarget(
      detachedPath ?? this.identity.getPermanentDeletionTargetPath(intent.teamName, target)
    );
    if (
      observedTarget.status !== 'present' ||
      !isExactDurablePathIdentity(observedTarget.identity, expectedTarget.identity)
    ) {
      return false;
    }

    if (target !== 'team-data') {
      return this.identity.isPermanentDeletionSourceGenerationCurrent(persisted);
    }
    const source = await this.identity.readPermanentDeletionSourceIdentity(
      intent.teamName,
      detachedPath ?? this.identity.getPermanentDeletionTargetPath(intent.teamName, target)
    );
    return source.status === 'identified' && source.identityId === intent.identityId;
  }

  async isPermanentDeletionFenced(teamName: string, knownIdentityId?: string): Promise<boolean> {
    await this.store.reloadPermanentDeletionIntent(teamName);
    if (this.store.corruptFences.has(teamName)) return true;
    const intent = this.store.intents.get(teamName);
    if (!intent || (intent.phase !== 'deleting' && intent.phase !== 'deleted' && !(intent.phase === 'prepared' && intent.ownerRequest))) return false;
    const expectedTarget = intent.targets['team-data'];
    const observedTarget = await this.identity.observePermanentDeletionTarget(
      this.identity.getPermanentDeletionTargetPath(teamName, 'team-data')
    );
    if (observedTarget.status === 'present') {
      if (
        expectedTarget.status !== 'present' ||
        !isExactDurablePathIdentity(observedTarget.identity, expectedTarget.identity)
      ) {
        return false;
      }
      const source = await this.identity.readPermanentDeletionSourceIdentity(teamName);
      return source.status !== 'identified' || source.identityId === intent.identityId;
    }
    const source = await this.identity.readPermanentDeletionSourceIdentity(teamName);
    if (source.status === 'identified') return source.identityId === intent.identityId;
    if (source.status === 'absent') {
      return knownIdentityId === undefined || knownIdentityId === intent.identityId;
    }
    return intent.phase === 'deleting';
  }

  async assertBackupPublicationCurrent(teamName: string, identityId: string): Promise<void> {
    if (
      this.ports.isShuttingDown() ||
      (await this.isPermanentDeletionFenced(teamName, identityId))
    ) {
      throw new BackupPublicationFencedError(
        `Backup publication fenced by permanent deletion: ${teamName}`
      );
    }
    const source = await this.identity.readPermanentDeletionSourceIdentity(teamName);
    if (source.status !== 'identified' || source.identityId !== identityId) {
      throw new BackupPublicationFencedError(`Backup identity ownership changed: ${teamName}`);
    }
  }

  isPermanentDeletionFencedSync(teamName: string, knownIdentityId?: string, purpose: 'publication' | 'retirement' = 'publication'): boolean {
    try {
      const raw = fs.readFileSync(this.store.getIntentPath(teamName), 'utf8');
      const intent = this.store.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
      if (intent?.teamName !== teamName) {
        throw new Error('invalid permanent deletion intent');
      }
      this.store.intents.set(teamName, intent);
      this.store.corruptFences.delete(teamName);
    } catch (error) {
      if (isEnoent(error)) {
        this.store.intents.delete(teamName);
        this.store.corruptFences.delete(teamName);
      } else {
        this.store.intents.delete(teamName);
        this.store.corruptFences.add(teamName);
      }
    }
    if (this.store.corruptFences.has(teamName)) return true;
    const intent = this.store.intents.get(teamName);
    if (!intent || (intent.phase !== 'deleting' && intent.phase !== 'deleted' && !(intent.phase === 'prepared' && intent.ownerRequest))) return false;
    const expectedTarget = intent.targets['team-data'];
    try {
      const observedIdentity = getDurablePathIdentity(
        fs.lstatSync(this.identity.getPermanentDeletionTargetPath(teamName, 'team-data'))
      );
      if (
        expectedTarget.status !== 'present' ||
        !isExactDurablePathIdentity(observedIdentity, expectedTarget.identity)
      ) {
        return false;
      }
      const source = this.identity.readPermanentDeletionSourceIdentitySync(teamName);
      // Intact pre-boundary data must stay routable for original actor/CAS reauthorization.
      if (purpose === 'retirement' && intent.phase === 'prepared' && intent.ownerRequest && source.status === 'identified' && source.identityId === intent.identityId) return false;
      return source.status !== 'identified' || source.identityId === intent.identityId;
    } catch (error) {
      if (!isEnoent(error)) return true;
    }
    const source = this.identity.readPermanentDeletionSourceIdentitySync(teamName);
    if (source.status === 'identified') return source.identityId === intent.identityId;
    if (source.status === 'absent') {
      return knownIdentityId === undefined || knownIdentityId === intent.identityId;
    }
    return intent.phase === 'deleting';
  }

  private async completePermanentDeletionInternal(
    intent: TeamPermanentDeletionIntent
  ): Promise<void> {
    let current = this.requireCurrentPermanentDeletionIntent(intent);
    if (current.phase !== 'deleting' && current.phase !== 'deleted') {
      throw new Error(
        `Permanent deletion has not crossed destructive boundary: ${intent.teamName}`
      );
    }
    if (current.phase === 'deleting' && !current.cleanupCompleted) {
      current = await this.reconcilePermanentDeletionProgressInternal(current);
    }
    if (!current.cleanupCompleted) {
      throw new Error(`Permanent deletion cleanup is incomplete: ${intent.teamName}`);
    }
    const deletedAt = nowIso();
    const manifest = await this.ports.loadManifest(intent.teamName);
    if (manifest?.identityId === intent.identityId) {
      manifest.status = 'deleted_by_user';
      manifest.deletedByUserAt = deletedAt;
      await this.ports.saveManifest(intent.teamName, manifest, true);
    }

    const registryEntry = this.ports.registry()[intent.teamName];
    if (!registryEntry || registryEntry.identityId === intent.identityId) {
      const deletedEntry: BackupRegistryEntryPort = {
        teamName: intent.teamName,
        identityId: intent.identityId,
        status: 'deleted_by_user',
        deletedByUserAt: deletedAt,
        lastBackupAt: registryEntry?.lastBackupAt ?? intent.requestedAt,
      };
      await this.ports.saveRegistryEntry(intent.teamName, deletedEntry, true);
    }

    const tombstone: TeamPermanentDeletionIntent = {
      ...current,
      phase: 'deleted',
      updatedAt: deletedAt,
    };
    await this.store.savePermanentDeletionIntent(tombstone);
    this.store.intents.set(intent.teamName, tombstone);
  }

  // ── Internal: backup ─────────────────────────────────────────────────

  ensureIdentityMarker(teamName: string, identityId: string): Promise<IdentityMarkerOwnership> {
    return this.identity.claimIdentityMarker(teamName, identityId, false);
  }

  claimIdentityMarkerSync(teamName: string, identityId: string): IdentityMarkerOwnership {
    return this.identity.claimIdentityMarkerSync(teamName, identityId);
  }

  isReplacementForPendingDeletion(teamName: string, manifestIdentityId: string): boolean {
    const pending = this.store.intents.get(teamName);
    return (
      (pending?.phase === 'deleting' || pending?.phase === 'deleted') &&
      pending.identityId === manifestIdentityId
    );
  }
}
