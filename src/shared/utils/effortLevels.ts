import type { EffortLevel, TeamProviderId } from '@shared/types/team';

export const TEAM_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly EffortLevel[];

export const LEGACY_TEAM_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
] as const satisfies readonly EffortLevel[];

export const CODEX_TEAM_EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly EffortLevel[];

const LEGACY_TEAM_EFFORT_LEVEL_SET = new Set<EffortLevel>(LEGACY_TEAM_EFFORT_LEVELS);
const CODEX_TEAM_EFFORT_LEVEL_SET = new Set<EffortLevel>(CODEX_TEAM_EFFORT_LEVELS);

export function isTeamEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && TEAM_EFFORT_LEVELS.includes(value as EffortLevel);
}

export function formatEffortLevelList(): string {
  return TEAM_EFFORT_LEVELS.join(', ');
}

export function isTeamEffortLevelForProvider(
  value: unknown,
  providerId?: TeamProviderId | null
): value is EffortLevel {
  if (!isTeamEffortLevel(value)) {
    return false;
  }

  if (providerId === 'codex') {
    return CODEX_TEAM_EFFORT_LEVEL_SET.has(value);
  }

  return LEGACY_TEAM_EFFORT_LEVEL_SET.has(value);
}

export function formatEffortLevelListForProvider(providerId?: TeamProviderId | null): string {
  if (providerId === 'codex') {
    return CODEX_TEAM_EFFORT_LEVELS.join(', ');
  }
  return LEGACY_TEAM_EFFORT_LEVELS.join(', ');
}
