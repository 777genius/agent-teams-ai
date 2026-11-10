import {
  buildTeamMemberMcpSettingSources,
  normalizeTeamMemberMcpPolicy,
  requiresStrictTeamMemberMcpConfig,
} from '@shared/utils/teamMemberMcpPolicy';
import { describe, expect, it } from 'vitest';

describe('teamMemberMcpPolicy', () => {
  it('normalizes inheritLead to the default unset policy', () => {
    expect(normalizeTeamMemberMcpPolicy({ mode: 'inheritLead' })).toBeUndefined();
  });

  it('keeps partial scope overrides while defaulting unspecified scopes to enabled', () => {
    const policy = normalizeTeamMemberMcpPolicy({
      mode: 'inheritScopes',
      scopes: { user: false },
    });

    expect(policy).toEqual({ mode: 'inheritScopes', scopes: { user: false } });
    expect(buildTeamMemberMcpSettingSources(policy)).toBe('project,local');
    expect(requiresStrictTeamMemberMcpConfig(policy)).toBe(false);
  });

  it('turns explicit no-scope policies into appOnly', () => {
    for (const mode of ['inheritScopes', 'strictAllowlist'] as const) {
      const policy = normalizeTeamMemberMcpPolicy({
        mode,
        scopes: { user: false, project: false, local: false },
        serverNames: ['github'],
      });

      expect(policy).toEqual({ mode: 'appOnly' });
      expect(requiresStrictTeamMemberMcpConfig(policy)).toBe(true);
    }
  });

  it('deduplicates strict allowlist names case-insensitively', () => {
    expect(
      normalizeTeamMemberMcpPolicy({
        mode: 'strictAllowlist',
        serverNames: ['github', ' GitHub ', 'sentry'],
      })
    ).toEqual({
      mode: 'strictAllowlist',
      serverNames: ['github', 'sentry'],
    });
  });
});
