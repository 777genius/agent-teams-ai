/**
 * Tests for conflictDetection — mtime comparison, deleted files, tolerance.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

import * as fs from 'fs/promises';

import { checkFileConflict } from '../../../../src/main/services/editor/conflictDetection';

// =============================================================================
// Helpers
// =============================================================================

function mockStat(mtimeMs: number): void {
  vi.mocked(fs.stat).mockResolvedValue({ mtimeMs } as Awaited<ReturnType<typeof fs.stat>>);
}

function mockStatError(code: string): void {
  const err = new Error(`${code}: no such file`) as NodeJS.ErrnoException;
  err.code = code;
  vi.mocked(fs.stat).mockRejectedValue(err);
}

// =============================================================================
// Tests
// =============================================================================

describe('checkFileConflict', () => {
  it('returns no conflict when mtime matches exactly', async () => {
    mockStat(1000);

    const result = await checkFileConflict('/test/file.ts', 1000);

    expect(result.hasConflict).toBe(false);
    expect(result.currentMtimeMs).toBe(1000);
    expect(result.deleted).toBe(false);
  });

  it('returns no conflict within 1ms tolerance', async () => {
    mockStat(1000.5);

    const result = await checkFileConflict('/test/file.ts', 1000);

    expect(result.hasConflict).toBe(false);
  });

  it('detects conflict when mtime differs by more than 1ms', async () => {
    mockStat(2000);

    const result = await checkFileConflict('/test/file.ts', 1000);

    expect(result.hasConflict).toBe(true);
    expect(result.currentMtimeMs).toBe(2000);
    expect(result.deleted).toBe(false);
  });

  it('detects deleted file (ENOENT)', async () => {
    mockStatError('ENOENT');

    const result = await checkFileConflict('/test/file.ts', 1000);

    expect(result.hasConflict).toBe(true);
    expect(result.currentMtimeMs).toBe(0);
    expect(result.deleted).toBe(true);
  });

  it('re-throws non-ENOENT errors', async () => {
    mockStatError('EPERM');

    await expect(checkFileConflict('/test/file.ts', 1000)).rejects.toThrow('EPERM');
  });

  it('handles mtime slightly earlier than baseline (e.g. clock drift)', async () => {
    mockStat(999);

    const result = await checkFileConflict('/test/file.ts', 1000);

    // |999 - 1000| = 1, which is <= 1ms tolerance
    expect(result.hasConflict).toBe(false);
  });

  it('detects conflict for mtime 2ms earlier than baseline', async () => {
    mockStat(998);

    const result = await checkFileConflict('/test/file.ts', 1000);

    // |998 - 1000| = 2, which is > 1ms tolerance
    expect(result.hasConflict).toBe(true);
  });
});
