/**
 * Tests for path validation utilities.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setClaudeBasePathOverride } from '../../../src/main/utils/pathDecoder';

import {
  isPathWithinAllowedDirectories,
  validateFilePath,
  validateOpenPath,
} from '../../../src/main/utils/pathValidation';

describe('pathValidation', () => {
  const homeDir = os.homedir();
  const claudeDir = path.join(homeDir, '.claude');
  const testProjectPath = path.resolve('/home/user/my-project');

  beforeEach(() => {
    setClaudeBasePathOverride(claudeDir);
  });

  afterEach(() => {
    setClaudeBasePathOverride(null);
  });

  describe('isPathWithinAllowedDirectories', () => {
    it('should allow paths within ~/.claude', () => {
      expect(
        isPathWithinAllowedDirectories(path.join(claudeDir, 'projects', 'test.jsonl'), null)
      ).toBe(true);
    });

    it('should allow paths within project directory', () => {
      expect(
        isPathWithinAllowedDirectories(
          path.join(testProjectPath, 'src', 'index.ts'),
          testProjectPath
        )
      ).toBe(true);
    });

    it('should reject paths outside allowed directories', () => {
      expect(isPathWithinAllowedDirectories('/etc/passwd', testProjectPath)).toBe(false);
    });

    it('should reject home directory itself without project context', () => {
      expect(isPathWithinAllowedDirectories(homeDir, null)).toBe(false);
    });

    it('should allow exact ~/.claude path', () => {
      expect(isPathWithinAllowedDirectories(claudeDir, null)).toBe(true);
    });

    it('should allow exact project path', () => {
      expect(isPathWithinAllowedDirectories(testProjectPath, testProjectPath)).toBe(true);
    });
  });

  describe('validateFilePath', () => {
    describe('basic validation', () => {
      it('should reject empty path', () => {
        const result = validateFilePath('', testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Invalid file path');
      });

      it('should reject relative paths', () => {
        const result = validateFilePath('src/index.ts', testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Path must be absolute');
      });

      it('should accept valid absolute paths within project', () => {
        const result = validateFilePath(
          path.join(testProjectPath, 'src', 'index.ts'),
          testProjectPath
        );
        expect(result.valid).toBe(true);
        expect(result.normalizedPath).toBeDefined();
      });
    });

    describe('sensitive file patterns', () => {
      it('should reject ~/.ssh paths', () => {
        const result = validateFilePath(path.join(homeDir, '.ssh', 'id_rsa'), testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject ~/.aws paths', () => {
        const result = validateFilePath(path.join(homeDir, '.aws', 'credentials'), testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject .env files in project', () => {
        const result = validateFilePath(path.join(testProjectPath, '.env'), testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject .env.local files', () => {
        const result = validateFilePath(path.join(testProjectPath, '.env.local'), testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject credentials.json files', () => {
        const result = validateFilePath(
          path.join(testProjectPath, 'credentials.json'),
          testProjectPath
        );
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject .pem files', () => {
        const result = validateFilePath(path.join(testProjectPath, 'server.pem'), testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject .key files', () => {
        const result = validateFilePath(path.join(testProjectPath, 'private.key'), testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject ~/.kube/config', () => {
        const result = validateFilePath(path.join(homeDir, '.kube', 'config'), testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject ~/.docker/config.json', () => {
        const result = validateFilePath(
          path.join(homeDir, '.docker', 'config.json'),
          testProjectPath
        );
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject secrets.json files', () => {
        const result = validateFilePath(
          path.join(testProjectPath, 'config', 'secrets.json'),
          testProjectPath
        );
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });
    });

    describe('path traversal prevention', () => {
      it('should handle normalized paths with ..', () => {
        // This path resolves correctly but starts outside project
        const result = validateFilePath(
          path.join(testProjectPath, '..', 'other-project', 'file.ts'),
          testProjectPath
        );
        // Should be rejected because final path is outside project
        expect(result.valid).toBe(false);
      });

      it('should reject symlink targets that escape project directory', () => {
        if (process.platform === 'win32') {
          // Symlink creation may require elevated privileges on Windows CI.
          return;
        }

        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-validation-'));
        const projectRoot = path.join(tempRoot, 'project');
        const outsideRoot = path.join(tempRoot, 'outside');
        fs.mkdirSync(projectRoot, { recursive: true });
        fs.mkdirSync(outsideRoot, { recursive: true });

        const outsideFile = path.join(outsideRoot, 'secret.txt');
        fs.writeFileSync(outsideFile, 'secret', 'utf8');

        const linkedPath = path.join(projectRoot, 'linked-secret.txt');
        fs.symlinkSync(outsideFile, linkedPath);

        const result = validateFilePath(linkedPath, projectRoot);
        expect(result.valid).toBe(false);

        fs.rmSync(tempRoot, { recursive: true, force: true });
      });
    });

    describe('allowed paths', () => {
      it('should allow regular source files in project', () => {
        const result = validateFilePath(
          path.join(testProjectPath, 'src', 'components', 'App.tsx'),
          testProjectPath
        );
        expect(result.valid).toBe(true);
      });

      it('should allow JSON config files (non-sensitive)', () => {
        const result = validateFilePath(
          path.join(testProjectPath, 'package.json'),
          testProjectPath
        );
        expect(result.valid).toBe(true);
      });

      it('should allow JSONL files in ~/.claude', () => {
        const result = validateFilePath(
          path.join(claudeDir, 'projects', '-home-user-project', 'session.jsonl'),
          null
        );
        expect(result.valid).toBe(true);
      });
    });

    describe('tilde expansion', () => {
      it('should expand ~ to home directory for paths within ~/.claude', () => {
        const result = validateFilePath('~/.claude/projects/test.jsonl', null);
        expect(result.valid).toBe(true);
        expect(result.normalizedPath).toBe(path.join(homeDir, '.claude', 'projects', 'test.jsonl'));
      });

      it('should expand ~ to home directory for project paths', () => {
        const projectInHome = path.join(homeDir, 'my-project');
        const result = validateFilePath('~/my-project/src/index.ts', projectInHome);
        expect(result.valid).toBe(true);
        expect(result.normalizedPath).toBe(path.join(projectInHome, 'src', 'index.ts'));
      });

      it('should reject tilde paths to sensitive files', () => {
        const result = validateFilePath('~/.ssh/id_rsa', testProjectPath);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Access to sensitive files is not allowed');
      });

      it('should reject tilde paths outside allowed directories', () => {
        const result = validateFilePath('~/random-dir/file.txt', testProjectPath);
        expect(result.valid).toBe(false);
      });
    });
  });

  describe('validateOpenPath', () => {
    it('should expand tilde in paths', () => {
      const result = validateOpenPath('~/.claude', null);
      expect(result.valid).toBe(true);
      expect(result.normalizedPath).toBe(path.normalize(claudeDir));
    });

    it('should reject sensitive files', () => {
      const result = validateOpenPath(path.join(homeDir, '.ssh', 'id_rsa'), testProjectPath);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Cannot open sensitive files');
    });

    it('should reject empty path', () => {
      const result = validateOpenPath('', testProjectPath);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid path');
    });

    it('should allow project directory', () => {
      const result = validateOpenPath(testProjectPath, testProjectPath);
      expect(result.valid).toBe(true);
    });

    it('should allow ~/.claude directory', () => {
      const result = validateOpenPath(claudeDir, null);
      expect(result.valid).toBe(true);
    });

    it('should reject paths outside allowed directories', () => {
      const result = validateOpenPath('/etc', testProjectPath);
      expect(result.valid).toBe(false);
    });

    it('should reject symlink paths that escape project directory', () => {
      if (process.platform === 'win32') {
        return;
      }

      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-path-validation-'));
      const projectRoot = path.join(tempRoot, 'project');
      const outsideRoot = path.join(tempRoot, 'outside');
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(outsideRoot, { recursive: true });

      const linkedDir = path.join(projectRoot, 'linked-outside');
      fs.symlinkSync(outsideRoot, linkedDir);

      const result = validateOpenPath(linkedDir, projectRoot);
      expect(result.valid).toBe(false);

      fs.rmSync(tempRoot, { recursive: true, force: true });
    });
  });
});
