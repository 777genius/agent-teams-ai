import { canUseGitWithoutMacInstallerPrompt } from '@main/utils/gitAvailability';
import { createManagedGitEnv, getManagedGitExecutable } from '@main/utils/managedGit';
import { getAppDataPath, getClaudeBasePath } from '@main/utils/pathDecoder';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface TeamMemberWorktreeRequest {
  teamName: string;
  memberName: string;
  baseCwd: string;
  /** Previously persisted runtime workspace; validate before reuse. */
  existingCwd?: string;
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
      getManagedGitExecutable(),
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, env: createManagedGitEnv(process.env, { gitCommand: true }) },
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

function normalizedSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'member'
  );
}

function slugify(value: string): string {
  const full = normalizedSlug(value);
  return full.length <= 48 ? full : `${full.slice(0, 37)}-${shortHash(full)}`;
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
  private static readonly inFlight = new Map<
    string,
    { existingCwd?: string; promise: Promise<TeamMemberWorktreeResolution> }
  >();

  async ensureMemberWorktree(
    request: TeamMemberWorktreeRequest
  ): Promise<TeamMemberWorktreeResolution> {
    const key = JSON.stringify([request.baseCwd, request.teamName, request.memberName]);
    const ongoing = TeamMemberWorktreeManager.inFlight.get(key);
    if (ongoing) {
      if (ongoing.existingCwd !== request.existingCwd) {
        throw new Error(`Conflicting concurrent worktree paths for member "${request.memberName}"`);
      }
      return ongoing.promise;
    }
    const pending = this.ensureMemberWorktreeInternal(request);
    TeamMemberWorktreeManager.inFlight.set(key, {
      existingCwd: request.existingCwd,
      promise: pending,
    });
    try {
      return await pending;
    } finally {
      if (TeamMemberWorktreeManager.inFlight.get(key)?.promise === pending) {
        TeamMemberWorktreeManager.inFlight.delete(key);
      }
    }
  }

  private async ensureMemberWorktreeInternal(
    request: TeamMemberWorktreeRequest
  ): Promise<TeamMemberWorktreeResolution> {
    if (getManagedGitExecutable() === 'git' && !(await canUseGitWithoutMacInstallerPrompt())) {
      throw new Error('Git is required for worktree isolation but is not installed on this Mac.');
    }
    const baseRepoPath = await this.resolveBaseRepoPath(request.baseCwd);
    const repoHash = shortHash(baseRepoPath);
    // The repository hash already disambiguates long project directory names.
    const projectSlug = legacySlugify(path.basename(baseRepoPath));
    const teamSlug = slugify(request.teamName);
    const memberSlug = slugify(request.memberName);
    // Extra path/ref segments make long-name IDs disjoint from every old short-name ID.
    const teamPrefix = normalizedSlug(request.teamName).length > 48 ? ['_long-teams'] : [];
    const memberPrefix = normalizedSlug(request.memberName).length > 48 ? ['_long-members'] : [];
    const branchName = [
      'agent-teams',
      ...teamPrefix,
      teamSlug,
      ...memberPrefix,
      `${memberSlug}-${repoHash}`,
    ].join('/');
    const worktreePath = path.join(
      getAppDataPath(),
      'team-worktrees',
      `${projectSlug}-${repoHash}`,
      ...teamPrefix,
      teamSlug,
      ...memberPrefix,
      memberSlug
    );
    const legacyWorktreePath = path.join(
      getClaudeBasePath(),
      'team-worktrees',
      repoHash,
      ...teamPrefix,
      teamSlug,
      ...memberPrefix,
      memberSlug
    );

    const existingCwd = request.existingCwd?.trim();
    if (existingCwd) {
      if (!path.isAbsolute(existingCwd)) {
        throw new Error(
          `Worktree path for member "${request.memberName}" must be absolute: ${existingCwd}`
        );
      }
      const existingCwdStat = await fs.promises.stat(existingCwd).catch(() => null);
      if (existingCwdStat) {
        if (!existingCwdStat.isDirectory()) {
          throw new Error(`Worktree path exists but is not a directory: ${existingCwd}`);
        }
        const branch = await this.validateExistingWorktreeAndGetBranch(
          existingCwd,
          baseRepoPath,
          request.memberName
        );
        return { baseRepoPath, worktreePath: existingCwd, branchName: branch };
      }
    }

    const existingStat = await fs.promises.stat(worktreePath).catch(() => null);
    if (existingStat) {
      if (!existingStat.isDirectory()) {
        throw new Error(`Worktree path exists but is not a directory: ${worktreePath}`);
      }
      const currentBranch = await this.validateExistingWorktreeAndGetBranch(
        worktreePath,
        baseRepoPath,
        request.memberName
      );
      return { baseRepoPath, worktreePath, branchName: currentBranch };
    }

    const legacyStat = await fs.promises.stat(legacyWorktreePath).catch(() => null);
    if (legacyStat) {
      if (!legacyStat.isDirectory()) {
        throw new Error(`Worktree path exists but is not a directory: ${legacyWorktreePath}`);
      }
      const currentBranch = await this.validateExistingWorktreeAndGetBranch(
        legacyWorktreePath,
        baseRepoPath,
        request.memberName
      );
      return { baseRepoPath, worktreePath: legacyWorktreePath, branchName: currentBranch };
    }

    // Historical long-name paths were truncated and have no reliable owner identity.
    // Never silently attach a second member to one of those older checkouts.
    const oldTeamSlug = legacySlugify(request.teamName);
    const oldMemberSlug = legacySlugify(request.memberName);
    if (teamPrefix.length > 0 || memberPrefix.length > 0) {
      const oldPaths = [
        path.join(
          getAppDataPath(),
          'team-worktrees',
          `${projectSlug}-${repoHash}`,
          oldTeamSlug,
          oldMemberSlug
        ),
        path.join(getClaudeBasePath(), 'team-worktrees', repoHash, oldTeamSlug, oldMemberSlug),
      ];
      for (const oldPath of oldPaths) {
        if (await fs.promises.stat(oldPath).catch(() => null)) {
          throw new Error(
            `An older worktree with an ambiguous truncated name exists at ${oldPath}. Restore its saved member cwd explicitly before continuing.`
          );
        }
      }
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

  private async validateExistingWorktreeAndGetBranch(
    worktreePath: string,
    baseRepoPath: string,
    memberName: string
  ): Promise<string> {
    const [baseCommonRaw, targetCommonRaw, targetGitDirRaw, targetBranchRaw, targetRootRaw, listedRaw] =
      await Promise.all([
        execGit(['rev-parse', '--git-common-dir'], baseRepoPath),
        execGit(['rev-parse', '--git-common-dir'], worktreePath),
        execGit(['rev-parse', '--git-dir'], worktreePath),
        execGit(['branch', '--show-current'], worktreePath),
        execGit(['rev-parse', '--show-toplevel'], worktreePath),
        execGit(['worktree', 'list', '--porcelain'], baseRepoPath),
      ]);
    const [baseCommon, targetCommon, targetGitDir] = await Promise.all([
      resolveGitPath(baseRepoPath, baseCommonRaw),
      resolveGitPath(worktreePath, targetCommonRaw),
      resolveGitPath(worktreePath, targetGitDirRaw),
    ]);
    if (baseCommon !== targetCommon) {
      throw new Error(`Worktree path belongs to a different git repository: ${worktreePath}`);
    }
    const [canonicalPath, canonicalRoot] = await Promise.all([
      fs.promises.realpath(worktreePath),
      resolveGitPath(worktreePath, targetRootRaw),
    ]);
    if (
      canonicalRoot !== canonicalPath ||
      canonicalPath === baseRepoPath ||
      targetGitDir === targetCommon
    ) {
      throw new Error(`Worktree path is not a separate checkout root: ${worktreePath}`);
    }
    const listedPaths = await Promise.all(
      parseGitWorktreeList(listedRaw).map((entry) => resolveGitPath(baseRepoPath, entry.worktree))
    );
    if (!listedPaths.includes(canonicalPath)) {
      throw new Error(`Worktree path is not registered by git worktree list: ${worktreePath}`);
    }
    if (!targetBranchRaw) {
      throw new Error(
        `Worktree path for member "${memberName}" has a detached HEAD. Check out a branch before continuing: ${worktreePath}`
      );
    }
    // An existing teammate worktree may have moved to a task branch; preserve it as-is.
    return targetBranchRaw;
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
