/**
 * Path Validation Utilities.
 *
 * Provides security sandboxing for file path access to prevent
 * unauthorized access to sensitive system files.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getClaudeBasePath, getHomeDir } from './pathDecoder';

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

export function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
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
export function matchesSensitivePattern(normalizedPath: string): boolean {
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
    ? path.join(getHomeDir(), filePath.slice(1))
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
 * Validates a path for opening when it was explicitly chosen by the user
 * via the system folder picker. Only checks sensitive patterns, not
 * allowed-directories (project / ~/.claude).
 *
 * @param targetPath - The path to open
 * @returns Validation result
 */
export function validateOpenPathUserSelected(targetPath: string): PathValidationResult {
  if (!targetPath || typeof targetPath !== 'string') {
    return { valid: false, error: 'Invalid path' };
  }

  const expandedPath = targetPath.startsWith('~')
    ? path.join(getHomeDir(), targetPath.slice(1))
    : targetPath;

  const normalizedPath = path.resolve(path.normalize(expandedPath));

  if (!path.isAbsolute(normalizedPath)) {
    return { valid: false, error: 'Path must be absolute' };
  }

  if (matchesSensitivePattern(normalizedPath)) {
    return { valid: false, error: 'Cannot open sensitive files' };
  }

  const realTargetPath = resolveRealPathIfExists(normalizedPath);
  if (realTargetPath) {
    const isWindows = process.platform === 'win32';
    const normalizedRealTarget = normalizeForCompare(realTargetPath, isWindows);
    if (matchesSensitivePattern(normalizedRealTarget)) {
      return { valid: false, error: 'Cannot open sensitive files' };
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
    ? path.join(getHomeDir(), targetPath.slice(1))
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

// =============================================================================
// Editor-specific validation utilities
// =============================================================================

const MAX_FILENAME_LENGTH = 255;

/** Characters forbidden in file/directory names. */
// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- Intentional: validating filenames against control characters
const INVALID_FILENAME_CHARS = /[\x00-\x1f/\\:*?"<>|]/;

/**
 * Validates a file or directory name for creation.
 * Prevents path traversal, control chars, and OS-invalid characters.
 */
export function validateFileName(name: string): PathValidationResult {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Name is required' };
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Name cannot be empty' };
  }

  if (trimmed.length > MAX_FILENAME_LENGTH) {
    return { valid: false, error: `Name exceeds ${MAX_FILENAME_LENGTH} characters` };
  }

  if (trimmed === '.' || trimmed === '..') {
    return { valid: false, error: 'Invalid name' };
  }

  if (INVALID_FILENAME_CHARS.test(trimmed)) {
    return { valid: false, error: 'Name contains invalid characters' };
  }

  return { valid: true };
}

/** Blocked device/pseudo-filesystem path prefixes. */
const DEVICE_PATH_PREFIXES = ['/dev/', '/proc/', '/sys/'];
const WINDOWS_DEVICE_PREFIX = '\\\\.\\';

/**
 * Returns true if the path points to a device or pseudo-filesystem
 * (/dev/, /proc/, /sys/, \\\\.\\).
 */
export function isDevicePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (DEVICE_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  return filePath.startsWith(WINDOWS_DEVICE_PREFIX);
}

/**
 * Returns true if the path contains a `.git/` segment.
 * Used to block writes to git internals.
 */
export function isGitInternalPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/.git/') || normalized.endsWith('/.git');
}
