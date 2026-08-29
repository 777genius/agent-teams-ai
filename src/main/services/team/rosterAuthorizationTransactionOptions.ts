import type { DurableUnknownLaunchEvidence } from './rosterAuthorizationOutcome';
import type {
  DurableLaunchCommandRecord,
  RosterAuthorizationTransactionRecord,
} from './TeamRosterAuthorizationLedger';

export interface RosterAuthorizationTransactionServiceOptions {
  now?: () => number;
  reservationLeaseMs?: number;
  reconcileUnknownLaunch?: (
    record: Readonly<RosterAuthorizationTransactionRecord>,
    command: Readonly<DurableLaunchCommandRecord>
  ) => Promise<DurableUnknownLaunchEvidence>;
  proveNoInvocationResources?: (
    record: Readonly<RosterAuthorizationTransactionRecord>,
    command: Readonly<DurableLaunchCommandRecord>
  ) => Promise<boolean>;
  unknownReconcileIntervalMs?: number;
}
