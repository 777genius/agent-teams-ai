// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAnthropicTeamAuthDirectoryName,
  cleanupAnthropicTeamApiKeyHelperMaterial,
  materializeAnthropicTeamApiKeyHelper,
  verifyAnthropicTeamApiKeyHelperMaterial,
} from '@main/services/runtime/anthropicTeamApiKeyHelper';

const execFileAsync = promisify(execFile);

describe('anthropicTeamApiKeyHelper', () => {
  const tempRoots: string[] = [];

  async function createTempRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'anthropic-team-helper-'));
    tempRoots.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('uses slug plus hash to avoid unsafe-name collisions', () => {
    const one = buildAnthropicTeamAuthDirectoryName('team/a');
    const two = buildAnthropicTeamAuthDirectoryName('team:a');

    expect(one).not.toBe(two);
    expect(one).toMatch(/^[a-zA-Z0-9._-]+-[a-f0-9]{12}$/);
    expect(two).toMatch(/^[a-zA-Z0-9._-]+-[a-f0-9]{12}$/);
  });

  it('materializes helper settings without writing the raw key into args or settings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), "anthropic team helper ' "));
    tempRoots.push(root);
    const apiKey = 'sk-ant-test-secret-value';
    const material = await materializeAnthropicTeamApiKeyHelper({
      teamName: 'secure team',
      authMaterialId: 'run-123',
      apiKey,
      baseClaudeDir: root,
    });

    const settingsRaw = await readFile(material.settingsPath, 'utf8');
    const helperRaw = await readFile(material.helperPath, 'utf8');

    expect(material.settingsArgs).toEqual(['--settings', material.settingsPath]);
    expect(material.settingsArgs.join(' ')).not.toContain(apiKey);
    expect(settingsRaw).toContain('apiKeyHelper');
    expect(settingsRaw).not.toContain(apiKey);
    expect(helperRaw).toContain('KEY_FILE=');
    expect(helperRaw).not.toContain(apiKey);
    const parsedSettings = JSON.parse(settingsRaw) as { apiKeyHelper: string };

    if (process.platform !== 'win32') {
      const shellResult = await execFileAsync('/bin/sh', ['-c', parsedSettings.apiKeyHelper]);
      expect(shellResult.stdout.trim()).toBe(apiKey);
      expect((await stat(material.keyPath)).mode & 0o777).toBe(0o600);
      expect((await stat(material.helperPath)).mode & 0o777).toBe(0o700);
      expect((await stat(material.settingsPath)).mode & 0o777).toBe(0o600);

      await verifyAnthropicTeamApiKeyHelperMaterial({
        helperPath: material.helperPath,
        expectedApiKey: apiKey,
      });
    }
  });

  it('cleans only owned helper material files', async () => {
    const root = await createTempRoot();
    const material = await materializeAnthropicTeamApiKeyHelper({
      teamName: 'cleanup team',
      authMaterialId: 'run-456',
      apiKey: 'sk-ant-test-cleanup',
      baseClaudeDir: root,
    });

    await cleanupAnthropicTeamApiKeyHelperMaterial({ directory: material.directory });

    await expect(stat(material.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
