export const OPENCODE_BOOTSTRAP_CHECKIN_RETRY_SENT_PREFIX =
  'opencode_bootstrap_checkin_retry_prompt_sent';

/**
 * Deterministic marker id for tracking that a bootstrap check-in retry prompt
 * has been sent for a given run + runtime session.
 */
export function getOpenCodeBootstrapCheckinRetryMarker(
  runId: string,
  runtimeSessionId: string
): string {
  return `${OPENCODE_BOOTSTRAP_CHECKIN_RETRY_SENT_PREFIX}:${runId}:${runtimeSessionId}`;
}
