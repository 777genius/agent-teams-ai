// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTeamControlApiBaseUrl,
  clearTeamControlApiState,
  writeTeamControlApiState,
} from '@main/services/team/TeamControlApiState';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

// Exercise the existing private Host wiring with offline server doubles. Importing
// main/index would boot Electron and all app services, outside this test's scope.
const source = ts.createSourceFile(
  'index.ts',
  await readFile(path.resolve('src/main/index.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
function functionSource(name: string): string {
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
  );
  if (!declaration) throw new Error(`Missing Host function ${name}`);
  return declaration.getText(source);
}

function createHost() {
  let running = false;
  let shuttingDown = false;
  const server = {
    isRunning: () => running,
    getPort: () => 4591,
    start: vi.fn(() => {
      running = true;
      return Promise.resolve(4591);
    }),
    stop: vi.fn(() => {
      running = false;
      return Promise.resolve();
    }),
  };
  const code = ts.transpileModule(
    ['getTeamControlApiBaseUrl', 'syncTeamControlApiState', 'startHttpServer']
      .map(functionSource)
      .join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  // Only named functions from this repository are executed, with offline dependencies.
  // eslint-disable-next-line sonarjs/code-eval -- trusted local source, no user input
  const host = runInNewContext(`${code}\n({ startHttpServer })`, {
    httpServer: server,
    isShutdownStarted: () => shuttingDown,
    buildTeamControlApiBaseUrl,
    clearTeamControlApiState,
    writeTeamControlApiState,
    configManager: { getConfig: () => ({ httpServer: { port: 3456 } }) },
    contextRegistry: { getActive: () => ({}) },
    teamHttpHandlerApis: {},
    bindTeamHttpDataApi: () => ({}),
    teamDataService: {},
    recentProjectsFeature: {},
    organizationsFeature: {},
    workspaceTrustStatus: {},
    tokenUsageFeature: null,
    memberWorkSyncFeature: null,
    updaterService: {},
    sshConnectionManager: {},
    logger: { info: vi.fn(), error: vi.fn() },
  }) as { startHttpServer: (handler: () => Promise<void>) => Promise<void> };
  return {
    server,
    start: () => host.startHttpServer(() => Promise.resolve()),
    shutdown: () => {
      shuttingDown = true;
    },
  };
}

describe('existing app Host endpoint wiring', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'app-control-host-'));
    setClaudeBasePathOverride(root);
    vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', 'http://127.0.0.1:9999');
  });
  afterEach(async () => {
    await clearTeamControlApiState();
    setClaudeBasePathOverride(null);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('revokes inherited endpoint before initializing services or exposing provider handlers', () => {
    const init = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'initializeServices'
    );
    expect(init?.body?.statements[0]?.getText(source)).toBe('await clearTeamControlApiState();');
  });

  it('publishes the listening fallback port on cold start and already-running start', async () => {
    const host = createHost();
    await host.start();
    expect(host.server.start).toHaveBeenCalledWith(expect.any(Object), expect.any(Function), 3456);
    expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBe('http://127.0.0.1:4591');
    expect(
      JSON.parse(await readFile(path.join(root, 'team-control-api.json'), 'utf8')).baseUrl
    ).toBe('http://127.0.0.1:4591');
    await host.start();
    expect(host.server.start).toHaveBeenCalledOnce();
    expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBe('http://127.0.0.1:4591');
  });

  it('clears both publications when server startup fails', async () => {
    await writeTeamControlApiState('http://127.0.0.1:4590');
    const host = createHost();
    host.server.start.mockRejectedValueOnce(new Error('all ports occupied'));
    await expect(host.start()).rejects.toThrow('all ports occupied');
    expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
    await expect(readFile(path.join(root, 'team-control-api.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('clears both publications when shutdown interrupts server startup', async () => {
    await writeTeamControlApiState('http://127.0.0.1:4590');
    const host = createHost();
    host.server.start.mockImplementationOnce(() => {
      host.shutdown();
      return Promise.resolve(4591);
    });
    await host.start();
    expect(host.server.stop).toHaveBeenCalledOnce();
    expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
    await expect(readFile(path.join(root, 'team-control-api.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
