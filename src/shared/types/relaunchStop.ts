/**
 * Authoritative result of the desktop-only stop operation used by relaunch.
 * Only `not-dispatched` proves that releasing a roster reservation is safe.
 */
export type TeamRelaunchStopOutcome =
  | { status: 'stopped' }
  | {
      status: 'not-dispatched';
      reason: 'validation-rejected';
      diagnostic: string;
    }
  | {
      status: 'outcome-unknown';
      reason: 'stop-operation-failed' | 'transport-failure' | 'malformed-response';
      diagnostic: string;
    };
