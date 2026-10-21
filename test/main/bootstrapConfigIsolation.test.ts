// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';

const mainRoot = path.resolve(import.meta.dirname, '../../src/main');
let sandbox: string | undefined;

afterEach(async () => {
  const { installStandardOutputGuard } = await import('../../src/main/utils/standardOutputGuard');
  installStandardOutputGuard(process.stdout)();
  installStandardOutputGuard(process.stderr)();
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.doUnmock('electron');
  vi.doUnmock('agent-teams-controller');
  vi.doUnmock('../../src/main/services/gateway/composeGatewayProviderRuntime');
  vi.doUnmock('../../src/main/utils/atomicWrite');
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

it('applies profile paths before entrypoint imports construct the configuration singleton', async () => {
  vi.resetModules();
  sandbox = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'TEST-main-config-isolation-')));
  const nativeHome = path.join(sandbox, 'native-home');
  const isolatedClaude = path.join(sandbox, 'isolated-home', '.claude');
  const userData = path.join(sandbox, 'user-data');
  mkdirSync(path.join(nativeHome, '.claude'), { recursive: true });
  const nativeConfig = path.join(nativeHome, '.claude', 'agent-teams-config.json');
  const sentinel = JSON.stringify({
    providerConnections: {
      anthropic: {
        authMode: 'auto',
        compatibleEndpoint: { enabled: true, baseUrl: 'http://127.0.0.1:1' },
      },
    },
  });
  writeFileSync(nativeConfig, sentinel);
  // Both the OS-home fallback and explicit profile belong to this disposable test.
  vi.stubEnv('HOME', nativeHome);
  vi.stubEnv('USERPROFILE', nativeHome);
  vi.stubEnv('AGENT_TEAMS_ELECTRON_USER_DATA_DIR', userData);
  vi.stubEnv('AGENT_TEAMS_ELECTRON_CLAUDE_ROOT', isolatedClaude);
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => (name === 'home' ? nativeHome : userData),
      setPath: vi.fn(),
    },
  }));
  // These integrations are irrelevant to path initialization. Keep the actual
  // BootstrapSpec -> AgentLanguage -> ConfigManager eager-import chain live.
  vi.doMock('../../src/main/services/gateway/composeGatewayProviderRuntime', () => ({}));
  vi.doMock('agent-teams-controller', () => ({
    AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES: [],
  }));
  vi.doMock('../../src/main/utils/atomicWrite', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/main/utils/atomicWrite')>()),
    atomicWriteAsync: vi.fn(async () => {}),
  }));

  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(path.join(mainRoot, 'index.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let initializedPaths = false;
  // Evaluate the real entrypoint's import prefix, without starting its app/IPC
  // lifecycle. A value import added before bootstrap must expose its side effects.
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    await import(specifier.startsWith('.') ? path.resolve(mainRoot, specifier) : specifier);
    if (specifier === './bootstrapUserDataMigration') {
      initializedPaths = true;
      break;
    }
  }
  expect(initializedPaths).toBe(true);
  const { configManager } = await import('../../src/main/services/infrastructure/ConfigManager');
  expect(configManager.getConfigPath()).toBe(path.join(isolatedClaude, 'agent-teams-config.json'));
  expect(configManager.getConfig().providerConnections.anthropic).toMatchObject({
    authMode: 'auto',
    compatibleEndpoint: { enabled: false, baseUrl: '' },
  });
  expect(readFileSync(nativeConfig, 'utf8')).toBe(sentinel);
});
