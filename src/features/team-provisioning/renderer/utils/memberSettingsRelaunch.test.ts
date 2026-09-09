import { describe, expect, it } from 'vitest';

import { fingerprintResolvedMember, memberToEditableSettings } from './memberSettingsPresentation';
import { applyMemberSettingsRelaunch, assertMemberSettingsRelaunchRoster, assertMemberSettingsRelaunchTarget } from './memberSettingsRelaunch';

import type { MemberSettingsRelaunchDraft } from './memberSettingsRelaunch';
import type { ResolvedTeamMember } from '@shared/types';

const member: ResolvedTeamMember = {
  name: 'alice', agentId: 'alice-1', agentType: 'general-purpose', joinedAt: 1,
  status: 'idle', currentTaskId: null, taskCount: 0, messageCount: 0, lastActiveAt: null,
  providerId: 'opencode', model: 'observed-model',
  configuredRuntimeSettings: { providerId: 'opencode', model: 'glm-5.3' },
};
const sibling = { ...member, name: 'bob', agentId: 'bob-1', configuredRuntimeSettings: {} };
const draft: MemberSettingsRelaunchDraft = {
  teamName: 'test-team', memberName: 'alice', targetKind: 'member',
  expectedFingerprint: fingerprintResolvedMember(member),
  settings: { ...memberToEditableSettings(member), model: 'glm-5.3-flash' },
};

describe('member settings relaunch handoff', () => {
  it('changes only the intended configured model in a disposable draft', () => {
    const before = structuredClone([member, sibling]);
    const result = applyMemberSettingsRelaunch([member, sibling], draft);
    expect(result[0].model).toBe('glm-5.3-flash');
    expect(result[1].model).toBeUndefined();
    expect(result[1].providerId).toBeUndefined();
    expect([member, sibling]).toEqual(before);
    expect(applyMemberSettingsRelaunch([member, sibling])[0].model).toBe('glm-5.3');
  });

  it('retains explicit siblings and clears overrides without materializing observed values', () => {
    const result = applyMemberSettingsRelaunch([member, { ...sibling, configuredRuntimeSettings: { model: 'sibling-model' } }], {
      ...draft, settings: { ...draft.settings, model: null, providerId: null },
    });
    expect(result[0].model).toBeUndefined();
    expect(result[0].providerId).toBeUndefined();
    expect(result[1].model).toBe('sibling-model');
  });

  it.each([
    { members: [] },
    { members: [{ ...member, agentId: 'replacement' }] },
    { members: [{ ...member, removedAt: 2 }] },
    { members: [{ ...member, configuredRuntimeSettings: { model: 'external-edit' } }] },
  ])('rejects missing, replaced, removed or externally edited targets', ({ members }) => {
    expect(() => assertMemberSettingsRelaunchTarget('test-team', members, draft)).toThrow();
  });

  it('refuses stale siblings and roster membership changes', () => {
    const baseline = [member, sibling];
    expect(() => assertMemberSettingsRelaunchRoster('test-team', baseline, baseline, draft)).not.toThrow();
    for (const current of [[member], [member, { ...sibling, model: 'runtime-only-change' }], [member, { ...sibling, role: 'external-edit' }]]) {
      if (current.length === 2 && current[1].role === sibling.role) {
        expect(() => assertMemberSettingsRelaunchRoster('test-team', current, baseline, draft)).not.toThrow();
      } else {
        expect(() => assertMemberSettingsRelaunchRoster('test-team', current, baseline, draft)).toThrow('Team settings changed');
      }
    }
  });

  it('rejects a different team and target kind', () => {
    expect(() => assertMemberSettingsRelaunchTarget('other', [member], draft)).toThrow();
    expect(() => assertMemberSettingsRelaunchTarget('test-team', [member], { ...draft, targetKind: 'lead' })).toThrow();
  });

  it('routes lead settings separately without modifying siblings or runtime observations', () => {
    const lead = { ...member, name: 'team-lead', agentType: 'team-lead' };
    const leadDraft: MemberSettingsRelaunchDraft = {
      ...draft, memberName: lead.name, targetKind: 'lead',
      expectedFingerprint: fingerprintResolvedMember(lead),
    };
    expect(() => assertMemberSettingsRelaunchTarget('test-team', [lead, sibling], leadDraft)).not.toThrow();
    const result = applyMemberSettingsRelaunch([lead, sibling], leadDraft);
    expect(result[0].model).toBe('glm-5.3-flash');
    expect(result[1].model).toBeUndefined();
    expect(lead.model).toBe('observed-model');
  });
});
