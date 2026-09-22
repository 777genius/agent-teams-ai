import { describe, expect, it } from 'vitest';

import {
  detectClaudeMdFromFilePath,
  extractUserMentionPaths,
  getDirectory,
  getParentDirectory,
  processSessionClaudeMd,
} from '@renderer/utils/claudeMdTracker';

describe('claudeMdTracker path helpers', () => {
  describe('getDirectory', () => {
    it('returns directory from Unix path', () => {
      expect(getDirectory('/a/b/file.ts')).toBe('/a/b');
    });

    it('returns directory from Windows path', () => {
      expect(getDirectory('C:\\a\\b\\file.ts')).toBe('C:\\a\\b');
    });

    it('returns directory from mixed-separator path', () => {
      expect(getDirectory('C:\\a/b\\file.ts')).toBe('C:\\a/b');
    });

    it('returns empty for bare filename', () => {
      expect(getDirectory('file.ts')).toBe('');
    });

    it('returns root for root-level file', () => {
      expect(getDirectory('/file.ts')).toBe('');
    });
  });

  describe('getParentDirectory', () => {
    it('returns parent from Unix path', () => {
      expect(getParentDirectory('/a/b/c')).toBe('/a/b');
    });

    it('returns parent from Windows path', () => {
      expect(getParentDirectory('C:\\a\\b\\c')).toBe('C:\\a\\b');
    });

    it('returns null at root', () => {
      expect(getParentDirectory('/a')).toBeNull();
    });

    it('returns null for single segment', () => {
      expect(getParentDirectory('a')).toBeNull();
    });

    it('returns parent from deeply nested path', () => {
      expect(getParentDirectory('/a/b/c/d/e')).toBe('/a/b/c/d');
    });
  });

  describe('detectClaudeMdFromFilePath', () => {
    it('detects CLAUDE.md files walking up Unix paths', () => {
      const result = detectClaudeMdFromFilePath('/repo/src/lib/file.ts', '/repo');
      expect(result).toContain('/repo/src/lib/CLAUDE.md');
      expect(result).toContain('/repo/src/CLAUDE.md');
      expect(result).toContain('/repo/CLAUDE.md');
      expect(result).toHaveLength(3);
    });

    it('detects CLAUDE.md files walking up Windows paths', () => {
      const result = detectClaudeMdFromFilePath('C:\\repo\\src\\file.ts', 'C:\\repo');
      expect(result).toContain('C:\\repo\\src\\CLAUDE.md');
      expect(result).toContain('C:\\repo\\CLAUDE.md');
      expect(result).toHaveLength(2);
    });

    it('detects CLAUDE.md files for Windows paths with drive-case and separator differences', () => {
      const result = detectClaudeMdFromFilePath('c:\\Repo\\src\\file.ts', 'C:/repo');
      expect(result).toContain('c:\\Repo\\src\\CLAUDE.md');
      expect(result).toContain('c:\\Repo\\CLAUDE.md');
      expect(result).toHaveLength(2);
    });

    it('uses correct separator for generated paths', () => {
      const unixResult = detectClaudeMdFromFilePath('/repo/src/file.ts', '/repo');
      for (const p of unixResult) {
        expect(p).not.toContain('\\');
      }

      const winResult = detectClaudeMdFromFilePath('C:\\repo\\src\\file.ts', 'C:\\repo');
      for (const p of winResult) {
        expect(p).toContain('\\');
        expect(p).not.toContain('/');
      }
    });

    it('returns empty array when file is at project root', () => {
      const result = detectClaudeMdFromFilePath('/repo/file.ts', '/repo');
      expect(result).toEqual(['/repo/CLAUDE.md']);
    });

    it('stops at project root boundary', () => {
      const result = detectClaudeMdFromFilePath('/repo/src/file.ts', '/repo');
      // Should not go above /repo
      const aboveRoot = result.some((p) => !p.startsWith('/repo'));
      expect(aboveRoot).toBe(false);
    });
  });
});

describe('processSessionClaudeMd Windows paths', () => {
  function aiReadGroup(id: string, turnIndex: number, filePath: string) {
    return {
      id,
      turnIndex,
      startTime: new Date(0),
      endTime: new Date(0),
      durationMs: 0,
      steps: [
        {
          type: 'tool_call',
          content: {
            toolName: 'Read',
            toolInput: { file_path: filePath },
          },
        },
      ],
      tokens: { input: 1000, output: 0, cached: 0 },
      summary: {
        toolCallCount: 1,
        outputMessageCount: 0,
        subagentCount: 0,
        totalDurationMs: 0,
        totalTokens: 1000,
        outputTokens: 0,
        cachedTokens: 0,
      },
      status: 'complete',
      processes: [],
      chunkId: id,
      metrics: {},
      responses: [],
    } as any;
  }

  it('dedupes directory CLAUDE.md paths across Windows case and separator differences', () => {
    const stats = processSessionClaudeMd(
      [
        { type: 'ai', group: aiReadGroup('ai-0', 0, 'C:\\Repo\\src\\file.ts') },
        { type: 'ai', group: aiReadGroup('ai-1', 1, 'c:/repo/src/other.ts') },
      ],
      'C:\\Repo'
    );

    const firstDirectories = stats
      .get('ai-0')!
      .newInjections.filter((injection) => injection.source === 'directory')
      .map((injection) => injection.path);
    const secondDirectories = stats
      .get('ai-1')!
      .newInjections.filter((injection) => injection.source === 'directory');

    expect(firstDirectories).toEqual(['C:\\Repo\\src\\CLAUDE.md']);
    expect(secondDirectories).toEqual([]);
  });
});

describe('extractUserMentionPaths Windows paths', () => {
  function userGroupWithPath(path: string) {
    return {
      content: {
        fileReferences: [{ path, raw: `@${path}` }],
      },
    } as any;
  }

  it('resolves Windows current-directory mentions with backslash separators', () => {
    expect(extractUserMentionPaths(userGroupWithPath('.\\src\\app.ts'), 'C:\\Repo')).toEqual([
      'C:\\Repo\\src\\app.ts',
    ]);
  });

  it('preserves Windows drive-root separators for relative mentions', () => {
    expect(extractUserMentionPaths(userGroupWithPath('src\\app.ts'), 'C:\\')).toEqual([
      'C:\\src\\app.ts',
    ]);
  });

  it('resolves relative mentions under UNC roots without escaping the share root', () => {
    expect(
      extractUserMentionPaths(userGroupWithPath('../outside/file.ts'), '//server/share')
    ).toEqual(['//server/share/outside/file.ts']);
    expect(
      extractUserMentionPaths(userGroupWithPath('..\\outside\\file.ts'), '\\\\server\\share')
    ).toEqual(['\\\\server\\share\\outside\\file.ts']);
  });

  it('leaves home-relative mentions untouched', () => {
    expect(extractUserMentionPaths(userGroupWithPath('~\\.claude\\CLAUDE.md'), 'C:\\Repo')).toEqual(
      ['~\\.claude\\CLAUDE.md']
    );
  });

  it('strips mention markers before preserving absolute mention paths', () => {
    expect(extractUserMentionPaths(userGroupWithPath('@C:\\Other\\file.ts'), 'C:\\Repo')).toEqual([
      'C:\\Other\\file.ts',
    ]);
    expect(
      extractUserMentionPaths(userGroupWithPath('@\\\\server\\share\\file.ts'), 'C:\\Repo')
    ).toEqual(['\\\\server\\share\\file.ts']);
  });
});
