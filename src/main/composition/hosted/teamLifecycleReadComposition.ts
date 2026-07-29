import { isAbsolute, resolve } from 'node:path';

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
  type LegacyTeamRuntimeReadPort,
  TeamLifecycleReadApiAdapter,
} from '@features/team-lifecycle/main';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import {
  createQueryContext,
  parseActorId,
  parseAuthorizedScope,
  parseCursor,
  parseRevision,
  type QueryContext,
  type Revision,
} from '@shared/contracts/hosted';

import {
  ExplicitRootReadOnlyTeamSummarySource,
  type HostedReadOnlyTeamSummarySource,
} from './teamLifecycleReadFileSource';
import * as shared from './teamLifecycleReadShared';
import {
  SnapshotLegacyDataPort,
  SnapshotRuntimeReadPort,
  TeamLifecycleReadSnapshotCoordinator,
} from './teamLifecycleReadSnapshot';

export type { HostedReadOnlyTeamSummarySource } from './teamLifecycleReadFileSource';
export type {
  TeamLifecycleReadAuthority,
  TeamLifecycleReadAuthorityInput,
} from './teamLifecycleReadShared';
export { TeamLifecycleReadSnapshotCoordinator } from './teamLifecycleReadSnapshot';

import {
  type AuthoritativeTeamRuntimeEvidenceSource,
  createMountBindingScopedRuntimeEvidencePort,
} from './teamRuntimeEvidenceSource';

const DEFAULT_PAGE_SIZE = 100;
const teamLifecycleReadAuthorities = new WeakSet<object>();

export interface TeamLifecycleReadCompositionDependencies {
  /** The host-created identity and authorization snapshot for every read in this composition. */
  readonly authority: shared.TeamLifecycleReadAuthority;
  /** Null means the durable component is unavailable; discovery fallback is forbidden. */
  readonly teamIdentities: TeamIdentityReadGateway | null;
  readonly legacyData: LegacyTeamDataReadPort;
  readonly legacyRuntime: LegacyTeamRuntimeReadPort;
  readonly nowMs: () => number;
  readonly pageSize?: number;
}

export interface TeamLifecycleReadComposition {
  readonly authority: shared.TeamLifecycleReadAuthority;
  readonly teamLifecycle: TeamLifecycleReadApi;
}

export interface MountBindingScopedTeamLifecycleReadPorts {
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly legacyData: LegacyTeamDataReadPort;
  readonly legacyRuntime: LegacyTeamRuntimeReadPort;
}

export interface MountBindingScopedTeamLifecycleReadPortsInput {
  readonly authority: shared.TeamLifecycleReadAuthority;
  readonly mountBinding: WorkspaceMountBinding;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly nowMs: () => number;
  /** Test seam for the narrow read-only adapter; production uses explicit-root filesystem reads. */
  readonly teamSummarySource?: HostedReadOnlyTeamSummarySource;
  /** Omit unless the host owns authoritative evidence already scoped to this exact mount. */
  readonly runtimeEvidenceSource?: AuthoritativeTeamRuntimeEvidenceSource;
}

export interface TeamLifecycleReadHost {
  listTeamLifecycle(
    request: unknown,
    requestSignal?: AbortSignal
  ): Promise<CanonicalListTeamLifecycleResult>;
}

class MountBindingScopedIdentityGateway implements TeamIdentityReadGateway {
  private currentIdentities: readonly TeamIdentityRecord[] = Object.freeze([]);

  constructor(
    private readonly source: TeamIdentityReadGateway,
    private readonly mountBinding: WorkspaceMountBinding
  ) {}

  async listTeamIdentities(): Promise<readonly TeamIdentityRecord[]> {
    const values = await this.source.listTeamIdentities();
    if (!Array.isArray(values)) {
      throw new TypeError('team-lifecycle-read-identity-source-invalid');
    }
    const identities = values.flatMap((value) => {
      const identity = parseTeamIdentityRecord(value);
      const workspaceBinding = identity.workspaceBinding;
      if (workspaceBinding === null) {
        throw new TypeError('team-lifecycle-read-identity-binding-invalid');
      }
      if (workspaceBinding.workspaceId !== this.mountBinding.workspaceId) return [];
      if (workspaceBinding.generation !== this.mountBinding.mountGeneration) {
        throw new TypeError('team-lifecycle-read-identity-binding-generation-invalid');
      }
      return [identity];
    });
    this.currentIdentities = Object.freeze(identities);
    return this.currentIdentities;
  }

  async getTeamIdentity(
    teamId: Parameters<TeamIdentityReadGateway['getTeamIdentity']>[0]
  ): Promise<TeamIdentityRecord | null> {
    const value = await this.source.getTeamIdentity(teamId);
    if (value === null) return null;
    const identity = parseTeamIdentityRecord(value);
    const workspaceBinding = identity.workspaceBinding;
    if (workspaceBinding === null) {
      throw new TypeError('team-lifecycle-read-identity-binding-invalid');
    }
    if (workspaceBinding.workspaceId !== this.mountBinding.workspaceId) return null;
    if (workspaceBinding.generation !== this.mountBinding.mountGeneration) {
      throw new TypeError('team-lifecycle-read-identity-binding-generation-invalid');
    }
    return identity;
  }

  identitiesForCurrentSnapshot(): readonly TeamIdentityRecord[] {
    return this.currentIdentities;
  }
}

class MountBindingScopedLegacyDataPort implements LegacyTeamDataReadPort {
  constructor(
    private readonly claudeRoot: string,
    private readonly identities: MountBindingScopedIdentityGateway,
    private readonly source: HostedReadOnlyTeamSummarySource,
    private readonly nowMs: () => number
  ) {}

  private assertActive(context: QueryContext): void {
    if (context.signal.aborted) throw new Error('team-lifecycle-read-request-cancelled');
    const nowMs = this.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= context.deadlineAtMs) {
      throw new Error('team-lifecycle-read-request-expired');
    }
  }

  private async readSummary(
    identity: TeamIdentityRecord,
    context: QueryContext
  ): Promise<Readonly<Record<PropertyKey, unknown>> | null> {
    this.assertActive(context);
    try {
      const summary = await this.source.readTeamSummary({
        claudeRoot: this.claudeRoot,
        identity,
        context,
        assertActive: () => this.assertActive(context),
      });
      this.assertActive(context);
      return summary;
    } catch (error) {
      this.assertActive(context);
      throw error;
    }
  }

  async listTeams(context: QueryContext): Promise<unknown> {
    const summaries: Readonly<Record<PropertyKey, unknown>>[] = [];
    for (const identity of this.identities.identitiesForCurrentSnapshot()) {
      if (identity.state !== 'active') continue;
      const summary = await this.readSummary(identity, context);
      if (summary) summaries.push(summary);
    }
    return Object.freeze(summaries);
  }

  async getTeamData(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const identity = this.identities
      .identitiesForCurrentSnapshot()
      .find((candidate) => candidate.legacyKey === legacyTeamName);
    if (!identity) throw new Error('team-lifecycle-read-team-outside-mount-binding');
    const summary = await this.readSummary(identity, context);
    if (!summary) throw new Error('team-lifecycle-read-team-data-unavailable');
    const config =
      typeof summary.deletedAt === 'string'
        ? Object.freeze({ deletedAt: summary.deletedAt })
        : Object.freeze({});
    const warnings =
      summary.partialLaunchFailure === true ? Object.freeze(['degraded']) : Object.freeze([]);
    return Object.freeze({ teamName: legacyTeamName, config, warnings });
  }
}

export function createTeamLifecycleReadAuthority(
  value: shared.TeamLifecycleReadAuthorityInput
): shared.TeamLifecycleReadAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('team-lifecycle-read-authority-invalid');
  }
  try {
    if (!(value.mountBinding instanceof WorkspaceMountBinding)) {
      throw new TypeError('team-lifecycle-read-mount-binding-not-admitted');
    }
    if (value.mountBinding.health === 'unavailable') {
      throw new TypeError('team-lifecycle-read-mount-binding-unavailable');
    }
    const runtimeInstance = createRuntimeInstanceContext(value.runtimeInstance);
    if (value.mountBinding.bootId !== runtimeInstance.bootId) {
      throw new TypeError('team-lifecycle-read-runtime-binding-mismatch');
    }
    const authority = Object.freeze({
      actorId: parseActorId(value.actorId),
      authorizedScope: parseAuthorizedScope(value.authorizedScope),
      workspaceId: value.mountBinding.workspaceId,
      workspaceGeneration: value.mountBinding.mountGeneration,
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
    });
    teamLifecycleReadAuthorities.add(authority);
    return authority;
  } catch {
    throw new TypeError('team-lifecycle-read-authority-invalid');
  }
}

/**
 * Builds the hosted-only read ports from one admitted mount binding and explicit runtime roots.
 * The adapters never enumerate the ambient teams root and expose no write, process, provider, or
 * cleanup capability. Legacy config reads are limited to keys returned for this mount binding.
 */
export function createMountBindingScopedTeamLifecycleReadPorts(
  input: MountBindingScopedTeamLifecycleReadPortsInput
): MountBindingScopedTeamLifecycleReadPorts {
  if (!teamLifecycleReadAuthorities.has(input.authority)) {
    throw new TypeError('team-lifecycle-read-authority-invalid');
  }
  if (!(input.mountBinding instanceof WorkspaceMountBinding)) {
    throw new TypeError('team-lifecycle-read-mount-binding-invalid');
  }
  const runtimeInstance = createRuntimeInstanceContext(input.runtimeInstance);
  if (
    input.mountBinding.health === 'unavailable' ||
    input.mountBinding.bootId !== runtimeInstance.bootId ||
    input.authority.workspaceId !== input.mountBinding.workspaceId ||
    input.authority.workspaceGeneration !== input.mountBinding.mountGeneration ||
    input.authority.deploymentId !== runtimeInstance.deploymentId ||
    input.authority.bootId !== runtimeInstance.bootId
  ) {
    throw new TypeError('team-lifecycle-read-mount-binding-invalid');
  }
  if (typeof input.nowMs !== 'function') {
    throw new TypeError('team-lifecycle-read-clock-invalid');
  }

  const claudeRoot = runtimeInstance.claudeRoot.reference as string;
  if (
    !isAbsolute(claudeRoot) ||
    resolve(claudeRoot) !== claudeRoot ||
    claudeRoot === resolve(claudeRoot, '/')
  ) {
    throw new TypeError('team-lifecycle-read-claude-root-invalid');
  }

  const identities = new MountBindingScopedIdentityGateway(
    input.teamIdentities,
    input.mountBinding
  );
  return Object.freeze({
    teamIdentities: identities,
    legacyData: new MountBindingScopedLegacyDataPort(
      claudeRoot,
      identities,
      input.teamSummarySource ?? new ExplicitRootReadOnlyTeamSummarySource(),
      input.nowMs
    ),
    legacyRuntime: createMountBindingScopedRuntimeEvidencePort({
      mountBinding: input.mountBinding,
      runtimeInstance,
      identitiesForCurrentSnapshot: () => identities.identitiesForCurrentSnapshot(),
      nowMs: input.nowMs,
      source: input.runtimeEvidenceSource,
    }),
  });
}

/** Owns the one immutable identity/data snapshot used throughout a host request. */
type IdentityProjectionPurpose = 'lifecycle' | 'runtime';

class IdentityProjectionPurposeContext {
  private readonly purposes = new WeakMap<QueryContext, IdentityProjectionPurpose>();

  async run<TResult>(
    context: QueryContext,
    purpose: IdentityProjectionPurpose,
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    if (this.purposes.has(context)) {
      throw new Error('team-lifecycle-read-projection-purpose-context-reused');
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
    private readonly coordinator: TeamLifecycleReadSnapshotCoordinator,
    private readonly pageSize: number,
    private readonly purposes: IdentityProjectionPurposeContext
  ) {}

  async listTeamBindings(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ): Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure> {
    if (this.purposes.current(context) !== 'lifecycle') return shared.projectionPurposeInvalid();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (shared.isSnapshotFailure(snapshot)) return snapshot;
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
    if (purpose === null) return shared.projectionPurposeInvalid();
    if (request.workspaceId !== this.coordinator.authority.workspaceId)
      return shared.forbiddenContext();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (shared.isSnapshotFailure(snapshot)) return snapshot;
    const identity = snapshot.identities.find((candidate) => candidate.teamId === request.teamId);
    if (!identity) return null;
    const summary = snapshot.summariesByName.get(identity.legacyKey) ?? null;
    let projection: unknown = summary;
    if (purpose === 'runtime') {
      if (shared.availability(identity, summary) === 'draft') return shared.dataUnavailable();
      const runtime = await this.coordinator.readRuntimeState(identity.legacyKey, context);
      if (shared.isRuntimeFailure(runtime)) return runtime;
      projection = runtime;
    }
    return shared.binding(identity, projection, summary);
  }

  async listAliveTeamBindings(
    legacyTeamNames: readonly string[],
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure> {
    if (this.purposes.current(context) !== 'runtime') return shared.projectionPurposeInvalid();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (shared.isSnapshotFailure(snapshot)) return snapshot;
    const frozenAliveNames = await this.coordinator.readAliveNames(context);
    if (shared.isAliveNamesFailure(frozenAliveNames)) return frozenAliveNames;
    if (
      legacyTeamNames.length !== frozenAliveNames.length ||
      legacyTeamNames.some((name, index) => name !== frozenAliveNames[index])
    ) {
      return shared.corruptData();
    }
    const alive = new Set(frozenAliveNames);
    const identities = snapshot.identities.filter(
      (identity) => identity.state === 'active' && alive.has(identity.legacyKey)
    );
    const revision = parseRevision(
      `revision_${shared.digest(
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
    snapshot: shared.TeamLifecycleReadSnapshot,
    projection: (identity: TeamIdentityRecord) => unknown
  ): LegacyTeamBindingPage | TeamLifecycleReadFailure {
    let offset = 0;
    if (cursorValue !== null) {
      const match = shared.matchTeamLifecycleReadCursorForRead(cursorValue);
      if (!match) return shared.invalidCursor();
      offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= identities.length) {
        return shared.invalidCursor();
      }
      if (match[2] !== this.cursorDigest(revision, offset)) return shared.snapshotChanged();
    }

    const pageIdentities = identities.slice(offset, offset + this.pageSize);
    const bindings: LegacyTeamIdentityBinding[] = [];
    for (const identity of pageIdentities) {
      const summary = snapshot.summariesByName.get(identity.legacyKey) ?? null;
      const result = shared.binding(identity, projection(identity), summary);
      if (shared.isFailure(result)) return result;
      bindings.push(result);
    }
    const nextOffset = offset + pageIdentities.length;
    const nextCursor =
      nextOffset < identities.length
        ? parseCursor(
            `${shared.TEAM_LIFECYCLE_READ_CURSOR_PREFIX}_${nextOffset}_${this.cursorDigest(revision, nextOffset)}`
          )
        : null;
    return Object.freeze({
      snapshotRevision: revision,
      bindings: Object.freeze(bindings),
      nextCursor,
    });
  }

  private cursorDigest(revision: Revision, offset: number): string {
    return shared.authorityCursorDigest(this.coordinator.authority, revision, offset);
  }
}

export function createTeamLifecycleReadComposition(
  dependencies: TeamLifecycleReadCompositionDependencies
): TeamLifecycleReadComposition {
  const pageSize = dependencies.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > shared.MAX_PAGE_SIZE) {
    throw new TypeError('team-lifecycle-read-page-size-invalid');
  }
  if (typeof dependencies.nowMs !== 'function') {
    throw new TypeError('team-lifecycle-read-clock-invalid');
  }

  if (!teamLifecycleReadAuthorities.has(dependencies.authority)) {
    throw new TypeError('team-lifecycle-read-authority-invalid');
  }
  const authority = dependencies.authority;
  const coordinator = new TeamLifecycleReadSnapshotCoordinator(
    authority,
    dependencies.teamIdentities,
    dependencies.legacyData,
    dependencies.legacyRuntime,
    dependencies.nowMs
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
        purposes.run(context, 'runtime', async () => {
          const result = await alive.execute(request, context);
          if (result.kind !== 'failure' || result.error.code !== 'unavailable') return result;
          const evidence = await coordinator.readAliveNames(context);
          return shared.isAliveNamesFailure(evidence) ? evidence : result;
        }),
    },
  };

  return Object.freeze({
    authority,
    teamLifecycle: new TeamLifecycleReadApiAdapter(useCases),
  });
}

export function createTeamLifecycleReadHost(
  composition: TeamLifecycleReadComposition,
  createContext: (
    authority: shared.TeamLifecycleReadAuthority,
    requestSignal: AbortSignal
  ) => QueryContext
): TeamLifecycleReadHost {
  return Object.freeze({
    async listTeamLifecycle(
      request: unknown,
      requestSignal?: AbortSignal
    ): Promise<CanonicalListTeamLifecycleResult> {
      try {
        const signal = requestSignal ?? new AbortController().signal;
        const createdContext = createContext(composition.authority, signal);
        const context =
          createdContext.signal === signal
            ? createdContext
            : createQueryContext({ ...createdContext, signal });
        return await composition.teamLifecycle.listTeamLifecycle(
          request as ListTeamLifecycleRequest,
          context
        );
      } catch {
        return shared.failure(
          'internal',
          'unexpected',
          shared.TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.hostUnexpected
        );
      }
    },
  });
}

/** Production-safe placeholder until the app shell owns one unique admitted workspace binding. */
export function createUnavailableTeamLifecycleReadHost(): TeamLifecycleReadHost {
  return Object.freeze({
    async listTeamLifecycle(request: unknown): Promise<CanonicalListTeamLifecycleResult> {
      const parsed = parseListTeamLifecycleRequest(request);
      if (!parsed.ok) {
        const code = parsed.error.code;
        if (code === 'not_found' || code === 'unauthenticated') {
          return shared.failure(
            'internal',
            'unexpected',
            shared.TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.requestErrorInvalid
          );
        }
        return shared.failure(code, parsed.error.reason, parsed.error.diagnosticId);
      }
      return shared.identityUnavailable();
    },
  });
}
