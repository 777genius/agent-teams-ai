// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  applyOriginalRuntimeExecutableEnv,
  originalRuntimeCacheKey,
  originalRuntimeProviderConnectionPort,
  readOriginalRuntimeScope,
  withOriginalRuntimeScope,
} from '../../../src/main/services/runtime/OriginalRuntimeScope';

import type { OriginalRuntimeScope } from '../../../src/main/services/runtime/OriginalRuntimeScope';
import type { ProviderConnectionService } from '../../../src/main/services/runtime/ProviderConnectionService';

function scope(label: string) {
  let current = true;
  const service = {
    getConfiguredAuthMode: vi.fn(() => label),
  } as unknown as ProviderConnectionService;
  const value: OriginalRuntimeScope = {
    teamName: 'TEST-original-team',
    sourceKey: 'TEST-original-physical-source',
    operation: 'status',
    cacheNamespace: label,
    binaryPath: `/TEST/${label}/orchestrator`,
    codexBinaryPath: `/TEST/${label}/codex`,
    nativeClaudeBinaryPath: `/TEST/${label}/claude`,
    openCodeBinaryPath: `/TEST/${label}/opencode`,
    processEnv: {},
    shellEnv: {},
    providerConnections: service,
    resolveOpenCodeInputDeclaration: vi.fn(),
    registerChild: vi.fn(),
    admitLaunch: vi.fn(),
    assertCurrent: () => {
      if (!current) throw new Error('TEST capture revoked');
    },
  };
  return {
    value,
    service,
    revoke: () => {
      current = false;
    },
  };
}

describe('original runtime operation dispatch', () => {
  it('keeps already captured provider service references on their admitted original account', async () => {
    const host = scope('TEST-selected-Host'),
      original = scope('TEST-original'),
      reference = originalRuntimeProviderConnectionPort(host.service);
    expect(reference.getConfiguredAuthMode('codex')).toBe('TEST-selected-Host');
    await withOriginalRuntimeScope(original.value, async () => {
      await Promise.resolve();
      expect(reference.getConfiguredAuthMode('codex')).toBe('TEST-original');
    });
    expect(reference.getConfiguredAuthMode('codex')).toBe('TEST-selected-Host');
  });
  it('does not substitute the selected Host after an original account is revoked', async () => {
    const host = scope('TEST-selected-Host'),
      original = scope('TEST-original'),
      reference = originalRuntimeProviderConnectionPort(host.service);
    await withOriginalRuntimeScope(original.value, async () => {
      original.revoke();
      await Promise.resolve();
      expect(() => reference.getConfiguredAuthMode('codex')).toThrow('TEST capture revoked');
    });
    expect(host.service.getConfiguredAuthMode).not.toHaveBeenCalled();
  });
  it('isolates simultaneous scopes without mutating the global selected provider', async () => {
    const host = scope('TEST-selected-Host'),
      first = scope('TEST-first-original'),
      second = scope('TEST-second-original');
    const reference = originalRuntimeProviderConnectionPort(host.service);
    const result = await Promise.all(
      [first, second].map((original) =>
        withOriginalRuntimeScope(original.value, async () => {
          await Promise.resolve();
          return reference.getConfiguredAuthMode('codex');
        })
      )
    );
    expect(result).toEqual(['TEST-first-original', 'TEST-second-original']);
    expect(readOriginalRuntimeScope()).toBeUndefined();
  });
  it('isolates native status caches and projects the same executable selections into child env', () => {
    const original = scope('TEST-original'),
      env = { CODEX_CLI_PATH: '/TEST-global/codex' };
    const globalKey = originalRuntimeCacheKey(['TEST-same-project', 'opencode']);
    withOriginalRuntimeScope(original.value, () => {
      expect(originalRuntimeCacheKey(['TEST-same-project', 'opencode'])).not.toBe(globalKey);
      applyOriginalRuntimeExecutableEnv(env);
    });
    expect(env).toMatchObject({
      CODEX_CLI_PATH: '/TEST/TEST-original/codex',
      CLAUDE_CLI_PATH: '/TEST/TEST-original/claude',
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: '/TEST/TEST-original/opencode',
    });
  });
  it('refuses a nested replacement of the captured original runtime', () => {
    const first = scope('TEST-first'),
      second = scope('TEST-second');
    withOriginalRuntimeScope(first.value, () =>
      expect(() => withOriginalRuntimeScope(second.value, () => {})).toThrow()
    );
  });
});
