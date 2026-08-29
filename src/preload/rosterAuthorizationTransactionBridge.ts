import {
  TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION,
  TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME,
  TEAM_ROLLBACK_ROSTER_AUTHORIZATION_TRANSACTION,
} from '@shared/types/rosterAuthorizationTransaction';

import type {
  BeginRosterAuthorizationTransactionRequest,
  RosterAuthorizationTransactionOutcome,
} from '@shared/types/rosterAuthorizationTransaction';

type Invoke = <T>(channel: string, ...args: unknown[]) => Promise<T>;

export function createRosterAuthorizationTransactionBridge(invoke: Invoke) {
  return {
    beginRosterAuthorizationTransaction: (
      teamName: string,
      request: BeginRosterAuthorizationTransactionRequest
    ) =>
      invoke<RosterAuthorizationTransactionOutcome>(
        TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION,
        teamName,
        request
      ),
    getRosterAuthorizationTransactionOutcome: (teamName: string, transactionId: string) =>
      invoke<RosterAuthorizationTransactionOutcome>(
        TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME,
        teamName,
        transactionId
      ),
    rollbackRosterAuthorizationTransaction: (teamName: string, transactionId: string) =>
      invoke<RosterAuthorizationTransactionOutcome>(
        TEAM_ROLLBACK_ROSTER_AUTHORIZATION_TRANSACTION,
        teamName,
        transactionId
      ),
  };
}
