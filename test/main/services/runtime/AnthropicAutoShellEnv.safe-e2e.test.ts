// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

const fixture = vi.hoisted(() => ({
  authMode: 'auto' as 'auto' | 'oauth' | 'api_key',
  compatibleEndpoint: { enabled: false, baseUrl: '' },
  lookupPreferred: vi.fn(),
}));

vi.mock('@main/services/infrastructure/ConfigManager', () => {
  const configManager = {
    getConfig: () => ({
      providerConnections: {
        anthropic: {
          authMode: fixture.authMode,
          fastModeDefault: false,
          compatibleEndpoint: fixture.compatibleEndpoint,
        },
        codex: {
          preferredAuthMode: 'auto',
          customProvider: { enabled: false, baseUrl: '', model: '' },
        },
      },
      runtime: { providerBackends: { gemini: 'auto', codex: 'codex-native' } },
    }),
  };
  return { ConfigManager: { getInstance: () => configManager }, configManager };
});

// Keep the real bridge, shell resolver, environment projection, subprocess and
// status parsing. The fixture has no stored credentials or installation actions.
vi.mock('@main/services/extensions/apikeys/ApiKeyService', () => ({
  ApiKeyService: class {
    lookupPreferred = fixture.lookupPreferred;
  },
}));

const TOKEN = 'TEST-auto-shell-credential';
const MODEL = 'TEST-gateway-large';
const FAST_MODEL = 'TEST-gateway-small';
const nativeRuntimePath = process.env.AGENT_TEAMS_TEST_ANTHROPIC_RUNTIME_PATH?.trim();

const runtimeProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const summary = args.length === 6 && args[5] === '--summary';
if (JSON.stringify(args.slice(0, 5)) !==
    JSON.stringify(['runtime', 'status', '--json', '--provider', 'anthropic']) ||
    (!summary && args.length !== 5)) {
  throw new Error('TEST fixture only accepts Anthropic runtime status');
}
const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
const model = process.env.ANTHROPIC_MODEL || '';
const fastModel = process.env.ANTHROPIC_SMALL_FAST_MODEL || '';
fs.appendFileSync(path.join(process.env.HOME, 'runtime-calls.jsonl'), JSON.stringify({
  args, pid: process.pid, baseUrl, model, fastModel, tokenPresent: Boolean(token),
  connectionMode: process.env.AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE,
}) + '\n');
(async () => {
  let verified = false;
  let models = [];
  if (!summary && baseUrl && token) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      throw new Error('TEST fixture refuses non-loopback endpoint');
    }
    const response = await fetch(new URL('/v1/models', url), {
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      models = (await response.json()).data.map(item => item.id);
      verified = models.includes(model) && models.includes(fastModel);
    }
  }
  const provider = {
    providerId: 'anthropic', supported: true, authenticated: verified,
    authMethod: verified ? 'anthropic_compatible_bearer_token' : null,
    verificationState: verified ? 'verified' : 'unknown', canLoginFromUi: false,
    capabilities: { teamLaunch: verified, oneShot: verified, extensions: {} },
    selectedBackendId: 'anthropic', resolvedBackendId: 'anthropic-compatible',
    availableBackends: [], externalRuntimeDiagnostics: [],
    backend: { kind: 'api', label: 'TEST compatible endpoint', endpointLabel: baseUrl },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'anthropic-compatible-api' } },
    statusCheckOutcome: 'authoritative', models,
    statusMessage: verified ? 'TEST endpoint verified' : 'TEST endpoint not verified',
    detailMessage: token ? null :
      'Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for this Anthropic-compatible endpoint.',
    defaultModel: model || null, effectiveDefaultModel: verified ? model : null,
    modelCatalog: verified ? {
      schemaVersion: 1, providerId: 'anthropic', source: 'anthropic-compatible-api',
      status: 'ready', fetchedAt: new Date().toISOString(),
      staleAt: new Date(Date.now() + 60000).toISOString(),
      defaultModelId: model, defaultLaunchModel: model,
      models: models.map(id => ({ id, launchModel: id, displayName: id,
        source: 'anthropic-compatible-api', supportedReasoningEfforts: [],
        isDefault: id === model })),
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    } : null,
  };
  process.stdout.write(JSON.stringify({ providers: { anthropic: provider } }));
})().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`;

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe.skipIf(process.platform === 'win32')('Anthropic Auto GUI shell safe e2e', () => {
  let sandbox: string;
  let runtimePath: string;
  let endpoint: string;
  let server: ReturnType<typeof createServer>;
  let shellEnv: typeof import('@main/utils/shellEnv');
  const requests: { url: string; authorized: boolean }[] = [];

  beforeEach(async () => {
    vi.resetModules();
    fixture.authMode = 'auto';
    fixture.compatibleEndpoint = { enabled: false, baseUrl: '' };
    fixture.lookupPreferred.mockReset();
    fixture.lookupPreferred.mockResolvedValue(null);
    requests.length = 0;
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'TEST-anthropic-auto-shell-'));
    await mkdir(path.join(sandbox, '.claude'));
    for (const key of Object.keys(process.env)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_|AGENT_TEAMS_ANTHROPIC_)/.test(key)) {
        vi.stubEnv(key, undefined);
      }
    }
    vi.stubEnv('HOME', sandbox);
    vi.stubEnv('USERPROFILE', sandbox);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(sandbox, '.claude'));
    vi.stubEnv('PATH', `${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`);
    const pathDecoder = await import('@main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(path.join(sandbox, '.claude'));
    shellEnv = await import('@main/utils/shellEnv');
    shellEnv.clearShellEnvCache();
    server = createServer((request, response) => {
      const authorized = request.headers.authorization === `Bearer ${TOKEN}`;
      requests.push({ url: request.url ?? '', authorized });
      const isModelCatalog =
        new URL(request.url ?? '/', 'http://127.0.0.1').pathname === '/v1/models';
      response.writeHead(authorized && isModelCatalog ? 200 : 401, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify({
          data: [MODEL, FAST_MODEL].map((id) => ({
            id,
            type: 'model',
            display_name: id,
            created_at: '2026-01-01T00:00:00Z',
          })),
          has_more: false,
          first_id: MODEL,
          last_id: FAST_MODEL,
        })
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TEST server address');
    endpoint = `http://127.0.0.1:${address.port}`;
    const programPath = path.join(sandbox, 'runtime.cjs');
    runtimePath = path.join(sandbox, 'runtime');
    await writeFile(programPath, runtimeProgram);
    await writeFile(
      runtimePath,
      `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(programPath)} "$@"\n`
    );
    await chmod(runtimePath, 0o755);
  });

  afterEach(async () => {
    shellEnv.clearShellEnvCache();
    const pathDecoder = await import('@main/utils/pathDecoder');
    pathDecoder.setClaudeBasePathOverride(null);
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    vi.unstubAllEnvs();
    await rm(sandbox, { recursive: true, force: true });
  });

  async function installLoginShell(env: NodeJS.ProcessEnv, delayMs = 100): Promise<void> {
    const programPath = path.join(sandbox, 'login-shell.cjs');
    const shellPath = path.join(sandbox, 'login-shell');
    await writeFile(
      programPath,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '-lic' || !args[1].includes(' && env -0 && ')) {
  throw new Error('TEST shell requires a real login-shell probe');
}
fs.appendFileSync(${JSON.stringify(path.join(sandbox, 'shell-calls.jsonl'))}, JSON.stringify({ pid: process.pid, args }) + '\\n');
const env = { ...process.env, ...${JSON.stringify(env)} };
setTimeout(() => {
  const result = require('node:child_process').spawnSync('/bin/sh', ['-c', args[1]], {
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}, ${delayMs});
`
    );
    await writeFile(
      shellPath,
      `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(programPath)} "$@"\n`
    );
    await chmod(shellPath, 0o755);
    vi.stubEnv('SHELL', shellPath);
  }

  async function readCalls(filename: string): Promise<Record<string, unknown>[]> {
    return (await readFile(path.join(sandbox, filename), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it.each(['shell-only', 'process-url-with-shell-credentials'] as const)(
    'detects %s configuration and verifies the endpoint with the inherited models',
    async (source) => {
      if (source === 'process-url-with-shell-credentials')
        vi.stubEnv('ANTHROPIC_BASE_URL', endpoint);
      await installLoginShell({
        ...(source === 'shell-only' ? { ANTHROPIC_BASE_URL: endpoint } : {}),
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        ANTHROPIC_MODEL: MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: FAST_MODEL,
      });
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');
      const status = await new ClaudeMultimodelBridgeService().getProviderStatus(
        runtimePath,
        'anthropic',
        undefined,
        { projectPath: sandbox }
      );

      expect(status).toMatchObject({
        authenticated: true,
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
        effectiveDefaultModel: MODEL,
        models: [MODEL, FAST_MODEL],
        modelCatalogRefreshState: 'ready',
        capabilities: { teamLaunch: true },
      });
      expect(requests).toEqual([{ url: '/v1/models', authorized: true }]);
      const calls = await readCalls('runtime-calls.jsonl');
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call).toMatchObject({
          baseUrl: endpoint,
          tokenPresent: true,
          model: MODEL,
          fastModel: FAST_MODEL,
          connectionMode: 'auto',
        });
        expect(call.pid).not.toBe(process.pid);
      }
      expect(await readCalls('shell-calls.jsonl')).toHaveLength(1);
      expect(fixture.lookupPreferred).not.toHaveBeenCalled();
    }
  );

  it.skipIf(!nativeRuntimePath)(
    'uses the native runtime to authenticate a cold shell configuration and infer with both models',
    async () => {
      if (!nativeRuntimePath) throw new Error('Missing opt-in native TEST runtime path');
      for (const key of [
        'CLAUDE_CODE_SIMPLE',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'DISABLE_TELEMETRY',
        'DISABLE_ERROR_REPORTING',
        'DISABLE_AUTOUPDATER',
      ]) {
        vi.stubEnv(key, '1');
      }
      for (const key of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
      ]) {
        vi.stubEnv(key, undefined);
      }
      const { configuredDefault, diagnosticModel, probePrompt, startDefaultModelGateway } =
        await import('../../../../scripts/e2e/anthropic-compatible-status/default-model-gateway');
      const gateway = await startDefaultModelGateway();
      try {
        await installLoginShell({
          ANTHROPIC_BASE_URL: gateway.baseUrl,
          ANTHROPIC_AUTH_TOKEN: gateway.token,
          ANTHROPIC_MODEL: configuredDefault,
          ANTHROPIC_SMALL_FAST_MODEL: diagnosticModel,
        });
        expect(shellEnv.getCachedShellEnv()).toBeNull();
        expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        const { ClaudeMultimodelBridgeService } =
          await import('@main/services/runtime/ClaudeMultimodelBridgeService');
        const status = await new ClaudeMultimodelBridgeService().getProviderStatus(
          nativeRuntimePath,
          'anthropic',
          undefined,
          { projectPath: sandbox }
        );

        expect(
          status,
          JSON.stringify({ status, requests: gateway.requests }, null, 2)
        ).toMatchObject({
          authenticated: true,
          verificationState: 'verified',
          statusCheckOutcome: 'authoritative',
          resolvedBackendId: 'anthropic-compatible',
          effectiveDefaultModel: configuredDefault,
          models: expect.arrayContaining([configuredDefault, diagnosticModel]),
          modelCatalogRefreshState: 'ready',
          capabilities: { teamLaunch: true },
        });
        expect(gateway.requests.length).toBeGreaterThan(0);
        expect(
          gateway.requests.every((request) => request.authorized && request.path === '/v1/models')
        ).toBe(true);

        const { buildPassiveProviderStatusCliEnv } =
          await import('@main/services/runtime/providerAwareCliEnv');
        const { providerConnectionService } =
          await import('@main/services/runtime/ProviderConnectionService');
        const { getAnthropicCompatibleDiagnosticModelOverride } =
          await import('@main/services/team/provisioning/TeamProvisioningAnthropicDiagnosticModel');
        const { execCli } = await import('@main/utils/childProcess');
        const { env } = buildPassiveProviderStatusCliEnv({
          binaryPath: nativeRuntimePath,
          providerId: 'anthropic',
        });
        await providerConnectionService.applyConfiguredConnectionEnv(env, 'anthropic');
        const fastModel = getAnthropicCompatibleDiagnosticModelOverride('anthropic', env);
        expect(fastModel).toBe(diagnosticModel);
        for (const model of [undefined, fastModel]) {
          const inference = await execCli(
            nativeRuntimePath,
            [
              '-p',
              probePrompt,
              '--output-format',
              'text',
              ...(model ? ['--model', model] : []),
              '--max-turns',
              '1',
              '--tools',
              '',
              '--no-session-persistence',
            ],
            { env, cwd: sandbox, timeout: 20_000, maxBuffer: 128 * 1024 }
          );
          expect(inference.stdout.trim()).toBe('PONG');
        }
        const messages = gateway.requests.filter((request) => request.path === '/v1/messages');
        expect(messages.map((request) => request.model)).toEqual([
          configuredDefault,
          diagnosticModel,
        ]);
        expect(
          messages.every((request) => request.authorized && request.allowed && request.completed)
        ).toBe(true);
        expect(gateway.inFlight()).toBe(0);
        expect(await readCalls('shell-calls.jsonl')).toHaveLength(1);
        expect(fixture.lookupPreferred).not.toHaveBeenCalled();
      } finally {
        await gateway.close();
      }
    },
    60_000
  );

  it('coalesces concurrent status requests into one shell probe and retains the cache', async () => {
    await installLoginShell({
      ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_AUTH_TOKEN: TOKEN,
      ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: FAST_MODEL,
    });
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const bridge = new ClaudeMultimodelBridgeService();
    await Promise.all(
      Array.from({ length: 6 }, () => bridge.getProviderStatus(runtimePath, 'anthropic'))
    );
    await bridge.getProviderStatus(runtimePath, 'anthropic');

    expect(await readCalls('shell-calls.jsonl')).toHaveLength(1);
    expect(shellEnv.getCachedShellEnv()).toMatchObject({ ANTHROPIC_MODEL: MODEL });
    const calls = await readCalls('runtime-calls.jsonl');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.tokenPresent === true && call.model === MODEL)).toBe(true);
    expect(requests).toEqual([]);
    expect(fixture.lookupPreferred).not.toHaveBeenCalled();
  });

  it('retains the missing-token failure when the discovered shell has no credential', async () => {
    await installLoginShell({
      ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: FAST_MODEL,
    });
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const status = await new ClaudeMultimodelBridgeService().getProviderStatus(
      runtimePath,
      'anthropic',
      undefined,
      { projectPath: sandbox }
    );

    expect(status).toMatchObject({
      authenticated: false,
      effectiveDefaultModel: null,
      capabilities: { teamLaunch: false },
      detailMessage:
        'Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for this Anthropic-compatible endpoint.',
    });
    expect(requests).toEqual([]);
    expect(await readCalls('shell-calls.jsonl')).toHaveLength(1);
    expect(fixture.lookupPreferred).not.toHaveBeenCalled();
  });

  it('publishes the authenticated catalog after a shell slower than the initial status budgets', async () => {
    await installLoginShell(
      {
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        ANTHROPIC_MODEL: MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: FAST_MODEL,
      },
      3_800
    );
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    let resolveCatalog!: (status: CliProviderStatus) => void;
    const catalog = new Promise<CliProviderStatus>((resolve) => {
      resolveCatalog = resolve;
    });
    try {
      const initial = await new ClaudeMultimodelBridgeService().getProviderStatus(
        runtimePath,
        'anthropic',
        resolveCatalog
      );

      expect(initial.authenticated).toBe(false);
      expect(shellEnv.getCachedShellEnv()).toBeNull();
      await expect(catalog).resolves.toMatchObject({
        authenticated: true,
        verificationState: 'verified',
        effectiveDefaultModel: MODEL,
        models: [MODEL, FAST_MODEL],
        modelCatalogRefreshState: 'ready',
        capabilities: { teamLaunch: true },
      });
      expect(requests).toEqual([{ url: '/v1/models', authorized: true }]);
      expect(await readCalls('shell-calls.jsonl')).toHaveLength(1);
      expect(fixture.lookupPreferred).not.toHaveBeenCalled();
    } finally {
      // Join the fixture's already-started probe even on a failed assertion so
      // no owned delayed child can outlive its disposable home/server.
      await shellEnv.resolveInteractiveShellEnv();
    }
  });

  it('keeps shell failure unauthenticated and reuses its cooldown for later status refreshes', async () => {
    await installLoginShell({});
    await writeFile(
      path.join(sandbox, 'login-shell.cjs'),
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(sandbox, 'shell-calls.jsonl'))}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
process.exitCode = 42;
`
    );
    vi.stubEnv('ANTHROPIC_BASE_URL', endpoint);
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const bridge = new ClaudeMultimodelBridgeService();
    for (let index = 0; index < 2; index += 1) {
      const status = await bridge.getProviderStatus(runtimePath, 'anthropic', undefined, {
        projectPath: sandbox,
      });
      expect(status).toMatchObject({
        authenticated: false,
        effectiveDefaultModel: null,
        capabilities: { teamLaunch: false },
      });
    }

    expect(await readCalls('shell-calls.jsonl')).toEqual([
      { args: ['-lic', expect.stringContaining(' && env -0 && ')] },
      { args: ['-ic', expect.stringContaining(' && env -0 && ')] },
    ]);
    expect(shellEnv.getCachedShellEnv()).toBeNull();
    expect(requests).toEqual([]);
    expect(fixture.lookupPreferred).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[Utils:shellEnv]',
      expect.stringContaining('Failed to resolve shell env after login and interactive probes')
    );
    vi.mocked(console.warn).mockClear();
  });

  it.each(['oauth', 'api_key', 'compatible'] as const)(
    'does not start automatic shell discovery for explicit %s mode',
    async (mode) => {
      if (mode === 'compatible') fixture.compatibleEndpoint = { enabled: true, baseUrl: endpoint };
      else fixture.authMode = mode;
      await installLoginShell({ ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: TOKEN });
      const { ClaudeMultimodelBridgeService } =
        await import('@main/services/runtime/ClaudeMultimodelBridgeService');
      await new ClaudeMultimodelBridgeService().getProviderStatus(runtimePath, 'anthropic');

      expect(shellEnv.getCachedShellEnv()).toBeNull();
      await expect(readCalls('shell-calls.jsonl')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(requests).toEqual([]);
      expect(fixture.lookupPreferred).not.toHaveBeenCalled();
    }
  );
});
