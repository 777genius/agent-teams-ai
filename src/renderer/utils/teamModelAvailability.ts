import type { TeamProviderId } from '@shared/types';

export const TEAM_MODEL_UI_DISABLED_BADGE_LABEL = 'Disabled';
export const GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL = 'gpt-5.1-codex-mini';
export const GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL = 'gpt-5.3-codex-spark';
export const GPT_5_1_CODEX_MINI_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model has been less reliable with task and reply tool contracts.';
export const GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model has been less reliable with bootstrap, task, and reply tool contracts.';

export function getTeamModelUiDisabledReason(
  providerId: TeamProviderId | undefined,
  model: string | undefined
): string | null {
  if (providerId === 'codex' && model === GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL) {
    return GPT_5_1_CODEX_MINI_UI_DISABLED_REASON;
  }
  if (providerId === 'codex' && model === GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL) {
    return GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON;
  }
  return null;
}

export function isTeamModelUiDisabled(
  providerId: TeamProviderId | undefined,
  model: string | undefined
): boolean {
  return getTeamModelUiDisabledReason(providerId, model) !== null;
}

export function normalizeTeamModelForUi(
  providerId: TeamProviderId | undefined,
  model: string | undefined
): string {
  return isTeamModelUiDisabled(providerId, model) ? '' : (model ?? '');
}
