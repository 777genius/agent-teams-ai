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

export async function resolveWorkspaceTrustFilesystemGitRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd).normalize('NFC');
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
    try {
      const stat = await fs.stat(path.join(current, '.git'));
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Keep walking until the filesystem root.
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
  const normalizedGitRoot = path.resolve(gitRoot).normalize('NFC');
  const gitFileContent = await readTrimmedFileOrNull(path.join(normalizedGitRoot, '.git'));
  if (!gitFileContent?.startsWith('gitdir:')) {
    return normalizedGitRoot;
  }

  const worktreeGitDir = path
    .resolve(normalizedGitRoot, gitFileContent.slice('gitdir:'.length).trim())
    .normalize('NFC');
  const commonDirRaw = await readTrimmedFileOrNull(path.join(worktreeGitDir, 'commondir'));
  if (!commonDirRaw) {
    return normalizedGitRoot;
  }

  const commonDir = path.resolve(worktreeGitDir, commonDirRaw).normalize('NFC');
  // Guard against a repo borrowing another trusted repo's worktree metadata.
  if (path.resolve(path.dirname(worktreeGitDir)) !== path.join(commonDir, 'worktrees')) {
    return normalizedGitRoot;
  }

  const gitdirBacklink = await readTrimmedFileOrNull(path.join(worktreeGitDir, 'gitdir'));
  if (!gitdirBacklink) {
    return normalizedGitRoot;
  }

  const [backlink, realGitRoot] = await Promise.all([
    realpathOrNull(gitdirBacklink),
    realpathOrNull(normalizedGitRoot),
  ]);
  if (!backlink || !realGitRoot || backlink !== path.join(realGitRoot, '.git')) {
    return normalizedGitRoot;
  }

  return (path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir).normalize(
    'NFC'
  );
}
