/** Compatibility entry; the canonical owner contract is shared with the Host. */
export { sameOwner } from '@agent-teams/legacy-agent-host/owned-process';
export type {
  ProcessOwner, Creation, Coverage, TreeReceipt, TreeOutcome, StopRequest, ResolvedLaunchSpec,
  RootExit, BrokerExit, ControlCause, ControlPhase, NativeExitCategory, ControlDiagnostics,
  TargetDrain, PendingOwnedProcess, PreparedOwnedProcess, Preparation, OwnedLaunchPort,
} from '@agent-teams/legacy-agent-host/owned-process';
