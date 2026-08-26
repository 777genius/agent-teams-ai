import type { AuthoritativeModelExecutionProof } from './launchExecutionProof';
import type { ReplaceMembersRequest, TeamMember } from './team';

export const TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION =
  'team:beginRosterAuthorizationTransaction';
export const TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME =
  'team:getRosterAuthorizationTransactionOutcome';
export const TEAM_ROLLBACK_ROSTER_AUTHORIZATION_TRANSACTION =
  'team:rollbackRosterAuthorizationTransaction';

export type RosterAuthorizationTransactionStatus =
  | 'not-started'
  | 'pending'
  | 'applied'
  | 'prepared'
  | 'launch-unknown'
  | 'committed'
  | 'rolled-back'
  | 'conflict'
  | 'unknown';

export interface BeginRosterAuthorizationTransactionRequest extends ReplaceMembersRequest {
  transactionId: string;
}

export interface RosterAuthorizationTransactionOutcome {
  transactionId: string;
  status: RosterAuthorizationTransactionStatus;
  priorSnapshotFingerprint?: string;
  appliedFingerprint?: string;
  targetFingerprint?: string;
  rosterRevision?: string;
  launchCommandId?: string;
  launchRunId?: string;
  /** Canonical main-owned roster. Metadata is stable for the lifetime of the reservation. */
  authorizedRoster?: TeamMember[];
  message?: string;
}

export type RosterAuthorizedLaunchStatus =
  | 'started'
  | 'not_started'
  | 'already_launching'
  | 'already_running';

/** Main-owned input passed to the production launch boundary after durable prepare. */
export interface RosterAuthorizedLaunchBinding {
  transactionId: string;
  teamName: string;
  rosterFingerprint: string;
  rosterRevision: string;
  launchCommandId: string;
  executionProof?: AuthoritativeModelExecutionProof;
  launchRequestFingerprint?: string;
}

/** Durable proof produced by the main-process launch boundary, never by the renderer. */
export interface RosterAuthorizedLaunchResult {
  transactionId: string;
  teamName: string;
  rosterFingerprint: string;
  rosterRevision: string;
  launchCommandId: string;
  executionProof?: AuthoritativeModelExecutionProof;
  launchRequestFingerprint?: string;
  runId: string;
  attemptId: string;
  launchStatus: RosterAuthorizedLaunchStatus;
}

export interface RosterAuthorizationTransactionApi {
  beginRosterAuthorizationTransaction(
    teamName: string,
    request: BeginRosterAuthorizationTransactionRequest
  ): Promise<RosterAuthorizationTransactionOutcome>;
  getRosterAuthorizationTransactionOutcome(
    teamName: string,
    transactionId: string
  ): Promise<RosterAuthorizationTransactionOutcome>;
  rollbackRosterAuthorizationTransaction(
    teamName: string,
    transactionId: string
  ): Promise<RosterAuthorizationTransactionOutcome>;
}
