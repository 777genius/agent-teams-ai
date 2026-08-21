import { isLeadMember, isReservedLeadRole } from '@shared/utils/leadDetection';
import { describe, expect, it } from 'vitest';

describe('isLeadMember', () => {
  it('supports the exact legacy team lead role without matching role substrings', () => {
    expect(isLeadMember({ name: ' Lead ', role: 'Lead' })).toBe(true);
    expect(isLeadMember({ name: 'legacy', role: '  Team   Lead ' })).toBe(true);
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
