import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { RetainedApiPublicationError } from '@features/local-http-auth/main';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  readinessFailure: undefined as Error | undefined,
  beforePublish: undefined as undefined | (() => Promise<void>),
}));
vi.mock('@features/local-http-auth/main', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/local-http-auth/main')>();
  return {
    ...actual,
    RetainedApiPublicationError: Reflect.get(actual, 'RetainedApiPublicationError'),
    checkApiReadiness: vi.fn(async () => {
      if (state.readinessFailure) throw state.readinessFailure;
    }),
    publishApiAuthority: async (...args: Parameters<typeof actual.publishApiAuthority>) => {
      await state.beforePublish?.();
      return actual.publishApiAuthority(...args);
    },
  };
});
vi.mock('@main/utils/pathDecoder', () => ({ getClaudeBasePath: () => state.root }));
const envKeys = [
  'CLAUDE_TEAM_CONTROL_URL',
  'CLAUDE_TEAM_CONTROL_AUTH_TOKEN',
  'CLAUDE_TEAM_CONTROL_AUTH_REF',
];
let previous: Array<string | undefined>;
let root: string;
const token = 'a'.repeat(64);

beforeEach(async () => {
  previous = envKeys.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'api-publication-')));
  state.root = root;
  state.beforePublish = undefined;
  state.readinessFailure = undefined;
  vi.resetModules();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  envKeys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
});
const discovery = () => path.join(state.root, 'team-control-api.json');

it('publishes private token-free discovery and revokes the environment synchronously on clear', async () => {
  const api = await import('@main/services/team/TeamControlApiState');
  await api.writeTeamControlApiState('http://127.0.0.1:3456', token);
  const raw = await readFile(discovery(), 'utf8');
  expect(raw).not.toContain(token);
  const reference = JSON.parse(raw);
  const authority = JSON.parse(await readFile(reference.descriptorPath, 'utf8'));
  expect(authority).toMatchObject({ service: 'api', token, baseUrl: 'http://127.0.0.1:3456' });
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBeTruthy();
  const clearing = api.clearTeamControlApiState();
  expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_TOKEN).toBeUndefined();
  await clearing;
  await expect(readFile(discovery())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves another independently instantiated publisher when the older instance stops', async () => {
  const first = await import('@main/services/team/TeamControlApiState');
  await first.writeTeamControlApiState('http://127.0.0.1:3456', token);
  vi.resetModules();
  const second = await import('@main/services/team/TeamControlApiState');
  await second.writeTeamControlApiState('http://127.0.0.1:3457', 'b'.repeat(64));
  const current = await readFile(discovery(), 'utf8');
  await first.clearTeamControlApiState();
  expect(await readFile(discovery(), 'utf8')).toBe(current);
  const reference = JSON.parse(current);
  expect(JSON.parse(await readFile(reference.descriptorPath, 'utf8')).token).toBe('b'.repeat(64));
  await second.clearTeamControlApiState();
});

it('serializes write/clear and clear/write without publishing a stopped generation', async () => {
  const api = await import('@main/services/team/TeamControlApiState');
  await Promise.all([
    api.writeTeamControlApiState('http://127.0.0.1:3456', token),
    api.clearTeamControlApiState(),
  ]);
  await expect(readFile(discovery())).rejects.toMatchObject({ code: 'ENOENT' });
  await Promise.all([
    api.clearTeamControlApiState(),
    api.writeTeamControlApiState('http://127.0.0.1:3457', token),
  ]);
  expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBe('http://127.0.0.1:3457');
  await api.clearTeamControlApiState();
});

it('retains managed environment and files after an idempotent manual-discovery failure', async () => {
  const api = await import('@main/services/team/TeamControlApiState');
  await api.writeTeamControlApiState('http://127.0.0.1:3456', token);
  const reference = process.env.CLAUDE_TEAM_CONTROL_AUTH_REF!;
  const before = await readFile(reference, 'utf8');
  await writeFile(discovery(), '{}\n', { mode: 0o600 });
  await expect(api.syncTeamControlApiAuthority('http://127.0.0.1:3456', token)).rejects.toThrow();
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBe(reference);
  expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBe('http://127.0.0.1:3456');
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_TOKEN).toBe(token);
  expect(await readFile(reference, 'utf8')).toBe(before);
  expect(JSON.parse(await readFile(JSON.parse(before).descriptorPath, 'utf8')).token).toBe(token);
});

it.each(['clear', 'new write', 'root change'] as const)(
  'never restores stale environment after a concurrent %s',
  async (action) => {
    const api = await import('@main/services/team/TeamControlApiState');
    await api.writeTeamControlApiState('http://127.0.0.1:3456', token);
    await writeFile(discovery(), '{}\n', { mode: 0o600 });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.beforePublish = async () => {
      entered();
      await gate;
    };
    const republishing = api.writeTeamControlApiState('http://127.0.0.1:3456', token);
    const rejected = expect(republishing).rejects.toThrow();
    await started;
    let next: Promise<void> | undefined;
    if (action === 'clear') next = api.clearTeamControlApiState().catch(() => undefined);
    if (action === 'new write')
      next = api.writeTeamControlApiState('http://127.0.0.1:3457', token).catch(() => undefined);
    if (action === 'root change') state.root = path.join(root, 'other-profile');
    release();
    await rejected;
    await next;
    expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBeUndefined();
    expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
    expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_TOKEN).toBeUndefined();
  }
);

// Execute only the existing startup function with offline ports; importing main boots Electron.
async function offlineHost(api: typeof import('@main/services/team/TeamControlApiState')) {
  const source = ts.createSourceFile(
    'index.ts',
    await readFile(path.resolve('src/main/index.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'startHttpServer'
  );
  if (!declaration) throw new Error('Missing HTTP startup function');
  let running = false;
  const server = {
    isRunning: () => running,
    start: vi.fn(async () => {
      running = true;
      return 3456;
    }),
    stop: vi.fn(async () => {
      running = false;
    }),
  };
  const code = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const host = runInNewContext(code + '\n({ startHttpServer })', {
    RetainedApiPublicationError,
    httpServer: server,
    isShutdownStarted: () => false,
    StartupCancelledError: Error,
    startupStage: (operation: () => Promise<void>) => operation(),
    assertStartupActive: () => undefined,
    syncTeamControlApiState: () => api.syncTeamControlApiAuthority('http://127.0.0.1:3456', token),
    clearTeamControlApiState: api.clearTeamControlApiState,
    configManager: { getConfig: () => ({}) },
    currentHttpServices: () => ({}),
    logger: { info: vi.fn(), error: vi.fn() },
  }) as { startHttpServer: (callback: () => Promise<void>) => Promise<void> };
  return { server, start: () => host.startHttpServer(async () => undefined) };
}

it('keeps an already running listener and its committed authority after refresh failure through app startup', async () => {
  const api = await import('@main/services/team/TeamControlApiState');
  const host = await offlineHost(api);
  await host.start();
  const reference = process.env.CLAUDE_TEAM_CONTROL_AUTH_REF!;
  const before = await readFile(reference, 'utf8');
  await writeFile(discovery(), '{}\n', { mode: 0o600 });
  await expect(host.start()).rejects.toThrow();
  expect(host.server.isRunning()).toBe(true);
  expect(host.server.stop).not.toHaveBeenCalled();
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBe(reference);
  expect(await readFile(reference, 'utf8')).toBe(before);
  expect(JSON.parse(await readFile(JSON.parse(before).descriptorPath, 'utf8')).token).toBe(token);
});

it('stops a new listener and clears its unpublished generation when initial publication fails', async () => {
  const api = await import('@main/services/team/TeamControlApiState');
  const host = await offlineHost(api);
  await writeFile(discovery(), '{}\n', { mode: 0o600 });
  await expect(host.start()).rejects.toThrow();
  expect(host.server.isRunning()).toBe(false);
  expect(host.server.stop).toHaveBeenCalledOnce();
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBeUndefined();
  expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
  const { readdir } = await import('node:fs/promises');
  expect(
    (await readdir(path.join(root, 'local-http-auth'))).filter((file) => file.endsWith('.json'))
  ).toEqual([]);
});

it('revokes committed discovery when a running listener fails authenticated readiness', async () => {
  const api = await import('@main/services/team/TeamControlApiState');
  const host = await offlineHost(api);
  await host.start();
  const reference = process.env.CLAUDE_TEAM_CONTROL_AUTH_REF!;
  const descriptor = JSON.parse(await readFile(reference, 'utf8')).descriptorPath;
  state.readinessFailure = new Error('authenticated readiness failed');
  await expect(host.start()).rejects.toThrow('authenticated readiness failed');
  expect(host.server.stop).not.toHaveBeenCalled();
  expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBeUndefined();
  await expect(readFile(reference)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
});
