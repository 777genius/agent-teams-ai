import { describe, expect, it } from 'vitest';

import {
  createMemberSettingsFingerprint,
  type MemberSettingsTargetSnapshot,
  toMemberSettingsTarget,
} from '../../core/domain/memberSettingsPolicy';

import { fingerprintResolvedMember, isCanonicalSettingsLead } from './memberSettingsPresentation';
import { memberSettingsTargetToMember } from './memberSettingsTarget';

function snapshot(
  overrides: Partial<MemberSettingsTargetSnapshot> = {}
): MemberSettingsTargetSnapshot {
  return {
    name: 'alice',
    agentType: 'general-purpose',
    agentId: null,
    joinedAt: 1_700_000_000_000,
    settings: {
      role: 'Developer',
      workflow: 'Review every change',
      isolation: 'worktree',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-test',
      effort: 'high',
      fastMode: 'on',
      mcpPolicy: {
        mode: 'strictAllowlist',
        scopes: { user: true },
        serverNames: ['beta', 'alpha'],
      },
    },
    teamIsAlive: false,
    leadProviderId: 'anthropic',
    teamIsMixed: false,
    runtimeLane: 'primary',
    ...overrides,
  };
}

/**
 * The editor sends the fingerprint of the member it shows; the main process
 * compares it with the saved target. A saved target shown through this mapper
 * must produce exactly that fingerprint, or every save is a "settings changed"
 * conflict (or, worse, a different member passes the check).
 */
describe('memberSettingsTargetToMember', () => {
  it.each([
    ['full settings', snapshot()],
    [
      'cleared settings (inheritance)',
      snapshot({
        settings: {
          role: null,
          workflow: null,
          isolation: null,
          providerId: null,
          providerBackendId: null,
          model: null,
          effort: null,
          fastMode: null,
          mcpPolicy: null,
        },
      }),
    ],
    [
      'an agent id and a numeric string joinedAt',
      snapshot({ agentId: 'alice@team', joinedAt: '42' }),
    ],
    ['no joinedAt', snapshot({ joinedAt: null })],
  ])('keeps the main-process fingerprint for %s', (_label, saved) => {
    const shown = memberSettingsTargetToMember(toMemberSettingsTarget(saved));
    expect(fingerprintResolvedMember(shown)).toBe(createMemberSettingsFingerprint(saved));
  });

  it('a different identity (re-added member) does not produce the saved fingerprint', () => {
    const saved = snapshot();
    const shown = memberSettingsTargetToMember(toMemberSettingsTarget({ ...saved, joinedAt: 1 }));
    expect(fingerprintResolvedMember(shown)).not.toBe(createMemberSettingsFingerprint(saved));
  });

  it('keeps the lead classification of the saved target', () => {
    const lead = snapshot({
      name: 'team-lead',
      agentType: 'team-lead',
      settings: snapshot().settings,
    });
    expect(
      isCanonicalSettingsLead(memberSettingsTargetToMember(toMemberSettingsTarget(lead)))
    ).toBe(true);
    expect(
      isCanonicalSettingsLead(memberSettingsTargetToMember(toMemberSettingsTarget(snapshot())))
    ).toBe(false);
  });
});
