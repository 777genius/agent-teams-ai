import { describe, expect, it } from 'vitest';

import {
  buildCrossTeamConversationKey,
  extractCrossTeamPseudoTargetTeam,
  getCrossTeamSourceTeam,
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
  looksLikeQualifiedExternalRecipientName,
  parseCrossTeamRecipient,
  parseCrossTeamTargetTeam,
  resolveSingleActiveCrossTeamReplyHint,
} from '../TeamProvisioningCrossTeamRouting';

describe('cross-team routing policy', () => {
  it('routes pseudo recipients to the target team lead outside the current team', () => {
    expect(parseCrossTeamRecipient('local-team', 'cross-team:peer-team', new Set())).toEqual({
      teamName: 'peer-team',
      memberName: 'team-lead',
    });
    expect(parseCrossTeamRecipient('peer-team', 'cross-team:peer-team', new Set())).toBeNull();
  });

  it('routes qualified external recipients and ignores local recipients', () => {
    const localRecipients = new Set(['worker-1']);

    expect(parseCrossTeamRecipient('local-team', 'peer-team.worker-2', localRecipients)).toEqual({
      teamName: 'peer-team',
      memberName: 'worker-2',
    });
    expect(parseCrossTeamRecipient('local-team', 'worker-1', localRecipients)).toBeNull();
    expect(
      parseCrossTeamRecipient('local-team', 'local-team.worker-2', localRecipients)
    ).toBeNull();
    expect(parseCrossTeamRecipient('local-team', 'BadTeam.worker-2', localRecipients)).toBeNull();
  });

  it('detects tool recipients, pseudo recipients, and qualified external names', () => {
    expect(isCrossTeamToolRecipientName(' cross_team_send ')).toBe(true);
    expect(isCrossTeamToolRecipientName('worker-1')).toBe(false);
    expect(extractCrossTeamPseudoTargetTeam('cross_team::peer-team')).toBe('peer-team');
    expect(isCrossTeamPseudoRecipientName('cross_team--peer-team')).toBe(true);
    expect(isCrossTeamPseudoRecipientName('cross_team--BadTeam')).toBe(false);
    expect(looksLikeQualifiedExternalRecipientName('peer-team.worker-1')).toBe(true);
    expect(looksLikeQualifiedExternalRecipientName('worker-1')).toBe(false);
  });

  it('deduplicates active reply hints and returns only a single unique conversation', () => {
    expect(
      resolveSingleActiveCrossTeamReplyHint([
        { toTeam: 'peer-team', conversationId: 'conv-1' },
        { toTeam: ' peer-team ', conversationId: ' conv-1 ' },
      ])
    ).toEqual({ toTeam: 'peer-team', conversationId: 'conv-1' });

    expect(
      resolveSingleActiveCrossTeamReplyHint([
        { toTeam: 'peer-team', conversationId: 'conv-1' },
        { toTeam: 'other-team', conversationId: 'conv-2' },
      ])
    ).toBeNull();
  });

  it('normalizes cross-team conversation keys and target/source teams', () => {
    expect(buildCrossTeamConversationKey(' peer-team ', ' conv-1 ')).toBe('peer-team\0conv-1');
    expect(parseCrossTeamTargetTeam('cross-team:peer-team')).toBe('peer-team');
    expect(parseCrossTeamTargetTeam('peer-team.worker-1')).toBe('peer-team');
    expect(parseCrossTeamTargetTeam('BadTeam.worker-1')).toBeNull();
    expect(getCrossTeamSourceTeam('peer-team.worker-1')).toBe('peer-team');
    expect(getCrossTeamSourceTeam('cross-team:peer-team')).toBeNull();
  });
});
