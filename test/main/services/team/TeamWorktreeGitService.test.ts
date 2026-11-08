import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as managedGit from '../../../../src/main/utils/managedGit';
import { TeamWorktreeGitService } from '../../../../src/main/services/team/TeamWorktreeGitService';

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

describe('TeamWorktreeGitService', () => {
  let tempRoot = '';
  let projectPath = '';
  let service: TeamWorktreeGitService;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-worktree-git-'));
    projectPath = path.join(tempRoot, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'README.md'), 'hello\n', 'utf8');
    service = new TeamWorktreeGitService();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('reports non-git projects as blocked but initializable', async () => {
    await expect(service.getStatus(projectPath)).resolves.toMatchObject({
      isGitRepo: false,
      hasHead: false,
      canUseWorktrees: false,
      reason: 'not_git_repo',
    });
  });

  it('reports invalid packaged Git as unavailable instead of rejecting', async () => {
    const resolver = vi.spyOn(managedGit, 'getManagedGitExecutable').mockImplementation(() => {
      throw new Error('Agent Teams bundled Git is missing or invalid');
    });
    try {
      await expect(service.getStatus(projectPath)).resolves.toMatchObject({
        reason: 'git_unavailable',
        canUseWorktrees: false,
      });
    } finally {
      resolver.mockRestore();
    }
  });

  it('initializes git without silently creating a commit', async () => {
    await expect(service.initializeRepository(projectPath)).resolves.toMatchObject({
      isGitRepo: true,
      hasHead: false,
      canUseWorktrees: false,
      reason: 'missing_head',
    });
  });

  it('creates an explicit initial commit for all current files', async () => {
    await service.initializeRepository(projectPath);

    await expect(service.createInitialCommit(projectPath)).resolves.toMatchObject({
      isGitRepo: true,
      hasHead: true,
      canUseWorktrees: true,
    });
    await expect(execGit(['log', '--format=%s', '-1'], projectPath)).resolves.toBe(
      'chore: initial commit'
    );
    await expect(execGit(['ls-files'], projectPath)).resolves.toContain('README.md');
  });
});
