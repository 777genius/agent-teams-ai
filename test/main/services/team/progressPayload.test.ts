import { describe, expect, it } from 'vitest';

import {
  PROGRESS_LOG_TAIL_LINES,
  PROGRESS_OUTPUT_TAIL_PARTS,
  buildProgressAssistantOutput,
  buildProgressLogsTail,
} from '../../../../src/main/services/team/progressPayload';

describe('buildProgressLogsTail', () => {
  it('returns undefined for an empty buffer', () => {
    expect(buildProgressLogsTail([])).toBeUndefined();
  });

  it('returns undefined when all lines are whitespace', () => {
    expect(buildProgressLogsTail(['', '   ', '\t'])).toBeUndefined();
  });

  it('returns the full buffer joined when below the limit', () => {
    const lines = ['alpha', 'beta', 'gamma'];
    expect(buildProgressLogsTail(lines, 10)).toBe('alpha\nbeta\ngamma');
  });

  it('caps the payload to the last N lines once the limit is exceeded', () => {
    const lines = Array.from({ length: 1_000 }, (_, i) => `line-${i}`);
    const result = buildProgressLogsTail(lines, 50);
    expect(result).toBeDefined();
    const parts = result!.split('\n');
    expect(parts).toHaveLength(50);
    expect(parts[0]).toBe('line-950');
    expect(parts[parts.length - 1]).toBe('line-999');
  });

  it('uses the default tail size when the caller does not override it', () => {
    const lines = Array.from({ length: PROGRESS_LOG_TAIL_LINES + 250 }, (_, i) => `l${i}`);
    const result = buildProgressLogsTail(lines);
    expect(result).toBeDefined();
    expect(result!.split('\n')).toHaveLength(PROGRESS_LOG_TAIL_LINES);
  });

  it('keeps payload size bounded for pathological inputs (50k lines)', () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `line-${i}`);
    const result = buildProgressLogsTail(lines);
    expect(result).toBeDefined();
    // Regression guard: a full-buffer join of 50k synthetic lines would exceed
    // 400k chars. The tail must stay well below that.
    expect(result!.length).toBeLessThan(50_000);
  });

  it('coerces non-positive limits to at least one line', () => {
    expect(buildProgressLogsTail(['a', 'b', 'c'], 0)).toBe('c');
    expect(buildProgressLogsTail(['a', 'b', 'c'], -5)).toBe('c');
  });
});

describe('buildProgressAssistantOutput', () => {
  it('returns undefined when there are no parts', () => {
    expect(buildProgressAssistantOutput([])).toBeUndefined();
  });

  it('joins parts with a blank-line separator when below the limit', () => {
    expect(buildProgressAssistantOutput(['first', 'second'], 10)).toBe('first\n\nsecond');
  });

  it('caps to the last N parts once the limit is exceeded', () => {
    const parts = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const result = buildProgressAssistantOutput(parts, 5);
    expect(result).toBe('p195\n\np196\n\np197\n\np198\n\np199');
  });

  it('uses the default tail size when the caller does not override it', () => {
    const parts = Array.from({ length: PROGRESS_OUTPUT_TAIL_PARTS + 10 }, (_, i) => `p${i}`);
    const result = buildProgressAssistantOutput(parts);
    expect(result).toBeDefined();
    expect(result!.split('\n\n')).toHaveLength(PROGRESS_OUTPUT_TAIL_PARTS);
  });
});
