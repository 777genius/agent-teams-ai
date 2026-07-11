import type { PersistedTeamLaunchSnapshot, TeamMember } from '@shared/types';

const DEFAULT_LAUNCH_STATE_NOOP_REFRESH_MS = 15_000;

export interface LaunchStateWriteResult {
  snapshot: PersistedTeamLaunchSnapshot;
  wrote: boolean;
}

export interface TeamProvisioningLaunchStateStoreBoundaryPorts {
  launchStateStore: {
    read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
    write(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void>;
    clear(teamName: string): Promise<void>;
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
    write(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void>;
    clear?(teamName: string): Promise<void>;
  };
  defaultLaunchStateStore: {
    write(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void>;
    clear(teamName: string): Promise<void>;
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
    await this.ports.launchStateStore.clear(teamName);
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
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot> {
    const result = await this.enqueue(teamName, async () => {
      const writeResult = await this.writeLaunchStateSnapshotNow(teamName, snapshot);
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
    options?: { allowNoopSkip?: boolean; runId?: string }
  ): Promise<LaunchStateWriteResult> {
    const previousSnapshot = await this.ports.launchStateStore.read(teamName).catch(() => null);
    const metaMembers = await this.ports.membersMetaStore.getMembers(teamName).catch(() => []);
    const overlaidSnapshot = await this.ports.applyOpenCodeSecondaryEvidenceOverlay({
      teamName,
      snapshot,
      previousSnapshot,
      metaMembers,
    });
    const normalizedSnapshot =
      this.ports.applyBootstrapStallOverlay(overlaidSnapshot) ?? overlaidSnapshot;
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
    await this.ports.launchStateStore.write(teamName, normalizedSnapshot);
    if (
      typeof options?.runId === 'string' &&
      this.ports.getTrackedRunId(teamName) !== options.runId
    ) {
      await this.ports.launchStateStore.clear(teamName);
      if (this.writtenRunIdByTeam.get(teamName) === writtenRunIdBeforeWrite) {
        this.writtenRunIdByTeam.delete(teamName);
      }
      this.ports.invalidateRuntimeSnapshotCaches(teamName);
      this.ports.logDebug(
        `[${teamName}] Removed stale launch-state write for run ${options.runId}`
      );
      return { snapshot: normalizedSnapshot, wrote: false };
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
      write: async (teamName, snapshot) => {
        await service.launchStateStore.write(teamName, snapshot);
        if (service.launchStateStore !== service.defaultLaunchStateStore) {
          await service.defaultLaunchStateStore.write(teamName, snapshot);
        }
      },
      clear: async (teamName) => {
        if (typeof service.launchStateStore.clear === 'function') {
          await service.launchStateStore.clear(teamName);
        }
        if (service.launchStateStore !== service.defaultLaunchStateStore) {
          await service.defaultLaunchStateStore.clear(teamName);
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
