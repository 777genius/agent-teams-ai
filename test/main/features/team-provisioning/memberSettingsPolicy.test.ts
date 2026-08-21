import {
  createMemberSettingsFingerprint,
  isCanonicalLeadTarget,
  type MemberSettingsTargetSnapshot,
  normalizeEditableMemberSettings,
  selectMemberSettingsLifecycleAction,
} from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import { describe, expect, it } from 'vitest';

import type { EditableMemberSettings } from '@features/team-provisioning/contracts/memberSettings';

function settings(overrides: Partial<EditableMemberSettings> = {}): EditableMemberSettings {
  return {
    role: null,
    workflow: null,
    isolation: null,
    providerId: null,
    providerBackendId: null,
    model: null,
    effort: null,
    fastMode: null,
    mcpPolicy: null,
    ...overrides,
  };
}

function target(
  overrides: Partial<MemberSettingsTargetSnapshot> = {}
): MemberSettingsTargetSnapshot {
  return {
    name: 'Worker',
    agentType: 'general-purpose',
    agentId: 'worker@team-a',
    joinedAt: 123,
    settings: settings(),
    teamIsAlive: true,
    leadProviderId: 'anthropic',
    teamIsMixed: false,
    runtimeLane: 'primary',
    ...overrides,
  };
}

describe('member settings domain policy', () => {
  it('normalizes every optional setting while preserving explicit null clears', () => {
    expect(
      normalizeEditableMemberSettings(
        settings({
          role: '  Reviewer  ',
          workflow: '   ',
          model: ' gpt-5.6 ',
          mcpPolicy: {
            mode: 'strictAllowlist',
            scopes: { local: false, user: true },
            serverNames: [' zeta ', 'alpha', 'alpha', ''],
          },
        })
      )
    ).toEqual(
      settings({
        role: 'Reviewer',
        workflow: null,
        model: 'gpt-5.6',
        mcpPolicy: {
          mode: 'strictAllowlist',
          scopes: { user: true, local: false },
          serverNames: ['alpha', 'zeta'],
        },
      })
    );
  });

  it('matches persisted MCP canonicalization for inheritance and empty restrictions', () => {
    expect(
      normalizeEditableMemberSettings(
        settings({ mcpPolicy: { mode: 'inheritLead', scopes: {}, serverNames: [] } })
      ).mcpPolicy
    ).toBeNull();
    expect(
      normalizeEditableMemberSettings(
        settings({
          mcpPolicy: {
            mode: 'strictAllowlist',
            scopes: { user: false, project: false, local: false },
            serverNames: [],
          },
        })
      ).mcpPolicy
    ).toEqual({ mode: 'appOnly' });
    expect(
      createMemberSettingsFingerprint(
        target({ settings: settings({ mcpPolicy: { mode: 'inheritLead' } }) })
      )
    ).toBe(createMemberSettingsFingerprint(target({ settings: settings({ mcpPolicy: null }) })));
  });

  it('builds a stable target-only fingerprint from identity and canonical settings', () => {
    const first = createMemberSettingsFingerprint(
      target({
        teamIsAlive: true,
        runtimeLane: 'primary',
        settings: settings({
          role: ' Reviewer ',
          mcpPolicy: { mode: 'strictAllowlist', serverNames: ['zeta', 'alpha'] },
        }),
      })
    );
    const equivalentRuntimeSnapshot = createMemberSettingsFingerprint(
      target({
        name: ' worker ',
        teamIsAlive: false,
        runtimeLane: 'opencode_secondary',
        settings: settings({
          role: 'Reviewer',
          mcpPolicy: { mode: 'strictAllowlist', serverNames: ['alpha', 'zeta'] },
        }),
      })
    );

    expect(equivalentRuntimeSnapshot).toBe(first);
    const defaultFingerprint = createMemberSettingsFingerprint(target());
    expect(createMemberSettingsFingerprint(target({ joinedAt: '123' }))).toBe(defaultFingerprint);
    expect(createMemberSettingsFingerprint(target({ joinedAt: ' 123.0 ' }))).toBe(
      defaultFingerprint
    );
    expect(createMemberSettingsFingerprint(target({ joinedAt: 999 }))).not.toBe(defaultFingerprint);
    expect(createMemberSettingsFingerprint(target({ agentId: 'replacement@team-a' }))).not.toBe(
      defaultFingerprint
    );
    expect(
      createMemberSettingsFingerprint(target({ settings: settings({ role: 'Reviewer' }) }))
    ).not.toBe(defaultFingerprint);
  });

  it('detects only canonical lead identities and the exact normalized legacy role', () => {
    expect(isCanonicalLeadTarget(target({ agentType: 'lead' }))).toBe(true);
    expect(isCanonicalLeadTarget(target({ name: ' Team-Lead ', agentType: null }))).toBe(true);
    expect(
      isCanonicalLeadTarget(
        target({ name: ' Lead ', agentType: null, settings: settings({ role: 'Lead' }) })
      )
    ).toBe(true);
    expect(
      isCanonicalLeadTarget(
        target({ agentType: null, settings: settings({ role: '  Team   Lead ' }) })
      )
    ).toBe(true);
    expect(
      isCanonicalLeadTarget(
        target({ agentType: null, settings: settings({ role: 'tech team lead' }) })
      )
    ).toBe(false);
    expect(
      isCanonicalLeadTarget(
        target({ agentType: 'developer', settings: settings({ role: 'Team Lead' }) })
      )
    ).toBe(false);
    expect(isCanonicalLeadTarget(target({ agentType: 'team-lead-helper' }))).toBe(false);
    expect(
      isCanonicalLeadTarget(target({ agentType: null, settings: settings({ role: 'Lead Developer' }) }))
    ).toBe(false);
  });

  it('selects persistence, member, OpenCode lane, and identity-safe relaunch actions', () => {
    const offline = target({ teamIsAlive: false });
    expect(selectMemberSettingsLifecycleAction(offline, offline)).toBe('none');
    expect(selectMemberSettingsLifecycleAction(target(), target())).toBe('restart_member');
    const stableOpenCode = target({
      runtimeLane: 'opencode_secondary',
      settings: settings({ providerId: 'opencode' }),
    });
    expect(
      selectMemberSettingsLifecycleAction(stableOpenCode, stableOpenCode)
    ).toBe('restart_opencode_lane');
    const lead = target({ agentType: 'orchestrator' });
    expect(selectMemberSettingsLifecycleAction(lead, lead)).toBe('require_team_relaunch');
    const offlineLead = target({ agentType: 'orchestrator', teamIsAlive: false });
    expect(selectMemberSettingsLifecycleAction(offlineLead, offlineLead)).toBe(
      'require_team_relaunch'
    );
    for (const role of ['lead', 'team lead', 'team-lead', 'orchestrator']) {
      const proposedReservedLead = target({
        agentType: null,
        settings: settings({ role }),
      });
      expect(selectMemberSettingsLifecycleAction(target(), proposedReservedLead)).toBe(
        'require_team_relaunch'
      );
    }
    const leadDeveloper = target({
      agentType: null,
      settings: settings({ role: 'Lead Developer' }),
    });
    expect(selectMemberSettingsLifecycleAction(leadDeveloper, leadDeveloper)).toBe(
      'restart_member'
    );
  });

  it('requires relaunch for ownership migrations in both directions', () => {
    const primary = target({ settings: settings({ providerId: 'codex' }) });
    const openCode = target({
      runtimeLane: 'opencode_secondary',
      settings: settings({ providerId: 'opencode' }),
    });

    expect(selectMemberSettingsLifecycleAction(primary, openCode)).toBe(
      'require_team_relaunch'
    );
    expect(selectMemberSettingsLifecycleAction(openCode, primary)).toBe(
      'require_team_relaunch'
    );
  });

  it('requires relaunch for OpenCode-led teams and primary-owned members in mixed teams', () => {
    const openCodeLed = target({ leadProviderId: 'opencode' });
    expect(selectMemberSettingsLifecycleAction(openCodeLed, openCodeLed)).toBe(
      'require_team_relaunch'
    );

    const mixedPrimary = target({ teamIsMixed: true, settings: settings({ providerId: 'codex' }) });
    expect(selectMemberSettingsLifecycleAction(mixedPrimary, mixedPrimary)).toBe(
      'require_team_relaunch'
    );
  });
});
