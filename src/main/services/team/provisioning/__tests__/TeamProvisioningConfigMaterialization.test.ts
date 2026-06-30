import { describe, expect, it } from 'vitest';

import {
  applyConfigPostLaunchMaterialization,
  applyEffectiveLaunchStateToConfig,
  buildConfigLaunchCompatibilityReport,
  buildLaunchMembersFromMeta,
  collectPostLaunchSessionHistory,
  extractTeammateSpecsFromConfig,
  hasIncompleteOpenCodeLaunchCompatibilityMember,
} from '../TeamProvisioningConfigMaterialization';
import { getMixedLaunchFallbackRecoveryError } from '../TeamProvisioningLaunchCompatibility';

describe('team provisioning config materialization', () => {
  it('applies effective launch provider, model, and effort to lead and member config entries', () => {
    const config: Record<string, unknown> = {
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          provider: 'anthropic',
          providerId: 'anthropic',
          model: 'old-lead-model',
          effort: 'low',
        },
        {
          name: 'Builder',
          provider: 'anthropic',
          providerId: 'anthropic',
          model: 'old-member-model',
          effort: 'minimal',
        },
      ],
    };

    applyEffectiveLaunchStateToConfig('runtime-team', config, {
      providerId: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
      members: [
        {
          name: 'Builder',
          providerId: 'opencode',
          model: 'opencode/anthropic/claude-sonnet-4.5',
          effort: 'medium',
        },
      ],
    });

    expect(config.members).toEqual([
      {
        name: 'team-lead',
        agentType: 'team-lead',
        provider: 'codex',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
      },
      {
        name: 'Builder',
        provider: 'opencode',
        providerId: 'opencode',
        model: 'opencode/anthropic/claude-sonnet-4.5',
        effort: 'medium',
      },
    ]);
  });

  it('appends missing OpenCode launch members to config members', () => {
    const config: Record<string, unknown> = {
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    };

    applyEffectiveLaunchStateToConfig(
      'runtime-team',
      config,
      {
        members: [
          {
            name: 'Reviewer',
            providerId: 'opencode',
            model: 'opencode/openai/gpt-5.4',
            effort: 'low',
            role: ' Review changes ',
            workflow: ' Check diffs ',
            isolation: 'worktree',
            cwd: ' /repo/reviewer ',
            mcpPolicy: {
              mode: 'strictAllowlist',
              scopes: { user: false, project: true },
              serverNames: [' git ', 'git', ''],
            },
          },
        ],
      },
      { now: () => 12345 }
    );

    expect(config.members).toEqual([
      {
        name: 'team-lead',
        agentType: 'team-lead',
        provider: 'anthropic',
        providerId: 'anthropic',
      },
      {
        name: 'Reviewer',
        agentId: 'Reviewer@runtime-team',
        agentType: 'general-purpose',
        role: 'Review changes',
        workflow: 'Check diffs',
        isolation: 'worktree',
        providerId: 'opencode',
        model: 'opencode/openai/gpt-5.4',
        effort: 'low',
        mcpPolicy: {
          mode: 'strictAllowlist',
          scopes: { user: false, project: true },
          serverNames: ['git'],
        },
        cwd: '/repo/reviewer',
        joinedAt: 12345,
      },
    ]);
  });

  it('extracts teammate specs from config and ignores lead, user, removed, and auto-suffixed entries', () => {
    const members = extractTeammateSpecsFromConfig(
      JSON.stringify({
        members: [
          { name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' },
          { name: 'user', providerId: 'anthropic' },
          { name: 'Removed', providerId: 'codex', removedAt: '2026-06-01T00:00:00.000Z' },
          {
            name: 'Alice',
            provider: 'codex',
            model: ' gpt-5.4 ',
            effort: 'high',
            role: ' Implementer ',
            workflow: ' Build features ',
            isolation: 'worktree',
            cwd: ' /repo/alice ',
            mcpPolicy: {
              mode: 'inheritScopes',
              scopes: { project: false },
            },
          },
          {
            name: 'Alice-2',
            providerId: 'codex',
            model: 'gpt-5.4',
          },
        ],
      })
    );

    expect(members).toEqual([
      {
        name: 'Alice',
        role: 'Implementer',
        workflow: 'Build features',
        isolation: 'worktree',
        cwd: '/repo/alice',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        mcpPolicy: {
          mode: 'inheritScopes',
          scopes: { project: false },
        },
      },
    ]);
  });

  it('builds launch members from metadata without lead, user, removed, or auto-suffixed entries', () => {
    expect(
      buildLaunchMembersFromMeta([
        { name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' },
        { name: 'user', providerId: 'anthropic' },
        { name: 'Removed', providerId: 'codex', removedAt: 123 },
        {
          name: 'Builder',
          providerId: 'codex',
          model: ' gpt-5.4 ',
          effort: 'medium',
          cwd: ' /repo/builder ',
          mcpPolicy: { mode: 'appOnly' },
        },
        { name: 'Builder-2', providerId: 'codex' },
      ])
    ).toEqual([
      {
        name: 'Builder',
        role: undefined,
        workflow: undefined,
        isolation: undefined,
        cwd: '/repo/builder',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
        mcpPolicy: { mode: 'appOnly' },
      },
    ]);
  });

  it('materializes post-launch config fields with bounded histories', () => {
    const config: Record<string, unknown> = {
      leadSessionId: 'previous-session',
      sessionHistory: ['older-session', 'kept-session'],
      projectPathHistory: ['/repo/old', '/repo/app', '/repo/other'],
    };

    applyConfigPostLaunchMaterialization({
      teamName: 'runtime-team',
      config,
      projectPath: '/repo/app',
      newSessionId: 'new-session',
      sessionHistory: collectPostLaunchSessionHistory(config),
      language: 'ru',
      color: ' teal ',
      maxSessionHistory: 2,
      maxProjectPathHistory: 2,
    });

    expect(config).toMatchObject({
      leadSessionId: 'new-session',
      sessionHistory: ['previous-session', 'new-session'],
      language: 'ru',
      color: 'teal',
      projectPath: '/repo/app',
      projectPathHistory: ['/repo/other', '/repo/app'],
    });
  });

  it('keeps incomplete OpenCode config fallback members blocking', () => {
    const members = [{ name: 'Reviewer', providerId: 'opencode' as const }];

    expect(hasIncompleteOpenCodeLaunchCompatibilityMember(members)).toBe(true);
    expect(buildConfigLaunchCompatibilityReport('legacy-team', members, 'anthropic')).toEqual({
      level: 'unsafe',
      rosterSource: 'config',
      members: [],
      warnings: [],
      blockers: [
        `[legacy-team] ${getMixedLaunchFallbackRecoveryError()} Fallback source: config.`,
      ],
    });
  });

  it('keeps complete mixed OpenCode config fallback members repairable', () => {
    const members = [
      {
        name: 'Reviewer',
        providerId: 'opencode' as const,
        model: 'opencode/openai/gpt-5.4',
      },
    ];

    expect(buildConfigLaunchCompatibilityReport('legacy-team', members, 'anthropic')).toEqual({
      level: 'repairable',
      rosterSource: 'config',
      members,
      warnings: [
        'members.meta.json and inboxes are empty; launch fell back to config.json members. ' +
          'Run a fresh team bootstrap to persist stable member metadata.',
      ],
      blockers: [],
      repairAction: 'materialize-members-meta',
    });
  });
});
