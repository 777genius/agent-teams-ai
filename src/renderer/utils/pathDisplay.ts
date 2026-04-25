/**
 * Path display utilities for shortening file paths in tight UI spaces.
 *
 * Strategy:
 * 1. Strip project root to make relative
 * 2. Replace home directory with ~
 * 3. Middle-truncate if still too long, preserving first and last segments
 *
 * Also provides resolveAbsolutePath() for clipboard copy (~ → real home, relative → absolute).
 */

import { splitPath } from '@shared/utils/platformPath';

function isWindowsAbsolutePath(input: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(input) || input.startsWith('\\\\') || input.startsWith('//');
}

function pathSeparatorFor(root: string): '/' | '\\' {
  return root.includes('\\') && !root.includes('/') ? '\\' : '/';
}

function joinDisplayPath(root: string, child: string): string {
  const sep = pathSeparatorFor(root);
  return root.replace(/[/\\]$/, '') + sep + child.replace(/[/\\]/g, sep);
}

/**
 * Shorten a file path for display in compact UI elements.
 * Full path should still be available via tooltip (title attribute).
 *
 * Examples:
 * - `/Users/name/.claude/projects/-Users-name-project/memory/MEMORY.md` → `~/.claude/…/memory/MEMORY.md`
 * - `/Users/name/project/.claude/rules/tailwind.md` (with projectRoot) → `.claude/rules/tailwind.md`
 * - `~/.claude/CLAUDE.md` → `~/.claude/CLAUDE.md` (already short)
 */
export function shortenDisplayPath(fullPath: string, projectRoot?: string, maxLength = 40): string {
  let p = fullPath;

  // 1. Make relative to project root
  if (projectRoot) {
    const root = projectRoot.replace(/[/\\]$/, '');
    const caseInsensitive = isWindowsAbsolutePath(p) || isWindowsAbsolutePath(root);
    const pathForCompare = caseInsensitive ? p.toLowerCase() : p;
    const rootForCompare = caseInsensitive ? root.toLowerCase() : root;
    if (
      pathForCompare.startsWith(rootForCompare + '/') ||
      pathForCompare.startsWith(rootForCompare + '\\')
    ) {
      p = p.slice(root.length + 1);
    }
  }

  // 2. Replace home directory with ~
  p = p
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');

  // 3. If short enough, return as-is
  if (p.length <= maxLength) return p;

  // 4. Middle-truncate: keep first meaningful segments + … + last 2 segments
  const sep = p.includes('\\') ? '\\' : '/';
  const segments = p.split(sep);

  // Determine where content starts (skip leading empty segment from absolute paths or ~)
  let startIdx = 0;
  if (segments[0] === '' || segments[0] === '~') startIdx = 1;

  // Need at least 4 content segments to truncate the middle
  if (segments.length - startIdx <= 3) return p;

  const head = segments.slice(0, startIdx + 1).join(sep);
  const tail = segments.slice(-2).join(sep);

  return `${head}${sep}\u2026${sep}${tail}`;
}

/**
 * Infer the user's home directory from a known absolute project path.
 * Works for macOS (/Users/x), Linux (/home/x), and Windows (C:\Users\x).
 */
function inferHomeDir(projectRoot: string): string | null {
  const match =
    /^(\/Users\/[^/]+)/.exec(projectRoot) ??
    /^(\/home\/[^/]+)/.exec(projectRoot) ??
    /^([A-Z]:\\Users\\[^\\]+)/i.exec(projectRoot);
  return match?.[1] ?? null;
}

/**
 * Resolve a possibly-shortened path to its full absolute form for clipboard copy.
 *
 * - `~/...` → `/Users/username/...` (home dir inferred from projectRoot)
 * - `src/foo/bar` → `{projectRoot}/src/foo/bar`
 * - Already absolute → returned as-is
 */
/**
 * Truncate a project path to ~/relative/path format.
 * Works for macOS (/Users/...), Linux (/home/...) and Windows (C:\Users\...).
 */
export function formatProjectPath(path: string): string {
  const p = path.replace(/\\/g, '/');

  if (p.startsWith('/Users/') || p.startsWith('/home/')) {
    const parts = splitPath(p);
    if (parts.length >= 2) {
      const rest = parts.slice(2).join('/');
      return rest ? `~/${rest}` : '~';
    }
  }

  if (isWindowsUserPath(path)) {
    const parts = splitPath(p);
    if (parts.length >= 3) {
      const rest = parts.slice(3).join('/');
      return rest ? `~/${rest}` : '~';
    }
  }

  return p;
}

function isWindowsUserPath(input: string): boolean {
  if (input.length < 10) return false;
  const drive = input.charCodeAt(0);
  const hasDriveLetter =
    ((drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122)) && input[1] === ':';
  return hasDriveLetter && input.slice(2, 9).toLowerCase() === '\\users\\';
}

export function resolveAbsolutePath(filePath: string, projectRoot?: string): string {
  let p = filePath;

  // Resolve ~ using home dir inferred from projectRoot
  if ((p.startsWith('~/') || p.startsWith('~\\')) && projectRoot) {
    const homeDir = inferHomeDir(projectRoot);
    if (homeDir) {
      p = joinDisplayPath(homeDir, p.slice(2));
    }
  }

  // Make relative paths absolute by prepending projectRoot
  if (projectRoot && !p.startsWith('/') && !p.startsWith('~') && !isWindowsAbsolutePath(p)) {
    p = joinDisplayPath(projectRoot, p);
  }

  return p;
}
