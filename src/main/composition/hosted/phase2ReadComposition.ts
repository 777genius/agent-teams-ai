import { createHash } from 'node:crypto';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import {
  createRuntimeInstanceContext,
  type RuntimeInstanceContext,
} from '@features/runtime-instance-context';
import {
  GetRuntimeStateProjection,
  GetTeamLifecycleSnapshot,
  ListAliveTeamProjections,
  ListTeamLifecycle,
} from '@features/team-lifecycle';
import {
  type CanonicalListTeamLifecycleResult,
  type ListAliveTeamProjectionsRequest,
  type ListTeamLifecycleRequest,
  parseListTeamLifecycleRequest,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleEntityRequest,
  type TeamLifecycleReadApi,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import {
  type LegacyTeamBindingPage,
  type LegacyTeamDataReadPort,
  type LegacyTeamIdentityBinding,
  type LegacyTeamIdentityReadPort,
  LegacyTeamLifecycleReadSource,
  type LegacyTeamReadAvailability,
  type LegacyTeamRuntimeReadPort,
  TeamLifecycleReadApiAdapter,
} from '@features/team-lifecycle/main';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import {
  type ActorId,
  type AuthorizedScope,
  type BootId,
  createSafeAppError,
  type DeploymentId,
  parseActorId,
  parseAuthorizedScope,
  parseCursor,
  parseRevision,
  type QueryContext,
  type Revision,
  type WorkspaceId,
} from '@shared/contracts/hosted';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const MAX_LEGACY_SUMMARIES = 2_000;
const CURSOR_PATTERN = /^cursor_phase2_(\d+)_([0-9a-f]{64})$/;
const phase2ReadAuthorities = new WeakSet<object>();

export interface Phase2ReadAuthority {
  readonly actorId: ActorId;
  readonly authorizedScope: AuthorizedScope;
  readonly workspaceId: WorkspaceId;
  readonly workspaceGeneration: number;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
}

export interface Phase2ReadAuthorityInput {
  readonly actorId: unknown;
  readonly authorizedScope: unknown;
  readonly mountBinding: WorkspaceMountBinding;
  readonly runtimeInstance: RuntimeInstanceContext;
}

export interface Phase2ReadCompositionDependencies {
  /** The host-created identity and authorization snapshot for every read in this composition. */
  readonly authority: Phase2ReadAuthority;
  /** Null means the durable component is unavailable; discovery fallback is forbidden. */
  readonly teamIdentities: TeamIdentityReadGateway | null;
  readonly legacyData: LegacyTeamDataReadPort;
  readonly legacyRuntime: LegacyTeamRuntimeReadPort;
  readonly nowMs: () => number;
  readonly pageSize?: number;
}

export interface Phase2ReadComposition {
  readonly authority: Phase2ReadAuthority;
  readonly teamLifecycle: TeamLifecycleReadApi;
}

export interface Phase2ReadHost {
  listTeamLifecycle(request: unknown): Promise<CanonicalListTeamLifecycleResult>;
}

interface FrozenLegacyLifecycleSummary extends Readonly<Record<PropertyKey, unknown>> {
  readonly teamName: string;
}

interface Phase2ReadSnapshot {
  readonly identities: readonly TeamIdentityRecord[];
  readonly summaries: readonly FrozenLegacyLifecycleSummary[];
  readonly summariesByName: ReadonlyMap<string, FrozenLegacyLifecycleSummary>;
  readonly revision: Revision;
}

interface FrozenRuntimeState {
  readonly teamName: string;
  readonly isAlive: boolean;
}

type IdentityProjectionPurpose = 'lifecycle' | 'runtime';

function failure(
  code: TeamLifecycleReadFailure['error']['code'],
  reason: string,
  diagnosticId?: string
): TeamLifecycleReadFailure {
  const error = createSafeAppError({ code, reason, diagnosticId });
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as TeamLifecycleReadFailure['error'],
    retryable: code === 'unavailable',
  });
}

function corruptIdentity(): TeamLifecycleReadFailure {
  return failure('internal', 'corrupt_source', 'phase2-read.identity-corrupt');
}

function corruptData(): TeamLifecycleReadFailure {
  return failure('internal', 'corrupt_source', 'phase2-read.data-corrupt');
}

function identityUnavailable(): TeamLifecycleReadFailure {
  return failure('unavailable', 'identity_storage_unavailable');
}

function dataUnavailable(): TeamLifecycleReadFailure {
  return failure('unavailable', 'source_unavailable');
}

function forbiddenContext(): TeamLifecycleReadFailure {
  return failure('forbidden', 'scope_not_authorized');
}

function snapshotChanged(): TeamLifecycleReadFailure {
  return failure('conflict', 'snapshot_changed');
}

function invalidCursor(): TeamLifecycleReadFailure {
  return failure('invalid_request', 'cursor_invalid');
}

function projectionPurposeInvalid(): TeamLifecycleReadFailure {
  return failure('internal', 'unexpected', 'phase2-read.projection-purpose-invalid');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectedRevision(identity: TeamIdentityRecord, projection: unknown): Revision {
  return parseRevision(`revision_${digest({ identity, projection })}`);
}

function availability(
  identity: TeamIdentityRecord,
  summary: FrozenLegacyLifecycleSummary | null
): LegacyTeamReadAvailability {
  switch (identity.state) {
    case 'reserved':
      return 'draft';
    case 'adoption_prepared':
    case 'file_published':
      return 'provisioning';
    case 'active':
      return summary?.pendingCreate === true ? 'draft' : 'current';
    case 'tombstoned':
      return 'current';
  }
}

function binding(
  identity: TeamIdentityRecord,
  projection: unknown,
  summary: FrozenLegacyLifecycleSummary | null
): LegacyTeamIdentityBinding | TeamLifecycleReadFailure {
  if (identity.workspaceBinding === null) return corruptIdentity();
  return Object.freeze({
    workspaceId: identity.workspaceBinding.workspaceId,
    teamId: identity.teamId,
    legacyTeamName: identity.legacyKey,
    displayName: identity.legacyKey,
    revision: projectedRevision(identity, projection),
    availability: availability(identity, summary),
  });
}

function isFailure(
  value: LegacyTeamIdentityBinding | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value && value.kind === 'failure';
}

function isSnapshotFailure(
  value: Phase2ReadSnapshot | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value;
}

function isRuntimeFailure(
  value: FrozenRuntimeState | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value;
}

function isAliveNamesFailure(
  value: readonly string[] | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return !Array.isArray(value);
}

function authorityCursorDigest(
  authority: Phase2ReadAuthority,
  revision: Revision,
  offset: number
): string {
  return digest({
    snapshotRevision: revision,
    actorId: authority.actorId,
    authorizedScope: authority.authorizedScope,
    workspaceId: authority.workspaceId,
    workspaceGeneration: authority.workspaceGeneration,
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    offset,
  });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectSummary(
  legacyTeamName: string,
  value: Record<PropertyKey, unknown>
): FrozenLegacyLifecycleSummary {
  const summary: Record<string, unknown> = { teamName: legacyTeamName };
  if (typeof value.deletedAt === 'string') summary.deletedAt = value.deletedAt;
  if (value.pendingCreate === true) summary.pendingCreate = true;
  if (value.partialLaunchFailure === true) summary.partialLaunchFailure = true;
  return Object.freeze(summary) as FrozenLegacyLifecycleSummary;
}

function tombstoneSummary(identity: TeamIdentityRecord): FrozenLegacyLifecycleSummary {
  return Object.freeze({
    teamName: identity.legacyKey,
    deletedAt: identity.tombstonedAt,
  });
}

export function createPhase2ReadAuthority(value: Phase2ReadAuthorityInput): Phase2ReadAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('phase2-read-authority-invalid');
  }
  try {
    if (!(value.mountBinding instanceof WorkspaceMountBinding)) {
      throw new TypeError('phase2-read-mount-binding-not-admitted');
    }
    if (value.mountBinding.health === 'unavailable') {
      throw new TypeError('phase2-read-mount-binding-unavailable');
    }
    const runtimeInstance = createRuntimeInstanceContext(value.runtimeInstance);
    if (value.mountBinding.bootId !== runtimeInstance.bootId) {
      throw new TypeError('phase2-read-runtime-binding-mismatch');
    }
    const authority = Object.freeze({
      actorId: parseActorId(value.actorId),
      authorizedScope: parseAuthorizedScope(value.authorizedScope),
      workspaceId: value.mountBinding.workspaceId,
      workspaceGeneration: value.mountBinding.mountGeneration,
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
    });
    phase2ReadAuthorities.add(authority);
    return authority;
  } catch {
    throw new TypeError('phase2-read-authority-invalid');
  }
}

/** Owns the one immutable identity/data snapshot used throughout a host request. */
export class Phase2ReadSnapshotCoordinator {
  private readonly snapshots = new WeakMap<
    QueryContext,
    Promise<Phase2ReadSnapshot | TeamLifecycleReadFailure>
  >();
  private readonly runtimeStates = new WeakMap<
    QueryContext,
    Map<string, Promise<FrozenRuntimeState | TeamLifecycleReadFailure>>
  >();
  private readonly aliveNames = new WeakMap<
    QueryContext,
    Promise<readonly string[] | TeamLifecycleReadFailure>
  >();

  constructor(
    readonly authority: Phase2ReadAuthority,
    private readonly identityGateway: TeamIdentityReadGateway | null,
    private readonly legacyData: LegacyTeamDataReadPort,
    private readonly legacyRuntime: LegacyTeamRuntimeReadPort
  ) {}

  admitContext(context: QueryContext): boolean {
    return (
      context.actorId === this.authority.actorId &&
      context.authorizedScope === this.authority.authorizedScope &&
      context.deploymentId === this.authority.deploymentId &&
      context.bootId === this.authority.bootId
    );
  }

  async readSnapshot(
    context: QueryContext
  ): Promise<Phase2ReadSnapshot | TeamLifecycleReadFailure> {
    if (!this.admitContext(context)) return forbiddenContext();
    const existing = this.snapshots.get(context);
    if (existing) return existing;

    const pending = this.loadSnapshot(context);
    this.snapshots.set(context, pending);
    return pending;
  }

  private async loadSnapshot(
    context: QueryContext
  ): Promise<Phase2ReadSnapshot | TeamLifecycleReadFailure> {
    if (!this.identityGateway) return identityUnavailable();

    let identityValues: readonly TeamIdentityRecord[];
    try {
      if (!this.admitContext(context)) return forbiddenContext();
      identityValues = await this.identityGateway.listTeamIdentities();
    } catch {
      return identityUnavailable();
    }

    let identities: readonly TeamIdentityRecord[];
    try {
      if (!Array.isArray(identityValues)) return corruptIdentity();
      const parsed = identityValues.map((identity) => parseTeamIdentityRecord(identity));
      if (
        new Set(parsed.map((identity) => identity.teamId)).size !== parsed.length ||
        new Set(parsed.map((identity) => identity.legacyKey)).size !== parsed.length ||
        new Set(parsed.map((identity) => identity.directoryFingerprint)).size !== parsed.length
      ) {
        return corruptIdentity();
      }
      const localIdentities: TeamIdentityRecord[] = [];
      for (const identity of parsed) {
        const workspaceBinding = identity.workspaceBinding;
        if (workspaceBinding === null) return corruptIdentity();
        if (workspaceBinding.workspaceId !== this.authority.workspaceId) continue;
        if (workspaceBinding.generation !== this.authority.workspaceGeneration) {
          return snapshotChanged();
        }
        localIdentities.push(identity);
      }
      identities = Object.freeze(
        localIdentities.sort((left, right) => left.teamId.localeCompare(right.teamId))
      );
    } catch {
      return corruptIdentity();
    }

    let summaryValues: unknown;
    try {
      if (!this.admitContext(context)) return forbiddenContext();
      summaryValues = await this.legacyData.listTeams(context);
    } catch {
      return dataUnavailable();
    }

    let summaries: readonly FrozenLegacyLifecycleSummary[];
    try {
      if (!Array.isArray(summaryValues) || summaryValues.length > MAX_LEGACY_SUMMARIES) {
        return corruptData();
      }
      const localNames = new Set(identities.map((identity) => identity.legacyKey as string));
      const byLegacyName = new Map<string, FrozenLegacyLifecycleSummary>();
      for (let index = 0; index < summaryValues.length; index += 1) {
        if (!Object.hasOwn(summaryValues, index)) return corruptData();
        const candidate = summaryValues[index];
        if (!isRecord(candidate) || typeof candidate.teamName !== 'string') return corruptData();
        if (!localNames.has(candidate.teamName)) continue;
        if (byLegacyName.has(candidate.teamName)) return corruptData();
        byLegacyName.set(candidate.teamName, projectSummary(candidate.teamName, candidate));
      }

      summaries = Object.freeze(
        identities.flatMap((identity) => {
          if (identity.state === 'tombstoned') return [tombstoneSummary(identity)];
          const summary = byLegacyName.get(identity.legacyKey);
          return summary ? [summary] : [];
        })
      );
    } catch {
      return corruptData();
    }

    const summariesByName = new Map(summaries.map((summary) => [summary.teamName, summary]));
    const revision = parseRevision(
      `revision_${digest(
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
  ): Promise<FrozenRuntimeState | TeamLifecycleReadFailure> {
    const snapshot = await this.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    if (!snapshot.identities.some((identity) => identity.legacyKey === legacyTeamName)) {
      return forbiddenContext();
    }

    let byTeamName = this.runtimeStates.get(context);
    if (!byTeamName) {
      byTeamName = new Map();
      this.runtimeStates.set(context, byTeamName);
    }
    const existing = byTeamName.get(legacyTeamName);
    if (existing) return existing;

    const pending = this.loadRuntimeState(legacyTeamName, context);
    byTeamName.set(legacyTeamName, pending);
    return pending;
  }

  async readAliveNames(
    context: QueryContext
  ): Promise<readonly string[] | TeamLifecycleReadFailure> {
    const snapshot = await this.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    const existing = this.aliveNames.get(context);
    if (existing) return existing;

    const pending = this.loadAliveNames(snapshot, context);
    this.aliveNames.set(context, pending);
    return pending;
  }

  private async loadRuntimeState(
    legacyTeamName: string,
    context: QueryContext
  ): Promise<FrozenRuntimeState | TeamLifecycleReadFailure> {
    let value: unknown;
    try {
      if (!this.admitContext(context)) return forbiddenContext();
      value = await this.legacyRuntime.getRuntimeState(legacyTeamName, context);
    } catch {
      return dataUnavailable();
    }
    if (
      !isRecord(value) ||
      value.teamName !== legacyTeamName ||
      typeof value.isAlive !== 'boolean'
    ) {
      return corruptData();
    }
    return Object.freeze({ teamName: legacyTeamName, isAlive: value.isAlive });
  }

  private async loadAliveNames(
    snapshot: Phase2ReadSnapshot,
    context: QueryContext
  ): Promise<readonly string[] | TeamLifecycleReadFailure> {
    let value: unknown;
    try {
      if (!this.admitContext(context)) return forbiddenContext();
      value = await this.legacyRuntime.getAliveTeams(context);
    } catch {
      return dataUnavailable();
    }
    if (!Array.isArray(value) || value.length > MAX_PAGE_SIZE) return corruptData();
    const localNames = new Set(snapshot.identities.map((identity) => identity.legacyKey as string));
    const seen = new Set<string>();
    const names: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || typeof value[index] !== 'string') return corruptData();
      const name = value[index];
      if (seen.has(name)) return corruptData();
      seen.add(name);
      if (localNames.has(name)) names.push(name);
    }
    names.sort();
    return Object.freeze(names);
  }
}

class IdentityProjectionPurposeContext {
  private readonly purposes = new WeakMap<QueryContext, IdentityProjectionPurpose>();

  async run<TResult>(
    context: QueryContext,
    purpose: IdentityProjectionPurpose,
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    if (this.purposes.has(context)) {
      throw new Error('phase2-read-projection-purpose-context-reused');
    }
    this.purposes.set(context, purpose);
    try {
      return await operation();
    } finally {
      this.purposes.delete(context);
    }
  }

  current(context: QueryContext): IdentityProjectionPurpose | null {
    return this.purposes.get(context) ?? null;
  }
}

class CanonicalIdentityProjectionReadPort implements LegacyTeamIdentityReadPort {
  constructor(
    private readonly coordinator: Phase2ReadSnapshotCoordinator,
    private readonly pageSize: number,
    private readonly purposes: IdentityProjectionPurposeContext
  ) {}

  async listTeamBindings(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ): Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure> {
    if (this.purposes.current(context) !== 'lifecycle') return projectionPurposeInvalid();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    return this.page(
      snapshot.identities,
      snapshot.revision,
      request.cursor,
      snapshot,
      (identity) => snapshot.summariesByName.get(identity.legacyKey) ?? null
    );
  }

  async getTeamBinding(
    request: TeamLifecycleEntityRequest,
    context: QueryContext
  ): Promise<LegacyTeamIdentityBinding | TeamLifecycleReadFailure | null> {
    const purpose = this.purposes.current(context);
    if (purpose === null) return projectionPurposeInvalid();
    if (request.workspaceId !== this.coordinator.authority.workspaceId) return forbiddenContext();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    const identity = snapshot.identities.find((candidate) => candidate.teamId === request.teamId);
    if (!identity) return null;
    const summary = snapshot.summariesByName.get(identity.legacyKey) ?? null;
    let projection: unknown = summary;
    if (purpose === 'runtime') {
      const runtime =
        availability(identity, summary) === 'draft'
          ? Object.freeze({ teamName: identity.legacyKey, isAlive: false })
          : await this.coordinator.readRuntimeState(identity.legacyKey, context);
      if (isRuntimeFailure(runtime)) return runtime;
      projection = runtime;
    }
    return binding(identity, projection, summary);
  }

  async listAliveTeamBindings(
    legacyTeamNames: readonly string[],
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure> {
    if (this.purposes.current(context) !== 'runtime') return projectionPurposeInvalid();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    const frozenAliveNames = await this.coordinator.readAliveNames(context);
    if (isAliveNamesFailure(frozenAliveNames)) return frozenAliveNames;
    if (
      legacyTeamNames.length !== frozenAliveNames.length ||
      legacyTeamNames.some((name, index) => name !== frozenAliveNames[index])
    ) {
      return corruptData();
    }
    const alive = new Set(frozenAliveNames);
    const identities = snapshot.identities.filter(
      (identity) => identity.state === 'active' && alive.has(identity.legacyKey)
    );
    const revision = parseRevision(
      `revision_${digest(
        snapshot.identities.map((identity) => ({
          identity,
          runtime: { isAlive: identity.state === 'active' && alive.has(identity.legacyKey) },
        }))
      )}`
    );
    return this.page(identities, revision, request.cursor, snapshot, (identity) =>
      Object.freeze({ teamName: identity.legacyKey, isAlive: true })
    );
  }

  private page(
    identities: readonly TeamIdentityRecord[],
    revision: Revision,
    cursorValue: ListTeamLifecycleRequest['cursor'],
    snapshot: Phase2ReadSnapshot,
    projection: (identity: TeamIdentityRecord) => unknown
  ): LegacyTeamBindingPage | TeamLifecycleReadFailure {
    let offset = 0;
    if (cursorValue !== null) {
      const match = CURSOR_PATTERN.exec(cursorValue);
      if (!match) return invalidCursor();
      offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= identities.length) {
        return invalidCursor();
      }
      if (match[2] !== this.cursorDigest(revision, offset)) return snapshotChanged();
    }

    const pageIdentities = identities.slice(offset, offset + this.pageSize);
    const bindings: LegacyTeamIdentityBinding[] = [];
    for (const identity of pageIdentities) {
      const summary = snapshot.summariesByName.get(identity.legacyKey) ?? null;
      const result = binding(identity, projection(identity), summary);
      if (isFailure(result)) return result;
      bindings.push(result);
    }
    const nextOffset = offset + pageIdentities.length;
    const nextCursor =
      nextOffset < identities.length
        ? parseCursor(`cursor_phase2_${nextOffset}_${this.cursorDigest(revision, nextOffset)}`)
        : null;
    return Object.freeze({
      snapshotRevision: revision,
      bindings: Object.freeze(bindings),
      nextCursor,
    });
  }

  private cursorDigest(revision: Revision, offset: number): string {
    return authorityCursorDigest(this.coordinator.authority, revision, offset);
  }
}

/** Projects tombstones and lifecycle fields from the coordinator's frozen request snapshot. */
class SnapshotLegacyDataPort implements LegacyTeamDataReadPort {
  constructor(private readonly coordinator: Phase2ReadSnapshotCoordinator) {}

  async listTeams(context: QueryContext): Promise<unknown> {
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) throw new Error('phase2-read-snapshot-unavailable');
    return snapshot.summaries;
  }

  async getTeamData(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) throw new Error('phase2-read-snapshot-unavailable');
    const identity = snapshot.identities.find(
      (candidate) => candidate.legacyKey === legacyTeamName
    );
    if (!identity) throw new Error('phase2-read-team-outside-authority');
    const summary = snapshot.summariesByName.get(legacyTeamName);
    if (!summary) throw new Error('phase2-read-summary-missing');
    const config =
      typeof summary.deletedAt === 'string'
        ? Object.freeze({ deletedAt: summary.deletedAt })
        : Object.freeze({});
    const warnings =
      summary.partialLaunchFailure === true ? Object.freeze(['degraded']) : Object.freeze([]);
    return Object.freeze({ teamName: legacyTeamName, config, warnings, isAlive: false });
  }
}

/** Returns only runtime values frozen by the coordinator for this host-owned request context. */
class SnapshotRuntimeReadPort implements LegacyTeamRuntimeReadPort {
  constructor(private readonly coordinator: Phase2ReadSnapshotCoordinator) {}

  async getRuntimeState(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const runtime = await this.coordinator.readRuntimeState(legacyTeamName, context);
    if (isRuntimeFailure(runtime)) throw new Error('phase2-read-runtime-unavailable');
    return runtime;
  }

  async getAliveTeams(context: QueryContext): Promise<unknown> {
    const names = await this.coordinator.readAliveNames(context);
    if (isAliveNamesFailure(names)) throw new Error('phase2-read-runtime-unavailable');
    return names;
  }
}

export function createPhase2ReadComposition(
  dependencies: Phase2ReadCompositionDependencies
): Phase2ReadComposition {
  const pageSize = dependencies.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new TypeError('phase2-read-page-size-invalid');
  }
  if (typeof dependencies.nowMs !== 'function') {
    throw new TypeError('phase2-read-clock-invalid');
  }

  if (!phase2ReadAuthorities.has(dependencies.authority)) {
    throw new TypeError('phase2-read-authority-invalid');
  }
  const authority = dependencies.authority;
  const coordinator = new Phase2ReadSnapshotCoordinator(
    authority,
    dependencies.teamIdentities,
    dependencies.legacyData,
    dependencies.legacyRuntime
  );
  const policy = {
    isAuthorized: (context: QueryContext) => coordinator.admitContext(context),
    nowMs: dependencies.nowMs,
  };
  const purposes = new IdentityProjectionPurposeContext();
  const source = new LegacyTeamLifecycleReadSource({
    identities: new CanonicalIdentityProjectionReadPort(coordinator, pageSize, purposes),
    data: new SnapshotLegacyDataPort(coordinator),
    runtime: new SnapshotRuntimeReadPort(coordinator),
    policy,
  });
  const list = new ListTeamLifecycle(source);
  const snapshot = new GetTeamLifecycleSnapshot(source);
  const runtime = new GetRuntimeStateProjection(source);
  const alive = new ListAliveTeamProjections(source);
  const useCases = {
    list: {
      execute: (request: unknown, context: QueryContext) =>
        purposes.run(context, 'lifecycle', () => list.execute(request, context)),
    },
    snapshot: {
      execute: (request: unknown, context: QueryContext) =>
        purposes.run(context, 'lifecycle', () => snapshot.execute(request, context)),
    },
    runtime: {
      execute: (request: unknown, context: QueryContext) =>
        purposes.run(context, 'runtime', () => runtime.execute(request, context)),
    },
    alive: {
      execute: (request: unknown, context: QueryContext) =>
        purposes.run(context, 'runtime', () => alive.execute(request, context)),
    },
  };

  return Object.freeze({
    authority,
    teamLifecycle: new TeamLifecycleReadApiAdapter(useCases),
  });
}

export function createPhase2ReadHost(
  composition: Phase2ReadComposition,
  createContext: (authority: Phase2ReadAuthority) => QueryContext
): Phase2ReadHost {
  return Object.freeze({
    async listTeamLifecycle(request: unknown): Promise<CanonicalListTeamLifecycleResult> {
      try {
        const context = createContext(composition.authority);
        return await composition.teamLifecycle.listTeamLifecycle(
          request as ListTeamLifecycleRequest,
          context
        );
      } catch {
        return failure('internal', 'unexpected', 'phase2-read.host-unexpected');
      }
    },
  });
}

/** Production-safe placeholder until the app shell owns one unique admitted workspace binding. */
export function createUnavailablePhase2ReadHost(): Phase2ReadHost {
  return Object.freeze({
    async listTeamLifecycle(request: unknown): Promise<CanonicalListTeamLifecycleResult> {
      const parsed = parseListTeamLifecycleRequest(request);
      if (!parsed.ok) {
        const code = parsed.error.code;
        if (code === 'not_found' || code === 'unauthenticated') {
          return failure('internal', 'unexpected', 'phase2-read.request-error-invalid');
        }
        return failure(code, parsed.error.reason, parsed.error.diagnosticId);
      }
      return identityUnavailable();
    },
  });
}
