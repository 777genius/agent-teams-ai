import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __setPathDecoderCopyDirectoryForTests,
  buildSessionPath,
  buildSubagentsPath,
  buildTodoPath,
  decodePath,
  encodePath,
  extractProjectName,
  extractSessionId,
  getAppDataPath,
  getProjectsBasePath,
  getSchedulesBasePath,
  getTodosBasePath,
  isValidEncodedPath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';

describe('pathDecoder', () => {
  const defaultHome = process.env.HOME ?? '/home/testuser';
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    __setPathDecoderCopyDirectoryForTests(null);
    setAppDataBasePath(null);
    setClaudeBasePathOverride(null);
    vi.stubEnv('HOME', defaultHome);
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  function createTempHome(): string {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'path-decoder-home-'));
    tempDirs.push(tempHome);
    vi.stubEnv('HOME', tempHome);
    return tempHome;
  }

  describe('encodePath', () => {
    it('should encode a macOS-style absolute path', () => {
      expect(encodePath('/Users/username/projectname')).toBe('-Users-username-projectname');
    });

    it('should encode a Windows-style absolute path', () => {
      expect(encodePath('C:\\Users\\username\\projectname')).toBe('C--Users-username-projectname');
    });

    it('should handle empty string', () => {
      expect(encodePath('')).toBe('');
    });

    it('should round-trip with decodePath for POSIX paths', () => {
      const original = '/Users/username/projectname';
      expect(decodePath(encodePath(original))).toBe(original);
    });

    it('should round-trip with decodePath for Windows paths', () => {
      const original = 'C:/Users/username/projectname';
      expect(decodePath(encodePath(original))).toBe(original);
    });

    it('should encode a Linux-style path', () => {
      expect(encodePath('/home/user/projects/myapp')).toBe('-home-user-projects-myapp');
    });
  });

  describe('decodePath', () => {
    it('should decode a simple encoded path', () => {
      expect(decodePath('-Users-username-projectname')).toBe('/Users/username/projectname');
    });

    it('should handle empty string', () => {
      expect(decodePath('')).toBe('');
    });

    it('should ensure leading slash for absolute paths', () => {
      expect(decodePath('Users-username-projectname')).toBe('/Users/username/projectname');
    });

    it('should decode path with multiple segments', () => {
      expect(decodePath('-home-user-projects-myapp-src')).toBe('/home/user/projects/myapp/src');
    });

    it('should handle single segment path', () => {
      expect(decodePath('-project')).toBe('/project');
    });

    it('should handle path with underscores', () => {
      expect(decodePath('-Users-username-my_projectname')).toBe('/Users/username/my_projectname');
    });

    it('should handle path with dots', () => {
      expect(decodePath('-Users-username-.config')).toBe('/Users/username/.config');
    });

    it('should decode Windows-style encoded path without adding leading slash', () => {
      expect(decodePath('-C:-Users-username-projectname')).toBe('C:/Users/username/projectname');
    });

    it('should decode legacy Windows-style encoded path without leading dash', () => {
      expect(decodePath('C--Users-username-projectname')).toBe('C:/Users/username/projectname');
    });
  });

  describe('extractProjectName', () => {
    it('should extract project name from encoded path', () => {
      expect(extractProjectName('-Users-username-projectname')).toBe('projectname');
    });

    it('should handle deeply nested paths', () => {
      expect(extractProjectName('-home-user-dev-projects-appname')).toBe('appname');
    });

    it('should return encoded name if decoding fails', () => {
      expect(extractProjectName('')).toBe('');
    });

    it('should handle single segment', () => {
      expect(extractProjectName('-projectname')).toBe('projectname');
    });

    it('should handle path with underscore in project name', () => {
      expect(extractProjectName('-Users-username-my_cool_projectname')).toBe('my_cool_projectname');
    });

    it('should prefer cwdHint over lossy decode for dashed project names', () => {
      // Without cwdHint, dashes are decoded as slashes (lossy)
      expect(extractProjectName('-Users-name-claude-devtools')).toBe('devtools');
      // With cwdHint, the actual project name is preserved
      expect(extractProjectName('-Users-name-claude-devtools', '/Users/name/claude-devtools')).toBe(
        'claude-devtools'
      );
    });

    it('should fall back to decoded name when cwdHint is undefined', () => {
      expect(extractProjectName('-Users-username-projectname')).toBe('projectname');
    });
  });

  describe('isValidEncodedPath', () => {
    it('should return true for valid encoded path', () => {
      expect(isValidEncodedPath('-Users-username-projectname')).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(isValidEncodedPath('')).toBe(false);
    });

    it('should return false for path without leading dash', () => {
      expect(isValidEncodedPath('Users-username-projectname')).toBe(false);
    });

    it('should return true for path with underscores', () => {
      expect(isValidEncodedPath('-Users-username-my_projectname')).toBe(true);
    });

    it('should return true for path with dots', () => {
      expect(isValidEncodedPath('-Users-username-.config')).toBe(true);
    });

    it('should return true for path with numbers', () => {
      expect(isValidEncodedPath('-Users-username-projectname123')).toBe(true);
    });

    it('should return true for path with spaces', () => {
      expect(isValidEncodedPath('-Users-username-My Projectname')).toBe(true);
    });

    it('should return true for valid Windows-style encoded path', () => {
      expect(isValidEncodedPath('C--Users-username-projectname')).toBe(true);
    });

    it('should return true for old colon Windows-style encoded path', () => {
      expect(isValidEncodedPath('-C:-Users-username-projectname')).toBe(true);
    });

    it('should return true for legacy Windows-style encoded path', () => {
      expect(isValidEncodedPath('C--Users-username-projectname')).toBe(true);
    });

    it('should return false for misplaced colons', () => {
      expect(isValidEncodedPath('-Users-username:project')).toBe(false);
      expect(isValidEncodedPath('-C:-Users-name-project:extra')).toBe(false);
    });
  });

  describe('extractSessionId', () => {
    it('should extract session ID from JSONL filename', () => {
      expect(extractSessionId('abc123.jsonl')).toBe('abc123');
    });

    it('should handle UUID-style session IDs', () => {
      expect(extractSessionId('550e8400-e29b-41d4-a716-446655440000.jsonl')).toBe(
        '550e8400-e29b-41d4-a716-446655440000'
      );
    });

    it('should handle filename without extension', () => {
      expect(extractSessionId('session123')).toBe('session123');
    });

    it('should handle empty string', () => {
      expect(extractSessionId('')).toBe('');
    });
  });

  describe('buildSessionPath', () => {
    it('should construct correct session path', () => {
      expect(buildSessionPath('/base', 'project-id', 'session-123')).toBe(
        path.join('/base', 'project-id', 'session-123.jsonl')
      );
    });

    it('should handle paths with special characters', () => {
      expect(buildSessionPath('/home/user/.claude/projects', '-Users-name', 'abc123')).toBe(
        path.join('/home/user/.claude/projects', '-Users-name', 'abc123.jsonl')
      );
    });
  });

  describe('buildSubagentsPath', () => {
    it('should construct correct subagents path', () => {
      expect(buildSubagentsPath('/base', 'project-id', 'session-123')).toBe(
        path.join('/base', 'project-id', 'session-123', 'subagents')
      );
    });
  });

  describe('buildTodoPath', () => {
    it('should construct correct todo path', () => {
      expect(buildTodoPath('/home/user/.claude', 'session-123')).toBe(
        path.join('/home/user/.claude', 'todos', 'session-123.json')
      );
    });
  });

  describe('getProjectsBasePath', () => {
    it('should return projects base path', () => {
      expect(getProjectsBasePath()).toBe(path.join('/home/testuser', '.claude', 'projects'));
    });
  });

  describe('getTodosBasePath', () => {
    it('should return todos base path', () => {
      expect(getTodosBasePath()).toBe(path.join('/home/testuser', '.claude', 'todos'));
    });
  });

  describe('getSchedulesBasePath', () => {
    it('should use the new schedules directory when no legacy data exists', () => {
      const root = path.join(createTempHome(), '.claude');
      setClaudeBasePathOverride(root);

      expect(getSchedulesBasePath()).toBe(path.join(root, 'agent-teams-schedules'));
    });

    it('should migrate legacy schedules data when the new directory is absent', () => {
      const root = path.join(createTempHome(), '.claude');
      const legacyRoot = path.join(root, 'claude-devtools-schedules');
      const files = [
        ['schedules.json', '[{"id":"sched-1"}]'],
        ['runs/sched-1.json', '[{"id":"run-1"}]'],
        ['logs/sched-1/run-1.log', 'stdout'],
      ] as const;
      setClaudeBasePathOverride(root);

      for (const [relativePath, content] of files) {
        const legacyFile = path.join(legacyRoot, relativePath);
        fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
        fs.writeFileSync(legacyFile, content);
      }

      expect(getSchedulesBasePath()).toBe(path.join(root, 'agent-teams-schedules'));
      for (const [relativePath, content] of files) {
        expect(
          fs.readFileSync(path.join(root, 'agent-teams-schedules', relativePath), 'utf8')
        ).toBe(content);
      }
      expect(fs.existsSync(legacyRoot)).toBe(true);
    });

    it('should prefer populated new schedules data over legacy schedules data', () => {
      const root = path.join(createTempHome(), '.claude');
      const currentFile = path.join(root, 'agent-teams-schedules', 'schedules.json');
      const legacyFile = path.join(root, 'claude-devtools-schedules', 'schedules.json');
      setClaudeBasePathOverride(root);

      fs.mkdirSync(path.dirname(currentFile), { recursive: true });
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(currentFile, '[{"id":"current"}]');
      fs.writeFileSync(legacyFile, '[{"id":"legacy"}]');

      expect(getSchedulesBasePath()).toBe(path.join(root, 'agent-teams-schedules'));
      expect(fs.readFileSync(currentFile, 'utf8')).toBe('[{"id":"current"}]');
    });

    it('should fall back to legacy schedules when copying fails and new directory is empty', () => {
      const root = path.join(createTempHome(), '.claude');
      const currentRoot = path.join(root, 'agent-teams-schedules');
      const legacyRoot = path.join(root, 'claude-devtools-schedules');
      setClaudeBasePathOverride(root);

      fs.mkdirSync(currentRoot, { recursive: true });
      fs.mkdirSync(legacyRoot, { recursive: true });
      fs.writeFileSync(path.join(legacyRoot, 'schedules.json'), '[{"id":"legacy"}]');
      __setPathDecoderCopyDirectoryForTests(() => {
        throw new Error('copy failed');
      });

      expect(getSchedulesBasePath()).toBe(legacyRoot);
    });
  });

  describe('getAppDataPath', () => {
    it('should use explicit app data base override', () => {
      setAppDataBasePath('/tmp/agent-teams-data');

      expect(getAppDataPath()).toBe(path.join('/tmp/agent-teams-data', 'data'));
    });

    it('should use the new fallback app data path when no legacy data exists', () => {
      const home = createTempHome();

      expect(getAppDataPath()).toBe(path.join(home, '.agent-teams-ai', 'data'));
    });

    it('should migrate legacy fallback app data when the new path is absent', () => {
      const home = createTempHome();
      const legacyRoot = path.join(home, '.claude-agent-teams-ui');
      const files = [
        ['data/attachments/team-a/note.txt', 'legacy attachment'],
        ['data/task-attachments/team-a/task-1/file.txt', 'legacy task attachment'],
        ['backups/registry.json', '{}'],
        ['mcp-configs/agent-teams-mcp-old.json', '{}'],
        ['mcp-server/1.3.0/index.js', 'console.log("mcp")'],
        ['future-store/state.json', '{"kept":true}'],
      ] as const;

      for (const [relativePath, content] of files) {
        const legacyFile = path.join(legacyRoot, relativePath);
        fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
        fs.writeFileSync(legacyFile, content);
      }

      expect(getAppDataPath()).toBe(path.join(home, '.agent-teams-ai', 'data'));
      for (const [relativePath, content] of files) {
        expect(fs.readFileSync(path.join(home, '.agent-teams-ai', relativePath), 'utf8')).toBe(
          content
        );
      }
      expect(fs.existsSync(path.join(home, '.claude-agent-teams-ui'))).toBe(true);
    });

    it('should prefer populated new fallback app data over legacy data', () => {
      const home = createTempHome();
      const currentFile = path.join(home, '.agent-teams-ai', 'data', 'current.txt');
      const legacyFile = path.join(home, '.claude-agent-teams-ui', 'data', 'legacy.txt');
      fs.mkdirSync(path.dirname(currentFile), { recursive: true });
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(currentFile, 'current data');
      fs.writeFileSync(legacyFile, 'legacy data');

      expect(getAppDataPath()).toBe(path.join(home, '.agent-teams-ai', 'data'));
      expect(fs.existsSync(path.join(home, '.agent-teams-ai', 'data', 'legacy.txt'))).toBe(false);
    });

    it('should fall back to legacy fallback app data when copying fails and new path is empty', () => {
      const home = createTempHome();
      const currentRoot = path.join(home, '.agent-teams-ai');
      const legacyRoot = path.join(home, '.claude-agent-teams-ui');

      fs.mkdirSync(currentRoot, { recursive: true });
      fs.mkdirSync(path.join(legacyRoot, 'data'), { recursive: true });
      fs.writeFileSync(path.join(legacyRoot, 'data', 'legacy.txt'), 'legacy data');
      __setPathDecoderCopyDirectoryForTests(() => {
        throw new Error('copy failed');
      });

      expect(getAppDataPath()).toBe(path.join(legacyRoot, 'data'));
    });
  });
});
