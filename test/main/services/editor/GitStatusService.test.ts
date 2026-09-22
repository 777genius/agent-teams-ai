/**
 * Tests for GitStatusService — caching, error handling, status mapping.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock simple-git
const mockStatus = vi.fn();
const mockRevparse = vi.fn();
const mockEnv = vi.fn();

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => {
    const git = {
      status: mockStatus,
      revparse: mockRevparse,
      env: mockEnv,
    };
    mockEnv.mockReturnValue(git);
    return git;
  }),
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { simpleGit } from 'simple-git';

import {
  GitStatusService,
  mapStatusResult,
} from '../../../../src/main/services/editor/GitStatusService';

import type { StatusResult } from 'simple-git';

// =============================================================================
// Helpers
// =============================================================================

function createMockStatusResult(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    not_added: [],
    conflicted: [],
    created: [],
    deleted: [],
    ignored: [],
    modified: [],
    renamed: [],
    staged: [],
    files: [],
    ahead: 0,
    behind: 0,
    current: 'main',
    tracking: 'origin/main',
    detached: false,
    isClean: () => true,
    ...overrides,
  } as StatusResult;
}

// =============================================================================
// Tests
// =============================================================================

describe('GitStatusService', () => {
  let service: GitStatusService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new GitStatusService();
  });

  describe('init', () => {
    it('initializes simple-git with project root and GIT_OPTIONAL_LOCKS=0', () => {
      service.init('/Users/test/project');

      expect(vi.mocked(simpleGit)).toHaveBeenCalledWith({
        baseDir: '/Users/test/project',
        timeout: { block: 10_000 },
      });
      expect(mockEnv).toHaveBeenCalledWith('GIT_OPTIONAL_LOCKS', '0');
    });
  });

  describe('getStatus', () => {
    it('returns empty non-repo result when not initialized', async () => {
      const result = await service.getStatus();

      expect(result).toEqual({ files: [], isGitRepo: false, branch: null });
    });

    it('returns isGitRepo: false for non-git directories', async () => {
      mockRevparse.mockRejectedValue(new Error('not a git repo'));

      service.init('/Users/test/not-a-repo');
      const result = await service.getStatus();

      expect(result.isGitRepo).toBe(false);
      expect(result.files).toEqual([]);
      expect(result.branch).toBeNull();
    });

    it('returns file statuses for a git repo', async () => {
      mockRevparse.mockResolvedValue('true');
      mockStatus.mockResolvedValue(
        createMockStatusResult({
          modified: ['src/index.ts'],
          not_added: ['new-file.txt'],
          deleted: ['old.ts'],
          current: 'feature-branch',
        })
      );

      service.init('/Users/test/project');
      const result = await service.getStatus();

      expect(result.isGitRepo).toBe(true);
      expect(result.branch).toBe('feature-branch');
      expect(result.files).toContainEqual({ path: 'src/index.ts', status: 'modified' });
      expect(result.files).toContainEqual({ path: 'new-file.txt', status: 'untracked' });
      expect(result.files).toContainEqual({ path: 'old.ts', status: 'deleted' });
    });

    it('caches results within TTL (5s)', async () => {
      mockRevparse.mockResolvedValue('true');
      mockStatus.mockResolvedValue(createMockStatusResult({ modified: ['a.ts'] }));

      service.init('/Users/test/project');

      // First call → hits git
      await service.getStatus();
      expect(mockStatus).toHaveBeenCalledTimes(1);

      // Second call within TTL → cached
      await service.getStatus();
      expect(mockStatus).toHaveBeenCalledTimes(1);
    });

    it('invalidateCache forces re-fetch', async () => {
      mockRevparse.mockResolvedValue('true');
      mockStatus.mockResolvedValue(createMockStatusResult({ modified: ['a.ts'] }));

      service.init('/Users/test/project');

      await service.getStatus();
      expect(mockStatus).toHaveBeenCalledTimes(1);

      service.invalidateCache();
      await service.getStatus();
      expect(mockStatus).toHaveBeenCalledTimes(2);
    });

    it('returns empty result on git error (graceful degradation)', async () => {
      mockRevparse.mockResolvedValue('true');
      mockStatus.mockRejectedValue(new Error('git timeout'));

      service.init('/Users/test/project');
      const result = await service.getStatus();

      expect(result).toEqual({ files: [], isGitRepo: false, branch: null });
    });
  });

  describe('destroy', () => {
    it('resets all internal state', async () => {
      mockRevparse.mockResolvedValue('true');
      mockStatus.mockResolvedValue(createMockStatusResult());

      service.init('/Users/test/project');
      await service.getStatus();

      service.destroy();

      // After destroy, should return empty result (no git instance)
      const result = await service.getStatus();
      expect(result).toEqual({ files: [], isGitRepo: false, branch: null });
    });
  });
});

describe('mapStatusResult', () => {
  it('maps all status categories', () => {
    const statusResult = createMockStatusResult({
      modified: ['a.ts'],
      not_added: ['b.ts'],
      staged: ['c.ts'],
      deleted: ['d.ts'],
      conflicted: ['e.ts'],
      renamed: [{ from: 'old.ts', to: 'new.ts' }] as StatusResult['renamed'],
    });

    const files = mapStatusResult(statusResult);

    expect(files).toContainEqual({ path: 'a.ts', status: 'modified' });
    expect(files).toContainEqual({ path: 'b.ts', status: 'untracked' });
    expect(files).toContainEqual({ path: 'c.ts', status: 'staged' });
    expect(files).toContainEqual({ path: 'd.ts', status: 'deleted' });
    expect(files).toContainEqual({ path: 'e.ts', status: 'conflict' });
    expect(files).toContainEqual({
      path: 'new.ts',
      status: 'renamed',
      renamedFrom: 'old.ts',
    });
  });

  it('returns empty array for clean repo', () => {
    const statusResult = createMockStatusResult();
    const files = mapStatusResult(statusResult);
    expect(files).toEqual([]);
  });
});
