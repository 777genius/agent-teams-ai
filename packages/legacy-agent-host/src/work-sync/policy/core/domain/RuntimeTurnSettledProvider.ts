export type RuntimeTurnSettledProvider = 'claude' | 'codex' | 'opencode';

export function isRuntimeTurnSettledProvider(value: unknown): value is RuntimeTurnSettledProvider {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}
