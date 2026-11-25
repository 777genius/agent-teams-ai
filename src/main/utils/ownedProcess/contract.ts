/** Compatibility entry; the canonical owner contract is shared with the Host. */
export type {
  BrokerExit,
  ControlCause,
  ControlDiagnostics,
  ControlPhase,
  Coverage,
  Creation,
  NativeExitCategory,
  OwnedLaunchPort,
  PendingOwnedProcess,
  Preparation,
  PreparedOwnedProcess,
  ProcessOwner,
  ResolvedLaunchSpec,
  RootExit,
  StopRequest,
  TargetDrain,
  TreeOutcome,
  TreeReceipt,
} from '@agent-teams/legacy-agent-host/owned-process';
export { sameOwner } from '@agent-teams/legacy-agent-host/owned-process';
