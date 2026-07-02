import type { TeamProvisioningProgress } from '@shared/types';

/**
 * Heuristic: does this raw CLI stdout chunk look like a Claude stream-json
 * fragment (an object/array carrying one of the stream-json shape keys)?
 */
export function looksLikeClaudeStdoutJsonFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  return (
    /"type"\s*:/.test(trimmed) ||
    /"message"\s*:/.test(trimmed) ||
    /"content"\s*:/.test(trimmed) ||
    /"subtype"\s*:/.test(trimmed) ||
    /"session_id"\s*:/.test(trimmed)
  );
}

export function isTerminalFailureProvisioningState(
  state: TeamProvisioningProgress['state']
): boolean {
  return state === 'failed' || state === 'cancelled' || state === 'disconnected';
}

/**
 * Guards against progress regressions that would move a run backwards out of a
 * settled state: a `ready` run may only stay ready or disconnect, and a
 * terminal-failure run may not flip to a different state.
 */
export function shouldIgnoreProvisioningProgressRegression(
  currentState: TeamProvisioningProgress['state'],
  nextState: TeamProvisioningProgress['state']
): boolean {
  if (currentState === 'ready') {
    return nextState !== 'ready' && nextState !== 'disconnected';
  }
  if (isTerminalFailureProvisioningState(currentState)) {
    return nextState !== currentState;
  }
  return false;
}
