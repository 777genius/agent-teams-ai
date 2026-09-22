import { describe, expect, it } from 'vitest';

import { collectActiveMemberProviderIds } from '@renderer/components/team/dialogs/provisioningMemberScope';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';

function member(overrides: Partial<MemberDraft> = {}): MemberDraft {
  return {
    id: overrides.id ?? 'member-1',
    name: overrides.name ?? 'alice',
    roleSelection: overrides.roleSelection ?? 'developer',
    customRole: overrides.customRole ?? '',
    ...overrides,
  };
}

describe('collectActiveMemberProviderIds', () => {
  it('collects only active member provider ids', () => {
    expect(
      collectActiveMemberProviderIds([
        member({ id: '1', providerId: 'codex' }),
        member({ id: '2', providerId: 'opencode' }),
        member({ id: '3', providerId: 'codex', removedAt: Date.now() }),
        member({ id: '4' }),
      ])
    ).toEqual(['codex', 'opencode']);
  });

  it('ignores removed members even when they still carry provider overrides', () => {
    expect(
      collectActiveMemberProviderIds([
        member({ id: '1', providerId: 'codex', removedAt: Date.now() }),
        member({ id: '2', providerId: 'gemini', removedAt: '2026-04-22T00:00:00.000Z' }),
      ])
    ).toEqual([]);
  });
});
