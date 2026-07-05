import { describe, expect, it } from 'vitest';

import {
  buildRetainedClaudeLogsSnapshot,
  extractCliLogsFromRun,
  type RetainedLogsRunLike,
} from '../TeamProvisioningRetainedLogs';

function run(overrides: Partial<RetainedLogsRunLike> = {}): RetainedLogsRunLike {
  return {
    claudeLogLines: [],
    stdoutBuffer: undefined,
    stderrBuffer: undefined,
    claudeLogsUpdatedAt: undefined,
    progress: {},
    ...overrides,
  };
}

describe('TeamProvisioningRetainedLogs', () => {
  describe('extractCliLogsFromRun', () => {
    it('prefers the captured line buffer', () => {
      expect(extractCliLogsFromRun(run({ claudeLogLines: ['a', 'b'] }))).toBe('a\nb');
    });

    it('falls back to the raw stdout/stderr tail when no lines captured', () => {
      const out = extractCliLogsFromRun(run({ stdoutBuffer: 'hello', stderrBuffer: 'err' }));
      expect(out).toContain('hello');
      expect(out).toContain('err');
    });

    it('returns undefined when the line buffer joins to empty', () => {
      expect(extractCliLogsFromRun(run({ claudeLogLines: ['  ', ''] }))).toBeUndefined();
    });

    it('returns undefined when there is nothing at all', () => {
      expect(extractCliLogsFromRun(run())).toBeUndefined();
    });
  });

  describe('buildRetainedClaudeLogsSnapshot', () => {
    it('snapshots the captured line buffer with its updatedAt', () => {
      expect(
        buildRetainedClaudeLogsSnapshot(
          run({ claudeLogLines: ['l1', 'l2'], claudeLogsUpdatedAt: '2026-01-01T00:00:00.000Z' })
        )
      ).toEqual({ lines: ['l1', 'l2'], updatedAt: '2026-01-01T00:00:00.000Z' });
    });

    it('reconstructs from the raw tail when there is no line buffer', () => {
      const snap = buildRetainedClaudeLogsSnapshot(
        run({ stdoutBuffer: 'x\r\ny', progress: { updatedAt: '2026-02-02T00:00:00.000Z' } })
      );
      expect(snap?.lines).toEqual(['x', 'y']);
      expect(snap?.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    });

    it('returns null when there is nothing to retain', () => {
      expect(buildRetainedClaudeLogsSnapshot(run())).toBeNull();
    });
  });
});
