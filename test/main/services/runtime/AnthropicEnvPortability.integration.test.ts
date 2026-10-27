// @vitest-environment node
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ lookupPreferred: vi.fn(() => Promise.resolve(null)) }));

vi.mock('@main/services/infrastructure/ConfigManager', () => {
  const configManager = {
    getConfig: () => ({
      providerConnections: {
        anthropic: {
          authMode: 'auto',
          fastModeDefault: false,
          compatibleEndpoint: { enabled: false, baseUrl: '' },
        },
      },
      runtime: { providerBackends: { gemini: 'auto', codex: 'codex-native' } },
    }),
  };
  return { ConfigManager: { getInstance: () => configManager }, configManager };
});

// Keep environment builders, auth projection, shell resolution and execCli real.
// Only external credential storage and runtime installation are unavailable here.
vi.mock('@main/services/extensions/apikeys/ApiKeyService', () => ({
  ApiKeyService: class {
    lookupPreferred = fixture.lookupPreferred;
  },
}));
vi.mock('@features/codex-runtime-installer/main', () => ({
  resolveAppManagedCodexRuntimeBinaryPath: () => null,
  resolveVerifiedAppManagedCodexRuntimeBinaryPath: () => Promise.resolve(null),
}));

import {
  buildPassiveProviderStatusCliEnv,
  buildProviderAwareCliEnv,
} from '@main/services/runtime/providerAwareCliEnv';
import { providerConnectionService } from '@main/services/runtime/ProviderConnectionService';
import { buildProvisioningEnv } from '@main/services/team/provisioning/TeamProvisioningEnvBuilder';
import { execCli } from '@main/utils/childProcess';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import {
  clearShellEnvCache,
  getCachedShellEnv,
  resolveInteractiveShellEnvBestEffort,
  waitForPendingShellEnv,
} from '@main/utils/shellEnv';

const inherited = {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
  ANTHROPIC_AUTH_TOKEN: 'TEST-portable-token',
  ANTHROPIC_MODEL: 'TEST-portable-main',
  ANTHROPIC_SMALL_FAST_MODEL: 'TEST-portable-small',
  TEST_ENV_PORTABILITY_EMPTY: '',
  TEST_ENV_PORTABILITY_MULTILINE: 'first=value\nsecond=value',
  TEST_ENV_PORTABILITY_UNICODE: 'TEST Müller 世界',
};

const observedKeys = [
  ...Object.keys(inherited),
  'HOME',
  'USERPROFILE',
  'PATH',
  'COMSPEC',
  'SHELL',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE',
] as const;

describe('Anthropic inherited environment portability with a native Node child', () => {
  let sandbox: string;
  let toolDir: string;
  let originalWindowsPath: { key: string; value: string | undefined } | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'TEST-anthropic-portability-'));
    toolDir = path.join(sandbox, 'inherited-tools');
    await mkdir(toolDir);
    for (const key of Object.keys(process.env)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_|AGENT_TEAMS_ANTHROPIC_)/i.test(key)) {
        vi.stubEnv(key, undefined);
      }
    }
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
    vi.stubEnv('HOME', sandbox);
    vi.stubEnv('USERPROFILE', sandbox);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(sandbox, '.claude'));
    // Never let the Windows writable-cache preflight touch the runner's profile.
    vi.stubEnv('LOCALAPPDATA', path.join(sandbox, 'AppData', 'Local'));
    vi.stubEnv('APPDATA', path.join(sandbox, 'AppData', 'Roaming'));
    vi.stubEnv('TEMP', path.join(sandbox, 'temp'));
    vi.stubEnv('TMP', path.join(sandbox, 'temp'));
    await mkdir(path.join(sandbox, 'temp'));
    const inheritedPath = [toolDir, process.env.PATH].filter(Boolean).join(path.delimiter);
    if (process.platform === 'win32') {
      // Exercise Windows' normal mixed-case spelling in the actual process.env.
      // Restore this manually: separate PATH/Path vi.stubEnv entries would alias
      // the same native variable and could delete each other's restoration.
      const originalKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
      originalWindowsPath = originalKey
        ? { key: originalKey, value: process.env[originalKey] }
        : undefined;
      if (originalKey) delete process.env[originalKey];
      process.env.Path = inheritedPath;
      // An attempted POSIX shell probe would fail; Windows must cache its skip.
      vi.stubEnv('SHELL', path.join(sandbox, 'must-not-run-shell.exe'));
    } else {
      vi.stubEnv('PATH', inheritedPath);
      const shell = path.join(sandbox, 'fixture-shell');
      await writeFile(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
      await chmod(shell, 0o755);
      vi.stubEnv('SHELL', shell);
    }
    setAppDataBasePath(path.join(sandbox, 'app-data'));
    setClaudeBasePathOverride(path.join(sandbox, '.claude'));
    clearShellEnvCache();
  });

  afterEach(async () => {
    clearShellEnvCache();
    setAppDataBasePath(null);
    setClaudeBasePathOverride(null);
    vi.unstubAllEnvs();
    if (process.platform === 'win32') {
      delete process.env.Path;
      if (originalWindowsPath?.value !== undefined) {
        process.env[originalWindowsPath.key] = originalWindowsPath.value;
      }
    }
    await rm(sandbox, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  });

  it.each(['passive status', 'active CLI', 'team launch'] as const)(
    'preserves inherited variables through %s and the real spawn seam',
    async (surface) => {
      const parentEnvIdentity = process.env;
      const parentEnv = { ...process.env };
      await resolveInteractiveShellEnvBestEffort({ timeoutMs: 2_000, fallbackEnv: process.env });
      await waitForPendingShellEnv();
      if (process.platform === 'win32') {
        expect(getCachedShellEnv() !== null).toBe(true);
        expect(Object.keys(getCachedShellEnv() ?? {}).length).toBe(0);
        expect((await waitForPendingShellEnv()) === getCachedShellEnv()).toBe(true);
      }

      let env: NodeJS.ProcessEnv;
      if (surface === 'passive status') {
        const passive = buildPassiveProviderStatusCliEnv({
          providerId: 'anthropic',
          binaryPath: process.execPath,
        });
        env = await providerConnectionService.applyPassiveProviderStatusConnectionEnv(
          passive.env,
          'anthropic'
        );
      } else if (surface === 'active CLI') {
        ({ env } = await buildProviderAwareCliEnv({
          providerId: 'anthropic',
          binaryPath: process.execPath,
        }));
      } else {
        ({ env } = await buildProvisioningEnv({
          providerId: 'anthropic',
          ports: {
            providerConnectionService,
            buildRuntimeTurnSettledEnvironment: () => Promise.resolve({}),
            resolveControlApiBaseUrl: () => Promise.resolve(null),
            getHomeDir: () => sandbox,
            logger: { warn: vi.fn(), error: vi.fn() },
          },
        }));
      }

      const { stdout, stderr } = await execCli(
        process.execPath,
        [
          '-e',
          `process.stdout.write(JSON.stringify({ env: Object.fromEntries(${JSON.stringify(observedKeys)}.map(key => [key, process.env[key]])), pathKeys: Object.keys(process.env).filter(key => key.toUpperCase() === 'PATH') }));`,
        ],
        { env, cwd: sandbox, timeout: 10_000 }
      );
      const child = JSON.parse(stdout) as { env: Record<string, string>; pathKeys: string[] };
      expect(stderr).toBe('');
      expect(child.env).toMatchObject(inherited);
      expect(child.env.HOME).toBe(sandbox);
      expect(child.env.USERPROFILE).toBe(sandbox);
      expect(child.env.PATH.split(path.delimiter)).toContain(toolDir);
      expect(child.env.AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE).toBe('auto');
      if (process.platform === 'win32') {
        expect(child.pathKeys).toHaveLength(1);
        expect(child.env.COMSPEC).toBe(process.env.COMSPEC);
        expect(child.env.SHELL).toBe(process.env.SHELL);
        for (const key of ['LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) {
          expect(child.env[key]).toBeTruthy();
          expect(path.isAbsolute(child.env[key])).toBe(true);
          expect(child.env[key].startsWith(sandbox)).toBe(true);
        }
      }
      // Boolean-only assertions keep any unrelated runner credentials out of
      // failure diffs while checking every original key/value and object identity.
      expect(process.env === parentEnvIdentity).toBe(true);
      expect(
        Object.keys(process.env).sort().join('\0') === Object.keys(parentEnv).sort().join('\0')
      ).toBe(true);
      expect(Object.keys(parentEnv).every((key) => process.env[key] === parentEnv[key])).toBe(true);
    }
  );
});
