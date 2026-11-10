/** No source roots, native identities or private snapshot selectors cross this boundary. */
export const STOPPED_TEAM_IMPORT_CHANNEL = 'agentBackend:stoppedImport';
export const STOPPED_TEAM_IMPORT_ROUTE = '/api/agent-backend/stopped-import';
export interface StoppedTeamImportAction {
  teamName: string;
  action: 'prepare' | 'lookup' | 'retry';
}
export type StoppedTeamImportResult =
  | { ok: true; selection: string }
  | {
      ok: false;
      reason:
        | 'unsupported'
        | 'invalid'
        | 'source-changed'
        | 'owner-active'
        | 'command-unknown'
        | 'native-custody-unverified'
        | 'source-unreadable'
        | 'delivery-unknown'
        | 'held'
        | 'unknown';
      outcome: 'not-dispatched' | 'unknown';
    };
export interface StoppedTeamImportApi {
  stoppedImport?(request: StoppedTeamImportAction): Promise<StoppedTeamImportResult>;
}
