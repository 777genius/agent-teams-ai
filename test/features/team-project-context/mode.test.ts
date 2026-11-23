import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NEW_TEAM_PROJECT_CONTEXT_MODE,
  LEGACY_TEAM_PROJECT_CONTEXT_MODE,
  parseNewTeamProjectContextMode,
  parsePersistedTeamProjectContextMode,
} from '../../../src/features/team-project-context/core';

describe('team project context mode', () => {
  it('preserves shared history for previously persisted teams without a mode field', () => {
    expect(LEGACY_TEAM_PROJECT_CONTEXT_MODE).toBe('shared');
    expect(parsePersistedTeamProjectContextMode(undefined, false)).toBe('shared');
  });

  it('defaults only new team creation to per-project history', () => {
    expect(DEFAULT_NEW_TEAM_PROJECT_CONTEXT_MODE).toBe('per_project');
    expect(parseNewTeamProjectContextMode(undefined)).toBe('per_project');
  });

  it('preserves explicit user selections and rejects invalid explicit values', () => {
    for (const mode of ['shared', 'per_project'] as const) {
      expect(parseNewTeamProjectContextMode(mode)).toBe(mode);
      expect(parsePersistedTeamProjectContextMode(mode, true)).toBe(mode);
    }
    for (const invalid of [null, '', false, 'project', 'global', 0]) {
      expect(() => parseNewTeamProjectContextMode(invalid)).toThrow();
      expect(() => parsePersistedTeamProjectContextMode(invalid, true)).toThrow();
    }
  });
});
