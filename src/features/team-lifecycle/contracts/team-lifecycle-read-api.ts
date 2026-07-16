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
