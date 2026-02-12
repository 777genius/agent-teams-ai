import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildSessionPath,
  buildSubagentsPath,
  buildTodoPath,
  decodePath,
  encodePath,
  extractProjectName,
  extractSessionId,
  getProjectsBasePath,
  getTodosBasePath,
  isValidEncodedPath,
} from '../../../src/main/utils/pathDecoder';

describe('pathDecoder', () => {
  describe('encodePath', () => {
    it('should encode a macOS-style absolute path', () => {
      expect(encodePath('/Users/username/projectname')).toBe('-Users-username-projectname');
    });

    it('should encode a Windows-style absolute path', () => {
      expect(encodePath('C:\\Users\\username\\projectname')).toBe('-C:-Users-username-projectname');
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
      expect(
        extractProjectName('-Users-name-claude-devtools', '/Users/name/claude-devtools')
      ).toBe('claude-devtools');
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
});
