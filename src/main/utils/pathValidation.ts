/**
 * Path Validation Utilities.
 *
 * Provides security sandboxing for file path access to prevent
 * unauthorized access to sensitive system files.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getClaudeBasePath } from './pathDecoder';

/**
 * Sensitive file patterns that should never be accessible.
 * These are checked against the normalized absolute path.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  // SSH keys and config
  /[/\\]\.ssh[/\\]/i,
  // AWS credentials
  /[/\\]\.aws[/\\]/i,
  // GCP credentials
  /[/\\]\.config[/\\]gcloud[/\\]/i,
  // Azure credentials
  /[/\\]\.azure[/\\]/i,
  // Environment files (anywhere in path)
  /[/\\]\.env($|\.)/i,
  // Git credentials
  /[/\\]\.git-credentials$/i,
  /[/\\]\.gitconfig$/i,
  // NPM tokens
  /[/\\]\.npmrc$/i,
  // Docker credentials
  /[/\\]\.docker[/\\]config\.json$/i,
  // Kubernetes config
  /[/\\]\.kube[/\\]config$/i,
  // Password files
  /[/\\]\.password/i,
  /[/\\]\.secret/i,
  // Private keys
  /[/\\]id_rsa$/i,
  /[/\\]id_ed25519$/i,
  /[/\\]id_ecdsa$/i,
  /[/\\][^/\\]*\.pem$/i,
  /[/\\][^/\\]*\.key$/i,
  // System files
  /^\/etc\/passwd$/,
  /^\/etc\/shadow$/,
  // Credentials in filename
  /credentials\.json$/i,
  /secrets\.json$/i,
  /tokens\.json$/i,
];

/**
 * Result of path validation.
 */
export interface PathValidationResult {
  valid: boolean;
  error?: string;
  normalizedPath?: string;
}

function normalizeForCompare(input: string, isWindows: boolean): string {
  const normalized = path.normalize(input);
  return isWindows ? normalized.toLowerCase() : normalized;
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);
}

function resolveRealPathIfExists(inputPath: string): string | null {
  try {
    return fs.realpathSync.native(inputPath);
  } catch {
    return null;
  }
}

/**
 * Checks if a path matches any sensitive file patterns.
 *
 * @param normalizedPath - The normalized absolute path to check
 * @returns true if path matches a sensitive pattern
 */
function matchesSensitivePattern(normalizedPath: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

/**
 * Checks if a path is within allowed directories.
 *
 * Allowed directories:
 * - The project path itself
 * - The ~/.claude directory (for session data)
 *
 * @param normalizedPath - The normalized absolute path to check
 * @param projectPath - The project root path (can be null for global access)
 * @returns true if path is within allowed directories
 */
export function isPathWithinAllowedDirectories(
  normalizedPath: string,
  projectPath: string | null
): boolean {
  const isWindows = process.platform === 'win32';
  const normalizedTarget = normalizeForCompare(normalizedPath, isWindows);
  const claudeDir = getClaudeBasePath();
  const normalizedClaudeDir = normalizeForCompare(claudeDir, isWindows);

  // Always allow access to ~/.claude for session data
  if (isPathWithinRoot(normalizedTarget, normalizedClaudeDir)) {
    return true;
  }

  // If project path provided, allow access within project
  if (projectPath) {
    const normalizedProjectPath = normalizeForCompare(projectPath, isWindows);
    if (isPathWithinRoot(normalizedTarget, normalizedProjectPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Validates a file path for safe reading.
 *
 * Security checks performed:
 * 1. Path must be absolute
 * 2. Path traversal prevention (no ..)
 * 3. Must be within allowed directories (project or ~/.claude)
 * 4. Must not match sensitive file patterns
 *
 * @param filePath - The file path to validate
 * @param projectPath - The project root path (can be null for global access)
 * @returns Validation result with normalized path if valid
 */
export function validateFilePath(
  filePath: string,
  projectPath: string | null
): PathValidationResult {
  // Must be a non-empty string
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'Invalid file path' };
  }

  // Expand ~ to home directory
  const expandedPath = filePath.startsWith('~')
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;

  // Must be absolute path
  const normalizedInput = path.normalize(expandedPath);
  if (!path.isAbsolute(normalizedInput)) {
    return { valid: false, error: 'Path must be absolute' };
  }

  // Normalize and resolve the path to remove traversal segments safely
  const normalizedPath = path.resolve(normalizedInput);

  // Check against sensitive patterns
  if (matchesSensitivePattern(normalizedPath)) {
    return { valid: false, error: 'Access to sensitive files is not allowed' };
  }

  // Check if within allowed directories
  if (!isPathWithinAllowedDirectories(normalizedPath, projectPath)) {
    return {
      valid: false,
      error: 'Path is outside allowed directories (project or Claude root)',
    };
  }

  // If target exists, validate real path containment to prevent symlink escapes.
  const realTargetPath = resolveRealPathIfExists(normalizedPath);
  if (realTargetPath) {
    const isWindows = process.platform === 'win32';
    const normalizedRealTarget = normalizeForCompare(realTargetPath, isWindows);
    if (matchesSensitivePattern(normalizedRealTarget)) {
      return { valid: false, error: 'Access to sensitive files is not allowed' };
    }

    const realProjectPath = projectPath
      ? (resolveRealPathIfExists(projectPath) ?? path.resolve(path.normalize(projectPath)))
      : null;

    if (!isPathWithinAllowedDirectories(normalizedRealTarget, realProjectPath)) {
      return {
        valid: false,
        error: 'Path is outside allowed directories (project or Claude root)',
      };
    }
  }

  return { valid: true, normalizedPath };
}

/**
 * Validates a path for shell:openPath operation.
 * More permissive than file reading - allows opening project directories
 * and Claude data directories.
 *
 * @param targetPath - The path to open
 * @param projectPath - The project root path (can be null)
 * @returns Validation result
 */
export function validateOpenPath(
  targetPath: string,
  projectPath: string | null
): PathValidationResult {
  if (!targetPath || typeof targetPath !== 'string') {
    return { valid: false, error: 'Invalid path' };
  }

  // Expand ~ to home directory
  const expandedPath = targetPath.startsWith('~')
    ? path.join(os.homedir(), targetPath.slice(1))
    : targetPath;

  const normalizedPath = path.resolve(path.normalize(expandedPath));

  // Must be absolute after expansion
  if (!path.isAbsolute(normalizedPath)) {
    return { valid: false, error: 'Path must be absolute' };
  }

  // Check against sensitive patterns (still block sensitive files)
  if (matchesSensitivePattern(normalizedPath)) {
    return { valid: false, error: 'Cannot open sensitive files' };
  }

  // For shell:openPath, we're more permissive but still require
  // the path to be within project or claude directories
  if (!isPathWithinAllowedDirectories(normalizedPath, projectPath)) {
    return {
      valid: false,
      error: 'Path is outside allowed directories',
    };
  }

  // If target exists, validate real path containment to prevent symlink escapes.
  const realTargetPath = resolveRealPathIfExists(normalizedPath);
  if (realTargetPath) {
    const isWindows = process.platform === 'win32';
    const normalizedRealTarget = normalizeForCompare(realTargetPath, isWindows);
    if (matchesSensitivePattern(normalizedRealTarget)) {
      return { valid: false, error: 'Cannot open sensitive files' };
    }

    const realProjectPath = projectPath
      ? (resolveRealPathIfExists(projectPath) ?? path.resolve(path.normalize(projectPath)))
      : null;

    if (!isPathWithinAllowedDirectories(normalizedRealTarget, realProjectPath)) {
      return {
        valid: false,
        error: 'Path is outside allowed directories',
      };
    }
  }

  return { valid: true, normalizedPath };
}
