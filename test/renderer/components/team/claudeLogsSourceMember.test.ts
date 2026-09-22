import { isLeadLogSourceMember } from '@renderer/components/team/claudeLogsSourceMember';
import { describe, expect, it } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

function member(overrides: Partial<ResolvedTeamMember>): ResolvedTeamMember {
  return {
    name: 'alice',
    status: 'active',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    ...overrides,
  };
}

describe('isLeadLogSourceMember', () => {
  it('accepts canonical and cached lead aliases for compact log source UI', () => {
    expect(isLeadLogSourceMember(member({ name: 'team-lead' }))).toBe(true);
    expect(isLeadLogSourceMember(member({ name: 'Lead' }))).toBe(true);
    expect(isLeadLogSourceMember(member({ name: 'current', role: 'Team Lead' }))).toBe(true);
  });

  it('does not treat arbitrary leadership-like roles as the lead log source', () => {
    expect(isLeadLogSourceMember(member({ name: 'alice', role: 'Tech Lead' }))).toBe(false);
    expect(isLeadLogSourceMember(member({ name: 'lead-reviewer' }))).toBe(false);
  });
});
