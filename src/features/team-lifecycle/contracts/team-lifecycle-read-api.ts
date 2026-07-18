import type {
  CanonicalListTeamLifecycleResult,
  GetRuntimeStateProjectionRequest,
  GetRuntimeStateProjectionResult,
  GetTeamLifecycleSnapshotRequest,
  GetTeamLifecycleSnapshotResult,
  ListAliveTeamProjectionsRequest,
  ListAliveTeamProjectionsResult,
  ListTeamLifecycleRequest,
} from './team-lifecycle-read';
import type { QueryContext } from '@shared/contracts/hosted';

/** Renderer-safe read operation implemented by every transport adapter. */
export interface TeamLifecycleReadTransportApi {
  listTeamLifecycle(request: ListTeamLifecycleRequest): Promise<CanonicalListTeamLifecycleResult>;
}

/** A small application-facing read facet. */
export interface TeamLifecycleReadApi {
  listTeamLifecycle(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ): Promise<CanonicalListTeamLifecycleResult>;

  getTeamLifecycleSnapshot(
    request: GetTeamLifecycleSnapshotRequest,
    context: QueryContext
  ): Promise<GetTeamLifecycleSnapshotResult>;

  getRuntimeStateProjection(
    request: GetRuntimeStateProjectionRequest,
    context: QueryContext
  ): Promise<GetRuntimeStateProjectionResult>;

  listAliveTeamProjections(
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): Promise<ListAliveTeamProjectionsResult>;
}
