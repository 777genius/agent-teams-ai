import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { type TeamLifecycleReadFailure } from '@features/team-lifecycle/contracts';
import {
  type LegacyTeamDataReadPort,
  type LegacyTeamRuntimeReadPort,
} from '@features/team-lifecycle/main';
import { parseRevision, type QueryContext } from '@shared/contracts/hosted';

import * as shared from './teamLifecycleReadShared';
import { TeamRuntimeEvidenceUnavailableError } from './teamRuntimeEvidenceSource';

export class TeamLifecycleReadSnapshotCoordinator {
  private readonly snapshots = new WeakMap<
    QueryContext,
    Promise<shared.TeamLifecycleReadSnapshot | TeamLifecycleReadFailure>
  >();
  private readonly runtimeStates = new WeakMap<
    QueryContext,
    Map<string, Promise<shared.FrozenRuntimeState | TeamLifecycleReadFailure>>
  >();
  private readonly aliveNames = new WeakMap<
    QueryContext,
    Promise<readonly string[] | TeamLifecycleReadFailure>
  >();

  constructor(
    readonly authority: shared.TeamLifecycleReadAuthority,
    private readonly identityGateway: TeamIdentityReadGateway | null,
    private readonly legacyData: LegacyTeamDataReadPort,
    private readonly legacyRuntime: LegacyTeamRuntimeReadPort,
    private readonly nowMs: () => number
  ) {}

  admitContext(context: QueryContext): boolean {
    return (
      context.actorId === this.authority.actorId &&
      context.authorizedScope === this.authority.authorizedScope &&
      context.deploymentId === this.authority.deploymentId &&
      context.bootId === this.authority.bootId
    );
  }

  private preflight(context: QueryContext): TeamLifecycleReadFailure | null {
    if (!this.admitContext(context)) return shared.forbiddenContext();
    if (context.signal.aborted) return shared.cancelledContext('request_cancelled');
    try {
      const nowMs = this.nowMs();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) return shared.clockInvalid();
      return nowMs >= context.deadlineAtMs ? shared.cancelledContext('deadline_exceeded') : null;
    } catch {
      return shared.clockInvalid();
    }
  }

  async readSnapshot(
    context: QueryContext
  ): Promise<shared.TeamLifecycleReadSnapshot | TeamLifecycleReadFailure> {
    const preflight = this.preflight(context);
    if (preflight) return preflight;
    const existing = this.snapshots.get(context);
    if (existing) {
      const snapshot = await existing;
      return this.preflight(context) ?? snapshot;
    }

    const pending = this.loadSnapshot(context);
    this.snapshots.set(context, pending);
    const snapshot = await pending;
    return this.preflight(context) ?? snapshot;
  }

  private async loadSnapshot(
    context: QueryContext
  ): Promise<shared.TeamLifecycleReadSnapshot | TeamLifecycleReadFailure> {
    if (!this.identityGateway) return shared.identityUnavailable();

    let identityValues: readonly TeamIdentityRecord[];
    try {
      const preflight = this.preflight(context);
      if (preflight) return preflight;
      identityValues = await this.identityGateway.listTeamIdentities();
    } catch {
      return this.preflight(context) ?? shared.identityUnavailable();
    }
    const afterIdentityRead = this.preflight(context);
    if (afterIdentityRead) return afterIdentityRead;

    let identities: readonly TeamIdentityRecord[];
    try {
      if (!Array.isArray(identityValues)) return shared.corruptIdentity();
      const parsed = identityValues.map((identity) => parseTeamIdentityRecord(identity));
      if (
        new Set(parsed.map((identity) => identity.teamId)).size !== parsed.length ||
        new Set(parsed.map((identity) => identity.legacyKey)).size !== parsed.length ||
        new Set(parsed.map((identity) => identity.directoryFingerprint)).size !== parsed.length
      ) {
        return shared.corruptIdentity();
      }
      const localIdentities: TeamIdentityRecord[] = [];
      for (const identity of parsed) {
        const workspaceBinding = identity.workspaceBinding;
        if (workspaceBinding === null) return shared.corruptIdentity();
        if (workspaceBinding.workspaceId !== this.authority.workspaceId) continue;
        if (workspaceBinding.generation !== this.authority.workspaceGeneration) {
          return shared.snapshotChanged();
        }
        localIdentities.push(identity);
      }
      identities = Object.freeze(
        localIdentities.sort((left, right) => left.teamId.localeCompare(right.teamId))
      );
    } catch {
      return shared.corruptIdentity();
    }

    let summaryValues: unknown;
    try {
      const preflight = this.preflight(context);
      if (preflight) return preflight;
      summaryValues = await this.legacyData.listTeams(context);
    } catch {
      return this.preflight(context) ?? shared.dataUnavailable();
    }
    const afterLegacyDataRead = this.preflight(context);
    if (afterLegacyDataRead) return afterLegacyDataRead;

    let summaries: readonly shared.FrozenLegacyLifecycleSummary[];
    try {
      if (!Array.isArray(summaryValues) || summaryValues.length > shared.MAX_LEGACY_SUMMARIES) {
        return shared.corruptData();
      }
      const localNames = new Set(identities.map((identity) => identity.legacyKey as string));
      const byLegacyName = new Map<string, shared.FrozenLegacyLifecycleSummary>();
      for (let index = 0; index < summaryValues.length; index += 1) {
        if (!Object.hasOwn(summaryValues, index)) return shared.corruptData();
        const candidate = summaryValues[index];
        if (!shared.isRecord(candidate) || typeof candidate.teamName !== 'string')
          return shared.corruptData();
        if (!localNames.has(candidate.teamName)) continue;
        if (byLegacyName.has(candidate.teamName)) return shared.corruptData();
        byLegacyName.set(candidate.teamName, shared.projectSummary(candidate.teamName, candidate));
      }

      summaries = Object.freeze(
        identities.flatMap((identity) => {
          if (identity.state === 'tombstoned') return [shared.tombstoneSummary(identity)];
          const summary = byLegacyName.get(identity.legacyKey);
          return summary ? [summary] : [];
        })
      );
    } catch {
      return shared.corruptData();
    }

    const summariesByName = new Map(summaries.map((summary) => [summary.teamName, summary]));
    const revision = parseRevision(
      `revision_${shared.digest(
        identities.map((identity) => ({
          identity,
          summary: summariesByName.get(identity.legacyKey) ?? null,
        }))
      )}`
    );
    return Object.freeze({ identities, summaries, summariesByName, revision });
  }

  async readRuntimeState(
    legacyTeamName: string,
    context: QueryContext
  ): Promise<shared.FrozenRuntimeState | TeamLifecycleReadFailure> {
    const preflight = this.preflight(context);
    if (preflight) return preflight;
    const snapshot = await this.readSnapshot(context);
    if (shared.isSnapshotFailure(snapshot)) return snapshot;
    if (!snapshot.identities.some((identity) => identity.legacyKey === legacyTeamName)) {
      return shared.forbiddenContext();
    }

    let byTeamName = this.runtimeStates.get(context);
    if (!byTeamName) {
      byTeamName = new Map();
      this.runtimeStates.set(context, byTeamName);
    }
    const existing = byTeamName.get(legacyTeamName);
    if (existing) {
      const runtime = await existing;
      return this.preflight(context) ?? runtime;
    }

    const pending = this.loadRuntimeState(legacyTeamName, context);
    byTeamName.set(legacyTeamName, pending);
    const runtime = await pending;
    return this.preflight(context) ?? runtime;
  }

  async readAliveNames(
    context: QueryContext
  ): Promise<readonly string[] | TeamLifecycleReadFailure> {
    const preflight = this.preflight(context);
    if (preflight) return preflight;
    const snapshot = await this.readSnapshot(context);
    if (shared.isSnapshotFailure(snapshot)) return snapshot;
    const existing = this.aliveNames.get(context);
    if (existing) {
      const names = await existing;
      return this.preflight(context) ?? names;
    }

    const pending = this.loadAliveNames(snapshot, context);
    this.aliveNames.set(context, pending);
    const names = await pending;
    return this.preflight(context) ?? names;
  }

  private async loadRuntimeState(
    legacyTeamName: string,
    context: QueryContext
  ): Promise<shared.FrozenRuntimeState | TeamLifecycleReadFailure> {
    let value: unknown;
    try {
      const preflight = this.preflight(context);
      if (preflight) return preflight;
      value = await this.legacyRuntime.getRuntimeState(legacyTeamName, context);
    } catch {
      return this.preflight(context) ?? shared.dataUnavailable();
    }
    const afterRuntimeRead = this.preflight(context);
    if (afterRuntimeRead) return afterRuntimeRead;
    if (
      !shared.isRecord(value) ||
      value.teamName !== legacyTeamName ||
      typeof value.isAlive !== 'boolean'
    ) {
      return shared.corruptData();
    }
    return Object.freeze({ teamName: legacyTeamName, isAlive: value.isAlive });
  }

  private async loadAliveNames(
    snapshot: shared.TeamLifecycleReadSnapshot,
    context: QueryContext
  ): Promise<readonly string[] | TeamLifecycleReadFailure> {
    let value: unknown;
    try {
      const preflight = this.preflight(context);
      if (preflight) return preflight;
      value = await this.legacyRuntime.getAliveTeams(context);
    } catch {
      return this.preflight(context) ?? shared.dataUnavailable();
    }
    const afterRuntimeRead = this.preflight(context);
    if (afterRuntimeRead) return afterRuntimeRead;
    if (!Array.isArray(value) || value.length > shared.MAX_PAGE_SIZE) return shared.corruptData();
    const localNames = new Set(snapshot.identities.map((identity) => identity.legacyKey as string));
    const seen = new Set<string>();
    const names: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || typeof value[index] !== 'string')
        return shared.corruptData();
      const name = value[index];
      if (seen.has(name)) return shared.corruptData();
      seen.add(name);
      if (localNames.has(name)) names.push(name);
    }
    names.sort();
    return Object.freeze(names);
  }
}

/** Projects tombstones and lifecycle fields from the coordinator's frozen request snapshot. */
export class SnapshotLegacyDataPort implements LegacyTeamDataReadPort {
  constructor(private readonly coordinator: TeamLifecycleReadSnapshotCoordinator) {}

  async listTeams(context: QueryContext): Promise<unknown> {
    const snapshot = await this.coordinator.readSnapshot(context);
    if (shared.isSnapshotFailure(snapshot)) {
      throw new Error('team-lifecycle-read-snapshot-unavailable');
    }
    return snapshot.summaries;
  }

  async getTeamData(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const snapshot = await this.coordinator.readSnapshot(context);
    if (shared.isSnapshotFailure(snapshot)) {
      throw new Error('team-lifecycle-read-snapshot-unavailable');
    }
    const identity = snapshot.identities.find(
      (candidate) => candidate.legacyKey === legacyTeamName
    );
    if (!identity) throw new Error('team-lifecycle-read-team-outside-authority');
    const summary = snapshot.summariesByName.get(legacyTeamName);
    if (!summary) throw new Error('team-lifecycle-read-summary-missing');
    const config =
      typeof summary.deletedAt === 'string'
        ? Object.freeze({ deletedAt: summary.deletedAt })
        : Object.freeze({});
    const warnings =
      summary.partialLaunchFailure === true ? Object.freeze(['degraded']) : Object.freeze([]);
    const runtime = await this.coordinator.readRuntimeState(legacyTeamName, context);
    if (shared.isRuntimeFailure(runtime))
      throw new Error('team-lifecycle-read-runtime-unavailable');
    return Object.freeze({ teamName: legacyTeamName, config, warnings, isAlive: runtime.isAlive });
  }
}

/** Returns only runtime values frozen by the coordinator for this host-owned request context. */
export class SnapshotRuntimeReadPort implements LegacyTeamRuntimeReadPort {
  constructor(private readonly coordinator: TeamLifecycleReadSnapshotCoordinator) {}

  async getRuntimeState(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const runtime = await this.coordinator.readRuntimeState(legacyTeamName, context);
    if (shared.isRuntimeFailure(runtime))
      throw new Error('team-lifecycle-read-runtime-unavailable');
    return runtime;
  }

  async getAliveTeams(context: QueryContext): Promise<unknown> {
    const names = await this.coordinator.readAliveNames(context);
    if (shared.isAliveNamesFailure(names)) throw new TeamRuntimeEvidenceUnavailableError();
    return names;
  }
}
