import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  constants,
  openSync,
  closeSync,
  fstatSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { LaunchWorktreeError } from '../../team-launch/worktreeContracts.js';
import type {
  LaunchWorktreePlan,
  LaunchWorktreePort,
  OwnedWorktreeBinding,
  WorktreeGitStatus,
  WorktreePathIdentity,
  WorktreeProof,
} from '../../team-launch/worktreeContracts.js';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function identity(path: string): WorktreePathIdentity {
  const value = lstatSync(path);
  if (!value.isDirectory() || value.isSymbolicLink() || realpathSync(path) !== path) {
    throw new LaunchWorktreeError('directory-identity-invalid');
  }
  return { path, device: value.dev, inode: value.ino };
}
function same(a: WorktreePathIdentity, b: WorktreePathIdentity): boolean {
  return a.path === b.path && a.device === b.device && a.inode === b.inode;
}
function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // A parent CLI's repository overrides must never redirect this owner's explicit -C target.
    for (const key of Object.keys(env))
      if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
    execFile(
      'git',
      ['--no-optional-locks', '-C', cwd, ...args],
      {
        encoding: 'buffer',
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
        env,
      },
      (error, stdout) => {
        if (error)
          reject(
            new LaunchWorktreeError(
              error.code === 'ENOENT' ? 'git-unavailable' : 'git-command-failed'
            )
          );
        else resolveResult(stdout);
      }
    );
  });
}
async function text(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).toString('utf8').trim();
}
async function commonDirectory(cwd: string): Promise<WorktreePathIdentity> {
  return identity(
    realpathSync(await text(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  );
}
function ownedName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'worktree'
  );
}

/** Host-private Git mechanism. The injected directory belongs to this Host owner, never appData. */
export class HostWorktreeGit implements LaunchWorktreePort {
  private readonly root: WorktreePathIdentity;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new LaunchWorktreeError('owned-root-not-absolute');
    this.root = identity(resolve(root));
  }
  digest(plan: LaunchWorktreePlan): string {
    return digest(plan);
  }

  async getStatus(projectPath: string): Promise<WorktreeGitStatus> {
    const blocked = (
      path: string,
      reason: WorktreeGitStatus['reason'],
      message: string
    ): WorktreeGitStatus => ({
      projectPath: path,
      isGitRepo: false,
      hasHead: false,
      canUseWorktrees: false,
      ...(reason ? { reason } : {}),
      message,
    });
    let cwd: string;
    try {
      if (!isAbsolute(projectPath.trim())) throw new Error('relative path');
      cwd = realpathSync(projectPath.trim());
      identity(cwd);
    } catch {
      return blocked(
        projectPath.trim(),
        'invalid_project_path',
        'Project path must be an absolute directory path.'
      );
    }
    let rootPath: string;
    try {
      rootPath = realpathSync(await text(cwd, ['rev-parse', '--show-toplevel']));
    } catch (error) {
      return error instanceof LaunchWorktreeError && error.reason === 'git-unavailable'
        ? blocked(cwd, 'git_unavailable', 'Git is not available on this machine.')
        : blocked(
            cwd,
            'not_git_repo',
            'Worktree isolation requires a Git repository. This project is not a Git repo yet.'
          );
    }
    const hasHead = await text(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).then(
      () => true,
      () => false
    );
    const branch = await text(cwd, ['branch', '--show-current']).catch(() => '');
    return {
      projectPath: cwd,
      isGitRepo: true,
      hasHead,
      canUseWorktrees: hasHead,
      rootPath,
      ...(branch ? { branch } : {}),
      ...(!hasHead
        ? {
            reason: 'missing_head' as const,
            message:
              'Create an initial commit before using worktrees. We will not commit files automatically.',
          }
        : {}),
    };
  }

  async plan(input: {
    baseCwd: string;
    teamId: string;
    slot: { kind: 'named' | 'member'; name: string };
    previous?: OwnedWorktreeBinding;
  }): Promise<LaunchWorktreePlan> {
    if (!isAbsolute(input.baseCwd) || !input.teamId || !input.slot.name.trim()) {
      throw new LaunchWorktreeError('worktree-input-invalid');
    }
    const repository = identity(
      realpathSync(await text(input.baseCwd, ['rev-parse', '--show-toplevel']))
    );
    const common = await commonDirectory(repository.path);
    const slotId = digest({ common, teamId: input.teamId, slot: input.slot });
    const targetPath = join(this.root.path, `${ownedName(input.slot.name)}-${slotId.slice(0, 20)}`);
    const branch = `agent-teams/${ownedName(input.teamId)}/${input.slot.kind}-${slotId.slice(0, 24)}`;
    const capturedCommit = await text(repository.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const plan: LaunchWorktreePlan = {
      version: 1,
      slotId,
      repository,
      commonDirectory: common,
      targetPath,
      branch,
      capturedCommit,
      proof: { head: capturedCommit, dirtyDigest: digest(['', '', []]) },
    };
    if (input.previous) {
      if (
        input.previous.slotId !== slotId ||
        input.previous.target.path !== targetPath ||
        !same(input.previous.commonDirectory, common)
      ) {
        throw new LaunchWorktreeError('previous-owned-slot-mismatch');
      }
      plan.reuse = input.previous;
      plan.branch = input.previous.branch;
      plan.proof = await this.inspect(plan, input.previous);
    } else {
      await this.assertUnclaimed(plan);
    }
    return plan;
  }

  reserve(plan: LaunchWorktreePlan): WorktreePathIdentity {
    this.assertPlanPath(plan);
    if (existsSync(plan.targetPath)) throw new LaunchWorktreeError('unrecorded-target-exists');
    mkdirSync(plan.targetPath, { mode: 0o700 });
    return identity(plan.targetPath);
  }

  async create(
    plan: LaunchWorktreePlan,
    target: WorktreePathIdentity,
    assertCurrent: () => void
  ): Promise<OwnedWorktreeBinding> {
    this.assertPlanPath(plan);
    await this.assertRepository(plan);
    if (
      target.path !== plan.targetPath ||
      !same(identity(target.path), target) ||
      readdirSync(target.path).length
    ) {
      throw new LaunchWorktreeError('reserved-target-changed');
    }
    await this.assertUnclaimed(plan, true);
    assertCurrent();
    await git(plan.repository.path, [
      'worktree',
      'add',
      '-b',
      plan.branch,
      target.path,
      plan.capturedCommit,
    ]);
    const binding = {
      slotId: plan.slotId,
      target,
      commonDirectory: plan.commonDirectory,
      branch: plan.branch,
      createdCommit: plan.capturedCommit,
    };
    const proof = await this.inspect(plan, binding);
    if (proof.head !== plan.capturedCommit || proof.dirtyDigest !== plan.proof.dirtyDigest)
      throw new LaunchWorktreeError('created-workspace-mismatch');
    return binding;
  }

  async inspect(plan: LaunchWorktreePlan, binding: OwnedWorktreeBinding): Promise<WorktreeProof> {
    this.assertPlanPath(plan);
    await this.assertRepository(plan);
    if (
      binding.slotId !== plan.slotId ||
      binding.target.path !== plan.targetPath ||
      !same(identity(binding.target.path), binding.target) ||
      !same(binding.commonDirectory, plan.commonDirectory) ||
      !same(await commonDirectory(binding.target.path), binding.commonDirectory)
    ) {
      throw new LaunchWorktreeError('owned-worktree-identity-changed');
    }
    const branch = await text(binding.target.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch !== binding.branch || branch !== plan.branch)
      throw new LaunchWorktreeError('owned-branch-changed');
    const entries = await this.worktrees(plan.repository.path);
    if (
      !entries.some(
        (entry) => entry.path === binding.target.path && entry.branch === `refs/heads/${branch}`
      )
    ) {
      throw new LaunchWorktreeError('worktree-registration-changed');
    }
    return this.proof(binding.target.path);
  }

  private async proof(cwd: string): Promise<WorktreeProof> {
    const head = await text(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const diff = await git(cwd, [
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
    ]);
    const paths = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort();
    const untracked: [string, number, string][] = [];
    for (const path of paths) {
      const absolute = resolve(cwd, path);
      if (relative(cwd, absolute).startsWith(`..${sep}`) || !absolute.startsWith(`${cwd}${sep}`)) {
        throw new LaunchWorktreeError('untracked-path-invalid');
      }
      const stat = lstatSync(absolute);
      const hash = createHash('sha256');
      if (stat.isSymbolicLink()) hash.update(readlinkSync(absolute));
      else if (stat.isFile()) {
        const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(fd);
          if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size)
            throw new LaunchWorktreeError('workspace-file-changed');
          if (before.size) {
            for await (const bytes of createReadStream(absolute, {
              fd,
              autoClose: false,
              start: 0,
              end: before.size - 1,
            }))
              hash.update(bytes);
          }
          const after = fstatSync(fd),
            current = lstatSync(absolute);
          if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            current.isSymbolicLink()
          )
            throw new LaunchWorktreeError('workspace-file-changed');
        } finally {
          closeSync(fd);
        }
      } else throw new LaunchWorktreeError('untracked-file-kind-unsupported');
      untracked.push([path, stat.mode, hash.digest('hex')]);
    }
    return {
      head,
      dirtyDigest: digest([status.toString('base64'), diff.toString('base64'), untracked]),
    };
  }

  private assertPlanPath(plan: LaunchWorktreePlan): void {
    if (
      !same(identity(this.root.path), this.root) ||
      resolve(plan.targetPath, '..') !== this.root.path ||
      !/^[a-f0-9]{64}$/.test(plan.slotId)
    ) {
      throw new LaunchWorktreeError('owned-target-path-invalid');
    }
  }
  private async assertRepository(plan: LaunchWorktreePlan): Promise<void> {
    if (
      !same(identity(plan.repository.path), plan.repository) ||
      !same(await commonDirectory(plan.repository.path), plan.commonDirectory)
    ) {
      throw new LaunchWorktreeError('repository-identity-changed');
    }
  }
  private async assertUnclaimed(plan: LaunchWorktreePlan, reserved = false): Promise<void> {
    this.assertPlanPath(plan);
    const entries = await this.worktrees(plan.repository.path);
    const refs = await text(plan.repository.path, [
      'for-each-ref',
      '--format=%(refname)',
      `refs/heads/${plan.branch}`,
    ]);
    if (
      (!reserved && existsSync(plan.targetPath)) ||
      refs ||
      entries.some((entry) => entry.path === plan.targetPath)
    ) {
      throw new LaunchWorktreeError('unrecorded-worktree-or-branch-exists');
    }
  }
  private async worktrees(cwd: string): Promise<{ path: string; branch?: string }[]> {
    const fields = (await git(cwd, ['worktree', 'list', '--porcelain', '-z']))
      .toString('utf8')
      .split('\0');
    const entries: { path: string; branch?: string }[] = [];
    let entry: { path: string; branch?: string } | undefined;
    for (const field of fields) {
      if (field.startsWith('worktree ')) {
        entry = { path: field.slice(9) };
        entries.push(entry);
      } else if (field.startsWith('branch ') && entry) entry.branch = field.slice(7);
    }
    return entries;
  }
}
