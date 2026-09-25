import type {
  CompositeRuntimePlan,
  CompositeRuntimePlanHash,
} from '@features/team-runtime-control';
import type { RunId, TeamId } from '@shared/contracts/hosted';

export const TEAM_LIFECYCLE_COMMAND_SCHEMA_VERSION = 1 as const;

export interface LifecycleRunRef {
  readonly runId: RunId;
  readonly generation: number;
}

export const LIFECYCLE_RUN_STATUSES = Object.freeze([
  'accepted',
  'provisioning',
  'ready',
  'degraded',
  'cancelling',
  'cancelled',
  'stopping',
  'stopped',
  'recovering',
  'failed',
  'operator_required',
] as const);
export type LifecycleRunStatus = (typeof LIFECYCLE_RUN_STATUSES)[number];

export const LIFECYCLE_LANE_STATUSES = Object.freeze([
  'queued',
  'launching',
  'starting',
  'ready',
  'degraded',
  'cancelling',
  'cancelled',
  'stopping',
  'stopped',
  'failed',
  'operator_required',
] as const);
export type LifecycleLaneStatus = (typeof LIFECYCLE_LANE_STATUSES)[number];

export interface LifecycleLaneStatusView {
  readonly laneId: string;
  readonly ordinal: number;
  readonly status: LifecycleLaneStatus;
  readonly diagnostic: string | null;
}

export interface LifecycleRunStatusView extends LifecycleRunRef {
  readonly planHash: CompositeRuntimePlanHash;
  readonly status: LifecycleRunStatus;
  readonly revision: number;
  readonly lanes: readonly LifecycleLaneStatusView[];
}

export interface TeamLifecycleCommandIdentity {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export interface PrepareProvisioningRequest {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly inputRevision: number;
}

export interface ProvisioningPreflightLaneView {
  readonly laneKey: string;
  readonly backend: 'provisioning_cli' | 'opencode';
  readonly status: 'ready' | 'unsupported' | 'unavailable';
}

export type PrepareProvisioningResult =
  | {
      readonly status: 'ready';
      readonly inputRevision: number;
      readonly lanes: readonly ProvisioningPreflightLaneView[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: TeamLifecycleCommandRejectionReason;
    };

export interface LaunchTeamRequest extends TeamLifecycleCommandIdentity {
  readonly expectedLifecycleRevision: number;
  readonly expectedCurrentRunRef: LifecycleRunRef | null;
  /** The canonical planner result. Lifecycle code persists it verbatim and never reconstructs it. */
  readonly plan: CompositeRuntimePlan;
}

export interface GetProvisioningStatusRequest {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly runRef: LifecycleRunRef;
}

export interface CancelProvisioningRequest extends TeamLifecycleCommandIdentity {
  readonly expectedLifecycleRevision: number;
  readonly runRef: LifecycleRunRef;
}

export interface StopTeamRequest extends TeamLifecycleCommandIdentity {
  readonly expectedLifecycleRevision: number;
  readonly runRef: LifecycleRunRef;
  readonly mode: 'graceful' | 'immediate';
}

export interface RecoverTeamRunRequest extends TeamLifecycleCommandIdentity {
  readonly expectedLifecycleRevision: number;
  readonly runRef: LifecycleRunRef;
}

export type TeamLifecycleCommandRejectionReason =
  | 'cancelled'
  | 'concurrency_conflict'
  | 'external_writer_busy'
  | 'idempotency_conflict'
  | 'invalid_request'
  | 'legacy_generation_ambiguous'
  | 'legacy_generation_mismatch'
  | 'legacy_drain_active'
  | 'not_found'
  | 'plan_conflict'
  | 'preparation_timeout'
  | 'stale_generation'
  | 'stale_revision'
  | 'terminal_run'
  | 'unavailable'
  | 'unsupported';

export type LaunchTeamResult =
  | {
      readonly status: 'accepted' | 'replayed' | 'degraded' | 'recovering' | 'operator_required';
      readonly run: LifecycleRunStatusView;
    }
  | {
      readonly status: 'rejected';
      readonly reason: TeamLifecycleCommandRejectionReason;
    };

export type GetProvisioningStatusResult =
  | {
      readonly status: 'current';
      readonly run: LifecycleRunStatusView;
    }
  | {
      readonly status: 'legacy';
      readonly generation: number;
      readonly lifecycle: 'active' | 'cancelling' | 'stopping' | 'recovering' | 'terminal';
    }
  | {
      readonly status: 'rejected';
      readonly reason: TeamLifecycleCommandRejectionReason;
    };

export type CancelProvisioningResult =
  | {
      readonly status: 'cancelled' | 'replayed' | 'degraded' | 'recovering' | 'operator_required';
      readonly run?: LifecycleRunStatusView;
      readonly generation?: number;
    }
  | {
      readonly status: 'rejected';
      readonly reason: TeamLifecycleCommandRejectionReason;
    };

export type StopTeamResult =
  | {
      readonly status: 'stopped' | 'replayed' | 'degraded' | 'recovering' | 'operator_required';
      readonly run?: LifecycleRunStatusView;
      readonly generation?: number;
    }
  | {
      readonly status: 'rejected';
      readonly reason: TeamLifecycleCommandRejectionReason;
    };

export type RecoverTeamRunResult =
  | {
      readonly status: 'recovered' | 'replayed' | 'degraded' | 'recovering' | 'operator_required';
      readonly run?: LifecycleRunStatusView;
      readonly generation?: number;
    }
  | {
      readonly status: 'rejected';
      readonly reason: TeamLifecycleCommandRejectionReason;
    };
