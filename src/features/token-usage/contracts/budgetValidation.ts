import { isCanonicalTeamId, TEAM_IDENTITY_VERSION } from './teamIdentity';

import type {
  TokenUsageBudgetLimitDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetSettingsUpdateRequestDto,
} from './dto';

export class BudgetValidationError extends Error {
  readonly code = 'BUDGET_VALIDATION';
}
export class BudgetConflictError extends Error {
  readonly code = 'BUDGET_CONFLICT';
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BudgetValidationError('Invalid budget configuration');
  return value as Record<string, unknown>;
}

export function validateBudgetLimit(value: unknown): TokenUsageBudgetLimitDto {
  const source = record(value);
  const result: TokenUsageBudgetLimitDto = { thresholds: [], notificationsEnabled: true };
  for (const name of ['monthlyTokenLimit', 'monthlyApiEquivalentCostLimitUsd'] as const) {
    const limit = source[name];
    if (limit !== undefined) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
        throw new BudgetValidationError('Budget limits must be finite positive numbers');
      result[name] = limit;
    }
  }
  if (
    result.monthlyTokenLimit === undefined &&
    result.monthlyApiEquivalentCostLimitUsd === undefined
  )
    throw new BudgetValidationError('Set at least one budget limit');
  if (
    !Array.isArray(source.thresholds) ||
    source.thresholds.length > 10 ||
    source.thresholds.some(
      (n) => typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100
    ) ||
    new Set(source.thresholds).size !== source.thresholds.length
  )
    throw new BudgetValidationError(
      'Thresholds must be unique integers from 1 to 100 (maximum 10)'
    );
  result.thresholds = [...(source.thresholds as number[])].sort((a, b) => a - b);
  if (typeof source.notificationsEnabled !== 'boolean')
    throw new BudgetValidationError('Invalid budget notification policy');
  result.notificationsEnabled = source.notificationsEnabled;
  return result;
}

export function validateBudgetSettings(value: unknown): TokenUsageBudgetSettingsDto {
  const source = record(value);
  const result: TokenUsageBudgetSettingsDto = {};
  if (source.global !== undefined) result.global = validateBudgetLimit(source.global);
  for (const scope of ['teams', 'projects'] as const) {
    if (source[scope] === undefined) continue;
    const entries = record(source[scope]);
    result[scope] = Object.fromEntries(
      Object.entries(entries).map(([id, limit]) => {
        if (!id.trim() || id !== id.trim() || (scope === 'teams' && !isCanonicalTeamId(id)))
          throw new BudgetValidationError('Invalid budget identity');
        return [id, validateBudgetLimit(limit)];
      })
    );
  }
  return result;
}

export function validateBudgetUpdate(value: unknown): TokenUsageBudgetSettingsUpdateRequestDto {
  const source = record(value);
  if (source.teamIdentityVersion !== TEAM_IDENTITY_VERSION)
    throw new BudgetValidationError(
      'Reload budget settings before saving: unsupported team identity version'
    );
  if (
    source.expectedUpdatedAt !== null &&
    (typeof source.expectedUpdatedAt !== 'string' ||
      !Number.isFinite(Date.parse(source.expectedUpdatedAt)))
  )
    throw new BudgetValidationError('Expected budget revision is required');
  return {
    teamIdentityVersion: TEAM_IDENTITY_VERSION,
    settings: validateBudgetSettings(source.settings),
    expectedUpdatedAt: source.expectedUpdatedAt,
  };
}
