import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Utility functions for encoding/decoding Claude Code project directory names.
 *
 * Directory naming pattern:
 * - Path: /Users/username/projectname
 * - Encoded: -Users-username-projectname
 *
 * IMPORTANT: This encoding is LOSSY for paths containing dashes.
 * For accurate path resolution, use extractCwd() from jsonl.ts to read
 * the actual cwd from session files.
 */

// =============================================================================
// Core Encoding/Decoding
// =============================================================================

/**
 * Encodes an absolute path into Claude Code's directory naming format.
 * Replaces all path separators (/ and \) with dashes.
 *
 * @param absolutePath - The absolute path to encode (e.g., "/Users/username/projectname")
 * @returns The encoded directory name (e.g., "-Users-username-projectname")
 */
export function encodePath(absolutePath: string): string {
  if (!absolutePath) {
    return '';
  }

  const encoded = absolutePath.replace(/[/\\]/g, '-');
  const windowsDriveMatch = /^([a-zA-Z]):-(.*)$/.exec(encoded);
  if (windowsDriveMatch) {
    return `${windowsDriveMatch[1].toUpperCase()}--${windowsDriveMatch[2]}`;
  }

  // Ensure leading dash for absolute paths
  return encoded.startsWith('-') ? encoded : `-${encoded}`;
}

function isWindowsAbsolutePathLike(name: string): boolean {
  const slashPath = name.replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(slashPath) || slashPath.startsWith('//');
}

function normalizeWindowsPathForStorageKey(name: string): string {
  if (!isWindowsAbsolutePathLike(name)) {
    return name;
  }
  return name.replace(/\\/g, '/').toLowerCase();
}

/**
 * Matches the orchestrator's cross-platform storage key codec.
 * It lowercases Windows absolute paths, normalizes separators, and replaces
 * every non-ASCII-alphanumeric character with a dash.
 */
export function encodePathPortable(absolutePath: string): string {
  if (!absolutePath) {
    return '';
  }
  return normalizeWindowsPathForStorageKey(absolutePath).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Decodes a project directory name to its original path.
 * Note: This is a best-effort decode. Paths with dashes cannot be decoded accurately.
 *
 * @param encodedName - The encoded directory name (e.g., "-Users-username-projectname")
 * @returns The decoded path (e.g., "/Users/username/projectname")
 */
export function decodePath(encodedName: string): string {
  if (!encodedName) {
    return '';
  }

  // Legacy Windows format observed in some Claude installs: "C--Users-name-project"
  // (no leading dash, drive separator encoded as "--").
  const legacyWindowsRegex = /^([a-zA-Z])--(.*)$/;
  const legacyWindowsMatch = legacyWindowsRegex.exec(encodedName);
  if (legacyWindowsMatch) {
    const drive = legacyWindowsMatch[1].toUpperCase();
    const rest = legacyWindowsMatch[2].replace(/-/g, '/');
    return `${drive}:/${rest}`;
  }

  // Remove leading dash if present (indicates absolute path)
  const withoutLeadingDash = encodedName.startsWith('-') ? encodedName.slice(1) : encodedName;

  // Replace dashes with slashes
  const decodedPath = withoutLeadingDash.replace(/-/g, '/');

  // Windows paths may decode to "C:/..."
  if (/^[a-zA-Z]:\//.test(decodedPath)) {
    return decodedPath;
  }

  // Ensure leading slash for POSIX-style absolute paths
  const absolutePath = decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`;

  // Translate WSL mount paths to Windows drive-letter paths on Windows
  return translateWslMountPath(absolutePath);
}

/**
 * Extract the project name (last path segment) from an encoded directory name.
 *
 * @param encodedName - The encoded directory name
 * @returns The project name
 */
export function extractProjectName(encodedName: string, cwdHint?: string): string {
  // Prefer cwdHint (actual filesystem path) since decodePath is lossy for
  // paths containing dashes (e.g., "claude-devtools" → "claude/code/context").
  if (cwdHint) {
    const segments = cwdHint.split(/[/\\]/).filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return last;
  }
  const decoded = decodePath(encodedName);
  const segments = decoded.split('/').filter(Boolean);
  return segments[segments.length - 1] || encodedName;
}

/**
 * Translate WSL mount paths (/mnt/X/...) to Windows drive-letter paths (X:/...)
 * when running on Windows. No-op on other platforms.
 */
export function translateWslMountPath(posixPath: string): string {
  if (process.platform !== 'win32') {
    return posixPath;
  }
  const match = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(posixPath);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = match[2] ?? '';
    return `${drive}:${rest}`;
  }
  return posixPath;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validates if a directory name follows the Claude Code encoding pattern.
 *
 * @param encodedName - The directory name to validate
 * @returns true if valid, false otherwise
 */
export function isValidEncodedPath(encodedName: string): boolean {
  if (!encodedName) {
    return false;
  }

  // Support legacy Windows format: "C--Users-name-project"
  // (no leading dash, drive separator encoded as "--").
  if (/^[a-zA-Z]--[^\x00-\x1f/\\:*?"<>|]+$/u.test(encodedName)) {
    return true;
  }

  // Must start with a dash (indicates absolute path)
  if (!encodedName.startsWith('-')) {
    return false;
  }

  // Encoded path is a single directory name. It may contain Unicode project
  // names, but must not contain separators, control chars, or Windows-invalid chars.
  // A single drive colon is allowed only in the old "-C:-Users-name" form.
  if (/[\x00-\x1f/\\*?"<>|]/u.test(encodedName)) {
    return false;
  }

  // Windows-style drive syntax is allowed only at the beginning after "-"
  // e.g. "-C:-Users-name-project". Reject stray ":" elsewhere.
  const firstColon = encodedName.indexOf(':');
  if (firstColon === -1) {
    return true;
  }

  if (!/^-[a-zA-Z]:/.test(encodedName)) {
    return false;
  }

  return !encodedName.includes(':', firstColon + 1);
}

/**
 * Validates a project ID that may be either a plain encoded path or
 * a composite subproject ID (`{encodedPath}::{8-char-hex}`).
 *
 * @param projectId - The project ID to validate
 * @returns true if valid
 */
export function isValidProjectId(projectId: string): boolean {
  if (!projectId) {
    return false;
  }

  const sep = projectId.indexOf('::');
  if (sep === -1) {
    // Plain encoded path
    return isValidEncodedPath(projectId);
  }

  // Composite ID: validate base part and hash suffix
  const basePart = projectId.slice(0, sep);
  const hashPart = projectId.slice(sep + 2);

  return isValidEncodedPath(basePart) && /^[a-f0-9]{8}$/.test(hashPart);
}

/**
 * Extract the base directory (encoded path) from a project ID.
 * For composite IDs (`{encoded}::{hash}`), returns the encoded part.
 * For plain IDs, returns the ID as-is.
 */
export function extractBaseDir(projectId: string): string {
  const sep = projectId.indexOf('::');
  if (sep !== -1) {
    return projectId.slice(0, sep);
  }
  return projectId;
}

function addUniqueCandidate(candidates: string[], candidate: string): void {
  if (candidate && !candidates.includes(candidate)) {
    candidates.push(candidate);
  }
}

/**
 * Returns possible ~/.claude/projects directory names for a project id.
 * The first candidate is always the id's own base dir. Additional entries cover
 * the orchestrator's portable codec, which lowercases Windows paths and folds
 * underscores/non-ASCII characters to dashes.
 */
export function getProjectDirNameCandidates(projectId: string): string[] {
  const baseDir = extractBaseDir(projectId);
  const candidates: string[] = [];
  addUniqueCandidate(candidates, baseDir);

  const decoded = decodePath(baseDir);
  addUniqueCandidate(candidates, encodePath(decoded));
  addUniqueCandidate(candidates, encodePathPortable(decoded));

  if (path.isAbsolute(projectId)) {
    addUniqueCandidate(candidates, encodePath(projectId));
    addUniqueCandidate(candidates, encodePathPortable(projectId));
  }

  return candidates;
}

// =============================================================================
// Session ID Extraction
// =============================================================================

/**
 * Extract session ID from a JSONL filename.
 *
 * @param filename - The filename (e.g., "abc123.jsonl")
 * @returns The session ID (e.g., "abc123")
 */
export function extractSessionId(filename: string): string {
  return filename.replace(/\.jsonl$/, '');
}

// =============================================================================
// Path Construction
// =============================================================================

/**
 * Construct the path to a session JSONL file.
 * Handles composite project IDs by extracting the base directory.
 */
export function buildSessionPath(basePath: string, projectId: string, sessionId: string): string {
  return path.join(basePath, extractBaseDir(projectId), `${sessionId}.jsonl`);
}

/**
 * Construct the path to a session's subagents directory.
 * Handles composite project IDs by extracting the base directory.
 */
export function buildSubagentsPath(basePath: string, projectId: string, sessionId: string): string {
  return path.join(basePath, extractBaseDir(projectId), sessionId, 'subagents');
}

/**
 * Construct the path to a task list file (stored in todos directory).
 */
export function buildTodoPath(claudeBasePath: string, sessionId: string): string {
  return path.join(claudeBasePath, 'todos', `${sessionId}.json`);
}

// =============================================================================
// Home Directory
// =============================================================================

/**
 * Try Electron's app.getPath('home') which correctly handles Unicode paths
 * on Windows (Cyrillic, CJK, etc.) unlike Node's os.homedir() / env vars
 * that can suffer from UTF-8 vs system codepage mismatches.
 *
 * Returns null when Electron app is unavailable (e.g. in tests).
 */
function getElectronHome(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Lazy require to avoid hard dependency on electron in test environments
    const electron = require('electron') as {
      app?: { getPath: (name: string) => string };
    };
    const app = electron.app;
    if (app && typeof app.getPath === 'function') {
      const home = app.getPath('home');
      if (home) return home;
    }
  } catch {
    // Not in Electron context (tests, standalone builds, etc.)
  }
  return null;
}

/**
 * Get the user's home directory.
 *
 * Priority:
 * 1. Electron app.getPath('home') — correct Unicode handling on all platforms
 * 2. HOME env var (Unix) / USERPROFILE (Windows)
 * 3. HOMEDRIVE + HOMEPATH (Windows fallback)
 * 4. os.homedir() (Node.js built-in)
 */
export function getHomeDir(): string {
  const electronHome = getElectronHome();
  if (electronHome) return electronHome;

  const windowsHome =
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : null;
  return process.env.HOME || process.env.USERPROFILE || windowsHome || os.homedir() || '/';
}

let claudeBasePathOverride: string | null = null;

function getDefaultClaudeBasePath(): string {
  return path.join(getHomeDir(), '.claude');
}

/**
 * Get the auto-detected Claude config base path (~/.claude) without considering overrides.
 */
export function getAutoDetectedClaudeBasePath(): string {
  return getDefaultClaudeBasePath();
}

function normalizeOverridePath(claudeBasePath: string): string | null {
  const trimmed = claudeBasePath.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized)) {
    return null;
  }

  const resolved = path.resolve(normalized);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return resolved;
  }
  let end = resolved.length;
  while (end > root.length) {
    const char = resolved[end - 1];
    if (char !== '/' && char !== '\\') {
      break;
    }
    end--;
  }

  return resolved.slice(0, end);
}

/**
 * Override the Claude config base path (~/.claude).
 * Pass null to return to auto-detection.
 */
export function setClaudeBasePathOverride(claudeBasePath: string | null | undefined): void {
  if (claudeBasePath == null) {
    claudeBasePathOverride = null;
    return;
  }

  claudeBasePathOverride = normalizeOverridePath(claudeBasePath);
}

/**
 * Get the Claude config base path (~/.claude).
 */
export function getClaudeBasePath(): string {
  return claudeBasePathOverride ?? getDefaultClaudeBasePath();
}

/**
 * Get the projects directory path (~/.claude/projects).
 */
export function getProjectsBasePath(): string {
  return path.join(getClaudeBasePath(), 'projects');
}

/**
 * Get the todos directory path (~/.claude/todos).
 */
export function getTodosBasePath(): string {
  return path.join(getClaudeBasePath(), 'todos');
}

/**
 * Get the teams directory path (~/.claude/teams).
 */
export function getTeamsBasePath(): string {
  return path.join(getClaudeBasePath(), 'teams');
}

/**
 * Get the tasks directory path (~/.claude/tasks).
 */
export function getTasksBasePath(): string {
  return path.join(getClaudeBasePath(), 'tasks');
}

/**
 * Get the tools directory path (~/.claude/tools).
 */
export function getToolsBasePath(): string {
  return path.join(getClaudeBasePath(), 'tools');
}

type CopyDirectoryForMigration = (sourcePath: string, targetPath: string) => void;

function copyDirectoryForMigrationSync(sourcePath: string, targetPath: string): void {
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: false,
    force: false,
  });
}

let copyDirectoryForMigration: CopyDirectoryForMigration = copyDirectoryForMigrationSync;

export function __setPathDecoderCopyDirectoryForTests(
  copyDirectory: CopyDirectoryForMigration | null
): void {
  copyDirectoryForMigration = copyDirectory ?? copyDirectoryForMigrationSync;
}

/**
 * Get the schedules directory path (~/.claude/agent-teams-schedules).
 */
export function getSchedulesBasePath(): string {
  const basePath = getClaudeBasePath();
  return migrateLegacyDirectoryPath(
    path.join(basePath, 'agent-teams-schedules'),
    path.join(basePath, 'claude-devtools-schedules')
  );
}

function migrateLegacyDirectoryPath(currentPath: string, legacyPath: string): string {
  if (!directoryExists(legacyPath)) {
    return currentPath;
  }

  if (directoryExists(currentPath)) {
    if (directoryHasEntries(currentPath)) {
      return currentPath;
    }
    return copyLegacyDirectoryPath(currentPath, legacyPath);
  }

  if (pathExists(currentPath)) {
    return currentPath;
  }

  return copyLegacyDirectoryPath(currentPath, legacyPath);
}

function copyLegacyDirectoryPath(currentPath: string, legacyPath: string): string {
  const tempPath = `${currentPath}.migrating-${process.pid}`;

  try {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    if (pathExists(tempPath)) {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }

    copyDirectoryForMigration(legacyPath, tempPath);

    if (directoryExists(currentPath) && !directoryHasEntries(currentPath)) {
      fs.rmdirSync(currentPath);
    }

    fs.renameSync(tempPath, currentPath);
    return currentPath;
  } catch {
    try {
      if (pathExists(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup only.
    }

    return directoryExists(currentPath) && directoryHasEntries(currentPath)
      ? currentPath
      : legacyPath;
  }
}

export function getTaskChangeSummariesBasePath(): string {
  return path.join(getClaudeBasePath(), 'task-change-summaries');
}

export function getTaskChangePresenceBasePath(): string {
  return path.join(getClaudeBasePath(), 'task-change-presence');
}

/**
 * Get the backups directory path for the app's own storage.
 */
export function getBackupsBasePath(): string {
  return path.join(getAppDataBasePath(), 'backups');
}

/**
 * Get the app's own data directory (attachments, task-attachments).
 * Separate from ~/.claude/ so CLI cannot delete our data.
 */
export function getAppDataPath(): string {
  return path.join(getAppDataBasePath(), 'data');
}

// ── App data root (Electron userData) ──

const APP_DATA_FALLBACK_DIR_NAME = '.agent-teams-ai';
const LEGACY_APP_DATA_FALLBACK_DIR_NAME = '.claude-agent-teams-ui';

let appDataBasePathOverride: string | null = null;

export function setAppDataBasePath(p: string | null | undefined): void {
  appDataBasePathOverride = p ?? null;
}

function getAppDataBasePath(): string {
  if (appDataBasePathOverride) return appDataBasePathOverride;
  // Fallback: resolve lazily from Electron app (safe after app.whenReady)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.getPath('userData');
  } catch {
    // Outside Electron (tests, CLI): use the new fallback path and migrate legacy data once.
    return getFallbackAppDataBasePath();
  }
}

function getFallbackAppDataBasePath(): string {
  const home = getHomeDir();
  const currentPath = path.join(home, APP_DATA_FALLBACK_DIR_NAME);
  const legacyPath = path.join(home, LEGACY_APP_DATA_FALLBACK_DIR_NAME);

  if (!directoryExists(legacyPath)) {
    return currentPath;
  }

  if (directoryExists(currentPath)) {
    if (directoryHasEntries(currentPath)) {
      return currentPath;
    }
    return migrateFallbackAppDataBasePath(currentPath, legacyPath);
  }

  if (pathExists(currentPath)) {
    return currentPath;
  }

  return migrateFallbackAppDataBasePath(currentPath, legacyPath);
}

function migrateFallbackAppDataBasePath(currentPath: string, legacyPath: string): string {
  const tempPath = `${currentPath}.migrating-${process.pid}`;

  try {
    if (pathExists(tempPath)) {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }

    copyDirectoryForMigration(legacyPath, tempPath);

    if (directoryExists(currentPath) && !directoryHasEntries(currentPath)) {
      fs.rmdirSync(currentPath);
    }

    fs.renameSync(tempPath, currentPath);
    return currentPath;
  } catch {
    try {
      if (pathExists(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup only.
    }

    return directoryExists(currentPath) && directoryHasEntries(currentPath)
      ? currentPath
      : legacyPath;
  }
}

function pathExists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function directoryHasEntries(targetPath: string): boolean {
  try {
    return fs.readdirSync(targetPath).length > 0;
  } catch {
    return false;
  }
}

/**
 * Directory for per-team MCP config JSON files.
 * Stored in app's userData so they persist across sessions and are
 * accessible by Claude CLI subprocess on all platforms (including AppImage).
 */
export function getMcpConfigsBasePath(): string {
  return path.join(getAppDataBasePath(), 'mcp-configs');
}

/**
 * Directory for the stable MCP server bundle copy (packaged builds).
 * Versioned subdirectories contain the copied index.js + package.json
 * so the server runs from a writable, non-FUSE location.
 */
export function getMcpServerBasePath(): string {
  return path.join(getAppDataBasePath(), 'mcp-server');
}
