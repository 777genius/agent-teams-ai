import { isLeadMember, isLeadNameAlias, isReservedLeadRole } from '@shared/utils/leadDetection';
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
