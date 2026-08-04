import { TeamLifecycleReadApiAdapter as InternalTeamLifecycleReadApiAdapter } from './adapters/input/TeamLifecycleReadApiAdapter';
import { LegacyTeamLifecycleReadSource as InternalLegacyTeamLifecycleReadSource } from './infrastructure/LegacyTeamLifecycleReadSource';

import type {
  CanonicalListTeamLifecycleResult,
  GetRuntimeStateProjectionRequest,
  GetRuntimeStateProjectionResult,
  GetTeamLifecycleSnapshotRequest,
  GetTeamLifecycleSnapshotResult,
  ListAliveTeamProjectionsRequest,
  ListAliveTeamProjectionsResult,
  ListTeamLifecycleInapplicable,
  ListTeamLifecycleRequest,
  TeamLifecycleEntityInapplicable,
  TeamLifecycleReadApi,
  TeamLifecycleReadFailure,
} from '../contracts';
import type {
  AliveTeamProjectionsReadPort,
  GetRuntimeStateProjection,
  GetTeamLifecycleSnapshot,
  ListAliveTeamProjections,
  ListTeamLifecycle,
  RuntimeStateProjectionReadPort,
  TeamLifecycleReadSource,
  TeamLifecycleSnapshotReadPort,
} from '../core/application';
import type { Cursor, QueryContext, Revision, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export type {
  TeamLifecycleAtomicCommandPort,
  TeamLifecycleIpcHandlerPort,
  TeamLifecycleIpcLoggerPort,
  TeamLifecycleIpcRegistrar,
  TeamLifecycleIpcResult,
  TeamLifecycleTeamNameValidator,
} from '../core/application/ports/TeamLifecycleIpcPorts';

export interface TeamLifecycleReadUseCases {
  readonly list: Pick<ListTeamLifecycle, 'execute'>;
  readonly snapshot: Pick<GetTeamLifecycleSnapshot, 'execute'>;
  readonly runtime: Pick<GetRuntimeStateProjection, 'execute'>;
  readonly alive: Pick<ListAliveTeamProjections, 'execute'>;
}

export class TeamLifecycleReadApiAdapter implements TeamLifecycleReadApi {
  private readonly adapter: TeamLifecycleReadApi;

  constructor(useCases: TeamLifecycleReadUseCases) {
    this.adapter = new InternalTeamLifecycleReadApiAdapter(useCases);
  }

  listTeamLifecycle(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ): Promise<CanonicalListTeamLifecycleResult> {
    return this.adapter.listTeamLifecycle(request, context);
  }

  getTeamLifecycleSnapshot(
    request: GetTeamLifecycleSnapshotRequest,
    context: QueryContext
  ): Promise<GetTeamLifecycleSnapshotResult> {
    return this.adapter.getTeamLifecycleSnapshot(request, context);
  }

  getRuntimeStateProjection(
    request: GetRuntimeStateProjectionRequest,
    context: QueryContext
  ): Promise<GetRuntimeStateProjectionResult> {
    return this.adapter.getRuntimeStateProjection(request, context);
  }

  listAliveTeamProjections(
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): Promise<ListAliveTeamProjectionsResult> {
    return this.adapter.listAliveTeamProjections(request, context);
  }
}

export {
  createTeamLifecycleCommandFeature,
  type TeamLifecycleCommandFeature,
  type TeamLifecycleCommandFeatureDependencies,
} from './composition/createTeamLifecycleCommandFeature';
export {
  createTeamLifecycleIpcFeature,
  registerTeamLifecycleIpc,
  removeTeamLifecycleIpc,
  type TeamLifecycleIpcFeature,
  type TeamLifecycleIpcFeatureDependencies,
} from './composition/createTeamLifecycleIpcFeature';
export {
  createTeamLifecycleReadIpcFeature,
  registerTeamLifecycleReadIpc,
  removeTeamLifecycleReadIpc,
  type TeamLifecycleReadIpcFeature,
  type TeamLifecycleReadIpcFeatureDependencies,
} from './composition/createTeamLifecycleReadIpcFeature';
export {
  createTeamRosterAdoptionFeature,
  type TeamRosterAdoptionFeature,
  type TeamRosterAdoptionFeatureDependencies,
} from './composition/createTeamRosterAdoptionFeature';
export {
  createHostedLifecycleCommandFeature,
  createHostedLifecycleCommandRouteContribution,
  OrchestratorLifecycleCommandClient,
  registerHostedLifecycleCommandHttp,
} from './hosted';

export type LegacyTeamReadAvailability =
  | 'current'
  | 'draft'
  | 'provisioning'
  | 'corrupt'
  | 'partial'
  | 'unavailable';

export interface LegacyTeamIdentityBinding {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly legacyTeamName: string;
  readonly displayName: string;
  readonly revision: Revision;
  readonly availability?: LegacyTeamReadAvailability;
}

export interface LegacyTeamBindingPage {
  readonly snapshotRevision: Revision;
  readonly bindings: readonly LegacyTeamIdentityBinding[];
  readonly nextCursor: Cursor | null;
}

export interface LegacyTeamIdentityReadPort {
  listTeamBindings(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ):
    | LegacyTeamBindingPage
    | TeamLifecycleReadFailure
    | ListTeamLifecycleInapplicable
    | Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure | ListTeamLifecycleInapplicable>;

  getTeamBinding(
    request: GetTeamLifecycleSnapshotRequest,
    context: QueryContext
  ):
    | LegacyTeamIdentityBinding
    | TeamLifecycleReadFailure
    | TeamLifecycleEntityInapplicable
    | null
    | Promise<
        | LegacyTeamIdentityBinding
        | TeamLifecycleReadFailure
        | TeamLifecycleEntityInapplicable
        | null
      >;

  listAliveTeamBindings(
    legacyTeamNames: readonly string[],
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ):
    | LegacyTeamBindingPage
    | TeamLifecycleReadFailure
    | Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure>;
}

export interface LegacyTeamDataReadPort {
  listTeams(context: QueryContext): unknown;
  getTeamData(legacyTeamName: string, context: QueryContext): unknown;
}

export interface LegacyTeamRuntimeReadPort {
  getRuntimeState(legacyTeamName: string, context: QueryContext): unknown;
  getAliveTeams(context: QueryContext): unknown;
}

export interface LegacyTeamLifecycleReadPolicy {
  isAuthorized(context: QueryContext): boolean;
  nowMs(): number;
}

export interface LegacyTeamLifecycleReadSourceDependencies {
  readonly identities: LegacyTeamIdentityReadPort;
  readonly data: LegacyTeamDataReadPort;
  readonly runtime: LegacyTeamRuntimeReadPort;
  readonly policy: LegacyTeamLifecycleReadPolicy;
}

export class LegacyTeamLifecycleReadSource
  implements
    TeamLifecycleReadSource,
    TeamLifecycleSnapshotReadPort,
    RuntimeStateProjectionReadPort,
    AliveTeamProjectionsReadPort
{
  private readonly source: InternalLegacyTeamLifecycleReadSource;

  constructor(dependencies: LegacyTeamLifecycleReadSourceDependencies) {
    this.source = new InternalLegacyTeamLifecycleReadSource(dependencies);
  }

  listTeamLifecycle(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ): Promise<CanonicalListTeamLifecycleResult> {
    return Promise.resolve(this.source.listTeamLifecycle(request, context));
  }

  getTeamLifecycleSnapshot(
    request: GetTeamLifecycleSnapshotRequest,
    context: QueryContext
  ): Promise<GetTeamLifecycleSnapshotResult> {
    return Promise.resolve(this.source.getTeamLifecycleSnapshot(request, context));
  }

  getRuntimeStateProjection(
    request: GetRuntimeStateProjectionRequest,
    context: QueryContext
  ): Promise<GetRuntimeStateProjectionResult> {
    return Promise.resolve(this.source.getRuntimeStateProjection(request, context));
  }

  listAliveTeamProjections(
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): Promise<ListAliveTeamProjectionsResult> {
    return Promise.resolve(this.source.listAliveTeamProjections(request, context));
  }
}
