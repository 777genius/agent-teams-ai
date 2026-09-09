import { captureTeamLaunchPublicationAuthority } from '../TeamLaunchStateStore';

import type { PersistedTeamLaunchSnapshot, TeamMember } from '@shared/types';

const DEFAULT_LAUNCH_STATE_NOOP_REFRESH_MS = 15_000;

export interface LaunchStateWriteResult {
  snapshot: PersistedTeamLaunchSnapshot;
  wrote: boolean;
}

export interface LaunchStateWriteOptions {
  isAuthorized?: () => boolean;
  allowNoopSkip?: boolean;
  requireTrackedRun?: boolean;
  runId?: string;
  /**
   * True when the snapshot republishes launch truth that already existed
   * instead of starting a launch. Forwarded to the store, where it keeps a stop
   * that settled during the write final over this publication.
   */
  republishesExistingLaunch?: boolean;
}

/** Mirrors `TeamLaunchStatePublicationOptions` on the launch-state store. */
export interface LaunchStatePublicationOptions {
  authorizesNewRun?: () => boolean;
  runId?: string;
  isAuthorized?: () => boolean;
  republishesExistingLaunch?: boolean;
}

export interface TeamProvisioningLaunchStateStoreBoundaryPorts {
  launchStateStore: {
    read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
    write(
      teamName: string,
      snapshot: PersistedTeamLaunchSnapshot,
      options?: LaunchStatePublicationOptions
    ): Promise<boolean | void>;
    clear(teamName: string, isAuthorized?: () => boolean): Promise<void>;
  };
  membersMetaStore: {
    getMembers(teamName: string): Promise<TeamMember[]>;
  };
  getTrackedRunId(teamName: string): string | null | undefined;
  applyOpenCodeSecondaryEvidenceOverlay(params: {
    teamName: string;
    snapshot: PersistedTeamLaunchSnapshot;
    previousSnapshot?: PersistedTeamLaunchSnapshot | null;
    metaMembers?: TeamMember[];
  }): Promise<PersistedTeamLaunchSnapshot>;
  applyBootstrapStallOverlay(
    snapshot: PersistedTeamLaunchSnapshot
  ): PersistedTeamLaunchSnapshot | null | undefined;
  areSnapshotsSemanticallyEqual(
    left: PersistedTeamLaunchSnapshot,
    right: PersistedTeamLaunchSnapshot
  ): boolean;
  clearBootstrapState(teamName: string): Promise<void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  logDebug(message: string): void;
  nowMs(): number;
  noopRefreshMs?: number;
  writtenRunIdByTeam?: Map<string, string>;
}

export interface TeamProvisioningLaunchStateStoreBoundaryServiceHost {
  launchStateStore: {
    read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
    write(
      teamName: string,
      snapshot: PersistedTeamLaunchSnapshot,
      options?: LaunchStatePublicationOptions
    ): Promise<boolean | void>;
    clear?(teamName: string, isAuthorized?: () => boolean): Promise<void>;
  };
  defaultLaunchStateStore: {
    write(
      teamName: string,
      snapshot: PersistedTeamLaunchSnapshot,
      options?: LaunchStatePublicationOptions
    ): Promise<boolean | void>;
    clear(teamName: string, isAuthorized?: () => boolean): Promise<void>;
  };
  membersMetaStore: TeamProvisioningLaunchStateStoreBoundaryPorts['membersMetaStore'];
  getTrackedRunId(teamName: string): string | null | undefined;
  applyOpenCodeSecondaryEvidenceOverlay: TeamProvisioningLaunchStateStoreBoundaryPorts['applyOpenCodeSecondaryEvidenceOverlay'];
  applyOpenCodeSecondaryBootstrapStallOverlay: TeamProvisioningLaunchStateStoreBoundaryPorts['applyBootstrapStallOverlay'];
  invalidateRuntimeSnapshotCaches: TeamProvisioningLaunchStateStoreBoundaryPorts['invalidateRuntimeSnapshotCaches'];
  launchStateWrittenRunIdByTeam: Map<string, string>;
}

export interface TeamProvisioningLaunchStateStoreBoundaryServiceHostOptions {
  areSnapshotsSemanticallyEqual: TeamProvisioningLaunchStateStoreBoundaryPorts['areSnapshotsSemanticallyEqual'];
  clearBootstrapState: TeamProvisioningLaunchStateStoreBoundaryPorts['clearBootstrapState'];
  logDebug: TeamProvisioningLaunchStateStoreBoundaryPorts['logDebug'];
  nowMs: TeamProvisioningLaunchStateStoreBoundaryPorts['nowMs'];
}

export class TeamProvisioningLaunchStateStoreBoundary {
  private readonly queue = new Map<string, Promise<unknown>>();
  private readonly writtenRunIdByTeam: Map<string, string>;
  private readonly observedTrackedRunIdByTeam = new Map<string, string>();

  constructor(private readonly ports: TeamProvisioningLaunchStateStoreBoundaryPorts) {
    this.writtenRunIdByTeam = ports.writtenRunIdByTeam ?? new Map<string, string>();
  }

  getWrittenRunIdByTeam(): Map<string, string> {
    return this.writtenRunIdByTeam;
  }

  async clearPersistedLaunchState(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    await this.enqueue(teamName, () => this.clearPersistedLaunchStateNow(teamName, options));
  }

  canClearPersistedLaunchStateForRun(teamName: string, expectedRunId: string | undefined): boolean {
    if (!expectedRunId) {
      return true;
    }
    const trackedRunId = this.ports.getTrackedRunId(teamName);
    if (trackedRunId !== expectedRunId) {
      return false;
    }
    const lastWrittenRunId = this.writtenRunIdByTeam.get(teamName);
    if (lastWrittenRunId && lastWrittenRunId !== expectedRunId) {
      return false;
    }
    return true;
  }

  async clearPersistedLaunchStateNow(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    if (!this.canClearPersistedLaunchStateForRun(teamName, options?.expectedRunId)) {
      this.ports.logDebug(
        `[${teamName}] Skipping stale launch-state clear for run ${options?.expectedRunId}`
      );
      return;
    }
    const writtenRunIdBeforeClear = this.writtenRunIdByTeam.get(teamName);
    await this.ports.launchStateStore.clear(teamName, () =>
      this.canClearPersistedLaunchStateForRun(teamName, options?.expectedRunId)
    );
    if (this.writtenRunIdByTeam.get(teamName) === writtenRunIdBeforeClear) {
      this.writtenRunIdByTeam.delete(teamName);
    }
    // Bootstrap state is team-scoped and written outside this queue. A run-scoped delete could
    // remove a successor run's state after the authority check has already passed.
    if (!options?.expectedRunId) {
      await this.ports.clearBootstrapState(teamName);
    }
    this.ports.invalidateRuntimeSnapshotCaches(teamName);
  }

  async writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: LaunchStateWriteOptions
  ): Promise<PersistedTeamLaunchSnapshot> {
    const publicationIsCurrent = captureTeamLaunchPublicationAuthority(teamName);
    const admittedOptions = {
      ...options,
      isAuthorized: () => publicationIsCurrent() && options?.isAuthorized?.() !== false,
    };
    const result = await this.enqueue(teamName, async () => {
      const writeResult = await this.writeLaunchStateSnapshotNow(
        teamName,
        snapshot,
        admittedOptions
      );
      if (writeResult.wrote) {
        this.ports.invalidateRuntimeSnapshotCaches(teamName);
      }
      return writeResult;
    });
    return result.snapshot;
  }

  async writeLaunchStateSnapshotNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: LaunchStateWriteOptions
  ): Promise<LaunchStateWriteResult> {
    if (options?.isAuthorized?.() === false) return { snapshot, wrote: false };
    if (!options?.runId && snapshot.publicationRunId)
      options = { ...options, runId: snapshot.publicationRunId };
    const previousSnapshot = await this.ports.launchStateStore.read(teamName).catch(() => null);
    const trackedRunIdBeforeWrite =
      typeof options?.runId === 'string' ? this.ports.getTrackedRunId(teamName) : undefined;
    if (typeof options?.runId === 'string' && trackedRunIdBeforeWrite === options.runId) {
      this.observedTrackedRunIdByTeam.set(teamName, options.runId);
    }
    if (
      typeof options?.runId === 'string' &&
      ((typeof trackedRunIdBeforeWrite === 'string' && trackedRunIdBeforeWrite !== options.runId) ||
        (trackedRunIdBeforeWrite == null &&
          (options.requireTrackedRun === true ||
            this.observedTrackedRunIdByTeam.get(teamName) === options.runId)))
    ) {
      this.ports.logDebug(
        `[${teamName}] Skipping stale launch-state write for run ${options.runId}`
      );
      return { snapshot: previousSnapshot ?? snapshot, wrote: false };
    }
    const metaMembers = await this.ports.membersMetaStore.getMembers(teamName).catch(() => []);
    const overlaidSnapshot = await this.ports.applyOpenCodeSecondaryEvidenceOverlay({
      teamName,
      snapshot,
      previousSnapshot,
      metaMembers,
    });
    const normalizedSnapshot = {
      ...(this.ports.applyBootstrapStallOverlay(overlaidSnapshot) ?? overlaidSnapshot),
      publicationRunId: options?.runId,
    };
    if (
      options?.allowNoopSkip === true &&
      typeof options.runId === 'string' &&
      this.writtenRunIdByTeam.get(teamName) === options.runId &&
      previousSnapshot &&
      this.ports.areSnapshotsSemanticallyEqual(previousSnapshot, normalizedSnapshot) &&
      !this.isLaunchStateNoopRefreshDue(previousSnapshot)
    ) {
      return { snapshot: previousSnapshot, wrote: false };
    }
    const writtenRunIdBeforeWrite = this.writtenRunIdByTeam.get(teamName);
    const persisted = await this.ports.launchStateStore.write(teamName, normalizedSnapshot, {
      runId: options?.runId,
      republishesExistingLaunch: options?.republishesExistingLaunch,
      authorizesNewRun: () =>
        !!options?.runId && this.ports.getTrackedRunId(teamName) === options.runId,
      isAuthorized: () => {
        if (options?.isAuthorized?.() === false) return false;
        if (!options?.runId) return true;
        const tracked = this.ports.getTrackedRunId(teamName);
        return (
          tracked === options.runId ||
          (tracked == null &&
            options.requireTrackedRun !== true &&
            this.observedTrackedRunIdByTeam.get(teamName) !== options.runId)
        );
      },
    });
    if (persisted === false)
      return { snapshot: previousSnapshot ?? normalizedSnapshot, wrote: false };
    const trackedRunIdAfterWrite =
      typeof options?.runId === 'string' ? this.ports.getTrackedRunId(teamName) : undefined;
    if (typeof options?.runId === 'string' && trackedRunIdAfterWrite === options.runId) {
      this.observedTrackedRunIdByTeam.set(teamName, options.runId);
    }
    if (
      typeof options?.runId === 'string' &&
      ((typeof trackedRunIdAfterWrite === 'string' && trackedRunIdAfterWrite !== options.runId) ||
        (trackedRunIdAfterWrite == null &&
          (options.requireTrackedRun === true ||
            this.observedTrackedRunIdByTeam.get(teamName) === options.runId)))
    ) {
      // The actual store checks authority and rolls back inside its publication queue.
      // Never restore old truth here over a successor publication or a later Stop.
      if (this.writtenRunIdByTeam.get(teamName) === writtenRunIdBeforeWrite) {
        this.writtenRunIdByTeam.delete(teamName);
      }
      this.ports.invalidateRuntimeSnapshotCaches(teamName);
      this.ports.logDebug(
        `[${teamName}] Removed stale launch-state write for run ${options.runId}`
      );
      return { snapshot: previousSnapshot ?? normalizedSnapshot, wrote: false };
    }
    if (typeof options?.runId === 'string') {
      this.writtenRunIdByTeam.set(teamName, options.runId);
    }
    return { snapshot: normalizedSnapshot, wrote: true };
  }

  isLaunchStateNoopRefreshDue(snapshot: PersistedTeamLaunchSnapshot): boolean {
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    return (
      !Number.isFinite(updatedAtMs) ||
      this.ports.nowMs() - updatedAtMs >=
        (this.ports.noopRefreshMs ?? DEFAULT_LAUNCH_STATE_NOOP_REFRESH_MS)
    );
  }

  enqueue<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(teamName);
    const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queue.set(teamName, queued);
    return queued.finally(() => {
      if (this.queue.get(teamName) === queued) {
        this.queue.delete(teamName);
      }
    });
  }
}

export function createTeamProvisioningLaunchStateStoreBoundaryFromService(
  service: TeamProvisioningLaunchStateStoreBoundaryServiceHost,
  options: TeamProvisioningLaunchStateStoreBoundaryServiceHostOptions
): TeamProvisioningLaunchStateStoreBoundary {
  return new TeamProvisioningLaunchStateStoreBoundary({
    launchStateStore: {
      read: (teamName) => service.launchStateStore.read(teamName),
      write: async (teamName, snapshot, publicationOptions) => {
        const persisted = await service.defaultLaunchStateStore.write(
          teamName,
          snapshot,
          publicationOptions
        );
        if (persisted === false) return false;
        if (service.launchStateStore !== service.defaultLaunchStateStore) {
          const secondary = await service.launchStateStore.write(
            teamName,
            snapshot,
            publicationOptions
          );
          if (secondary === false) return false;
        }
        return persisted;
      },
      clear: async (teamName, isAuthorized) => {
        const errors: unknown[] = [];
        if (typeof service.launchStateStore.clear === 'function') {
          try {
            await service.launchStateStore.clear(teamName, isAuthorized);
          } catch (error) {
            errors.push(error);
          }
        }
        if (service.launchStateStore !== service.defaultLaunchStateStore) {
          try {
            await service.defaultLaunchStateStore.clear(teamName, isAuthorized);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, `[${teamName}] Failed to clear launch-state stores`);
        }
      },
    },
    membersMetaStore: service.membersMetaStore,
    getTrackedRunId: (teamName) => service.getTrackedRunId(teamName),
    applyOpenCodeSecondaryEvidenceOverlay: (params) =>
      service.applyOpenCodeSecondaryEvidenceOverlay(params),
    applyBootstrapStallOverlay: (snapshot) =>
      service.applyOpenCodeSecondaryBootstrapStallOverlay(snapshot),
    areSnapshotsSemanticallyEqual: options.areSnapshotsSemanticallyEqual,
    clearBootstrapState: (teamName) => options.clearBootstrapState(teamName),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    logDebug: (message) => options.logDebug(message),
    nowMs: options.nowMs,
    writtenRunIdByTeam: service.launchStateWrittenRunIdByTeam,
  });
}
