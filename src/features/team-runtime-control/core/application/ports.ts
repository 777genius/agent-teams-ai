import type {
  CompositeRuntimePlan,
  CompositeRuntimePlanHash,
  ExecutionUnitId,
  HostedChildEnvironmentPolicy,
  LaneId,
  ProcessExecutionUnit,
  RegisteredWorkspaceRuntimeBinding,
  ResolvedRuntimeBinaryPolicy,
  RuntimeExecutionBackendKind,
  RuntimeResourcePolicy,
  Sha256Hash,
} from '../../contracts';
import type { MemberId, RunId, WorkspaceId } from '@shared/contracts/hosted';

declare const runtimeControlPortBrand: unique symbol;

type RuntimeControlRef<Name extends string> = string & {
  readonly [runtimeControlPortBrand]: Name;
};

export type SupervisedProcessRef = RuntimeControlRef<'SupervisedProcessRef'>;
export type RuntimeIngressRelayRef = RuntimeControlRef<'RuntimeIngressRelayRef'>;
export type LaneRelayHandle = RuntimeControlRef<'LaneRelayHandle'>;
export type RuntimeIngressVerb = RuntimeControlRef<'RuntimeIngressVerb'>;
export type WorkspaceExecutionGrantId = RuntimeControlRef<'WorkspaceExecutionGrantId'>;
export type ResolvedExecutableAuthorityRef = RuntimeControlRef<'ResolvedExecutableAuthorityRef'>;
export type ResolvedWorkdirAuthorityRef = RuntimeControlRef<'ResolvedWorkdirAuthorityRef'>;
export type ResolvedEnvironmentAuthorityRef = RuntimeControlRef<'ResolvedEnvironmentAuthorityRef'>;
export type RuntimeCancellationId = RuntimeControlRef<'RuntimeCancellationId'>;

export interface RuntimePlanRef {
  readonly teamId: CompositeRuntimePlan['teamId'];
  readonly runId: RunId;
  readonly generation: number;
  readonly planHash: CompositeRuntimePlanHash;
}

/** Opaque authorization issued for one exact registered workspace generation. */
export interface WorkspaceExecutionGrant {
  readonly grantId: WorkspaceExecutionGrantId;
  readonly workspaceId: WorkspaceId;
  readonly registrationRevision: number;
  readonly bindingGeneration: number;
  readonly mountGeneration: number;
  readonly permission: 'execute_process';
}

/** Cooperative cancellation is explicit on every operation that can create or own a process. */
export interface RuntimeCancellation {
  readonly cancellationId: RuntimeCancellationId;
  readonly isCancellationRequested: () => boolean;
}

export interface ResolveRuntimeExecutionRequest {
  readonly plan: CompositeRuntimePlan;
  readonly executionUnitId: ExecutionUnitId;
  readonly cancellation: RuntimeCancellation;
}

export interface ResolvedProcessArgvAuthority {
  readonly executableRef: ResolvedExecutableAuthorityRef;
  readonly binaryPolicy: ResolvedRuntimeBinaryPolicy;
  readonly argv: readonly string[];
  readonly argvHash: Sha256Hash;
}

export interface ResolvedProcessEnvironmentAuthority {
  readonly environmentRef: ResolvedEnvironmentAuthorityRef;
  readonly policy: HostedChildEnvironmentPolicy;
}

export interface ResolvedRuntimeExecution {
  readonly argvAuthority: ResolvedProcessArgvAuthority;
  readonly environmentAuthority: ResolvedProcessEnvironmentAuthority;
}

export type ResolveRuntimeExecutionResult =
  | { readonly status: 'resolved'; readonly execution: ResolvedRuntimeExecution }
  | {
      readonly status: 'rejected';
      readonly reason: 'cancelled' | 'invalid_plan' | 'unsupported' | 'unavailable';
    };

/** Provider execution semantics resolve argv/environment only; they never supervise processes. */
export interface RuntimeExecutionBackend {
  readonly backend: RuntimeExecutionBackendKind;
  resolve(request: ResolveRuntimeExecutionRequest): Promise<ResolveRuntimeExecutionResult>;
}

export interface ResolveWorkspaceExecutionRequest {
  readonly planRef: RuntimePlanRef;
  readonly workspaceBinding: RegisteredWorkspaceRuntimeBinding;
  readonly grant: WorkspaceExecutionGrant;
  readonly cancellation: RuntimeCancellation;
}

export interface ResolvedProcessWorkdirAuthority {
  readonly workdirRef: ResolvedWorkdirAuthorityRef;
  readonly grant: WorkspaceExecutionGrant;
}

export type ResolveWorkspaceExecutionResult =
  | { readonly status: 'resolved'; readonly workdirAuthority: ResolvedProcessWorkdirAuthority }
  | {
      readonly status: 'rejected';
      readonly reason: 'cancelled' | 'stale_grant' | 'not_authorized' | 'unavailable';
    };

/** The workspace owner resolves a grant without exposing an arbitrary cwd to provider code. */
export interface WorkspaceExecutionAuthorityPort {
  resolve(request: ResolveWorkspaceExecutionRequest): Promise<ResolveWorkspaceExecutionResult>;
}

export interface ResolvedProcessLaunchSpec {
  readonly planRef: RuntimePlanRef;
  readonly executionUnitId: ExecutionUnitId;
  readonly backend: RuntimeExecutionBackendKind;
  readonly argvAuthority: ResolvedProcessArgvAuthority;
  readonly workdirAuthority: ResolvedProcessWorkdirAuthority;
  readonly environmentAuthority: ResolvedProcessEnvironmentAuthority;
  readonly resourcePolicy: RuntimeResourcePolicy;
}

export interface StartProcessExecutionUnitRequest {
  readonly executionUnit: ProcessExecutionUnit;
  readonly launchSpec: ResolvedProcessLaunchSpec;
  readonly cancellation: RuntimeCancellation;
}

export type StartProcessExecutionUnitResult =
  | { readonly status: 'started' | 'already_started'; readonly processRef: SupervisedProcessRef }
  | {
      readonly status: 'rejected';
      readonly reason: 'cancelled' | 'stale_plan' | 'not_owned' | 'unavailable';
    };

export interface StopProcessExecutionUnitRequest {
  readonly planRef: RuntimePlanRef;
  readonly executionUnitId: ExecutionUnitId;
  readonly processRef: SupervisedProcessRef;
  readonly mode: 'graceful' | 'immediate';
  readonly cancellation: RuntimeCancellation;
}

export type StopProcessExecutionUnitResult =
  | { readonly status: 'drained' | 'already_drained' | 'cancelled' }
  | { readonly status: 'unclassified_residual' };

export interface ObserveProcessExecutionUnitRequest {
  readonly planRef: RuntimePlanRef;
  readonly executionUnitId: ExecutionUnitId;
  readonly processRef: SupervisedProcessRef;
}

export type ObserveProcessExecutionUnitResult =
  | { readonly status: 'starting' | 'ready' | 'stopping' }
  | { readonly status: 'exited'; readonly outcome: 'success' | 'failure' | 'unknown' }
  | { readonly status: 'unclassified_residual' };

export interface RecoverProcessExecutionUnitRequest {
  readonly planRef: RuntimePlanRef;
  readonly executionUnit: ProcessExecutionUnit;
  readonly cancellation: RuntimeCancellation;
}

export type RecoverProcessExecutionUnitResult =
  | { readonly status: 'not_started' | 'recovered'; readonly processRef?: SupervisedProcessRef }
  | { readonly status: 'cancelled' | 'operator_required' };

/** Process ownership consumes resolved authorities and never performs provider planning. */
export interface ProcessSupervisorPort {
  start(request: StartProcessExecutionUnitRequest): Promise<StartProcessExecutionUnitResult>;
  stop(request: StopProcessExecutionUnitRequest): Promise<StopProcessExecutionUnitResult>;
  observe(request: ObserveProcessExecutionUnitRequest): Promise<ObserveProcessExecutionUnitResult>;
  recover(request: RecoverProcessExecutionUnitRequest): Promise<RecoverProcessExecutionUnitResult>;
}

export interface OpenRuntimeIngressRelayRequest {
  readonly planRef: RuntimePlanRef;
  readonly laneId: LaneId;
  readonly memberIds: readonly MemberId[];
  readonly credentialGeneration: number;
  readonly allowedVerbs: readonly RuntimeIngressVerb[];
}

export type OpenRuntimeIngressRelayResult =
  | {
      readonly status: 'opened' | 'already_open';
      readonly relayRef: RuntimeIngressRelayRef;
      readonly laneRelayHandle: LaneRelayHandle;
    }
  | { readonly status: 'rejected'; readonly reason: 'stale_plan' | 'unsupported' | 'unavailable' };

export interface CloseRuntimeIngressRelayRequest {
  readonly planRef: RuntimePlanRef;
  readonly laneId: LaneId;
  readonly relayRef: RuntimeIngressRelayRef;
}

export type CloseRuntimeIngressRelayResult = {
  readonly status: 'closed' | 'already_closed' | 'unclassified_residual';
};

/** Lane scope is fixed by the request; provider payloads cannot select another authority. */
export interface RuntimeIngressRelayPort {
  open(request: OpenRuntimeIngressRelayRequest): Promise<OpenRuntimeIngressRelayResult>;
  close(request: CloseRuntimeIngressRelayRequest): Promise<CloseRuntimeIngressRelayResult>;
}
