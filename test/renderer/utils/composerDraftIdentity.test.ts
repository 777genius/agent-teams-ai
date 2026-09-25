import {
  composerDraftAddressKey,
  resolveComposerDraftTarget,
} from '@renderer/utils/composerDraftIdentity';
import { describe, expect, it } from 'vitest';

describe('composer draft identity', () => {
  it('prioritizes a locked direct recipient and normalizes it', () => {
    expect(
      resolveComposerDraftTarget({
        lockedRecipient: ' Alice ',
        selectedTeam: 'other-team',
        crossTeamRecipient: 'bob',
        groupChatSelected: true,
        localRecipient: 'lead',
      })
    ).toEqual({ kind: 'direct', participant: 'alice' });
  });

  it('keeps group, direct lead, and cross-team targets distinct', () => {
    const base = { contextId: 'context-a', teamName: 'team-a' };
    const keys = [
      composerDraftAddressKey({ ...base, target: { kind: 'team-feed' } }),
      composerDraftAddressKey({ ...base, target: { kind: 'direct', participant: 'alice' } }),
      composerDraftAddressKey({
        ...base,
        target: { kind: 'cross-team', toTeam: 'team-b', toMember: 'alice' },
      }),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('isolates equal team names in different contexts and encodes delimiters', () => {
    const target = { kind: 'direct' as const, participant: 'alice' };
    const first = composerDraftAddressKey({ contextId: 'context:a', teamName: 'same/team', target });
    const second = composerDraftAddressKey({ contextId: 'context:b', teamName: 'same/team', target });
    expect(first).not.toBe(second);
    expect(first).toContain('context%3Aa');
    expect(first).toContain('same%2Fteam');
  });
});
