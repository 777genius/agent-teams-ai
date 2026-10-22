// @vitest-environment node
import {
  cleanupAnthropicTeamApiKeyHelperForTeam,
  cleanupAnthropicTeamApiKeyHelperMaterial,
  cleanupStaleAnthropicTeamApiKeyHelpers,
  materializeAnthropicTeamApiKeyHelper,
} from '@main/services/runtime/anthropicTeamApiKeyHelper';
import { cleanupRunOwnedAnthropicApiKeyHelper } from '@main/services/team/provisioning/TeamProvisioningAnthropicApiKeyHelperLease';
import childProcess from 'child_process';
import fs from 'fs';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const credentialField = ['api', 'Key'].join('');

function buildCredential(...parts: string[]): string {
  return ['test-only', ...parts, 'value'].join('-');
}

function materializeFixture(
  options: { teamName: string; authMaterialId: string; baseClaudeDir: string },
  credential: string
) {
  return materializeAnthropicTeamApiKeyHelper({
    ...options,
    [credentialField]: credential,
  } as Parameters<typeof materializeAnthropicTeamApiKeyHelper>[0]);
}

describe('anthropicTeamApiKeyHelper cleanup failures', () => {
  const tempRoots: string[] = [];

  async function createTempRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'anthropic-team-helper-cleanup-'));
    tempRoots.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('treats an already-missing helper directory as successful cleanup', async () => {
    const root = await createTempRoot();
    const missingDirectory = path.join(root, 'already-removed');

    await expect(
      cleanupAnthropicTeamApiKeyHelperMaterial({ directory: missingDirectory })
    ).resolves.toBeUndefined();
  });

  it('reports helper-directory read failures', async () => {
    const root = await createTempRoot();
    const material = await materializeFixture(
      {
        teamName: 'read failure team',
        authMaterialId: 'run-read-failure',
        baseClaudeDir: root,
      },
      buildCredential('read-failure')
    );
    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(readError);

    await expect(
      cleanupAnthropicTeamApiKeyHelperMaterial({ directory: material.directory })
    ).rejects.toBe(readError);
    await expect(stat(material.directory)).resolves.toBeDefined();
  });

  it('retains run ownership after a production remove failure and succeeds on retry', async () => {
    const root = await createTempRoot();
    const credential = buildCredential('remove-failure');
    const material = await materializeFixture(
      {
        teamName: 'remove failure team',
        authMaterialId: 'run-remove-failure',
        baseClaudeDir: root,
      },
      credential
    );
    const run = {
      anthropicApiKeyHelper: material,
      anthropicApiKeyHelperCleanupPromise: null,
    };
    const removeError = Object.assign(new Error('remove permission denied'), { code: 'EACCES' });
    const removeSpy = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(removeError);

    const firstCleanup = cleanupRunOwnedAnthropicApiKeyHelper(run);
    await expect(firstCleanup).rejects.toBe(removeError);
    expect(String(removeError)).not.toContain(credential);
    expect(run.anthropicApiKeyHelper).toBe(material);

    removeSpy.mockRestore();
    await cleanupRunOwnedAnthropicApiKeyHelper(run);

    expect(run.anthropicApiKeyHelper).toBeNull();
    await expect(stat(material.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports rmdir failure and allows idempotent cleanup retry', async () => {
    const root = await createTempRoot();
    const material = await materializeFixture(
      {
        teamName: 'rmdir failure team',
        authMaterialId: 'run-rmdir-failure',
        baseClaudeDir: root,
      },
      buildCredential('rmdir-failure')
    );
    const rmdirError = Object.assign(new Error('rmdir permission denied'), { code: 'EACCES' });
    const rmdirSpy = vi.spyOn(fs.promises, 'rmdir').mockRejectedValueOnce(rmdirError);

    await expect(
      cleanupAnthropicTeamApiKeyHelperMaterial({ directory: material.directory })
    ).rejects.toBe(rmdirError);
    await expect(stat(material.directory)).resolves.toBeDefined();

    rmdirSpy.mockRestore();
    await cleanupAnthropicTeamApiKeyHelperMaterial({ directory: material.directory });
    await expect(stat(material.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves foreign contents and symlinks while continuing the stale sweep', async () => {
    if (process.platform === 'win32') return;
    const root = await createTempRoot();
    const material = await materializeFixture(
      { teamName: 'foreign contents', authMaterialId: 'run-a', baseClaudeDir: root },
      buildCredential('foreign')
    );
    const otherMaterial = await materializeFixture(
      { teamName: 'foreign contents', authMaterialId: 'run-b', baseClaudeDir: root },
      buildCredential('other')
    );
    const foreignFile = path.join(material.directory, 'user-notes.txt');
    const nestedFile = path.join(material.directory, 'user-data', 'keep.txt');
    const target = path.join(root, 'symlink-target');
    await writeFile(foreignFile, 'user notes');
    await mkdir(path.dirname(nestedFile));
    await writeFile(nestedFile, 'nested user data');
    await writeFile(target, 'outside target');
    await rm(material.keyPath);
    await symlink(target, material.keyPath);
    const runtimeSettings = path.join(material.directory, 'runtime-settings-fixture.json');
    await writeFile(runtimeSettings, '{}');

    // A second sweep must also succeed with only deliberately preserved entries.
    for (let attempt = 0; attempt < 2; attempt++) {
      await cleanupStaleAnthropicTeamApiKeyHelpers({ baseClaudeDir: root, maxAgeMs: -1 });
    }

    await expect(readFile(foreignFile, 'utf8')).resolves.toBe('user notes');
    await expect(readFile(nestedFile, 'utf8')).resolves.toBe('nested user data');
    expect((await lstat(material.keyPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, 'utf8')).resolves.toBe('outside target');
    for (const removed of [
      material.helperPath,
      material.settingsPath,
      runtimeSettings,
      otherMaterial.directory,
    ]) {
      await expect(lstat(removed)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps ENOTEMPTY visible when an owned regular file remains', async () => {
    const root = await createTempRoot();
    const material = await materializeFixture(
      { teamName: 'recreated material', authMaterialId: 'run-a', baseClaudeDir: root },
      buildCredential('recreated')
    );
    const rmdir = fs.promises.rmdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'rmdir').mockImplementationOnce(async (directory) => {
      await writeFile(material.settingsPath, '{}');
      return rmdir(directory);
    });

    await expect(
      cleanupAnthropicTeamApiKeyHelperMaterial({ directory: material.directory })
    ).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    await expect(readFile(material.settingsPath, 'utf8')).resolves.toBe('{}');
  });

  it('preserves nonempty parent directories after stopped-team helper cleanup', async () => {
    const root = await createTempRoot();
    const teamName = 'TEST stopped preserved parents';
    const material = await materializeFixture(
      { teamName, authMaterialId: 'run-a', baseClaudeDir: root },
      buildCredential('stopped-preserved')
    );
    const runsDir = path.dirname(material.directory);
    const teamDir = path.dirname(runsDir);
    const foreignFiles = [
      path.join(material.directory, 'keep.txt'),
      path.join(runsDir, 'user-run-notes.txt'),
      path.join(teamDir, 'user-team-notes.txt'),
    ];
    for (const file of foreignFiles) await writeFile(file, 'preserved user data');

    for (let attempt = 0; attempt < 2; attempt++) {
      await cleanupAnthropicTeamApiKeyHelperForTeam({ teamName, baseClaudeDir: root });
    }

    for (const file of foreignFiles) {
      await expect(readFile(file, 'utf8')).resolves.toBe('preserved user data');
    }
    for (const file of [material.helperPath, material.keyPath, material.settingsPath]) {
      await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('reports read errors when checking a nonempty helper directory', async () => {
    const root = await createTempRoot();
    const material = await materializeFixture(
      { teamName: 'preserved read failure', authMaterialId: 'run-a', baseClaudeDir: root },
      buildCredential('preserved-read')
    );
    await writeFile(path.join(material.directory, 'keep.txt'), 'user data');
    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir')
      .mockImplementationOnce(readdir)
      .mockRejectedValueOnce(readError);

    await expect(
      cleanupAnthropicTeamApiKeyHelperMaterial({ directory: material.directory })
    ).rejects.toBe(readError);
  });

  it('reports a parent-directory remove failure after removing helper material', async () => {
    const root = await createTempRoot();
    const teamName = 'TEST parent remove failure';
    const material = await materializeFixture(
      { teamName, authMaterialId: 'run-a', baseClaudeDir: root },
      buildCredential('parent-remove')
    );
    const removeError = Object.assign(new Error('parent permission denied'), { code: 'EACCES' });
    const rmdir = fs.promises.rmdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'rmdir').mockImplementationOnce(rmdir).mockRejectedValueOnce(removeError);

    await expect(
      cleanupAnthropicTeamApiKeyHelperForTeam({ teamName, baseClaudeDir: root })
    ).rejects.toBe(removeError);
    await expect(lstat(material.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.dirname(material.directory))).resolves.toBeDefined();
  });

  it('reports parent-directory read failure instead of claiming pruning succeeded', async () => {
    const root = await createTempRoot();
    const teamName = 'TEST parent read failure';
    await materializeFixture(
      { teamName, authMaterialId: 'run-a', baseClaudeDir: root },
      buildCredential('parent-read')
    );
    const readError = Object.assign(new Error('parent permission denied'), { code: 'EACCES' });
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir')
      .mockImplementationOnce(readdir)
      .mockImplementationOnce(readdir)
      .mockRejectedValueOnce(readError);

    await expect(
      cleanupAnthropicTeamApiKeyHelperForTeam({ teamName, baseClaudeDir: root })
    ).rejects.toBe(readError);
  });

  it('preserves stale material referenced by a live process and symlinked run directories', async () => {
    if (process.platform === 'win32') return;
    const root = await createTempRoot();
    const material = await materializeFixture(
      { teamName: 'live material', authMaterialId: 'run-live', baseClaudeDir: root },
      buildCredential('live')
    );
    const linkedRun = path.join(path.dirname(material.directory), 'run-linked');
    await symlink(material.directory, linkedRun, 'dir');
    const child = childProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', material.settingsPath],
      { stdio: 'ignore' }
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    try {
      await cleanupStaleAnthropicTeamApiKeyHelpers({ baseClaudeDir: root, maxAgeMs: -1 });
      await cleanupAnthropicTeamApiKeyHelperForTeam({
        teamName: 'live material',
        baseClaudeDir: root,
      });

      await expect(stat(material.helperPath)).resolves.toBeDefined();
      await expect(stat(material.keyPath)).resolves.toBeDefined();
      expect((await lstat(linkedRun)).isSymbolicLink()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      });
    }
  });

  it.each([
    ['lstat', 'stopped-team lstat failed'],
    ['readdir', 'stopped-team readdir failed'],
    ['rmdir', 'stopped-team rmdir failed'],
  ] as const)('propagates %s failures from the stopped-team sweep', async (method, message) => {
    const root = await createTempRoot();
    await materializeFixture(
      {
        teamName: 'stopped sweep team',
        authMaterialId: `run-${method}`,
        baseClaudeDir: root,
      },
      buildCredential(method, 'sweep')
    );
    const sweepError = Object.assign(new Error(message), { code: 'EACCES' });
    vi.spyOn(fs.promises, method).mockRejectedValueOnce(sweepError);

    await expect(
      cleanupAnthropicTeamApiKeyHelperForTeam({
        teamName: 'stopped sweep team',
        baseClaudeDir: root,
      })
    ).rejects.toBe(sweepError);
  });

  it.each([
    ['lstat', 'startup stale sweep lstat failed'],
    ['readdir', 'startup stale sweep readdir failed'],
    ['rmdir', 'startup stale sweep rmdir failed'],
  ] as const)(
    'propagates %s failures from the startup stale-helper sweep',
    async (method, message) => {
      if (process.platform === 'win32') {
        return;
      }
      const root = await createTempRoot();
      await materializeFixture(
        {
          teamName: 'startup stale sweep team',
          authMaterialId: `run-${method}`,
          baseClaudeDir: root,
        },
        buildCredential('startup', method)
      );
      const sweepError = Object.assign(new Error(message), { code: 'EACCES' });
      vi.spyOn(fs.promises, method).mockRejectedValueOnce(sweepError);

      await expect(
        cleanupStaleAnthropicTeamApiKeyHelpers({
          baseClaudeDir: root,
          maxAgeMs: -1,
        })
      ).rejects.toBe(sweepError);
    }
  );
});
