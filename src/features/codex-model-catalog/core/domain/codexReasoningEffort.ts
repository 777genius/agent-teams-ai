import type { CliProviderReasoningEffort } from '@shared/types';

export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly CliProviderReasoningEffort[];

const CODEX_REASONING_EFFORT_SET = new Set<string>(CODEX_REASONING_EFFORTS);

export function isCodexReasoningEffort(value: unknown): value is CliProviderReasoningEffort {
  return typeof value === 'string' && CODEX_REASONING_EFFORT_SET.has(value);
}

export function normalizeCodexReasoningEffort(value: unknown): CliProviderReasoningEffort | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return isCodexReasoningEffort(normalized) ? normalized : null;
}
