import { describe, expect, it, vi } from 'vitest';

import {
  appendMissingConfigMembersFromMeta,
  applyConfigPostLaunchMaterialization,
  applyEffectiveLaunchStateToConfig,
  buildConfigLaunchCompatibilityReport,
  buildInboxLaunchCompatibilityReport,
  buildLaunchMembersFromMeta,
  collectPostLaunchSessionHistory,
  extractTeammateSpecsFromConfig,
  hasIncompleteOpenCodeLaunchCompatibilityMember,
  selectLaunchCompatibilityInboxNames,
  updateTeamConfigPostLaunch,
} from '../TeamProvisioningConfigMaterialization';
import {
  getMixedLaunchFallbackRecoveryError,
  isPureOpenCodeProvisioningRequest,
} from '../TeamProvisioningLaunchCompatibility';

import type { TeamMember } from '@shared/types';

function parseConfigMembers(raw: string): unknown {
  return (JSON.parse(raw) as { members?: unknown }).members;
}

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

  it('appends missing members.meta members into config members without duplicating entries', () => {
    const config: Record<string, unknown> = {
      members: [
        { name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' },
        { name: 'Existing', providerId: 'opencode', model: 'opencode/openai/gpt-5.4' },
      ],
    };

    const changed = appendMissingConfigMembersFromMeta(
      'runtime-team',
      config,
      [
        { name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' },
        { name: 'user' },
        { name: 'Removed', providerId: 'opencode', model: 'opencode/x/y', removedAt: 1 },
        { name: ' existing ', providerId: 'opencode', model: 'opencode/openai/gpt-5.4' },
        {
          name: 'Worker',
          providerId: 'opencode',
          model: 'opencode/zai-coding-plan/glm-4.6',
          role: 'Implementer',
          agentType: 'general-purpose',
          joinedAt: 111,
        },
        { name: 'Builder', providerId: 'anthropic', model: 'claude-sonnet-4-5' },
      ],
      { now: () => 999 }
    );

    expect(changed).toBe(true);
    expect(config.members).toEqual([
      { name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' },
      { name: 'Existing', providerId: 'opencode', model: 'opencode/openai/gpt-5.4' },
      {
        name: 'Worker',
        agentId: 'Worker@runtime-team',
        agentType: 'general-purpose',
        role: 'Implementer',
        providerId: 'opencode',
        model: 'opencode/zai-coding-plan/glm-4.6',
        joinedAt: 111,
      },
      {
        name: 'Builder',
        agentId: 'Builder@runtime-team',
        agentType: 'general-purpose',
        providerId: 'anthropic',
        model: 'claude-sonnet-4-5',
        joinedAt: 999,
      },
    ]);
  });

  it.each([
    ['the runtime-owned lead by name', { name: 'team-lead', providerId: 'anthropic' }],
    [
      'the runtime-owned lead by agent type',
      { name: 'Captain', agentType: 'orchestrator', providerId: 'anthropic' },
    ],
    ['the user pseudo-member', { name: 'user' }],
    [
      'a member already removed from the roster',
      { name: 'Scout', providerId: 'opencode', model: 'opencode/x/y', removedAt: 1 },
    ],
    ['a blank member name', { name: '   ', providerId: 'opencode' }],
  ] satisfies [string, TeamMember][])(
    'never materializes %s into the config member list',
    (_label, metaMember) => {
      const configMembers = [{ name: 'team-lead', agentType: 'team-lead' }];
      const config: Record<string, unknown> = { members: configMembers };

      expect(appendMissingConfigMembersFromMeta('runtime-team', config, [metaMember])).toBe(false);
      expect(config.members).toBe(configMembers);
    }
  );

  it('reports no config change when every active meta member already has a config identity', () => {
    const members = [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'Worker', providerId: 'opencode', model: 'opencode/openai/gpt-5.4' },
    ];
    const config: Record<string, unknown> = { members };

    expect(
      appendMissingConfigMembersFromMeta('runtime-team', config, [
        { name: 'Worker', providerId: 'opencode', model: 'opencode/openai/gpt-5.4' },
        { name: 'Gone', providerId: 'opencode', model: 'opencode/x/y', removedAt: 42 },
      ])
    ).toBe(false);
    expect(config.members).toBe(members);
  });

  it('leaves an already-synced config member list untouched on a second sync', () => {
    const metaMembers: TeamMember[] = [
      { name: 'Worker', providerId: 'opencode', model: 'opencode/openai/gpt-5.4', joinedAt: 111 },
    ];
    const config: Record<string, unknown> = {
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    };

    expect(
      appendMissingConfigMembersFromMeta('runtime-team', config, metaMembers, { now: () => 999 })
    ).toBe(true);
    const afterFirstSync = config.members;

    expect(
      appendMissingConfigMembersFromMeta('runtime-team', config, metaMembers, { now: () => 1000 })
    ).toBe(false);
    expect(config.members).toBe(afterFirstSync);
  });

  it('syncs members.meta members into config members during post-launch config update', async () => {
    let writtenRaw = '';
    const info = vi.fn();

    await updateTeamConfigPostLaunch(
      {
        teamName: 'runtime-team',
        projectPath: '/repo/app',
        detectedSessionId: 'session-1',
      },
      {
        readConfig: vi.fn().mockResolvedValue(
          JSON.stringify({
            members: [{ name: 'team-lead', agentType: 'team-lead' }],
          })
        ),
        writeConfig: vi.fn(async (raw: string) => {
          writtenRaw = raw;
        }),
        invalidateTeam: vi.fn(),
        scanForNewestSession: vi.fn(),
        readMetaMembers: vi.fn(async () => [
          {
            name: 'Worker',
            providerId: 'opencode' as const,
            model: 'opencode/zai-coding-plan/glm-4.6',
            role: 'Implementer',
            agentType: 'general-purpose',
            joinedAt: 111,
          },
        ]),
        getLanguage: () => 'system',
        info,
        warn: vi.fn(),
      }
    );

    expect(parseConfigMembers(writtenRaw)).toEqual([
      { name: 'team-lead', agentType: 'team-lead' },
      {
        name: 'Worker',
        agentId: 'Worker@runtime-team',
        agentType: 'general-purpose',
        role: 'Implementer',
        providerId: 'opencode',
        model: 'opencode/zai-coding-plan/glm-4.6',
        joinedAt: 111,
      },
    ]);
    expect(info).toHaveBeenCalledWith(
      '[runtime-team] Synced missing members.meta.json members into config.json members'
    );
  });

  it('writes the same member list on a second post-launch update over a synced config', async () => {
    const writtenRaws: string[] = [];
    const info = vi.fn();
    let storedRaw = JSON.stringify({ members: [{ name: 'team-lead', agentType: 'team-lead' }] });
    const ports = {
      readConfig: vi.fn(async () => storedRaw),
      writeConfig: vi.fn(async (raw: string) => {
        writtenRaws.push(raw);
        storedRaw = raw;
      }),
      invalidateTeam: vi.fn(),
      scanForNewestSession: vi.fn(),
      readMetaMembers: vi.fn(async () => [
        { name: 'Worker', providerId: 'opencode' as const, model: 'opencode/x/y', joinedAt: 111 },
      ]),
      getLanguage: () => 'system',
      info,
      warn: vi.fn(),
    };
    const input = {
      teamName: 'runtime-team',
      projectPath: '/repo/app',
      detectedSessionId: 'session-1',
    };

    await updateTeamConfigPostLaunch(input, ports);
    await updateTeamConfigPostLaunch(input, ports);

    const syncLogs = info.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('Synced missing members.meta.json members'));
    expect(syncLogs).toHaveLength(1);
    expect(writtenRaws).toHaveLength(2);
    expect(parseConfigMembers(writtenRaws[1])).toEqual(parseConfigMembers(writtenRaws[0]));
  });

  it('keeps the post-launch config write when the members.meta roster cannot be read', async () => {
    let writtenRaw = '';
    const warn = vi.fn();

    await updateTeamConfigPostLaunch(
      {
        teamName: 'runtime-team',
        projectPath: '/repo/app',
        detectedSessionId: 'session-1',
      },
      {
        readConfig: vi.fn().mockResolvedValue(
          JSON.stringify({
            members: [{ name: 'team-lead', agentType: 'team-lead' }],
          })
        ),
        writeConfig: vi.fn(async (raw: string) => {
          writtenRaw = raw;
        }),
        invalidateTeam: vi.fn(),
        scanForNewestSession: vi.fn(),
        readMetaMembers: vi.fn().mockRejectedValue(new Error('members.meta.json unreadable')),
        getLanguage: () => 'system',
        info: vi.fn(),
        warn,
      }
    );

    expect(parseConfigMembers(writtenRaw)).toEqual([{ name: 'team-lead', agentType: 'team-lead' }]);
    expect(warn).toHaveBeenCalledWith(
      '[runtime-team] Failed to sync members.meta.json into config members: members.meta.json unreadable'
    );
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

  it('updates post-launch config through ports and scans when session id is missing', async () => {
    let writtenRaw = '';
    const invalidateTeam = vi.fn();
    const scanForNewestSession = vi.fn().mockResolvedValue('scanned-session');
    const info = vi.fn();

    await updateTeamConfigPostLaunch(
      {
        teamName: 'runtime-team',
        projectPath: '/repo/app',
        detectedSessionId: null,
        color: ' green ',
      },
      {
        readConfig: vi.fn().mockResolvedValue(
          JSON.stringify({
            leadSessionId: 'previous-session',
            sessionHistory: ['older-session'],
            projectPathHistory: ['/repo/old'],
          })
        ),
        writeConfig: vi.fn(async (raw: string) => {
          writtenRaw = raw;
        }),
        invalidateTeam,
        scanForNewestSession,
        readMetaMembers: vi.fn(async () => []),
        getLanguage: () => 'uk',
        info,
        warn: vi.fn(),
      }
    );

    expect(scanForNewestSession).toHaveBeenCalledWith('/repo/app', [
      'older-session',
      'previous-session',
    ]);
    expect(JSON.parse(writtenRaw)).toMatchObject({
      leadSessionId: 'scanned-session',
      sessionHistory: ['older-session', 'previous-session', 'scanned-session'],
      language: 'uk',
      color: 'green',
      projectPath: '/repo/app',
      projectPathHistory: ['/repo/old', '/repo/app'],
    });
    expect(invalidateTeam).toHaveBeenCalledWith('runtime-team');
    expect(info).toHaveBeenCalledWith(
      '[runtime-team] Detected new session via project dir scan: scanned-session'
    );
  });

  it('logs and skips post-launch config writes when config is unreadable', async () => {
    const writeConfig = vi.fn();
    const invalidateTeam = vi.fn();
    const warn = vi.fn();

    await updateTeamConfigPostLaunch(
      {
        teamName: 'runtime-team',
        projectPath: '/repo/app',
        detectedSessionId: 'session-1',
      },
      {
        readConfig: vi.fn().mockResolvedValue(null),
        writeConfig,
        invalidateTeam,
        scanForNewestSession: vi.fn(),
        readMetaMembers: vi.fn(async () => []),
        getLanguage: () => 'system',
        info: vi.fn(),
        warn,
      }
    );

    expect(writeConfig).not.toHaveBeenCalled();
    expect(invalidateTeam).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[runtime-team] Failed to update config post-launch: config.json unreadable'
    );
  });

  it('keeps incomplete OpenCode config fallback members blocking', () => {
    const members = [{ name: 'Reviewer', providerId: 'opencode' as const }];

    expect(hasIncompleteOpenCodeLaunchCompatibilityMember(members)).toBe(true);
    expect(buildConfigLaunchCompatibilityReport('legacy-team', members, 'anthropic')).toEqual({
      level: 'unsafe',
      rosterSource: 'config',
      members: [],
      warnings: [],
      blockers: [`[legacy-team] ${getMixedLaunchFallbackRecoveryError()} Fallback source: config.`],
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

  it('filters launch compatibility inbox names while keeping intentional numeric names', () => {
    expect(
      selectLaunchCompatibilityInboxNames([
        ' team-lead ',
        'user',
        'worker',
        'worker-2',
        'dev-1',
        'cross_team--peer-team',
        'cross_team_send',
        'other-team.reviewer',
        'worker',
      ])
    ).toEqual(['worker', 'dev-1']);
  });

  it('builds inbox launch compatibility reports with config member overrides', () => {
    const report = buildInboxLaunchCompatibilityReport({
      teamName: 'legacy-team',
      inboxNames: ['Reviewer'],
      configMembers: [
        {
          name: 'Reviewer',
          model: 'gpt-5',
          effort: 'high',
          isolation: 'worktree',
        },
      ],
      leadProviderId: 'codex',
    });

    expect(report).toEqual({
      level: 'ready',
      rosterSource: 'inboxes',
      members: [
        {
          name: 'Reviewer',
          role: undefined,
          workflow: undefined,
          isolation: 'worktree',
          cwd: undefined,
          providerId: undefined,
          model: 'gpt-5',
          effort: 'high',
          mcpPolicy: undefined,
        },
      ],
      warnings: [
        'Launch roster was recovered from inboxes and merged with config.json provider/model/effort overrides. ' +
          'Multimodel reconnect is best-effort in this fallback path.',
      ],
      blockers: [],
    });
  });

  it('preserves config fallback when inbox names would drop OpenCode member metadata', () => {
    const members = [
      {
        name: 'Reviewer',
        providerId: 'opencode' as const,
        model: 'opencode/openai/gpt-5.4',
      },
    ];

    expect(
      buildInboxLaunchCompatibilityReport({
        teamName: 'legacy-team',
        inboxNames: ['Reviewer'],
        configMembers: members,
        leadProviderId: 'anthropic',
      })
    ).toEqual({
      level: 'repairable',
      rosterSource: 'config',
      members,
      warnings: [
        'members.meta.json is missing; launch used complete config.json member metadata instead of inbox fallback to preserve mixed provider/model layout.',
      ],
      blockers: [],
      repairAction: 'materialize-members-meta',
    });
  });

  it('recognizes legacy OpenCode teams from their member providers when root provider is absent', () => {
    expect(
      isPureOpenCodeProvisioningRequest({
        members: [{ providerId: 'opencode' }, { providerId: 'opencode' }],
      })
    ).toBe(true);

    expect(
      isPureOpenCodeProvisioningRequest({
        providerId: 'anthropic',
        members: [{ providerId: 'opencode' }],
      })
    ).toBe(false);
  });
});
