import { describe, expect, it } from 'vitest';

import { filterFileSuggestions } from '@renderer/hooks/useFileSuggestions';

import type { QuickOpenFile } from '@shared/types/editor';

function file(name: string, relativePath: string, path?: string): QuickOpenFile {
  return {
    name,
    relativePath,
    path: path ?? `/project/${relativePath}`,
  };
}

const FILES: QuickOpenFile[] = [
  file('index.ts', 'src/index.ts'),
  file('App.tsx', 'src/App.tsx'),
  file('test.ts', 'src/test.ts'),
  file('telemetry.ts', 'src/utils/telemetry.ts'),
  file('auth.ts', 'src/services/auth.ts'),
  file('authMiddleware.ts', 'src/middleware/authMiddleware.ts'),
  file('package.json', 'package.json'),
  file('README.md', 'README.md'),
  file('config.ts', 'src/config.ts'),
  file('database.ts', 'src/services/database.ts'),
  file('router.ts', 'src/router.ts'),
  file('types.ts', 'src/types.ts'),
];

describe('filterFileSuggestions', () => {
  it('returns empty array for empty query', () => {
    expect(filterFileSuggestions(FILES, '')).toEqual([]);
  });

  it('returns empty array for empty file list', () => {
    expect(filterFileSuggestions([], 'test')).toEqual([]);
  });

  it('filters by file name', () => {
    const results = filterFileSuggestions(FILES, 'test');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('test.ts');
    expect(results[0].type).toBe('file');
    expect(results[0].filePath).toBe('/project/src/test.ts');
    expect(results[0].relativePath).toBe('src/test.ts');
  });

  it('filters by relative path', () => {
    const results = filterFileSuggestions(FILES, 'middleware');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('authMiddleware.ts');
  });

  it('is case-insensitive', () => {
    const results = filterFileSuggestions(FILES, 'APP');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('App.tsx');
  });

  it('returns multiple matches', () => {
    const results = filterFileSuggestions(FILES, 'auth');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toEqual(['auth.ts', 'authMiddleware.ts']);
  });

  it('matches on name substring', () => {
    const results = filterFileSuggestions(FILES, 'te');
    // 'te' matches: test.ts, telemetry.ts, and router.ts (rou-te-r)
    expect(results.map((r) => r.name)).toEqual(['test.ts', 'telemetry.ts', 'router.ts']);
  });

  it('limits results to 8', () => {
    const results = filterFileSuggestions(FILES, 'ts');
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it('sets id with file: prefix', () => {
    const results = filterFileSuggestions(FILES, 'config');
    expect(results[0].id).toBe('file:/project/src/config.ts');
  });

  it('sets subtitle to relativePath', () => {
    const results = filterFileSuggestions(FILES, 'config');
    expect(results[0].subtitle).toBe('src/config.ts');
  });

  it('matches partial path segments', () => {
    const results = filterFileSuggestions(FILES, 'services/');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toEqual(['auth.ts', 'database.ts']);
  });

  it('returns results in file list order', () => {
    const results = filterFileSuggestions(FILES, '.ts');
    expect(results[0].name).toBe('index.ts');
  });
});
