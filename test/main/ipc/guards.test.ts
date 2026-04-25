import { describe, expect, it } from 'vitest';

import {
  coercePageLimit,
  coerceSearchMaxResults,
  validateFromField,
  validateMemberName,
  validateTeammateName,
  validateProjectId,
  validateSearchQuery,
  validateSessionId,
  validateTaskId,
  validateTeamName,
} from '../../../src/main/ipc/guards';

describe('ipc guards', () => {
  it('accepts valid encoded project IDs', () => {
    const result = validateProjectId('-Users-test-project');
    expect(result.valid).toBe(true);
    expect(result.value).toBe('-Users-test-project');
  });

  it('accepts valid Windows-style encoded project IDs', () => {
    const result = validateProjectId('-C:-Users-test-project');
    expect(result.valid).toBe(true);
    expect(result.value).toBe('-C:-Users-test-project');
  });

  it('accepts legacy Windows-style encoded project IDs', () => {
    const result = validateProjectId('C--Users-test-project');
    expect(result.valid).toBe(true);
    expect(result.value).toBe('C--Users-test-project');
  });

  it('rejects invalid project IDs', () => {
    const result = validateProjectId('../escape');
    expect(result.valid).toBe(false);
  });

  it('accepts valid session IDs', () => {
    const result = validateSessionId('abc123-session_id');
    expect(result.valid).toBe(true);
  });

  it('rejects empty search queries', () => {
    const result = validateSearchQuery('   ');
    expect(result.valid).toBe(false);
  });

  it('caps search max results', () => {
    expect(coerceSearchMaxResults(9999, 50)).toBe(200);
    expect(coerceSearchMaxResults(-1, 50)).toBe(50);
  });

  it('caps pagination limits', () => {
    expect(coercePageLimit(500, 20)).toBe(200);
    expect(coercePageLimit(0, 20)).toBe(20);
  });

  it('validates team/task/member/from fields', () => {
    expect(validateTeamName('team-1').valid).toBe(true);
    expect(validateTaskId('123').valid).toBe(true);
    expect(validateMemberName('alice_1').valid).toBe(true);
    expect(validateFromField('team-lead').valid).toBe(true);
    expect(validateMemberName('team-lead').valid).toBe(true);
    expect(validateMemberName('user').valid).toBe(false);
    expect(validateTeammateName('alice_1').valid).toBe(true);
    expect(validateTeammateName('team-lead').valid).toBe(false);
    expect(validateTeammateName('user').valid).toBe(false);
  });

  it('rejects traversal and invalid chars for team-related fields', () => {
    expect(validateTeamName('../escape').valid).toBe(false);
    expect(validateTaskId('12/34').valid).toBe(false);
    expect(validateMemberName('alice bob').valid).toBe(false);
    expect(validateFromField('../../etc').valid).toBe(false);
  });

  it('rejects Windows reserved device names for filesystem-backed fields', () => {
    expect(validateTeamName('con').valid).toBe(false);
    expect(validateTaskId('NUL').valid).toBe(false);
    expect(validateMemberName('com1').valid).toBe(false);
    expect(validateMemberName('lpt9.txt').valid).toBe(false);
  });
});
