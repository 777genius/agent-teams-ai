import { getAppDataPath, getClaudeBasePath } from '@main/utils/pathDecoder';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface TeamMemberWorktreeRequest {
  teamName: string;
  memberName: string;
  baseCwd: string;
}

export interface TeamMemberWorktreeResolution {
  baseRepoPath: string;
  worktreePath: string;
  branchName: string;
}

interface GitWorktreeEntry {
  worktree: string;
  branch?: string;
}

const GIT_TIMEOUT_MS = 15_000;

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message || 'git command failed').trim();
          reject(new Error(message));
          return;
        }
        resolve(String(stdout).trim());
      }
    );
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

async function realpathIfExists(candidate: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(candidate);
  } catch {
    return null;
  }
}

async function resolveGitPath(cwd: string, raw: string): Promise<string> {
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return (await realpathIfExists(resolved)) ?? resolved;
}

function parseGitWorktreeList(raw: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  for (const line of raw.split(/\r?\n/g)) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ').trim();
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = { worktree: value };
      continue;
    }
    if (key === 'branch' && current) {
      current.branch = value.replace(/^refs\/heads\//, '');
    }
  }

  if (current) entries.push(current);
  return entries;
}

export class TeamMemberWorktreeManager {
  async ensureMemberWorktree(
    request: TeamMemberWorktreeRequest
  ): Promise<TeamMemberWorktreeResolution> {
    const baseRepoPath = await this.resolveBaseRepoPath(request.baseCwd);
    const repoHash = shortHash(baseRepoPath);
    const projectSlug = slugify(path.basename(baseRepoPath));
    const teamSlug = slugify(request.teamName);
    const memberSlug = slugify(request.memberName);
    const branchName = `agent-teams/${teamSlug}/${memberSlug}-${repoHash}`;
    const worktreePath = path.join(
      getAppDataPath(),
      'team-worktrees',
      `${projectSlug}-${repoHash}`,
      teamSlug,
      memberSlug
    );
    const legacyWorktreePath = path.join(
      getClaudeBasePath(),
      'team-worktrees',
      repoHash,
      teamSlug,
      memberSlug
    );

    const existingStat = await fs.promises.stat(worktreePath).catch(() => null);
    if (existingStat) {
      if (!existingStat.isDirectory()) {
        throw new Error(`Worktree path exists but is not a directory: ${worktreePath}`);
      }
      await this.assertExistingWorktreeMatchesRepo(worktreePath, baseRepoPath, branchName);
      return { baseRepoPath, worktreePath, branchName };
    }

    const legacyStat = await fs.promises.stat(legacyWorktreePath).catch(() => null);
    if (legacyStat) {
      if (!legacyStat.isDirectory()) {
        throw new Error(`Worktree path exists but is not a directory: ${legacyWorktreePath}`);
      }
      await this.assertExistingWorktreeMatchesRepo(legacyWorktreePath, baseRepoPath, branchName);
      return { baseRepoPath, worktreePath: legacyWorktreePath, branchName };
    }

    await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
    await this.createWorktree({ baseRepoPath, worktreePath, branchName });
    return { baseRepoPath, worktreePath, branchName };
  }

  private async resolveBaseRepoPath(baseCwd: string): Promise<string> {
    if (!path.isAbsolute(baseCwd)) {
      throw new Error('OpenCode worktree isolation requires an absolute project path.');
    }
    const root = await execGit(['rev-parse', '--show-toplevel'], baseCwd).catch((error) => {
      throw new Error(
        `OpenCode worktree isolation requires a git repository: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    return (await realpathIfExists(root)) ?? root;
  }

  private async assertExistingWorktreeMatchesRepo(
    worktreePath: string,
    baseRepoPath: string,
    branchName: string
  ): Promise<void> {
    const [baseCommonRaw, targetCommonRaw, targetBranchRaw] = await Promise.all([
      execGit(['rev-parse', '--git-common-dir'], baseRepoPath),
      execGit(['rev-parse', '--git-common-dir'], worktreePath),
      execGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath),
    ]);
    const [baseCommon, targetCommon] = await Promise.all([
      resolveGitPath(baseRepoPath, baseCommonRaw),
      resolveGitPath(worktreePath, targetCommonRaw),
    ]);
    if (baseCommon !== targetCommon) {
      throw new Error(`Worktree path belongs to a different git repository: ${worktreePath}`);
    }
    if (targetBranchRaw !== branchName) {
      throw new Error(
        `Worktree path is checked out on "${targetBranchRaw}", expected "${branchName}": ${worktreePath}`
      );
    }
  }

  private async createWorktree(params: {
    baseRepoPath: string;
    worktreePath: string;
    branchName: string;
  }): Promise<void> {
    const branchExists = await execGit(
      ['rev-parse', '--verify', `refs/heads/${params.branchName}`],
      params.baseRepoPath
    )
      .then(() => true)
      .catch(() => false);

    const listRaw = await execGit(['worktree', 'list', '--porcelain'], params.baseRepoPath);
    const branchInUse = parseGitWorktreeList(listRaw).some(
      (entry) => entry.branch === params.branchName
    );
    if (branchInUse) {
      throw new Error(
        `OpenCode worktree branch is already checked out elsewhere: ${params.branchName}`
      );
    }

    if (branchExists) {
      await execGit(
        ['worktree', 'add', params.worktreePath, params.branchName],
        params.baseRepoPath
      );
      return;
    }

    await execGit(
      ['worktree', 'add', '-b', params.branchName, params.worktreePath, 'HEAD'],
      params.baseRepoPath
    );
  }
}
