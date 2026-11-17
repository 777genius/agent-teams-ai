// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRuntimeBaseEnv } from '../../../src/main/services/runtime/buildRuntimeBaseEnv';
import {
  readOriginalRuntimeScope,
  withOriginalRuntimeScope,
} from '../../../src/main/services/runtime/OriginalRuntimeScope';

import type { OriginalRuntimeScope } from '../../../src/main/services/runtime/OriginalRuntimeScope';

const ambient = vi.hoisted(() => ({ shell: {} as NodeJS.ProcessEnv }));
vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => readOriginalRuntimeScope()?.shellEnv ?? ambient.shell,
  getShellPreferredHome: () => (readOriginalRuntimeScope()?.shellEnv ?? ambient.shell).HOME,
}));
vi.mock('@main/utils/managedGit', () => ({ createManagedGitEnv: (env: NodeJS.ProcessEnv) => env }));
vi.mock('@main/services/identity/AgentTeamsIdentityStore', () => ({
  applyAgentTeamsIdentityEnv: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  configManager: {
    getConfig: () => ({
      runtime: { providerBackends: { gemini: 'cli', codex: 'codex-native' } },
      providerConnections: { anthropic: {} },
    }),
  },
}));
vi.mock('@features/opencode-runtime-installer/main', () => ({
  getOpenCodeV2SupportRoot: () => '/TEST/opencode-support',
}));
vi.mock('@main/utils/pathDecoder', () => ({
  getClaudeBasePath: () => '/TEST/claude',
  getAutoDetectedClaudeBasePath: () => '/TEST/claude',
}));
afterEach(() => vi.unstubAllEnvs());

describe('captured original runtime environment precedence', () => {
  it.each([false, true])(
    'preserves process → shell → explicit precedence (explicit=%s)',
    (explicit) => {
      vi.stubEnv('HOME', '/TEST/process-home');
      vi.stubEnv('USERPROFILE', '/TEST/process-home');
      vi.stubEnv('PATH', '/TEST/process-bin');
      vi.stubEnv('ANTHROPIC_API_KEY', 'TEST-process-key');
      ambient.shell = {
        HOME: '/TEST/shell-home',
        USERPROFILE: '/TEST/shell-home',
        PATH: '/TEST/shell-bin',
        ANTHROPIC_API_KEY: 'TEST-shell-key',
      };
      const options = {
        shellEnv: ambient.shell,
        ...(explicit
          ? {
              env: {
                HOME: '/TEST/explicit-home',
                PATH: '/TEST/explicit-bin',
                ANTHROPIC_API_KEY: 'TEST-explicit-key',
              },
            }
          : {}),
      };
      const ordinary = buildRuntimeBaseEnv(options).env;
      const scope: OriginalRuntimeScope = {
        teamName: 'TEST-original',
        sourceKey: 'TEST-source',
        operation: 'prepare',
        cacheNamespace: 'TEST-private',
        binaryPath: '/TEST/never-executed',
        codexBinaryPath: null,
        nativeClaudeBinaryPath: null,
        openCodeBinaryPath: null,
        processEnv: { ...process.env },
        shellEnv: { ...ambient.shell },
        providerConnections: {} as never,
        assertCurrent: vi.fn(),
        admitLaunch: vi.fn(),
        registerChild: vi.fn(),
        resolveOpenCodeInputDeclaration: vi.fn(),
      };
      const captured = withOriginalRuntimeScope(scope, () => buildRuntimeBaseEnv(options).env);
      for (const key of ['HOME', 'USERPROFILE', 'PATH', 'ANTHROPIC_API_KEY'])
        expect(captured[key], key).toBe(ordinary[key]);
      expect(captured.HOME).toBe(explicit ? '/TEST/explicit-home' : '/TEST/shell-home');
      expect(captured.ANTHROPIC_API_KEY).toBe(explicit ? 'TEST-explicit-key' : 'TEST-shell-key');
    }
  );
});
