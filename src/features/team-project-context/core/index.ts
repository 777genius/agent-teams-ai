import type { TeamProjectContextMode } from '../contracts';

/** Missing field on an already saved team is always the pre-feature shared mode. */
export const LEGACY_TEAM_PROJECT_CONTEXT_MODE: TeamProjectContextMode = 'shared';

/** Used only when accepting a request to create a new team. */
export const DEFAULT_NEW_TEAM_PROJECT_CONTEXT_MODE: TeamProjectContextMode = 'per_project';

/** Distinguish absence from a corrupt or unknown persisted value. */
export function parsePersistedTeamProjectContextMode(
  value: unknown,
  hasField: boolean
): TeamProjectContextMode {
  if (!hasField) return LEGACY_TEAM_PROJECT_CONTEXT_MODE;
  if (value === 'shared' || value === 'per_project') return value;
  throw new Error('Invalid persisted projectContextMode');
}

/** A new creation request with no explicit choice uses isolation. */
export function parseNewTeamProjectContextMode(value: unknown): TeamProjectContextMode {
  if (value === undefined) return DEFAULT_NEW_TEAM_PROJECT_CONTEXT_MODE;
  if (value === 'shared' || value === 'per_project') return value;
  throw new Error('projectContextMode must be shared or per_project');
}
