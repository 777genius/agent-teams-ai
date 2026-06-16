// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Anthropic-compatible Claude settings safe e2e', () => {
  let tempHome: string;
  let claudeRoot: string;
  let restoreClaudeBasePath: (() => void) | null;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

  beforeEach(async () => {
    vi.resetModules();
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'anthropic-compatible-settings-e2e-'));
    claudeRoot = path.join(tempHome, '.claude');
    await mkdir(claudeRoot, { recursive: true });
    await writeFile(
      path.join(claudeRoot, 'settings.json'),
      `${JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
            ANTHROPIC_AUTH_TOKEN: 'ccs-internal-managed',
          },
        },
        null,
        2
      )}\n`,
      { encoding: 'utf8', flag: 'w' }
    );

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;

    const pathDecoder = await import('@main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(claudeRoot);
    restoreClaudeBasePath = () => pathDecoder.setClaudeBasePathOverride(null);
  });

  afterEach(async () => {
    restoreClaudeBasePath?.();
    restoreClaudeBasePath = null;
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
    if (originalAnthropicAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    }
    if (originalAnthropicBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it('builds provider-managed Anthropic runtime env from user Claude settings', async () => {
    const { buildProviderAwareCliEnv } = await import(
      '@main/services/runtime/providerAwareCliEnv'
    );
    const pathDecoder = await import('@main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(claudeRoot);

    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude-multimodel',
      providerId: 'anthropic',
      shellEnv: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
      },
      env: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
      },
    });

    expect(result.connectionIssues).toEqual({});
    expect(result.providerArgs).toEqual([]);
    expect(result.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    expect(result.env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic');
    expect(result.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:15721');
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('ccs-internal-managed');
    expect(result.env.ANTHROPIC_API_KEY).toBe('');
  });

  it('builds provider-managed Anthropic API key env from user Claude settings', async () => {
    await writeFile(
      path.join(claudeRoot, 'settings.json'),
      `${JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-settings',
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        },
      })}\n`,
      'utf8'
    );
    const { buildProviderAwareCliEnv } = await import(
      '@main/services/runtime/providerAwareCliEnv'
    );
    const pathDecoder = await import('@main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(claudeRoot);

    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude-multimodel',
      providerId: 'anthropic',
      shellEnv: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
      },
      env: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
      },
    });

    expect(result.connectionIssues.anthropic).toBeUndefined();
    expect(result.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    expect(result.env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic');
    expect(result.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(result.env.ANTHROPIC_API_KEY).toBe('sk-ant-settings');
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('does not import Claude settings auth into generic augment envs', async () => {
    const { buildProviderAwareCliEnv } = await import(
      '@main/services/runtime/providerAwareCliEnv'
    );
    const pathDecoder = await import('@main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(claudeRoot);

    const result = await buildProviderAwareCliEnv({
      connectionMode: 'augment',
      shellEnv: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
      },
      env: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
      },
    });

    expect(result.connectionIssues).toEqual({});
    expect(result.providerArgs).toEqual([]);
    expect(result.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('imports Claude settings auth into aggregate strict runtime envs', async () => {
    const { buildProviderAwareCliEnv } = await import(
      '@main/services/runtime/providerAwareCliEnv'
    );
    const pathDecoder = await import('@main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(claudeRoot);

    const result = await buildProviderAwareCliEnv({
      shellEnv: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
      },
      env: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
      },
    });

    expect(result.connectionIssues.anthropic).toBeUndefined();
    expect(result.providerArgs).toEqual([]);
    expect(result.env.CLAUDE_CODE_ENTRY_PROVIDER).toBeUndefined();
    expect(result.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:15721');
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('ccs-internal-managed');
    expect(result.env.ANTHROPIC_API_KEY).toBe('');
  });
});
