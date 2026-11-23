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

function legacySlugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'member'
  );
}

function slugify(value: string): string {
  const full =
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'member';
  return full.length <= 48 ? full : `${full.slice(0, 37)}-${shortHash(full)}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function expectedWorktreePath(repoPath: string, teamName = 'Atlas HQ', memberName = 'Bob'): string {
  return path.join(
    hoisted.appDataRoot,
    'team-worktrees',
    `${legacySlugify(path.basename(repoPath))}-${shortHash(repoPath)}`,
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

  it('keeps distinct long member and team names in distinct worktrees', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const manager = new TeamMemberWorktreeManager();
    const prefix = 'a'.repeat(48);
    const bob = await manager.ensureMemberWorktree({
      teamName: 'Atlas HQ',
      memberName: `${prefix}bob`,
      baseCwd: repoPath,
    });
    const alice = await manager.ensureMemberWorktree({
      teamName: 'Atlas HQ',
      memberName: `${prefix}alice`,
      baseCwd: repoPath,
    });
    const otherTeam = await manager.ensureMemberWorktree({
      teamName: `${prefix}other`,
      memberName: `${prefix}bob`,
      baseCwd: repoPath,
    });
    expect(new Set([bob.worktreePath, alice.worktreePath, otherTeam.worktreePath]).size).toBe(3);
    expect(new Set([bob.branchName, alice.branchName, otherTeam.branchName]).size).toBe(3);
    for (const resolution of [bob, alice, otherTeam]) {
      await expect(execGit(['branch', '--show-current'], resolution.worktreePath)).resolves.toBe(
        resolution.branchName
      );
    }
  });

  it('separates long generated names from otherwise identical short names', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const manager = new TeamMemberWorktreeManager();
    const longName = 'a'.repeat(49);
    const shortName = `${'a'.repeat(37)}-${shortHash(longName)}`;
    expect(longName).not.toBe(shortName);
    expect(slugify(longName)).toBe(slugify(shortName)); // Without a namespace, these collide.

    const longMember = await manager.ensureMemberWorktree({
      teamName: 'Atlas HQ',
      memberName: longName,
      baseCwd: repoPath,
    });
    const shortMember = await manager.ensureMemberWorktree({
      teamName: 'Atlas HQ',
      memberName: shortName,
      baseCwd: repoPath,
    });
    const longTeam = await manager.ensureMemberWorktree({
      teamName: longName,
      memberName: 'Bob',
      baseCwd: repoPath,
    });
    const shortTeam = await manager.ensureMemberWorktree({
      teamName: shortName,
      memberName: 'Bob',
      baseCwd: repoPath,
    });
    const worktrees = [longMember, shortMember, longTeam, shortTeam];
    expect(new Set(worktrees.map((entry) => entry.worktreePath)).size).toBe(4);
    expect(new Set(worktrees.map((entry) => entry.branchName)).size).toBe(4);
    expect(longMember.worktreePath).toContain('_long-members');
    expect(longTeam.worktreePath).toContain('_long-teams');
    for (const entry of worktrees) {
      await expect(execGit(['branch', '--show-current'], entry.worktreePath)).resolves.toBe(
        entry.branchName
      );
    }
  });

  it('rejects main checkout when base cwd itself is another linked worktree', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const linkedBase = path.join(tempRoot, 'linked-base');
    const sibling = path.join(tempRoot, 'sibling-worktree');
    await execGit(['worktree', 'add', '-b', 'linked-base', linkedBase, 'HEAD'], repoPath);
    await execGit(['worktree', 'add', '-b', 'sibling', sibling, 'HEAD'], repoPath);
    const manager = new TeamMemberWorktreeManager();
    const input = { teamName: 'Atlas HQ', memberName: 'Bob', baseCwd: linkedBase };
    await expect(manager.ensureMemberWorktree({
      ...input,
      existingCwd: repoPath,
    })).rejects.toThrow('not a separate checkout root');
    const restored = await manager.ensureMemberWorktree({
      ...input,
      existingCwd: sibling,
    });
    expect(restored.worktreePath).toBe(sibling);
    expect(restored.branchName).toBe('sibling');
    expect(await execGit(['status', '--porcelain'], repoPath)).toBe('');
  });

  it('coalesces concurrent creation attempts without creating duplicate checkouts', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const manager = new TeamMemberWorktreeManager();
    const request = { teamName: 'Atlas HQ', memberName: 'Bob', baseCwd: repoPath };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => manager.ensureMemberWorktree(request))
    );
    expect(results.every((result) => result.worktreePath === results[0]?.worktreePath)).toBe(true);
    const registered = await execGit(['worktree', 'list', '--porcelain'], repoPath);
    expect(registered.match(/^worktree /gm)).toHaveLength(2);
    await expect(manager.ensureMemberWorktree(request)).resolves.toEqual(results[0]);
  });

  it('rejects the shared checkout and nested directories passed as persisted member cwd', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const nested = path.join(repoPath, 'nested');
    await fs.mkdir(nested);
    const manager = new TeamMemberWorktreeManager();
    for (const existingCwd of [repoPath, nested]) {
      await expect(
        manager.ensureMemberWorktree({
          teamName: 'Atlas HQ',
          memberName: 'Bob',
          baseCwd: repoPath,
          existingCwd,
        })
      ).rejects.toThrow('not a separate checkout root');
    }
    await expect(fs.stat(expectedWorktreePath(repoPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a persisted member cwd belonging to a foreign repository', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const foreignRepoPath = await createGitRepo(path.join(tempRoot, 'foreign'));
    const foreignWorktree = path.join(tempRoot, 'foreign-worktree');
    await execGit(['worktree', 'add', '-b', 'foreign-work', foreignWorktree, 'HEAD'], foreignRepoPath);
    await expect(
      new TeamMemberWorktreeManager().ensureMemberWorktree({
        teamName: 'Atlas HQ',
        memberName: 'Bob',
        baseCwd: repoPath,
        existingCwd: foreignWorktree,
      })
    ).rejects.toThrow('belongs to a different git repository');
  });

  (process.platform === 'win32' ? it.skip : it)(
    'rejects a managed worktree path symlinked to the main checkout',
    async () => {
      const repoPath = await createGitRepo(tempRoot);
      const managedPath = expectedWorktreePath(repoPath);
      await fs.mkdir(path.dirname(managedPath), { recursive: true });
      await fs.symlink(repoPath, managedPath, 'dir');
      await expect(
        new TeamMemberWorktreeManager().ensureMemberWorktree({
          teamName: 'Atlas HQ',
          memberName: 'Bob',
          baseCwd: repoPath,
        })
      ).rejects.toThrow('not a separate checkout root');
      await expect(execGit(['status', '--porcelain'], repoPath)).resolves.toBe('');
    }
  );

  it('reuses a persisted existing worktree on a different branch without changing files', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const manager = new TeamMemberWorktreeManager();
    const request = { teamName: 'Atlas HQ', memberName: 'Bob', baseCwd: repoPath };
    const initial = await manager.ensureMemberWorktree(request);
    await execGit(['switch', '-c', 'task-branch'], initial.worktreePath);
    await fs.writeFile(path.join(initial.worktreePath, 'notes.txt'), 'preserved\n');
    const restored = await manager.ensureMemberWorktree({
      ...request,
      existingCwd: initial.worktreePath,
    });
    expect(restored).toEqual({ ...initial, branchName: 'task-branch' });
    expect(await fs.readFile(path.join(initial.worktreePath, 'notes.txt'), 'utf8')).toBe(
      'preserved\n'
    );
  });

  it('refuses to guess the owner of old truncated-name checkouts without a persisted path', async () => {
    const repoPath = await createGitRepo(tempRoot);
    const memberName = `${'a'.repeat(48)}alice`;
    const oldPath = path.join(
      hoisted.appDataRoot,
      'team-worktrees',
      `${legacySlugify(path.basename(repoPath))}-${shortHash(repoPath)}`,
      legacySlugify('Atlas HQ'),
      legacySlugify(memberName)
    );
    const oldBranch = `agent-teams/atlas-hq/${legacySlugify(memberName)}-${shortHash(repoPath)}`;
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await execGit(['worktree', 'add', '-b', oldBranch, oldPath, 'HEAD'], repoPath);
    const manager = new TeamMemberWorktreeManager();
    await expect(
      manager.ensureMemberWorktree({ teamName: 'Atlas HQ', memberName, baseCwd: repoPath })
    ).rejects.toThrow('ambiguous truncated name');
    const restored = await manager.ensureMemberWorktree({
      teamName: 'Atlas HQ',
      memberName,
      baseCwd: repoPath,
      existingCwd: oldPath,
    });
    expect(restored.worktreePath).toBe(oldPath);
    expect(restored.branchName).toBe(oldBranch);
  });
});
