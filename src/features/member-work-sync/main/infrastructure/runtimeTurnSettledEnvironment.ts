import type { RuntimeTurnSettledProvider } from '../../core/domain';

export const RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV = 'AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT';

export function buildRuntimeTurnSettledEnvironment(input: {
  provider: RuntimeTurnSettledProvider;
  spoolRoot: string;
}): Record<string, string> | null {
  if (input.provider !== 'codex' && input.provider !== 'opencode') {
    return null;
  }
  return {
    [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: input.spoolRoot,
  };
}
