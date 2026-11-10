import {
  isConversationLeadAlias,
  isLeadMember,
  isLeadNameAlias,
  isLeadThoughtSourceMessage,
  isReservedLeadRole,
  LEAD_THOUGHT_SPEAKER_NAME,
  resolveRuntimeLeadName,
} from '@shared/utils/leadDetection';
import { describe, expect, it } from 'vitest';

describe('isLeadMember', () => {
  it('uses runtime identity instead of ambiguous role labels', () => {
    expect(isLeadMember({ name: ' Lead ', role: 'Lead' })).toBe(false);
    expect(isLeadMember({ name: 'legacy', role: '  Team   Lead ' })).toBe(false);
    expect(isLeadMember({ name: 'lead', agentType: 'general-purpose', role: 'Lead' })).toBe(false);
    expect(isLeadMember({ name: 'lead', role: 'Developer' })).toBe(false);
    expect(isLeadMember({ name: 'worker', agentType: 'developer', role: 'Team Lead' })).toBe(false);
    expect(isLeadMember({ name: 'worker', role: 'Lead Developer' })).toBe(false);
    expect(isLeadMember({ name: 'worker', role: 'tech team lead' })).toBe(false);
  });

  it('recognizes only exact normalized runtime-reserved lead roles', () => {
    for (const role of ['lead', 'team lead', 'team-lead', 'orchestrator']) {
      expect(isReservedLeadRole(` ${role.toUpperCase()} `)).toBe(true);
    }
    expect(isReservedLeadRole('Lead Developer')).toBe(false);
    expect(isReservedLeadRole('orchestrator helper')).toBe(false);
  });
});

describe('isLeadNameAlias', () => {
  it('recognizes lead identity aliases including team-leader', () => {
    expect(isLeadNameAlias('lead')).toBe(true);
    expect(isLeadNameAlias('team-lead')).toBe(true);
    expect(isLeadNameAlias('team_lead')).toBe(true);
    expect(isLeadNameAlias('teamlead')).toBe(true);
    expect(isLeadNameAlias('team-leader')).toBe(true);
    expect(isLeadNameAlias('orchestrator')).toBe(true);
    expect(isLeadNameAlias('alice')).toBe(false);
  });
});

describe('isConversationLeadAlias', () => {
  it('matches chat lead aliases but not the CLI orchestrator identity', () => {
    expect(isConversationLeadAlias('lead')).toBe(true);
    expect(isConversationLeadAlias('team-lead')).toBe(true);
    expect(isConversationLeadAlias('team_lead')).toBe(true);
    expect(isConversationLeadAlias('team-leader')).toBe(true);
    expect(isConversationLeadAlias('orchestrator')).toBe(false);
    expect(isConversationLeadAlias('oscar')).toBe(false);
  });
});

describe('resolveRuntimeLeadName', () => {
  it('uses canonical lead identity and ignores reserved teammate roles', () => {
    expect(
      resolveRuntimeLeadName([
        { name: 'max', role: 'Team Lead' },
        { name: 'ora', role: 'Developer' },
      ])
    ).toBe('team-lead');
    expect(
      resolveRuntimeLeadName([
        { name: ' Lead ', role: 'Lead' },
        { name: 'max', role: 'Team Lead' },
      ])
    ).toBe('team-lead');
    expect(
      resolveRuntimeLeadName([
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'max', role: 'Team Lead' },
      ])
    ).toBe('team-lead');
    expect(
      resolveRuntimeLeadName([
        { name: 'alice', agentType: 'team-lead' },
        { name: 'max', role: 'Team Lead' },
      ])
    ).toBe('alice');
    expect(resolveRuntimeLeadName([{ name: 'worker-1', role: 'worker' }])).toBe('team-lead');
    expect(resolveRuntimeLeadName([{ name: '', role: 'lead' }])).toBe('team-lead');
    expect(resolveRuntimeLeadName(null)).toBe('team-lead');
    expect(resolveRuntimeLeadName(undefined)).toBe('team-lead');
  });
});

describe('isLeadThoughtSourceMessage', () => {
  it('matches unaddressed lead process/session rows regardless of from', () => {
    expect(isLeadThoughtSourceMessage({ source: 'lead_process' })).toBe(true);
    expect(isLeadThoughtSourceMessage({ source: 'lead_session' })).toBe(true);
    expect(isLeadThoughtSourceMessage({ source: 'lead_process', to: 'ora' })).toBe(false);
    expect(isLeadThoughtSourceMessage({ source: 'inbox' })).toBe(false);
    expect(LEAD_THOUGHT_SPEAKER_NAME).toBe('team-lead');
  });
});
