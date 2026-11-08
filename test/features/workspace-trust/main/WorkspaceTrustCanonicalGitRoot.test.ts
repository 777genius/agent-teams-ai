import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFilesystemGitRoot,
} from '@features/workspace-trust/main';
import { afterEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string | null = null;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-trust-git-root-'));
  return tmpDir;
}

async function createSyntheticWorktree(input: {
  repoDir: string;
  worktreeDir: string;
  name: string;
  relativeBacklink?: boolean;
}): Promise<void> {
  const worktreeGitDir = path.join(input.repoDir, '.git', 'worktrees', input.name);
  await fs.mkdir(input.worktreeDir, { recursive: true });
  await fs.mkdir(worktreeGitDir, { recursive: true });
  await fs.writeFile(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(input.worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
  await fs.writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
  const backlink = path.join(input.worktreeDir, '.git');
  await fs.writeFile(
    path.join(worktreeGitDir, 'gitdir'),
    `${input.relativeBacklink ? path.relative(worktreeGitDir, backlink) : backlink}\n`,
    'utf8'
  );
}

async function createGitDirectoryLayout(root: string): Promise<void> {
  // Real Git rejects a HEAD/config-only directory. Give positive fixtures the
  // refs and objects structure produced by git init.
  await fs.mkdir(path.join(root, '.git', 'refs'), { recursive: true });
  await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('resolveWorkspaceTrustCanonicalGitRoot', () => {
  it('rejects forged or malformed Git markers before elevating a parent to a trust root', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'parent');
    const nested = path.join(repo, 'nested');
    await createGitDirectoryLayout(repo);
    await fs.mkdir(nested);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBeNull();
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git', 'config'), '[core]\n');
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(repo);
  });

  it('does not trust a HEAD/config-only directory that Git itself refuses', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'incomplete');
    const nested = path.join(repo, 'nested');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(nested);
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git', 'config'), '[core]\n');
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBeNull();
    await createGitDirectoryLayout(repo);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(repo);
  });

  it('recognizes a real .git directory symlink as a repository marker', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'source');
    const alias = path.join(dir, 'linked');
    await createGitDirectoryLayout(repo);
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git', 'config'), '[core]\n');
    await fs.mkdir(alias);
    await fs.symlink(
      path.join(repo, '.git'),
      path.join(alias, '.git'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(resolveWorkspaceTrustFilesystemGitRoot(alias)).resolves.toBe(alias);
  });

  it('accepts valid symbolic HEAD names beginning with underscore, Unicode or dot', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'repo');
    const nested = path.join(repo, 'nested');
    await createGitDirectoryLayout(repo);
    await fs.mkdir(nested);
    await fs.writeFile(path.join(repo, '.git', 'config'), '[core]\n');

    for (const branch of ['_feature', 'фича', '.invalid']) {
      await fs.writeFile(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
      await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(repo);
    }
  });

  it('preserves the original filesystem spelling for decomposed unicode paths', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'Cafe\u0301');
    const nested = path.join(repo, 'nested');
    await createGitDirectoryLayout(repo);
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git', 'config'), '[core]\n');
    await fs.mkdir(nested);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(repo);
  });

  it('recognizes a case-insensitive core config section', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'upper-core');
    const nested = path.join(repo, 'nested');
    await createGitDirectoryLayout(repo);
    await fs.mkdir(nested);
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git', 'config'), '[CORE]\n\tbare = false\n');
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(repo);
  });

  it('keeps separate-git-dir acceptance when another section mentions worktree', async () => {
    const dir = await makeTmpDir();
    const checkout = path.join(dir, 'checkout');
    const nested = path.join(checkout, 'nested');
    const gitDir = path.join(dir, 'metadata');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(gitDir);
    await fs.writeFile(path.join(checkout, '.git'), `gitdir: ${gitDir}\n`);
    await fs.writeFile(path.join(gitDir, 'config'),
      '[core]\n\tbare = false\n[remote "origin"]\n\tworktree = unrelated\n');
    const managedGit = vi.fn(async () => true);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested, managedGit)).resolves.toBe(checkout);
    expect(managedGit).toHaveBeenCalledWith(checkout);
  });

  it('needs explicit proof before trusting a standalone Git metadata pointer', async () => {
    const dir = await makeTmpDir();
    const checkout = path.join(dir, 'checkout');
    const nested = path.join(checkout, 'nested');
    const gitDir = path.join(dir, 'metadata');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(gitDir);
    await fs.writeFile(path.join(checkout, '.git'), `gitdir: ${gitDir}\n`);
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(gitDir, 'config'), '[core]\n\tbare = false\n');

    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBeNull();
    const denied = vi.fn(async () => false);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested, denied)).resolves.toBeNull();
    const verified = vi.fn(async (candidate: string) => candidate === checkout);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested, verified)).resolves.toBe(checkout);
    expect(verified).toHaveBeenCalledWith(checkout);
  });

  it('rejects forged .git pointers to another repository', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'parent');
    const nested = path.join(repo, 'nested');
    const foreign = path.join(dir, 'foreign-git');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git'), `gitdir: ${foreign}\n`);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBeNull();
  });

  it('never passes a forged linked-worktree pointer through the standalone Git fallback', async () => {
    const dir = await makeTmpDir();
    const repository = path.join(dir, 'repository');
    const validWorktree = path.join(dir, 'worktree');
    const forged = path.join(dir, 'forged');
    await createGitDirectoryLayout(repository);
    await createSyntheticWorktree({ repoDir: repository, worktreeDir: validWorktree, name: 'alice' });
    await fs.mkdir(forged);
    await fs.writeFile(
      path.join(forged, '.git'),
      `gitdir: ${path.join(repository, '.git', 'worktrees', 'alice')}\n`
    );
    // A managed git rev-parse call can accept this foreign pointer, but it
    // must not override the failed backlink validation.
    const unsafeGitProbe = vi.fn(async () => true);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(forged, unsafeGitProbe)).resolves.toBeNull();
    expect(unsafeGitProbe).not.toHaveBeenCalled();
  });

  it('finds a git root from nested paths without spawning git', async () => {
    const dir = await makeTmpDir();
    const repoDir = path.join(dir, 'repo');
    const nestedDir = path.join(repoDir, 'packages', 'app');
    await createGitDirectoryLayout(repoDir);
    await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repoDir, '.git', 'config'), '[core]\n');
    await fs.mkdir(nestedDir, { recursive: true });

    await expect(resolveWorkspaceTrustFilesystemGitRoot(nestedDir)).resolves.toBe(repoDir);
  });

  it('does not infer a git root from a missing path', async () => {
    const dir = await makeTmpDir();
    const repoDir = path.join(dir, 'repo');
    const missingDir = path.join(repoDir, 'packages', 'missing');
    await createGitDirectoryLayout(repoDir);
    await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repoDir, '.git', 'config'), '[core]\n');

    await expect(resolveWorkspaceTrustFilesystemGitRoot(missingDir)).resolves.toBeNull();
  });

  it('recognizes quoted core.worktree paths in a real-style submodule', async () => {
    const root = await makeTmpDir();
    const superproject = path.join(root, 'repo');
    const submodule = path.join(superproject, 'app#1');
    const nested = path.join(submodule, 'src');
    const submoduleGitDir = path.join(superproject, '.git', 'modules', 'app#1');
    await createGitDirectoryLayout(superproject);
    await fs.writeFile(path.join(superproject, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(superproject, '.git', 'config'), '[core]\n');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(submoduleGitDir, { recursive: true });
    await fs.writeFile(path.join(submodule, '.git'), 'gitdir: ../.git/modules/app#1\n');
    await fs.writeFile(path.join(submoduleGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(
      path.join(submoduleGitDir, 'config'),
      '[core]\n\tworktree = "../../../app#1"\n'
    );
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(submodule);
  });

  it('resolves a valid git worktree to the canonical repository root', async () => {
    const dir = await makeTmpDir();
    const repoDir = path.join(dir, 'repo');
    const worktreeDir = path.join(dir, 'worktrees', 'alice');
    await createGitDirectoryLayout(repoDir);
    await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repoDir, '.git', 'config'), '[core]\n');
    await createSyntheticWorktree({ repoDir, worktreeDir, name: 'alice' });

    await expect(resolveWorkspaceTrustCanonicalGitRoot(worktreeDir)).resolves.toBe(repoDir);
  });

  it('preserves filesystem spelling for the canonical root of a linked worktree', async () => {
    const dir = await makeTmpDir();
    const repoDir = path.join(dir, 'Cafe\u0301');
    const worktreeDir = path.join(dir, 'worktree');
    await createGitDirectoryLayout(repoDir);
    await createSyntheticWorktree({ repoDir, worktreeDir, name: 'unicode' });
    await expect(resolveWorkspaceTrustCanonicalGitRoot(worktreeDir)).resolves.toBe(repoDir);
  });

  it('resolves worktree-relative backlinks from git metadata, not process cwd', async () => {
    const dir = await makeTmpDir();
    const repoDir = path.join(dir, 'repo');
    const worktreeDir = path.join(dir, 'worktrees', 'alice');
    await createGitDirectoryLayout(repoDir);
    await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repoDir, '.git', 'config'), '[core]\n');
    await createSyntheticWorktree({ repoDir, worktreeDir, name: 'alice', relativeBacklink: true });
    const nested = path.join(worktreeDir, 'nested');
    await fs.mkdir(nested);

    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(worktreeDir);
    await expect(resolveWorkspaceTrustCanonicalGitRoot(worktreeDir)).resolves.toBe(repoDir);
  });

  it('does not accept a forged gitdir pointer to another repository', async () => {
    const dir = await makeTmpDir();
    const trustedRepoDir = path.join(dir, 'trusted-repo');
    const forgedDir = path.join(dir, 'forged');
    await createGitDirectoryLayout(trustedRepoDir);
    await fs.mkdir(forgedDir, { recursive: true });
    await fs.writeFile(
      path.join(forgedDir, '.git'),
      `gitdir: ${path.join(trustedRepoDir, '.git')}\n`,
      'utf8'
    );

    await expect(resolveWorkspaceTrustCanonicalGitRoot(forgedDir)).resolves.toBe(forgedDir);
  });

  it('does not accept borrowed worktree metadata without a backlink', async () => {
    const dir = await makeTmpDir();
    const trustedRepoDir = path.join(dir, 'trusted-repo');
    const forgedDir = path.join(dir, 'forged');
    const borrowedWorktreeGitDir = path.join(trustedRepoDir, '.git', 'worktrees', 'alice');
    await createGitDirectoryLayout(trustedRepoDir);
    await fs.mkdir(forgedDir, { recursive: true });
    await fs.mkdir(borrowedWorktreeGitDir, { recursive: true });
    await fs.writeFile(
      path.join(forgedDir, '.git'),
      `gitdir: ${borrowedWorktreeGitDir}\n`,
      'utf8'
    );
    await fs.writeFile(path.join(borrowedWorktreeGitDir, 'commondir'), '../..\n', 'utf8');
    await fs.writeFile(
      path.join(borrowedWorktreeGitDir, 'gitdir'),
      `${path.join(trustedRepoDir, '.git')}\n`,
      'utf8'
    );

    await expect(resolveWorkspaceTrustCanonicalGitRoot(forgedDir)).resolves.toBe(forgedDir);
  });
});
