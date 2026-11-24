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

function historicalWorktreePaths(repoPath: string, teamName: string, memberName: string): string[] {
  const repoHash = shortHash(repoPath);
  const teamSlug = legacySlugify(teamName);
  const memberSlug = legacySlugify(memberName);
  return [
    path.join(getAppDataPath(), 'team-worktrees', `${legacySlugify(path.basename(repoPath))}-${repoHash}`, teamSlug, memberSlug),
    path.join(getClaudeBasePath(), 'team-worktrees', repoHash, teamSlug, memberSlug),
  ];
}

function historicalBranchName(repoPath: string, teamName: string, memberName: string): string {
  return `agent-teams/${legacySlugify(teamName)}/${legacySlugify(memberName)}-${shortHash(repoPath)}`;
}

async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  return execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], repoPath)
    .then(() => true)
    .catch(() => false);
}

function hasLongWorktreeName(teamName: string, memberName: string): boolean {
  return normalizedSlug(teamName).length > 48 || normalizedSlug(memberName).length > 48;
}

export class TeamMemberWorktreeManager {
  private static readonly inFlight = new Map<
    string,
    { existingCwd?: string; sourceRepoPath: string; promise: Promise<TeamMemberWorktreeResolution> }
  >();

  async ensureMemberWorktree(
    request: TeamMemberWorktreeRequest
  ): Promise<TeamMemberWorktreeResolution> {
    if (getManagedGitExecutable() === 'git' && !(await canUseGitWithoutMacInstallerPrompt())) {
      throw new Error('Git is required for worktree isolation but is not installed on this Mac.');
    }
    const { baseRepoPath, sourceRepoPath } = await this.resolveBaseRepoPath(request.baseCwd);
    const key = JSON.stringify([baseRepoPath, request.teamName, request.memberName]);
    const ongoing = TeamMemberWorktreeManager.inFlight.get(key);
    if (ongoing) {
      if (ongoing.existingCwd !== request.existingCwd) {
        throw new Error(`Conflicting concurrent worktree paths for member "${request.memberName}"`);
      }
      const resolved = await ongoing.promise;
      // Short-name historical workspaces are specific to the selected checkout.
      // Check both origins, regardless of which request entered first. Truncated
      // long-name candidates are never eligible for automatic reuse.
      if (
        resolved.worktreePath !== request.existingCwd?.trim() &&
        sourceRepoPath !== ongoing.sourceRepoPath &&
        !hasLongWorktreeName(request.teamName, request.memberName)
      ) {
        const historicalPaths = await Promise.all(
          [sourceRepoPath, ongoing.sourceRepoPath].map(async (checkout) => {
            if (checkout === baseRepoPath) return undefined;
            const candidates = historicalWorktreePaths(checkout, request.teamName, request.memberName);
            for (const candidate of candidates) {
              if (await fs.promises.stat(candidate).catch(() => null)) return candidate;
            }
            // A removed checkout can still own a historical branch with committed work.
            const historicalBranch = historicalBranchName(checkout, request.teamName, request.memberName);
            return (await branchExists(baseRepoPath, historicalBranch)) ? candidates[0] : undefined;
          })
        );
        if (historicalPaths[0] !== historicalPaths[1] ||
            (historicalPaths[0] && historicalPaths[0] !== resolved.worktreePath)) {
          throw new Error(`Conflicting concurrent worktree paths for member "${request.memberName}"`);
        }
      }
      return resolved;
    }
    const pending = this.ensureMemberWorktreeInternal(request, baseRepoPath, sourceRepoPath);
    TeamMemberWorktreeManager.inFlight.set(key, {
      existingCwd: request.existingCwd,
      sourceRepoPath,
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
    request: TeamMemberWorktreeRequest,
    baseRepoPath: string,
    sourceRepoPath: string
  ): Promise<TeamMemberWorktreeResolution> {
    const repoHash = shortHash(baseRepoPath);
    // The repository hash already disambiguates long project directory names.
    const projectSlug = legacySlugify(path.basename(baseRepoPath));
    const teamSlug = slugify(request.teamName);
    const memberSlug = slugify(request.memberName);
    // Reserved '@' cannot be produced by normalizedSlug for either short team or member names.
    const teamPrefix = normalizedSlug(request.teamName).length > 48 ? ['@long-teams'] : [];
    const memberPrefix = normalizedSlug(request.memberName).length > 48 ? ['@long-members'] : [];
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

    const longName = hasLongWorktreeName(request.teamName, request.memberName);
    // Older versions keyed short-name paths by the selected checkout root.
    // Prefer the original linked-project workspace before creating a new one.
    const linkedHistoricalPaths = sourceRepoPath === baseRepoPath
      ? []
      : historicalWorktreePaths(sourceRepoPath, request.teamName, request.memberName);
    const candidates = [
      ...(!longName ? linkedHistoricalPaths : []),
      worktreePath,
      legacyWorktreePath,
    ];
    for (const candidate of candidates) {
      const stat = await fs.promises.stat(candidate).catch(() => null);
      if (!stat) continue;
      if (!stat.isDirectory()) {
        throw new Error(`Worktree path exists but is not a directory: ${candidate}`);
      }
      const currentBranch = await this.validateExistingWorktreeAndGetBranch(
        candidate,
        baseRepoPath,
        request.memberName
      );
      return { baseRepoPath, worktreePath: candidate, branchName: currentBranch };
    }

    // Historical long-name paths were truncated and have no reliable owner identity.
    // Never silently attach a second member to one of those older checkouts.
    if (longName) {
      const oldPaths = [
        ...historicalWorktreePaths(baseRepoPath, request.teamName, request.memberName),
        ...linkedHistoricalPaths,
      ];
      for (const oldPath of oldPaths) {
        if (await fs.promises.stat(oldPath).catch(() => null)) {
          throw new Error(
            `An older worktree with an ambiguous truncated name exists at ${oldPath}. Restore its saved member cwd explicitly before continuing.`
          );
        }
      }
    }

    // A historical linked-project checkout may have been removed manually while
    // its short-name branch still contains committed teammate work.
    let target = { worktreePath, branchName };
    const [historicalPath] = linkedHistoricalPaths;
    if (!longName && historicalPath) {
      const historicalBranch = historicalBranchName(sourceRepoPath, request.teamName, request.memberName);
      if (await branchExists(baseRepoPath, historicalBranch)) {
        target = {
          worktreePath: existingCwd && linkedHistoricalPaths.includes(existingCwd) ? existingCwd : historicalPath,
          branchName: historicalBranch,
        };
      }
    }

    await fs.promises.mkdir(path.dirname(target.worktreePath), { recursive: true });
    await this.createWorktree({ baseRepoPath, sourceCwd: request.baseCwd, ...target });
    return { baseRepoPath, ...target };
  }

  private async resolveBaseRepoPath(baseCwd: string): Promise<{ baseRepoPath: string; sourceRepoPath: string }> {
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
    // The caller may be a saved member worktree after restart, rather than the
    // original project checkout. Git lists the primary checkout first; use it
    // to keep repository identity stable and avoid rejecting this linked worktree
    // as its own base. Do not move, reset, or modify any checkout.
    const listed = parseGitWorktreeList(await execGit(['worktree', 'list', '--porcelain'], root));
    const primaryCheckout = listed[0]?.worktree;
    if (!primaryCheckout) {
      throw new Error(`OpenCode worktree isolation could not find the main checkout: ${baseCwd}`);
    }
    return {
      baseRepoPath: (await realpathIfExists(primaryCheckout)) ?? path.resolve(primaryCheckout),
      sourceRepoPath: (await realpathIfExists(root)) ?? path.resolve(root),
    };
  }

  private async validateExistingWorktreeAndGetBranch(
    worktreePath: string,
    baseRepoPath: string,
    memberName: string
  ): Promise<string> {
    const [
      baseCommonRaw,
      targetCommonRaw,
      targetGitDirRaw,
      targetBranchRaw,
      targetRootRaw,
      listedRaw,
    ] = await Promise.all([
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
    sourceCwd: string;
    worktreePath: string;
    branchName: string;
  }): Promise<void> {
    const existingBranch = await branchExists(params.baseRepoPath, params.branchName);

    const listRaw = await execGit(['worktree', 'list', '--porcelain'], params.baseRepoPath);
    const branchInUse = parseGitWorktreeList(listRaw).some(
      (entry) => entry.branch === params.branchName
    );
    if (branchInUse) {
      throw new Error(
        `OpenCode worktree branch is already checked out elsewhere: ${params.branchName}`
      );
    }

    if (existingBranch) {
      await execGit(
        ['worktree', 'add', params.worktreePath, params.branchName],
        params.baseRepoPath
      );
      return;
    }

    // Repository identity comes from the primary checkout, but a newly created
    // teammate must start at the selected project's commit (possibly a linked
    // checkout at a different HEAD). Pin the SHA to avoid switching branches.
    const sourceHead = await execGit(['rev-parse', 'HEAD'], params.sourceCwd);
    await execGit(
      ['worktree', 'add', '-b', params.branchName, params.worktreePath, sourceHead],
      params.baseRepoPath
    );
  }
}
