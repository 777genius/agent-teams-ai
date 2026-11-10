import { describe, expect, it } from 'vitest';

import { buildCopiedTeamMembers } from './teamCopyData';

describe('buildCopiedTeamMembers', () => {
  it('copies reusable member config from the primary source and falls back to snapshots', () => {
    const members = buildCopiedTeamMembers(
      [
        {
          name: 'team-lead',
          role: 'Team Lead',
          model: 'claude-opus-4.5',
        },
        {
          name: 'alice',
          role: 'reviewer',
          workflow: 'Review finished tasks',
          isolation: 'worktree',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.1-codex',
          effort: 'high',
          fastMode: 'on',
          mcpPolicy: { mode: 'appOnly' },
        },
        {
          name: 'removed',
          role: 'developer',
          removedAt: Date.now(),
        },
        {
          name: 'bob',
        },
      ],
      [
        {
          name: 'alice',
          role: 'developer',
          workflow: 'Snapshot workflow should not override config',
          providerId: 'anthropic',
          model: 'claude-haiku-4.5',
          effort: 'low',
          selectedFastMode: 'off',
        },
        {
          name: 'bob',
          agentType: 'researcher',
          workflow: 'Research before implementation',
          providerId: 'anthropic',
          model: 'claude-sonnet-4.5',
          effort: 'medium',
          selectedFastMode: 'inherit',
        },
        {
          name: 'carol',
          role: 'developer',
          workflow: 'Implement scoped tasks',
          providerId: 'gemini',
          providerBackendId: 'api',
          model: 'gemini-3-pro',
        },
      ]
    );

    expect(members).toEqual([
      {
        name: 'alice',
        role: 'reviewer',
        workflow: 'Review finished tasks',
        isolation: 'worktree',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.1-codex',
        effort: 'high',
        fastMode: 'on',
        mcpPolicy: { mode: 'appOnly' },
      },
      {
        name: 'bob',
        role: 'researcher',
        workflow: 'Research before implementation',
        isolation: undefined,
        providerId: 'anthropic',
        providerBackendId: undefined,
        model: 'claude-sonnet-4.5',
        effort: 'medium',
        fastMode: 'inherit',
        mcpPolicy: undefined,
      },
      {
        name: 'carol',
        role: 'developer',
        workflow: 'Implement scoped tasks',
        isolation: undefined,
        providerId: 'gemini',
        providerBackendId: 'api',
        model: 'gemini-3-pro',
        effort: undefined,
        fastMode: undefined,
        mcpPolicy: undefined,
      },
    ]);
  });

  it('dedupes by member name and ignores generic agent type as a role fallback', () => {
    const members = buildCopiedTeamMembers(
      [
        {
          name: 'Alice',
          workflow: 'Primary workflow',
        },
        {
          name: 'alice',
          role: 'duplicate',
          workflow: 'Duplicate should be ignored',
        },
      ],
      [
        {
          name: 'alice',
          agentType: 'general-purpose',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.1-codex',
          effort: 'xhigh',
          selectedFastMode: 'on',
        },
      ]
    );

    expect(members).toEqual([
      {
        name: 'Alice',
        role: undefined,
        workflow: 'Primary workflow',
        isolation: undefined,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.1-codex',
        effort: 'xhigh',
        fastMode: 'on',
        mcpPolicy: undefined,
      },
    ]);
  });

  it('filters lead and removed fallback-only members', () => {
    const members = buildCopiedTeamMembers(undefined, [
      {
        name: 'team-lead',
        role: 'Team Lead',
        model: 'claude-opus-4.5',
      },
      {
        name: 'removed',
        role: 'Developer',
        removedAt: Date.now(),
      },
      {
        name: 'active',
        agentType: 'analyst',
      },
    ]);

    expect(members).toEqual([
      {
        name: 'active',
        role: 'analyst',
        workflow: undefined,
        isolation: undefined,
        providerId: undefined,
        providerBackendId: undefined,
        model: undefined,
        effort: undefined,
        fastMode: undefined,
        mcpPolicy: undefined,
      },
    ]);
  });
});
