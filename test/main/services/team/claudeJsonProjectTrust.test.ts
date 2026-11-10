import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyClaudeJsonProjectTrust,
  revertClaudeJsonProjectTrust,
  revertClaudeJsonProjectTrustInMemory,
  upsertTrustedClaudeProjectConfig,
} from './claudeJsonProjectTrust';

describe('claude json project trust edits', () => {
  const sandboxKeys = ['/sandbox/canary', '/private/sandbox/canary'];
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('keeps concurrent settings and unrelated project trust after revert', () => {
    const before = {
      theme: 'light',
      projects: {
        '/sandbox/already-trusted': { hasTrustDialogAccepted: true },
      },
    };
    const applied = applyClaudeJsonProjectTrust(before, sandboxKeys);
    const duringTest = {
      theme: 'dark',
      projects: {
        '/sandbox/already-trusted': { hasTrustDialogAccepted: true },
        '/sandbox/new-user-project': { hasTrustDialogAccepted: true },
        '/sandbox/canary': { hasTrustDialogAccepted: true, extra: 'from-other-session' },
        '/private/sandbox/canary': { hasTrustDialogAccepted: true },
      },
    };
    const after = revertClaudeJsonProjectTrustInMemory(
      duringTest,
      sandboxKeys,
      applied.previousProjects
    );
    expect(after.theme).toBe('dark');
    expect(after.projects).toEqual({
      '/sandbox/already-trusted': { hasTrustDialogAccepted: true },
      '/sandbox/new-user-project': { hasTrustDialogAccepted: true },
    });
  });

  it('restores a pre-existing sandbox project entry instead of deleting it', () => {
    const before = {
      projects: {
        '/sandbox/canary': { hasTrustDialogAccepted: false, allowedTools: ['Read'] },
      },
    };
    const applied = applyClaudeJsonProjectTrust(before, ['/sandbox/canary']);
    const after = revertClaudeJsonProjectTrustInMemory(
      applied.next,
      ['/sandbox/canary'],
      applied.previousProjects
    );
    expect(after.projects).toEqual({
      '/sandbox/canary': { hasTrustDialogAccepted: false, allowedTools: ['Read'] },
    });
  });

  it('does not delete a file created after setup when other config remains', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-json-trust-'));
    const projectPath = path.join(tempDir, 'sandbox');
    await fs.mkdir(projectPath, { recursive: true });
    const edit = await upsertTrustedClaudeProjectConfig(tempDir, projectPath, tempDir);
    const configPath = path.join(tempDir, '.claude.json');
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          theme: 'dark',
          projects: {
            [edit.projectKeys[0]!]: { hasTrustDialogAccepted: true },
            '/sandbox/new-user-project': { hasTrustDialogAccepted: true },
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    await revertClaudeJsonProjectTrust(edit);

    const after = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      theme?: string;
      projects?: Record<string, unknown>;
    };
    expect(after.theme).toBe('dark');
    expect(after.projects?.['/sandbox/new-user-project']).toEqual({
      hasTrustDialogAccepted: true,
    });
    for (const key of edit.projectKeys) {
      expect(after.projects?.[key]).toBeUndefined();
    }
  });

  it('removes a test-created file only when nothing else remains', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-json-trust-'));
    const projectPath = path.join(tempDir, 'sandbox');
    await fs.mkdir(projectPath, { recursive: true });
    const edit = await upsertTrustedClaudeProjectConfig(tempDir, projectPath, tempDir);
    const configPath = path.join(tempDir, '.claude.json');
    expect(edit.createdFiles).toContain(configPath);

    await revertClaudeJsonProjectTrust(edit);

    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
