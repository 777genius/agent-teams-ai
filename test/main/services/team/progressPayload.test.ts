import { describe, expect, it } from 'vitest';

import {
  boundLaunchDiagnostics,
  boundProgressAssistantParts,
  boundProgressLogLines,
  buildProgressAssistantOutput,
  buildProgressLiveOutput,
  buildProgressLogsTail,
  buildProgressTraceLine,
  buildProgressTraceTail,
  PROGRESS_LOG_TAIL_LINES,
  PROGRESS_OUTPUT_TAIL_PARTS,
  PROGRESS_TRACE_TAIL_LINES,
} from '../../../../src/main/services/team/progressPayload';

function totalChars(values: readonly string[]): number {
  return values.reduce((sum, value) => sum + value.length, 0);
}

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

describe('boundProgressLogLines', () => {
  it('keeps the newest lines under item and byte limits', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}-${'x'.repeat(20)}`);

    const result = boundProgressLogLines(lines, {
      maxLines: 10,
      maxTotalChars: 120,
      maxLineChars: 40,
    });

    expect(result.length).toBeLessThanOrEqual(10);
    expect(totalChars(result)).toBeLessThanOrEqual(120);
    expect(result.at(-1)).toBe(`line-19-${'x'.repeat(20)}`);
    expect(result.join('\n')).not.toContain('line-0-');
  });

  it('truncates a pathological single log line', () => {
    const result = boundProgressLogLines([`huge-${'x'.repeat(500)}`], {
      maxLines: 10,
      maxTotalChars: 120,
      maxLineChars: 80,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.length).toBeLessThanOrEqual(80);
    expect(result[0]).toContain('[truncated]');
  });
});

describe('boundProgressAssistantParts', () => {
  it('keeps the newest assistant parts under item and byte limits', () => {
    const parts = Array.from({ length: 12 }, (_, i) => `part-${i}-${'y'.repeat(25)}`);

    const result = boundProgressAssistantParts(parts, {
      maxParts: 5,
      maxTotalChars: 100,
      maxPartChars: 50,
    });

    expect(result.length).toBeLessThanOrEqual(5);
    expect(totalChars(result)).toBeLessThanOrEqual(100);
    expect(result.at(-1)).toBe(`part-11-${'y'.repeat(25)}`);
    expect(result.join('\n')).not.toContain('part-0-');
  });

  it('truncates a pathological single assistant part', () => {
    const result = boundProgressAssistantParts([`huge-${'z'.repeat(500)}`], {
      maxParts: 10,
      maxTotalChars: 120,
      maxPartChars: 80,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.length).toBeLessThanOrEqual(80);
    expect(result[0]).toContain('[truncated]');
  });
});

describe('buildProgressTraceLine', () => {
  it('redacts secrets and strips markdown fence delimiters', () => {
    const result = buildProgressTraceLine({
      timestamp: '2026-04-28T12:00:00.000Z',
      state: 'spawning',
      message: 'Starting runtime --api-key sk-test Authorization: Bearer local-bearer-token',
      detail:
        'OPENAI_API_KEY=super-secret CODEX_API_KEY="also-secret" ANTHROPIC_AUTH_TOKEN="lmstudio local token" ```',
    });

    expect(result).toContain('--api-key [redacted]');
    expect(result).toContain('OPENAI_API_KEY=[redacted]');
    expect(result).toContain('CODEX_API_KEY=[redacted]');
    expect(result).toContain('ANTHROPIC_AUTH_TOKEN=[redacted]');
    expect(result).toContain('Authorization: Bearer [redacted]');
    expect(result).not.toContain('sk-test');
    expect(result).not.toContain('super-secret');
    expect(result).not.toContain('also-secret');
    expect(result).not.toContain('lmstudio');
    expect(result).not.toContain('local token');
    expect(result).not.toContain('local-bearer-token');
    expect(result).not.toContain('```');
  });
});

describe('buildProgressTraceTail', () => {
  it('caps trace output to the last N lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `trace-${i}`);

    expect(buildProgressTraceTail(lines, 3)).toBe('trace-7\ntrace-8\ntrace-9');
  });

  it('uses the default trace tail size when not overridden', () => {
    const lines = Array.from({ length: PROGRESS_TRACE_TAIL_LINES + 10 }, (_, i) => `trace-${i}`);
    const result = buildProgressTraceTail(lines);

    expect(result).toBeDefined();
    expect(result!.split('\n')).toHaveLength(PROGRESS_TRACE_TAIL_LINES);
  });
});

describe('buildProgressLiveOutput', () => {
  it('preserves assistant-only output when no trace is available', () => {
    expect(buildProgressLiveOutput([], ['hello'], { maxAssistantParts: 10 })).toBe('hello');
  });

  it('combines bounded launch trace with runtime output', () => {
    const result = buildProgressLiveOutput(['trace-1', 'trace-2'], ['assistant'], {
      maxTraceLines: 1,
      maxAssistantParts: 10,
    });

    expect(result).toContain('**Launch trace**');
    expect(result).not.toContain('trace-1');
    expect(result).toContain('trace-2');
    expect(result).toContain('**Runtime output**');
    expect(result).toContain('assistant');
  });
});

describe('boundLaunchDiagnostics', () => {
  it('redacts secret CLI flags and caps diagnostic payload size', () => {
    const longDetail = `node runtime --token super-secret ${'x'.repeat(800)}`;
    const result = boundLaunchDiagnostics([
      {
        id: 'bob:tmux_shell_only',
        memberName: 'bob',
        severity: 'warning',
        code: 'tmux_shell_only',
        label: 'bob - shell only --api-key abc123',
        detail: longDetail,
        observedAt: '2026-04-24T12:00:00.000Z',
      },
    ]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    const first = result?.[0];
    expect(first).toBeDefined();
    if (!first) {
      throw new Error('Expected one bounded launch diagnostic');
    }
    expect(first.label).toContain('--api-key [redacted]');
    expect(first.detail).toContain('--token [redacted]');
    expect(first.detail).not.toContain('super-secret');
    expect(first.detail?.length).toBeLessThanOrEqual(500);
  });
});
