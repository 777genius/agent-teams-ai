import fs from 'node:fs/promises';
import path from 'node:path';

async function realpathOrNull(value: string): Promise<string | null> {
  try {
    return await fs.realpath(value);
  } catch {
    return null;
  }
}

async function readTrimmedFileOrNull(filePath: string): Promise<string | null> {
  try {
    const value = await fs.readFile(filePath, 'utf8');
    return value.trim();
  } catch {
    return null;
  }
}

function validHead(head: string | null): boolean {
  return Boolean(
    head &&
    (/^ref: refs\/(?:heads|tags)\/[^\s][^\r\n]*$/.test(head) ||
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(head))
  );
}

async function isValidGitMarker(root: string): Promise<boolean> {
  const marker = path.join(root, '.git');
  try {
    const stat = await fs.lstat(marker);
    if (stat.isDirectory()) {
      const [head, config] = await Promise.all([
        readTrimmedFileOrNull(path.join(marker, 'HEAD')),
        readTrimmedFileOrNull(path.join(marker, 'config')),
      ]);
      return validHead(head) && Boolean(config?.includes('[core]'));
    }
    if (!stat.isFile()) return false;
    const contents = await readTrimmedFileOrNull(marker);
    const match = /^gitdir:\s*(.+)$/.exec(contents ?? '');
    if (!match || /[\r\n]/.test(match[1])) return false;
    const gitDir = path.resolve(root, match[1]);
    const [head, backlink, commonDir] = await Promise.all([
      readTrimmedFileOrNull(path.join(gitDir, 'HEAD')),
      readTrimmedFileOrNull(path.join(gitDir, 'gitdir')),
      readTrimmedFileOrNull(path.join(gitDir, 'commondir')),
    ]);
    if (!validHead(head)) return false;
    // Worktrees must link back to this exact .git file; do not borrow another
    // repository's metadata as a source of trust for sibling directories.
    if (commonDir) {
      if (!backlink) return false;
      const [actual, expected] = await Promise.all([
        realpathOrNull(path.resolve(gitDir, backlink)),
        realpathOrNull(marker),
      ]);
      return Boolean(actual && expected && actual === expected);
    }
    // Submodules may legitimately use .git files pointing to a module gitdir.
    // A real submodule config identifies its worktree; arbitrary gitdir files do not.
    const config = await readTrimmedFileOrNull(path.join(gitDir, 'config'));
    const coreConfig = /(?:^|\n)\s*\[core\]\s*([^]*?)(?=\n\s*\[|$)/i.exec(config ?? '')?.[1];
    const rawWorktree = /(?:^|\n)\s*worktree\s*=\s*([^\r\n]+)/im
      .exec(coreConfig ?? '')?.[1]?.trim();
    if (!rawWorktree) return false;
    // Git quotes core.worktree paths containing '#' or ';'. Decode the
    // ordinary quoted-path escapes instead of treating quotes as path bytes.
    const worktree =
      rawWorktree.startsWith('"') && rawWorktree.endsWith('"')
        ? rawWorktree.slice(1, -1).replace(/\\([\\"])/g, '$1')
        : rawWorktree;
    return path.resolve(gitDir, worktree) === root;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceTrustFilesystemGitRoot(
  cwd: string,
  verifyGitFile?: (candidateRoot: string) => Promise<boolean>
): Promise<string | null> {
  let current = path.resolve(cwd);
  const root = path.parse(current).root;
  try {
    const cwdStat = await fs.stat(current);
    if (!cwdStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  while (true) {
    if (await isValidGitMarker(current)) return current;
    // Standalone git init --separate-git-dir metadata has no core.worktree.
    // Verify only otherwise untrusted .git files with the managed Git binary.
    // Normal directories and absent markers must never trigger a Git process.
    if (verifyGitFile) {
      try {
        if ((await fs.lstat(path.join(current, '.git'))).isFile() && await verifyGitFile(current)) {
          return current;
        }
      } catch {
        // Invalid or unreadable metadata is not a trust root.
      }
    }

    if (current === root) {
      return null;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function resolveWorkspaceTrustCanonicalGitRoot(gitRoot: string): Promise<string> {
  const normalizedGitRoot = path.resolve(gitRoot);
  const gitFileContent = await readTrimmedFileOrNull(path.join(normalizedGitRoot, '.git'));
  if (!gitFileContent?.startsWith('gitdir:')) {
    return normalizedGitRoot;
  }

  const worktreeGitDir = path
    .resolve(normalizedGitRoot, gitFileContent.slice('gitdir:'.length).trim())
    ;
  const commonDirRaw = await readTrimmedFileOrNull(path.join(worktreeGitDir, 'commondir'));
  if (!commonDirRaw) {
    return normalizedGitRoot;
  }

  const commonDir = path.resolve(worktreeGitDir, commonDirRaw);
  // Guard against a repo borrowing another trusted repo's worktree metadata.
  if (path.resolve(path.dirname(worktreeGitDir)) !== path.join(commonDir, 'worktrees')) {
    return normalizedGitRoot;
  }

  const gitdirBacklink = await readTrimmedFileOrNull(path.join(worktreeGitDir, 'gitdir'));
  if (!gitdirBacklink) {
    return normalizedGitRoot;
  }

  const [backlink, realGitRoot] = await Promise.all([
    realpathOrNull(path.resolve(worktreeGitDir, gitdirBacklink)),
    realpathOrNull(normalizedGitRoot),
  ]);
  if (!backlink || !realGitRoot || backlink !== path.join(realGitRoot, '.git')) {
    return normalizedGitRoot;
  }

  return (path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir).normalize(
    'NFC'
  );
}
