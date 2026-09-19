import { belongsToConversation } from '@features/team-direct-chats/core/domain/belongsToConversation';
import { TEAM_FEED_SCOPE } from '@features/team-direct-chats/core/domain/conversationScope';
import { describe, expect, it } from 'vitest';

import { msg } from './fixtures';

const leadNames = ['oscar'];

describe('belongsToConversation', () => {
  it('keeps user↔alice in alice and team-feed', () => {
    const outgoing = msg({ from: 'user', to: 'alice', text: 'hi' });
    const incoming = msg({ from: 'alice', to: 'user', text: 'hey' });
    expect(belongsToConversation(outgoing, TEAM_FEED_SCOPE, leadNames)).toBe(true);
    expect(belongsToConversation(incoming, TEAM_FEED_SCOPE, leadNames)).toBe(true);
    expect(belongsToConversation(outgoing, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(
      true
    );
    expect(belongsToConversation(incoming, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(
      true
    );
  });

  it('puts teammate mail to the lead in the lead chat, not the sender 1:1', () => {
    const a2a = msg({ from: 'cody', to: 'oscar', text: 'handoff' });
    const toAlias = msg({ from: 'atlas', to: 'lead', text: 'started task' });
    expect(belongsToConversation(a2a, TEAM_FEED_SCOPE, leadNames)).toBe(true);
    expect(belongsToConversation(a2a, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(false);
    expect(belongsToConversation(a2a, { kind: 'direct', participant: 'cody' }, leadNames)).toBe(false);
    expect(belongsToConversation(a2a, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(true);
    expect(belongsToConversation(toAlias, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      true
    );
    expect(belongsToConversation(toAlias, { kind: 'direct', participant: 'lead' }, leadNames)).toBe(
      true
    );
    expect(belongsToConversation(toAlias, { kind: 'direct', participant: 'atlas' }, leadNames)).toBe(
      false
    );
  });

  it('keeps system→lead out of member 1:1 and in the lead chat', () => {
    const system = msg({ from: 'system', to: 'lead', text: 'boot' });
    expect(belongsToConversation(system, TEAM_FEED_SCOPE, leadNames)).toBe(true);
    expect(belongsToConversation(system, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(
      false
    );
    expect(belongsToConversation(system, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      true
    );
  });

  it('puts lead thoughts on the lead chat only', () => {
    const thought = msg({
      from: 'oscar',
      text: 'thinking',
      source: 'lead_process',
    });
    expect(belongsToConversation(thought, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      true
    );
    expect(belongsToConversation(thought, { kind: 'direct', participant: 'lead' }, leadNames)).toBe(
      true
    );
    expect(belongsToConversation(thought, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(
      false
    );
  });

  it('does not put mis-stamped lead thoughts on the teammate named in from', () => {
    const thought = msg({
      from: 'max',
      text: 'LEAD_THOUGHT_PROOF',
      source: 'lead_process',
    });
    expect(belongsToConversation(thought, { kind: 'direct', participant: 'max' }, leadNames)).toBe(
      false
    );
    expect(belongsToConversation(thought, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      true
    );
    expect(belongsToConversation(thought, { kind: 'direct', participant: 'lead' }, ['team-lead'])).toBe(
      true
    );
    expect(belongsToConversation(thought, { kind: 'direct', participant: 'max' }, [])).toBe(false);
  });

  it('includes user→lead in the lead chat', () => {
    const outgoing = msg({ from: 'user', to: 'oscar', text: 'lead hi', source: 'user_sent' });
    const toAlias = msg({ from: 'user', to: 'lead', text: 'lead hi', source: 'user_sent' });
    expect(belongsToConversation(outgoing, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      true
    );
    expect(belongsToConversation(toAlias, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      true
    );
  });

  it('excludes cross-team sent copies from local 1:1', () => {
    const sent = msg({
      from: 'user',
      to: 'oscar',
      text: 'remote copy',
      source: 'cross_team_sent',
    });
    expect(belongsToConversation(sent, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      false
    );
  });

  it('excludes cross-team traffic from local 1:1', () => {
    const qualified = msg({ from: 'user', to: 'otherTeam/oscar', text: 'remote' });
    const sourced = msg({
      from: 'other-lead',
      to: 'user',
      text: 'hello',
      source: 'cross_team',
    });
    expect(belongsToConversation(qualified, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      false
    );
    expect(belongsToConversation(sourced, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      false
    );
    expect(belongsToConversation(sourced, TEAM_FEED_SCOPE, leadNames)).toBe(true);
  });

  it('keeps bootstrap lead→oscar in oscar and team-feed', () => {
    const toOscar = msg({ from: 'lead', to: 'oscar', text: 'start' });
    expect(belongsToConversation(toOscar, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      true
    );
    expect(belongsToConversation(toOscar, TEAM_FEED_SCOPE, leadNames)).toBe(true);
    expect(belongsToConversation(toOscar, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(
      false
    );
  });

  it('keeps member-to-member a2a out of both 1:1 rows and the lead chat', () => {
    const a2a = msg({ from: 'cody', to: 'alice', text: 'peer' });
    expect(belongsToConversation(a2a, { kind: 'direct', participant: 'cody' }, leadNames)).toBe(false);
    expect(belongsToConversation(a2a, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(
      false
    );
    expect(belongsToConversation(a2a, { kind: 'direct', participant: 'oscar' }, leadNames)).toBe(
      false
    );
  });

  it('does not put missing to on a non-lead source into 1:1', () => {
    const orphan = msg({ from: 'alice', text: 'no to', source: 'inbox' });
    expect(belongsToConversation(orphan, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(
      false
    );
  });

  it('does not match qualified names against a local member', () => {
    const remote = msg({ from: 'user', to: 'acme/alice', text: 'nope' });
    expect(belongsToConversation(remote, { kind: 'direct', participant: 'alice' }, leadNames)).toBe(
      false
    );
  });

  it('does not treat orchestrator as a conversation lead alias', () => {
    const bootstrap = msg({ from: 'orchestrator', to: 'alice', text: 'boot' });
    expect(
      belongsToConversation(bootstrap, { kind: 'direct', participant: 'alice' }, leadNames)
    ).toBe(false);
    expect(
      belongsToConversation(bootstrap, { kind: 'direct', participant: 'oscar' }, leadNames)
    ).toBe(false);
    expect(
      belongsToConversation(bootstrap, { kind: 'direct', participant: 'orchestrator' }, leadNames)
    ).toBe(false);
  });
});
