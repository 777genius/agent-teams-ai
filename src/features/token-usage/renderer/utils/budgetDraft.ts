import { validateBudgetLimit } from '../../contracts';

import type {
  TokenUsageBudgetLimitDto,
  TokenUsageBudgetScope,
  TokenUsageBudgetSettingsDto,
} from '../../contracts';

export interface BudgetDraftLimit {
  tokens: string;
  usd: string;
  thresholds: string[];
  notificationsEnabled: boolean;
}
export type BudgetDraft = Record<string, BudgetDraftLimit | null>;
export const budgetTargetKey = (target: { scope: TokenUsageBudgetScope; id: string }): string =>
  `${target.scope}:${target.id}`;
export const newBudgetDraft = (): BudgetDraftLimit => ({
  tokens: '',
  usd: '',
  thresholds: ['50', '70', '90', '100'],
  notificationsEnabled: true,
});

function fromLimit(limit: TokenUsageBudgetLimitDto): BudgetDraftLimit {
  return {
    tokens: limit.monthlyTokenLimit?.toString() ?? '',
    usd: limit.monthlyApiEquivalentCostLimitUsd?.toString() ?? '',
    thresholds: limit.thresholds.map(String),
    notificationsEnabled: limit.notificationsEnabled,
  };
}
export function createBudgetDraft(settings: TokenUsageBudgetSettingsDto): BudgetDraft {
  const draft: BudgetDraft = {};
  if (settings.global) draft['global:global'] = fromLimit(settings.global);
  for (const [id, limit] of Object.entries(settings.teams ?? {}))
    draft[`team:${id}`] = fromLimit(limit);
  for (const [id, limit] of Object.entries(settings.projects ?? {}))
    draft[`project:${id}`] = fromLimit(limit);
  return draft;
}
export function draftErrors(draft: BudgetDraftLimit): {
  tokens?: string;
  usd?: string;
  thresholds?: string;
} {
  const errors: ReturnType<typeof draftErrors> = {};
  for (const name of ['tokens', 'usd'] as const) {
    const raw = draft[name].trim();
    if (raw && (!Number.isFinite(Number(raw)) || Number(raw) <= 0)) errors[name] = 'invalidLimit';
  }
  if (!draft.tokens.trim() && !draft.usd.trim()) errors.tokens = 'requiredLimit';
  const values = draft.thresholds.map((raw) => (raw.trim() ? Number(raw) : NaN));
  if (
    values.length > 10 ||
    values.some((value) => !Number.isInteger(value) || value < 1 || value > 100) ||
    new Set(values).size !== values.length
  )
    errors.thresholds = 'invalidThresholds';
  return errors;
}
export function settingsFromDraft(draft: BudgetDraft): TokenUsageBudgetSettingsDto {
  const result: TokenUsageBudgetSettingsDto = {};
  for (const [key, value] of Object.entries(draft)) {
    if (value === null) continue;
    if (Object.keys(draftErrors(value)).length) throw new Error('Invalid budget draft');
    const limit = validateBudgetLimit({
      monthlyTokenLimit: value.tokens.trim() ? Number(value.tokens) : undefined,
      monthlyApiEquivalentCostLimitUsd: value.usd.trim() ? Number(value.usd) : undefined,
      thresholds: value.thresholds.map(Number),
      notificationsEnabled: value.notificationsEnabled,
    });
    const separator = key.indexOf(':');
    const scope = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (scope === 'global') result.global = limit;
    else if (scope === 'team') {
      result.teams ??= Object.create(null) as Record<string, TokenUsageBudgetLimitDto>;
      result.teams[id] = limit;
    } else if (scope === 'project') {
      result.projects ??= Object.create(null) as Record<string, TokenUsageBudgetLimitDto>;
      result.projects[id] = limit;
    }
  }
  return result;
}
