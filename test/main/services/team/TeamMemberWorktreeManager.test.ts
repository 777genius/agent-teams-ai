import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  claudeRoot: '',
  appDataRoot: '',
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getClaudeBasePath: () => hoisted.claudeRoot,
  getAppDataPath: () => hoisted.appDataRoot,
}));

import { TeamMemberWorktreeManager } from '../../../../src/main/services/team/TeamMemberWorktreeManager';

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'member'
  );
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function expectedWorktreePath(repoPath: string, teamName = 'Atlas HQ', memberName = 'Bob'): string {
  return path.join(
    hoisted.appDataRoot,
    'team-worktrees',
    `${slugify(path.basename(repoPath))}-${shortHash(repoPath)}`,
    slugify(teamName),
    slugify(memberName)
  );
}

function legacyWorktreePath(repoPath: string, teamName = 'Atlas HQ', memberName = 'Bob'): string {
  return path.join(
    hoisted.claudeRoot,
    'team-worktrees',
    shortHash(repoPath),
    slugify(teamName),
    slugify(memberName)
  );
}

async function createGitRepo(root: string): Promise<string> {
  const repoPath = path.join(root, 'repo');
  await fs.mkdir(repoPath, { recursive: true });
  await execGit(['init'], repoPath);
  await fs.writeFile(path.join(repoPath, 'README.md'), 'test repo\n', 'utf8');
  await execGit(['add', 'README.md'], repoPath);
  await execGit(
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'],
    repoPath
  );
  return await fs.realpath(repoPath);
}

describe('TeamMemberWorktreeManager', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-member-worktree-'));
    hoisted.claudeRoot = path.join(tempRoot, 'claude');
    hoisted.appDataRoot = path.join(tempRoot, 'app-data');
    await fs.mkdir(hoisted.claudeRoot, { recursive: true });
    await fs.mkdir(hoisted.appDataRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('creates deterministic member worktrees on agent-teams branches', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const manager = new TeamMemberWorktreeManager();

    const resolution = await manager.ensureMemberWorktree({
      teamName: 'Atlas HQ',
      memberName: 'Bob',
      baseCwd: repoPath,
    });

    expect(resolution.baseRepoPath).toBe(repoPath);
    expect(resolution.branchName).toBe(`agent-teams/atlas-hq/bob-${shortHash(repoPath)}`);
    expect(resolution.worktreePath).toBe(expectedWorktreePath(repoPath));
    expect(resolution.worktreePath.startsWith(hoisted.appDataRoot)).toBe(true);
    expect(resolution.worktreePath.startsWith(hoisted.claudeRoot)).toBe(false);
    await expect(
      execGit(['rev-parse', '--abbrev-ref', 'HEAD'], resolution.worktreePath)
    ).resolves.toBe(resolution.branchName);
    await expect(
      manager.ensureMemberWorktree({ teamName: 'Atlas HQ', memberName: 'Bob', baseCwd: repoPath })
    ).resolves.toEqual(resolution);
  });

  it('reuses legacy deterministic worktree paths for existing teammates', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const manager = new TeamMemberWorktreeManager();
    const branchName = `agent-teams/atlas-hq/bob-${shortHash(repoPath)}`;
    const legacyPath = legacyWorktreePath(repoPath);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await execGit(['worktree', 'add', '-b', branchName, legacyPath, 'HEAD'], repoPath);

    const resolution = await manager.ensureMemberWorktree({
      teamName: 'Atlas HQ',
      memberName: 'Bob',
      baseCwd: repoPath,
    });

    expect(resolution.worktreePath).toBe(legacyPath);
    expect(resolution.branchName).toBe(branchName);
    await expect(
      execGit(['rev-parse', '--abbrev-ref', 'HEAD'], resolution.worktreePath)
    ).resolves.toBe(branchName);
  });

  it.each(['current', 'legacy'] as const)(
    'continues on the current branch and preserves all local work in a %s worktree',
    async (location) => {
      const repoPath = await createGitRepo(tempRoot);
      const worktreePath =
        location === 'legacy' ? legacyWorktreePath(repoPath) : expectedWorktreePath(repoPath);
      const expectedBranch = `agent-teams/atlas-hq/bob-${shortHash(repoPath)}`;
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await execGit(['worktree', 'add', '-b', expectedBranch, worktreePath, 'HEAD'], repoPath);
      await execGit(['switch', '-c', 'm0merge'], worktreePath);
      await fs.writeFile(path.join(worktreePath, 'README.md'), 'staged work\n');
      await execGit(['add', 'README.md'], worktreePath);
      await fs.writeFile(path.join(worktreePath, 'README.md'), 'uncommitted work\n');
      await fs.writeFile(path.join(worktreePath, 'notes.txt'), 'untracked work\n');
      const headBefore = await execGit(['rev-parse', 'HEAD'], worktreePath);
      const statusBefore = await execGit(['status', '--porcelain'], worktreePath);
      const stagedBefore = await execGit(['diff', '--cached'], worktreePath);
      const unstagedBefore = await execGit(['diff'], worktreePath);

      const manager = new TeamMemberWorktreeManager();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          manager.ensureMemberWorktree({
            teamName: 'Atlas HQ',
            memberName: 'Bob',
            baseCwd: repoPath,
          })
        ).resolves.toEqual({ baseRepoPath: repoPath, worktreePath, branchName: 'm0merge' });
      }
      await expect(execGit(['branch', '--show-current'], worktreePath)).resolves.toBe('m0merge');
      await expect(execGit(['rev-parse', 'HEAD'], worktreePath)).resolves.toBe(headBefore);
      await expect(execGit(['status', '--porcelain'], worktreePath)).resolves.toBe(statusBefore);
      await expect(execGit(['diff', '--cached'], worktreePath)).resolves.toBe(stagedBefore);
      await expect(execGit(['diff'], worktreePath)).resolves.toBe(unstagedBefore);
      await expect(fs.readFile(path.join(worktreePath, 'README.md'), 'utf8')).resolves.toBe(
        'uncommitted work\n'
      );
      await expect(fs.readFile(path.join(worktreePath, 'notes.txt'), 'utf8')).resolves.toBe(
        'untracked work\n'
      );
    }
  );

  it.each(['current', 'legacy'] as const)(
    'rejects a %s worktree belonging to another repository',
    async (location) => {
      const repoPath = await createGitRepo(tempRoot);
      const foreignRepoPath = await createGitRepo(path.join(tempRoot, 'foreign'));
      const worktreePath =
        location === 'legacy' ? legacyWorktreePath(repoPath) : expectedWorktreePath(repoPath);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await execGit(['worktree', 'add', '-b', 'foreign', worktreePath, 'HEAD'], foreignRepoPath);

      await expect(
        new TeamMemberWorktreeManager().ensureMemberWorktree({
          teamName: 'Atlas HQ',
          memberName: 'Bob',
          baseCwd: repoPath,
        })
      ).rejects.toThrow('belongs to a different git repository');
      await expect(execGit(['branch', '--show-current'], worktreePath)).resolves.toBe('foreign');
    }
  );

  it.each(['current', 'legacy'] as const)(
    'rejects a detached HEAD in a %s worktree without changing it',
    async (location) => {
      const repoPath = await createGitRepo(tempRoot);
      const worktreePath =
        location === 'legacy' ? legacyWorktreePath(repoPath) : expectedWorktreePath(repoPath);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await execGit(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repoPath);
      await fs.writeFile(path.join(worktreePath, 'notes.txt'), 'untracked work\n');
      const headBefore = await execGit(['rev-parse', 'HEAD'], worktreePath);

      await expect(
        new TeamMemberWorktreeManager().ensureMemberWorktree({
          teamName: 'Atlas HQ',
          memberName: 'Bob',
          baseCwd: repoPath,
        })
      ).rejects.toThrow(
        `Worktree path for member "Bob" has a detached HEAD. Check out a branch before continuing: ${worktreePath}`
      );
      await expect(execGit(['branch', '--show-current'], worktreePath)).resolves.toBe('');
      await expect(execGit(['rev-parse', 'HEAD'], worktreePath)).resolves.toBe(headBefore);
      await expect(fs.readFile(path.join(worktreePath, 'notes.txt'), 'utf8')).resolves.toBe(
        'untracked work\n'
      );
    }
  );

  it('creates a new worktree on an existing deterministic branch without resetting it', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const branchName = `agent-teams/atlas-hq/bob-${shortHash(repoPath)}`;
    await execGit(['branch', branchName], repoPath);
    const branchHead = await execGit(['rev-parse', branchName], repoPath);
    await fs.writeFile(path.join(repoPath, 'README.md'), 'later base changes\n');
    await execGit(['add', 'README.md'], repoPath);
    await execGit(
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'later'],
      repoPath
    );

    const resolution = await new TeamMemberWorktreeManager().ensureMemberWorktree({
      teamName: 'Atlas HQ',
      memberName: 'Bob',
      baseCwd: repoPath,
    });
    expect(resolution.branchName).toBe(branchName);
    await expect(execGit(['rev-parse', 'HEAD'], resolution.worktreePath)).resolves.toBe(branchHead);
  });
});
