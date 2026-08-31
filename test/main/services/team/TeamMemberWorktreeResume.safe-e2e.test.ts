import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultTeamProvisioningPrepareCoordinatorPorts,
  TeamProvisioningPrepareCoordinator,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningPrepareCoordinator';
import { TeamMemberWorktreeManager } from '../../../../src/main/services/team/TeamMemberWorktreeManager';

import type { TeamCreateRequest } from '../../../../src/shared/types';

const roots = vi.hoisted(() => ({ appData: '', claude: '' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getAppDataPath: () => roots.appData,
  getClaudeBasePath: () => roots.claude,
}));

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

// Exercises real workspace preflight and Git only, never launches a provider/model.
describe('managed worktree resume through runtime workspace preflight', () => {
  let tempRoot = '';
  let repoPath = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-resume-safe-e2e-'));
    roots.appData = path.join(tempRoot, 'app-data');
    roots.claude = path.join(tempRoot, 'claude');
    repoPath = path.join(tempRoot, 'repo');
    await fs.mkdir(repoPath);
    repoPath = await fs.realpath(repoPath);
    await git(repoPath, 'init');
    await fs.writeFile(path.join(repoPath, 'README.md'), 'initial\n');
    await git(repoPath, 'add', 'README.md');
    await git(
      repoPath,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'init'
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rediscovers a changed branch after roster save and leaves shared workspaces untouched', async () => {
    const manager = new TeamMemberWorktreeManager();
    const coordinator = new TeamProvisioningPrepareCoordinator(
      createDefaultTeamProvisioningPrepareCoordinatorPorts({
        ensureMemberWorktree: (input) => manager.ensureMemberWorktree(input),
        execCli: async () => {
          throw new Error('Provider execution is forbidden in this test');
        },
        resolveClaudeBinaryPath: async () => {
          throw new Error('Provider discovery is forbidden in this test');
        },
      })
    );
    const roster: TeamCreateRequest['members'] = [
      { name: 'bob', providerId: 'opencode', isolation: 'worktree' },
      { name: 'alice', providerId: 'codex', cwd: repoPath },
      { name: 'carol', providerId: 'opencode' },
    ];
    const resolve = (members: TeamCreateRequest['members']) =>
      coordinator.resolveOpenCodeMemberWorkspacesForRuntime({
        teamName: 'resume-test',
        baseCwd: repoPath,
        leadProviderId: 'codex',
        members,
      });
    const initial = await resolve(roster);
    const worktreePath = initial[0].cwd!;
    expect(worktreePath).toContain('team-worktrees');
    expect(worktreePath).not.toBe(repoPath);
    expect(await git(worktreePath, 'branch', '--show-current')).toMatch(
      /^agent-teams\/resume-test\/bob-/
    );
    await git(worktreePath, 'switch', '-c', 'm0merge');
    await fs.writeFile(path.join(worktreePath, 'README.md'), 'staged\n');
    await git(worktreePath, 'add', 'README.md');
    await fs.writeFile(path.join(worktreePath, 'README.md'), 'unstaged\n');
    await fs.writeFile(path.join(worktreePath, 'notes.txt'), 'keep me\n');
    const head = await git(worktreePath, 'rev-parse', 'HEAD');
    const staged = await git(worktreePath, 'diff', '--cached');
    const unstaged = await git(worktreePath, 'diff');
    const status = await git(worktreePath, 'status', '--porcelain');

    // replaceMembers persists the editable roster without a prior member cwd.
    const resumed = await resolve(roster);
    expect(resumed[0].cwd).toBe(worktreePath);
    expect(resumed.slice(1)).toEqual(roster.slice(1));
    expect(roster[0].cwd).toBeUndefined();

    // Turning isolation off must not reuse or modify the old worktree.
    const withoutIsolation: TeamCreateRequest['members'] = roster.map((member) =>
      member.name === 'bob' ? { name: member.name, providerId: member.providerId } : member
    );
    expect(await resolve(withoutIsolation)).toEqual(withoutIsolation);
    expect(await git(worktreePath, 'branch', '--show-current')).toBe('m0merge');
    expect(await git(worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(worktreePath, 'diff', '--cached')).toBe(staged);
    expect(await git(worktreePath, 'diff')).toBe(unstaged);
    expect(await git(worktreePath, 'status', '--porcelain')).toBe(status);
    expect(await fs.readFile(path.join(worktreePath, 'notes.txt'), 'utf8')).toBe('keep me\n');
    expect(await git(repoPath, 'status', '--porcelain')).toBe('');
  });
});
