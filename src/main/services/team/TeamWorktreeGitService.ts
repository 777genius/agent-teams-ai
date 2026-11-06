import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { TeamWorktreeGitStatus } from '@shared/types';

const GIT_TIMEOUT_MS = 20_000;

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

/**
 * Apple's /usr/bin/git is an installer shim when Xcode/Command Line Tools
 * are missing. Do not execute it during passive worktree readiness checks:
 * on macOS that opens a system-wide installation dialog on every call.
 */
export async function canUseGitWithoutMacInstallerPrompt(
  platform: NodeJS.Platform = process.platform,
  searchPath: string = process.env.PATH ?? ''
): Promise<boolean> {
  if (platform !== 'darwin') return true;

  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'git');
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }

    const executable = await fs.promises.realpath(candidate).catch(() => candidate);
    if (executable !== '/usr/bin/git') return true;

    // xcode-select --print-path does NOT launch the CLT installer.
    const developerDirectory = await new Promise<string | null>((resolve) => {
      execFile('/usr/bin/xcode-select', ['--print-path'], { timeout: 1_000 }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim() || null);
      });
    });
    if (!developerDirectory || !path.isAbsolute(developerDirectory)) return false;
    return fs.promises
      .access(path.join(developerDirectory, 'usr/bin', 'git'), fs.constants.X_OK)
      .then(
        () => true,
        () => false
      );
  }
  return false;
}

function normalizeGitError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitUnavailable(error: unknown): boolean {
  const message = normalizeGitError(error).toLowerCase();
  return message.includes('enoent') || message.includes('git: command not found');
}

async function assertUsableDirectory(projectPath: string): Promise<string> {
  const trimmed = projectPath.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error('Project path must be an absolute directory path.');
  }
  const stat = await fs.promises.stat(trimmed).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Project path is not a directory: ${trimmed}`);
  }
  return await fs.promises.realpath(trimmed).catch(() => trimmed);
}

function blockedStatus(
  projectPath: string,
  reason: NonNullable<TeamWorktreeGitStatus['reason']>,
  message: string,
  overrides: Partial<TeamWorktreeGitStatus> = {}
): TeamWorktreeGitStatus {
  return {
    projectPath,
    isGitRepo: false,
    hasHead: false,
    canUseWorktrees: false,
    reason,
    message,
    ...overrides,
  };
}

export class TeamWorktreeGitService {
  async getStatus(projectPath: string): Promise<TeamWorktreeGitStatus> {
    let cwd: string;
    try {
      cwd = await assertUsableDirectory(projectPath);
    } catch (error) {
      return blockedStatus(projectPath.trim(), 'invalid_project_path', normalizeGitError(error));
    }

    if (!(await canUseGitWithoutMacInstallerPrompt())) {
      return blockedStatus(
        cwd,
        'git_unavailable',
        'Git is required only for worktree isolation. Install Git to enable it.'
      );
    }

    let rootPath: string;
    try {
      const rootRaw = await execGit(['rev-parse', '--show-toplevel'], cwd);
      rootPath = await fs.promises.realpath(rootRaw).catch(() => rootRaw);
    } catch (error) {
      if (isGitUnavailable(error)) {
        return blockedStatus(cwd, 'git_unavailable', 'Git is not available on this machine.');
      }
      return blockedStatus(
        cwd,
        'not_git_repo',
        'Worktree isolation requires a Git repository. This project is not a Git repo yet.'
      );
    }

    const hasHead = await execGit(['rev-parse', '--verify', 'HEAD'], cwd)
      .then(() => true)
      .catch(() => false);
    const branch = await execGit(['branch', '--show-current'], cwd)
      .then((value) => value || undefined)
      .catch(() => undefined);

    if (!hasHead) {
      return blockedStatus(
        cwd,
        'missing_head',
        'Create an initial commit before using worktrees. We will not commit files automatically.',
        {
          isGitRepo: true,
          rootPath,
          branch,
        }
      );
    }

    return {
      projectPath: cwd,
      isGitRepo: true,
      hasHead: true,
      canUseWorktrees: true,
      rootPath,
      branch,
    };
  }

  async initializeRepository(projectPath: string): Promise<TeamWorktreeGitStatus> {
    const current = await this.getStatus(projectPath);
    if (current.isGitRepo) {
      return current;
    }
    if (current.reason !== 'not_git_repo') {
      return current;
    }

    const cwd = await assertUsableDirectory(projectPath);
    await execGit(['init'], cwd);
    return this.getStatus(cwd);
  }

  async createInitialCommit(projectPath: string): Promise<TeamWorktreeGitStatus> {
    const current = await this.getStatus(projectPath);
    if (!current.isGitRepo || !current.rootPath) {
      return current;
    }
    if (current.hasHead) {
      return current;
    }

    await execGit(['add', '-A'], current.rootPath);
    await execGit(
      [
        '-c',
        'user.name=Agent Teams',
        '-c',
        'user.email=agent-teams@local',
        'commit',
        '--allow-empty',
        '-m',
        'chore: initial commit',
      ],
      current.rootPath
    );
    return this.getStatus(current.rootPath);
  }
}
