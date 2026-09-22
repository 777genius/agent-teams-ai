// @vitest-environment node
import fs from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupAnthropicTeamApiKeyHelperForTeam,
  cleanupAnthropicTeamApiKeyHelperMaterial,
  cleanupStaleAnthropicTeamApiKeyHelpers,
  materializeAnthropicTeamApiKeyHelper,
} from '@main/services/runtime/anthropicTeamApiKeyHelper';
import { cleanupRunOwnedAnthropicApiKeyHelper } from '@main/services/team/provisioning/TeamProvisioningAnthropicApiKeyHelperLease';

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
