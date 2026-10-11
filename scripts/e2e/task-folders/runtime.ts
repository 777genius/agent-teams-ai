import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { gracefulClose, stopOwnedGroup } from './shutdown.ts';
// Existing transport only; the harness below owns its typed interaction contract.
// @ts-expect-error Existing CDP JavaScript transport has no declarations.
import { CdpClient } from '../comment-notification/cdp.mjs';
import type { Snapshot } from '../../../src/features/task-folders/core/domain/folders.ts';

export interface Cdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): void;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
}
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
export async function until(predicate: () => Promise<unknown>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
export async function fixture(repo: string) {
  const scratch = await realpath(
    process.env.TASK_FOLDERS_E2E_SCRATCH ?? path.join(repo, '.tool', 'scratch')
  );
  assert(scratch.startsWith('/srv/workers/'), 'Scratch must be under /srv/workers');
  if (process.env.TMPDIR) {
    const tmp = await realpath(process.env.TMPDIR);
    assert(
      tmp.startsWith(path.join(repo, '.tool') + path.sep) || tmp.startsWith(scratch + path.sep),
      'TMPDIR must resolve inside owned job scratch'
    );
  }
  const root = await mkdtemp(path.join(scratch, 'tf-TEST-'));
  try {
    const team = 'task-folders-TEST-' + randomUUID();
    const project = path.join(root, 'TEST-project');
    const claude = path.join(root, 'claude');
    const env: Record<string, string> = Object.fromEntries(
      ['PATH', 'DISPLAY', 'XAUTHORITY'].flatMap((k) =>
        process.env[k] ? [[k, process.env[k]!]] : []
      )
    );
    Object.assign(env, {
      HOME: path.join(root, 'home'),
      TMPDIR: path.join(root, 'tmp'),
      AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
      AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(root, 'user-data'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'multimodel-data'),
      CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'multimodel-cache'),
      COREPACK_HOME: path.join(root, 'corepack'),
      CLAUDE_DEV_RUNTIME_CACHE_ROOT: path.join(root, 'runtime-cache'),
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC',
      SHELL: '/bin/sh',
      CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
      AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
      pnpm_config_verify_deps_before_run: 'false',
      NODE_BINARY: await realpath(process.execPath),
    });
    for (const key of ['CONFIG', 'DATA', 'CACHE', 'STATE', 'RUNTIME'])
      env[`XDG_${key}_${key === 'RUNTIME' ? 'DIR' : 'HOME'}`] = path.join(
        root,
        'xdg-' + key.toLowerCase()
      );
    const dirs = [
      project,
      path.join(claude, 'teams', team, 'inboxes'),
      path.join(claude, 'tasks', team),
      path.join(claude, 'projects'),
      path.join(root, 'screenshots'),
      ...Object.values(env).filter((v) => v.startsWith(root)),
    ];
    await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
    if (process.env.TMPDIR) {
      // Preserve operator's short symlink spelling for UNIX socket path limits.
      env.TMPDIR = await mkdtemp(path.join(process.env.TMPDIR, 'tf-'));
    }
    await chmod(env.XDG_RUNTIME_DIR, 0o700);
    await writeFile(path.join(root, '.test-only'), 'task-folders-desktop-v1\n');
    await writeFile(path.join(project, 'README.md'), '# Disposable task folders fixture\n');
    const audit = path.join(root, 'runtime-audit.ndjson');
    await writeFile(audit, '');
    const runtime = path.join(root, 'deny-runtime.ts');
    const version = (
      JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const denySource = await readFile(
      path.join(repo, 'scripts/e2e/task-folders/deny-runtime.ts'),
      'utf8'
    );
    await writeFile(runtime, denySource.replace('#!/usr/bin/env node', '#!' + process.execPath));
    env.TASK_FOLDERS_E2E_RUNTIME_AUDIT = audit;
    env.TASK_FOLDERS_E2E_RUNTIME_VERSION = version;
    await chmod(runtime, 0o755);
    env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = runtime;
    env.CLAUDE_TERMINAL_DAEMON_BINARY = runtime;
    env.CLAUDE_TEAM_OPENCODE_MCP_HTTP = '0';
    if (process.getuid?.() === 0) env.NO_SANDBOX = '1';
    const members = [
      {
        name: 'team-lead',
        agentId: 'team-lead@' + team,
        agentType: 'team-lead',
        cwd: project,
        joinedAt: Date.now() - 86400000,
        color: 'blue',
        subscriptions: [],
      },
    ];
    await json(path.join(claude, 'agent-teams-config.json'), {
      general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
    });
    await json(path.join(claude, 'teams', team, 'config.json'), {
      name: team,
      description: 'Disposable task folders E2E',
      createdAt: Date.now() - 86400000,
      leadAgentId: members[0].agentId,
      members,
      projectPath: project,
      projectPathHistory: [project],
    });
    await json(path.join(claude, 'teams', team, 'members.meta.json'), { version: 1, members });
    await json(path.join(claude, 'teams', team, 'team.meta.json'), {
      version: 1,
      cwd: project,
      createdAt: Date.now() - 86400000,
      prompt: 'Test only. Never launch.',
    });
    const task = (id: string) => ({
      kind: 'task' as const,
      identity: { teamName: team, taskId: id },
    });
    const parent = '00000000-0000-4000-8000-000000000001';
    const nested = '00000000-0000-4000-8000-000000000002';
    const snapshot: Snapshot = {
      version: 1,
      revision: 1,
      rootFolderIds: [parent],
      folders: [
        { id: parent, name: 'Seed parent', children: [{ kind: 'folder', id: nested }] },
        {
          id: nested,
          name: 'Seed nested',
          children: [task('a'), task('missing'), task('archived'), task('b')],
        },
      ],
    };
    for (let i = 0; i < 180; i++) {
      const id = '10000000-0000-4000-8000-' + String(i).padStart(12, '0');
      snapshot.rootFolderIds.push(id);
      snapshot.folders.push({
        id,
        name: 'Large folder ' + String(i).padStart(3, '0'),
        children: [],
      });
    }
    const ids = ['a', 'b', 'c', 'archived', ...Array.from({ length: 1000 }, (_, i) => 'bulk-' + i)];
    await Promise.all(
      ids.map((id) =>
        json(path.join(claude, 'tasks', team, id + '.json'), {
          id,
          subject: 'TEST task ' + id,
          description: 'Disposable task only',
          status: 'pending',
          owner: 'team-lead',
          blocks: [],
          blockedBy: [],
          comments: [],
          createdAt: new Date().toISOString(),
        })
      )
    );
    const old = new Date(Date.now() - 86400000);
    await Promise.all(
      ids
        .filter((id) => id.startsWith('bulk-'))
        .map((id) => utimes(path.join(claude, 'tasks', team, id + '.json'), old, old))
    );
    return {
      root,
      team,
      project,
      claude,
      env,
      audit,
      snapshot,
      parent,
      nested,
      task,
      taskIds: ids,
    };
  } catch (error) {
    await json(path.join(root, 'receipt.json'), {
      kind: 'task-folders-desktop-v1',
      passed: false,
      fixtureSetupFailed: true,
      root,
      failure: String(error),
    });
    throw new Error('Fixture setup failed; evidence: ' + root, { cause: error });
  }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export class Desktop {
  app?: ChildProcess;
  cdp?: Cdp;
  port?: number;
  logs = '';
  logHistory: string[] = [];
  faults: unknown[] = [];
  ownership: unknown[] = [];
  private spawnError?: Error;
  private rendererPort?: number;
  private rendererOrigin?: string;
  private intercepted?: Record<string, unknown>;
  constructor(
    readonly repo: string,
    readonly f: Fixture
  ) {}
  async start() {
    // A busy default port is recorded, never attached or terminated. The approved launcher chooses a free one.
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(9222, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    const portOwnership = await promisify(execFile)('ss', ['-ltnp', 'sport = :9222'])
      .then((result) => result.stdout)
      .catch((error) => 'ss ownership probe failed: ' + String(error));
    this.ownership.push({ defaultPort: 9222, available, portOwnership });
    assert(!this.app, 'Previous owned launch must stop before restart');
    if (!this.rendererPort) {
      this.rendererPort = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          assert(address && typeof address !== 'string');
          server.close(() => resolve(address.port));
        });
      });
    }
    // Installed electron-vite 5 documents --config (not a renderer --port flag).
    // strictPort fails on a collision instead of silently changing the storage origin.
    const config = path.join(this.f.root, 'electron.e2e.config.mts');
    await writeFile(
      config,
      `import config from ${JSON.stringify(path.join(this.repo, 'electron.vite.config.ts'))};
export default {...config, renderer: {...config.renderer, server: {...config.renderer?.server, port: ${this.rendererPort}, strictPort: true}}};
`
    );
    const pnpm = process.env.TASK_FOLDERS_E2E_PNPM;
    this.logs = '';
    this.spawnError = undefined;
    this.app = spawn(
      pnpm ? process.execPath : 'pnpm',
      pnpm ? [pnpm, 'dev:mcp', '--', '--config', config] : ['dev:mcp', '--', '--config', config],
      {
        cwd: this.repo,
        env: this.f.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    this.app.on('error', (error) => {
      this.spawnError = error;
    });
    this.ownership.push({
      pid: this.app.pid,
      processGroup: this.app.pid,
      defaultPortAvailable: available,
      launchedAt: new Date().toISOString(),
      fixture: this.f.root,
    });
    for (const stream of [this.app.stdout, this.app.stderr])
      stream?.on('data', (chunk: Buffer) => {
        this.logs += chunk.toString();
      });
    await until(
      async () => {
        if (this.spawnError) throw this.spawnError;
        if (this.app?.exitCode !== null)
          throw new Error('Owned launcher exited: ' + this.app?.exitCode);
        const port = this.logs.match(
          /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//
        )?.[1];
        if (!port) return false;
        this.port = Number(port);
        try {
          await this.connect();
          return true;
        } catch {
          return false;
        }
      },
      'owned Electron DevTools URL from spawned logs',
      180_000
    );
    await this.ready();
  }
  async connect() {
    assert(this.port, 'Owned debug port not discovered');
    const targets = (await fetch(`http://127.0.0.1:${this.port}/json/list`).then((r) =>
      r.json()
    )) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const renderer = targets.find(
      (t) => t.type === 'page' && /^http:\/\/localhost:\d+/.test(t.url)
    );
    assert(renderer, 'Owned desktop renderer missing');
    const origin = new URL(renderer.url).origin;
    assert.equal(new URL(origin).port, String(this.rendererPort), 'Unexpected renderer port');
    if (this.rendererOrigin) assert.equal(origin, this.rendererOrigin, 'Renderer origin changed');
    this.rendererOrigin = origin;
    await this.cdp?.close();
    this.cdp = (await CdpClient.connect(renderer.webSocketDebuggerUrl)) as Cdp;
    this.ownership.push({
      port: this.port,
      renderer: renderer.url,
      endpoint: renderer.webSocketDebuggerUrl,
    });
    this.cdp.on('Runtime.exceptionThrown', (e) => this.faults.push(e));
    this.cdp.on('Runtime.consoleAPICalled', (e) => {
      if ((e as { type: string }).type === 'error') this.faults.push(e);
    });
    this.cdp.on('Log.entryAdded', (e) => {
      if ((e as { entry: { level: string } }).entry.level === 'error') this.faults.push(e);
    });
    this.cdp.on('Input.dragIntercepted', (e) => {
      this.intercepted = (e as { data: Record<string, unknown> }).data;
    });
    for (const method of ['Runtime.enable', 'Page.enable', 'Log.enable'])
      await this.cdp.send(method);
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await this.cdp.send('Input.setInterceptDrags', { enabled: true });
  }
  async ready() {
    await until(
      async () => {
        try {
          return await this.cdp!.evaluate(
            '(async()=> !!window.__agentTeamsDevStore && !!(await window.electronAPI.startup.getStatus()).ready)()'
          );
        } catch (e) {
          if (/execution context|No handler registered/.test(String(e))) return false;
          throw e;
        }
      },
      'startup.getStatus.ready',
      90_000
    );
    await this.cdp!.evaluate('window.__agentTeamsDevStore.getState().fetchAllTasks()');
    await until(
      () =>
        this.cdp!.evaluate(
          `window.__agentTeamsDevStore.getState().globalTasks.some(t=>t.teamName===${JSON.stringify(this.f.team)})`
        ),
      'fixture task catalog',
      60_000
    );
    await this.cdp!.evaluate(
      `(() => {const s=window.__agentTeamsDevStore.getState(); if(s.sidebarCollapsed)s.toggleSidebar();})()`
    );
  }
  takeDrag() {
    const data = this.intercepted;
    this.intercepted = undefined;
    return data;
  }
  async stop(emergency = false) {
    const group = this.app?.pid;
    try {
      if (group && !emergency) {
        assert(this.cdp && this.port, 'Graceful stop requires owned renderer');
        const evidence = await gracefulClose(this.cdp, this.port, group);
        this.ownership.push({ gracefulClose: evidence, group });
      }
    } finally {
      // Only after native exit (or a failed close): remove own launcher/build descendants.
      if (group) await stopOwnedGroup(group);
      if (this.cdp) {
        await Promise.race([
          this.cdp.close(),
          delay(2000).then(() => {
            throw new Error('CDP cleanup timed out');
          }),
        ]);
      }
      this.cdp = undefined;
      this.port = undefined;
      this.ownership.push({ stoppedGroup: group, emergency, stoppedAt: new Date().toISOString() });
      this.logHistory.push(this.logs);
      this.logs = '';
      this.app = undefined;
    }
  }
}
