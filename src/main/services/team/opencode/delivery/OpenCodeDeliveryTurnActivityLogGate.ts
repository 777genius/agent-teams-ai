/**
 * `opencode_prompt_delivery_turn_activity` traces every retry-due observation
 * pass, so it is the line an operator reconstructs a retry decision from. It is
 * durable evidence, not a problem report: `logger.diagnostic` reaches the
 * persistent sink at every log level and never writes a console line, which is
 * what this trace wants in steady state.
 *
 * Live triage occasionally wants it in the console next to everything else,
 * though, and promoting it by editing the source is not an option on a running
 * installation. Set CLAUDE_TEAM_DELIVERY_TURN_ACTIVITY_WARN=1 to raise it to
 * `warn` for that session; the durable copy is written either way.
 */
export function isOpenCodeDeliveryTurnActivityWarnEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env.CLAUDE_TEAM_DELIVERY_TURN_ACTIVITY_WARN?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Level name for the trace, resolved per call so the gate stays runtime-togglable. */
export function selectOpenCodeDeliveryTurnActivityLogLevel(
  env: NodeJS.ProcessEnv = process.env
): 'warn' | 'diagnostic' {
  return isOpenCodeDeliveryTurnActivityWarnEnabled(env) ? 'warn' : 'diagnostic';
}
