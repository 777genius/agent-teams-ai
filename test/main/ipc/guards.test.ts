import { describe, expect, it } from 'vitest';

import {
  coercePageLimit,
  coerceSearchMaxResults,
  validateProjectId,
  validateSearchQuery,
  validateSessionId,
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
});
