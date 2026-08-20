import { isLeadMember } from '@shared/utils/leadDetection';
import { describe, expect, it } from 'vitest';

describe('isLeadMember', () => {
  it('supports the exact legacy team lead role without matching role substrings', () => {
    expect(isLeadMember({ name: 'legacy', role: '  Team   Lead ' })).toBe(true);
    expect(isLeadMember({ name: 'worker', agentType: 'developer', role: 'Team Lead' })).toBe(false);
    expect(isLeadMember({ name: 'worker', role: 'Lead Developer' })).toBe(false);
    expect(isLeadMember({ name: 'worker', role: 'tech team lead' })).toBe(false);
  });
});
