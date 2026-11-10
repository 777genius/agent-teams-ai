// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readClaudeUserAnthropicSettingsAuthEnv } from '@main/services/runtime/claudeUserSettingsEnv';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it } from 'vitest';

describe('claudeUserSettingsEnv', () => {
  const tempRoots: string[] = [];

  async function writeSettings(settings: unknown): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-user-settings-env-'));
    tempRoots.push(dir);
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return settingsPath;
  }

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reads Anthropic-compatible auth from Claude user settings env', async () => {
    const settingsPath = await writeSettings({
      env: {
        ANTHROPIC_BASE_URL: ' http://127.0.0.1:15721 ',
        ANTHROPIC_AUTH_TOKEN: ' ccs-internal-managed ',
      },
    });

    await expect(readClaudeUserAnthropicSettingsAuthEnv(settingsPath)).resolves.toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: 'ccs-internal-managed',
    });
  });

  it('reads Anthropic API key auth from Claude user settings env', async () => {
    const settingsPath = await writeSettings({
      env: {
        ANTHROPIC_API_KEY: ' sk-ant-settings ',
        ANTHROPIC_BASE_URL: ' https://api.anthropic.com ',
      },
    });

    await expect(readClaudeUserAnthropicSettingsAuthEnv(settingsPath)).resolves.toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-settings',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
  });

  it('keeps settings API key auth when the optional base URL is malformed', async () => {
    const settingsPath = await writeSettings({
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-settings',
        ANTHROPIC_BASE_URL: 'not a url',
      },
    });

    await expect(readClaudeUserAnthropicSettingsAuthEnv(settingsPath)).resolves.toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-settings',
    });
  });

  it('prefers settings API key over auth token when both are present', async () => {
    const settingsPath = await writeSettings({
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-settings',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_AUTH_TOKEN: 'compatible-token',
      },
    });

    await expect(readClaudeUserAnthropicSettingsAuthEnv(settingsPath)).resolves.toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-settings',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
    });
  });

  it('ignores first-party Anthropic hosts', async () => {
    const settingsPath = await writeSettings({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_AUTH_TOKEN: 'stale-token',
      },
    });

    await expect(readClaudeUserAnthropicSettingsAuthEnv(settingsPath)).resolves.toBeNull();
  });

  it('ignores malformed or incomplete settings env', async () => {
    const malformedPath = await writeSettings({
      env: {
        ANTHROPIC_BASE_URL: 'not a url',
        ANTHROPIC_AUTH_TOKEN: 'token',
      },
    });
    const missingTokenPath = await writeSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      },
    });

    await expect(readClaudeUserAnthropicSettingsAuthEnv(malformedPath)).resolves.toBeNull();
    await expect(readClaudeUserAnthropicSettingsAuthEnv(missingTokenPath)).resolves.toBeNull();
  });

  it('falls back to legacy claude.json only when settings.json is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-user-settings-env-'));
    tempRoots.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'claude.json'),
      `${JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
          ANTHROPIC_AUTH_TOKEN: 'legacy-token',
        },
      })}\n`,
      'utf8'
    );
    setClaudeBasePathOverride(dir);

    await expect(readClaudeUserAnthropicSettingsAuthEnv()).resolves.toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: 'legacy-token',
    });
  });

  it('does not fall back to legacy claude.json when settings.json exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-user-settings-env-'));
    tempRoots.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'settings.json'), '{"env":{}}\n', 'utf8');
    await writeFile(
      path.join(dir, 'claude.json'),
      `${JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
          ANTHROPIC_AUTH_TOKEN: 'legacy-token',
        },
      })}\n`,
      'utf8'
    );
    setClaudeBasePathOverride(dir);

    await expect(readClaudeUserAnthropicSettingsAuthEnv()).resolves.toBeNull();
  });
});
