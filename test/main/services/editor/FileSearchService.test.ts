/**
 * Tests for FileSearchService — literal string search across project files.
 */

import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('isbinaryfile', () => ({
  isBinaryFile: vi.fn(),
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as fs from 'fs/promises';
import { isBinaryFile } from 'isbinaryfile';

import { FileSearchService } from '@main/services/editor/FileSearchService';

const PROJECT_ROOT = '/test/project';

describe('FileSearchService', () => {
  let service: FileSearchService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new FileSearchService();
  });

  function mockFileSystem(files: Record<string, string>) {
    const entries = Object.keys(files).map((filePath) => {
      const name = path.basename(filePath);
      return { name, isFile: () => true, isDirectory: () => false };
    });

    vi.mocked(fs.readdir).mockResolvedValue(entries as never);
    vi.mocked(isBinaryFile).mockResolvedValue(false);

    vi.mocked(fs.stat).mockImplementation(async (filePath: unknown) => {
      const p = String(filePath);
      const content = files[p];
      if (content === undefined) throw new Error('ENOENT');
      return { size: content.length } as never;
    });

    vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
      const p = String(filePath);
      const content = files[p];
      if (content === undefined) throw new Error('ENOENT');
      return content as never;
    });
  }

  it('finds matches in files', async () => {
    const files = {
      [`${PROJECT_ROOT}/hello.ts`]: 'const foo = "hello";\nconst bar = "world";\n',
      [`${PROJECT_ROOT}/world.ts`]: 'export const baz = "hello world";\n',
    };
    mockFileSystem(files);

    const result = await service.searchInFiles(PROJECT_ROOT, { query: 'hello' });

    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const match = result.results[0].matches[0];
    expect(match.line).toBe(1);
    expect(match.lineContent).toContain('hello');
  });

  it('returns empty results for empty query', async () => {
    const result = await service.searchInFiles(PROJECT_ROOT, { query: '' });
    expect(result.results).toEqual([]);
    expect(result.totalMatches).toBe(0);
  });

  it('supports case-sensitive search', async () => {
    const files = {
      [`${PROJECT_ROOT}/test.ts`]: 'Hello World\nhello world\n',
    };
    mockFileSystem(files);

    const caseInsensitive = await service.searchInFiles(PROJECT_ROOT, { query: 'Hello' });
    expect(caseInsensitive.totalMatches).toBe(2); // both lines match

    const caseSensitive = await service.searchInFiles(PROJECT_ROOT, {
      query: 'Hello',
      caseSensitive: true,
    });
    expect(caseSensitive.totalMatches).toBe(1); // only first line
  });

  it('respects maxMatches limit', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `match line ${i}`).join('\n');
    const files = {
      [`${PROJECT_ROOT}/many.ts`]: lines,
    };
    mockFileSystem(files);

    const result = await service.searchInFiles(PROJECT_ROOT, {
      query: 'match',
      maxMatches: 5,
    });

    expect(result.totalMatches).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  it('skips binary files', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'binary.bin', isFile: () => true, isDirectory: () => false },
    ] as never);

    vi.mocked(fs.stat).mockResolvedValue({ size: 100 } as never);
    vi.mocked(isBinaryFile).mockResolvedValue(true);

    const result = await service.searchInFiles(PROJECT_ROOT, { query: 'test' });
    expect(result.results).toEqual([]);
  });

  it('skips files larger than 1MB', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'large.ts', isFile: () => true, isDirectory: () => false },
    ] as never);

    vi.mocked(fs.stat).mockResolvedValue({ size: 2 * 1024 * 1024 } as never);

    const result = await service.searchInFiles(PROJECT_ROOT, { query: 'test' });
    expect(result.results).toEqual([]);
  });

  it('respects AbortController cancellation', async () => {
    const files = {
      [`${PROJECT_ROOT}/file.ts`]: 'hello world\n',
    };
    mockFileSystem(files);

    const controller = new AbortController();
    controller.abort(); // Already aborted

    const result = await service.searchInFiles(PROJECT_ROOT, { query: 'hello' }, controller.signal);
    // Should return empty or partial results since aborted
    expect(result.totalMatches).toBe(0);
  });

  it('finds multiple matches in same line', async () => {
    const files = {
      [`${PROJECT_ROOT}/multi.ts`]: 'foo foo foo\n',
    };
    mockFileSystem(files);

    const result = await service.searchInFiles(PROJECT_ROOT, { query: 'foo' });
    expect(result.totalMatches).toBe(3);
    expect(result.results[0].matches).toHaveLength(3);
    expect(result.results[0].matches[0].column).toBe(0);
    expect(result.results[0].matches[1].column).toBe(4);
    expect(result.results[0].matches[2].column).toBe(8);
  });
});
