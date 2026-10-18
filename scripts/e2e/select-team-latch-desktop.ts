#!/usr/bin/env node
// Run: pnpm test:e2e:select-team-latch
// Negative control: pnpm test:e2e:select-team-latch --without-settlement (must fail with a latched cold view).
// Reproducible Electron renderer E2E for the selectTeam() stale-read loading latch.
//
// The critical bug: while selectTeam() owns selectedTeamLoading, a team lifecycle
// action (restore/launch/delete/create) bumps the team-local state epoch mid-read.
// The in-flight snapshot is then discarded as stale, and the duplicate guard blocks
// any re-entry, so the Team Details view latches on TeamLoadingSkeleton forever.
//
// The harness creates only a disposable team/project, launches the real `pnpm
// dev:mcp` desktop app, and replaces only getData/restoreTeam renderer API methods
// through response-stage CDP Fetch interception. Source invalidation runs through
// the real invalidateTaskDetailTeamSource store action, matching the field report. It never launches a provider. Evidence is written outside the repository.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// @ts-expect-error Existing shared CDP transport has no TypeScript declaration.
import { CdpClient as RawCdpClient } from './comment-notification/cdp.mjs';
import type { ChildProcess } from 'node:child_process';

type FixturePath =
  | 'claudeRoot'
  | 'userDataRoot'
  | 'claudeConfigDir'
  | 'multimodelDataHome'
  | 'multimodelCacheHome'
  | 'xdgConfigHome'
  | 'xdgDataHome'
  | 'xdgCacheHome'
  | 'xdgStateHome'
  | 'xdgRuntimeDir'
  | 'projectPath'
  | 'runtimeWrapperPath'
  | 'runtimeLedgerPath';
type Fixture = Record<FixturePath, string> & {
  kind: string;
  root: string;
  teamName: string;
  coldTeamName: string;
  raceTeamName: string;
  exhaustTeamName: string;
  deliveryRuntimeVersion: string;
  teamNames?: string[];
};
interface Lifecycle {
  reads: Record<string, number>;
  transports: { raw: number; legacy: number };
  restore: number;
  list: number;
}
interface LoadState {
  loading: boolean;
  hasData: boolean;
  team: string;
  error: string | null;
}
interface RendererTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
interface Evidence {
  kind: string;
  fixture: string;
  evidenceRoot: string;
  providerLaunched: boolean;
  cdpPort: number | null;
  rendererNavigations: number;
  assertions: string[];
  screenshots: string[];
  [key: string]: unknown;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const evidenceRoot = path.resolve(
  process.env.AGENT_TEAMS_LATCH_E2E_EVIDENCE ??
    path.join(os.tmpdir(), 'agent-teams-select-team-latch-desktop-evidence')
);
const withoutSettlement = process.argv.includes('--without-settlement');
let settlementControlPatches = 0;
const apiModuleSuffix = '/src/renderer/api/index.ts';
const expectedApiModulePaths = new Set([
  '/api/index.ts',
  apiModuleSuffix,
  `/@fs${repoRoot}${apiModuleSuffix}`,
  `/@fs/${repoRoot}${apiModuleSuffix}`,
]);
const apiNeedle = 'function getImpl() {\n  if (window.electronAPI) return window.electronAPI;';
const appLogTail: string[] = [];
const appLogRemainder = { stdout: '', stderr: '' };
const consoleWarnings: string[] = [];
let appProcess: ChildProcess | null = null;
let appProcessGroupId: number | null = null;
let cdp: CdpClient | null = null;

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function rememberAppLog(chunk: Buffer | string, stream: keyof typeof appLogRemainder) {
  const text = chunk.toString();
  const lines = `${appLogRemainder[stream]}${text}`.split(/\r?\n/);
  appLogRemainder[stream] = lines.pop() ?? '';
  appLogTail.push(...lines.filter(Boolean));
  if (appLogTail.length > 400) appLogTail.splice(0, appLogTail.length - 400);
  if (process.env.AGENT_TEAMS_LATCH_E2E_VERBOSE === '1') process.stdout.write(text);
}

async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function seedFixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'select-team-latch-desktop-e2e-'))
  );
  const runtimeLock = JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
  assert(/^\d+\.\d+\.\d+$/.test(runtimeLock.version), 'runtime.lock.json version is invalid');
  const teamSeed = randomUUID();
  const fixture: Fixture = {
    kind: 'select-team-latch-disposable-desktop-v2',
    root,
    claudeRoot: path.join(root, '.claude'),
    userDataRoot: path.join(root, 'user-data'),
    claudeConfigDir: path.join(root, 'claude-config'),
    multimodelDataHome: path.join(root, 'multimodel-data'),
    multimodelCacheHome: path.join(root, 'multimodel-cache'),
    xdgConfigHome: path.join(root, 'xdg-config'),
    xdgDataHome: path.join(root, 'xdg-data'),
    xdgCacheHome: path.join(root, 'xdg-cache'),
    xdgStateHome: path.join(root, 'xdg-state'),
    xdgRuntimeDir: path.join(root, 'xdg-runtime'),
    projectPath: path.join(root, 'sandbox-project'),
    // Four disposable teams: warm-up absorbs Vite's first-open dependency reload, the
    // cold team proves the golden path, the race team is only ever loaded through the
    // stale-read race, and the exhaust team is never loaded successfully at all, so the
    // retry-budget scenario renders the cold view with no cached snapshot behind it.
    teamName: `latch-e2e-${teamSeed}`,
    coldTeamName: `latch-e2e-${teamSeed}-cold`,
    raceTeamName: `latch-e2e-${teamSeed}-race`,
    exhaustTeamName: `latch-e2e-${teamSeed}-exhaust`,
    runtimeWrapperPath: path.join(root, 'fixture-runtime-deny.cjs'),
    runtimeLedgerPath: path.join(root, 'fixture-runtime-ledger.ndjson'),
    deliveryRuntimeVersion: runtimeLock.version,
  };
  for (const key of [
    'claudeRoot',
    'userDataRoot',
    'claudeConfigDir',
    'multimodelDataHome',
    'multimodelCacheHome',
    'xdgConfigHome',
    'xdgDataHome',
    'xdgCacheHome',
    'xdgStateHome',
    'xdgRuntimeDir',
    'projectPath',
  ] as const) {
    await mkdir(fixture[key], { recursive: true });
  }
  const nodeBinary = await realpath(process.execPath);
  await writeFile(
    fixture.runtimeWrapperPath,
    `#!${nodeBinary}\n` +
      `'use strict';\n` +
      `const fs = require('node:fs');\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args.length === 1 && args[0] === '--version') {\n` +
      `  process.stdout.write(${JSON.stringify(`${runtimeLock.version}\n`)});\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `fs.appendFileSync(${JSON.stringify(fixture.runtimeLedgerPath)}, JSON.stringify({ args, at: Date.now() }) + '\\n');\n` +
      `process.stderr.write('fixture runtime denies all lifecycle and provider commands\\n');\n` +
      `process.exit(77);\n`
  );
  await chmod(fixture.runtimeWrapperPath, 0o755);
  await writeFile(fixture.runtimeLedgerPath, '');
  await writeFile(path.join(fixture.projectPath, 'README.md'), '# Disposable latch E2E project\n');
  const memberFor = (teamName: string) => ({
    name: 'team-lead',
    agentId: `team-lead@${teamName}`,
    agentType: 'team-lead',
    role: 'Lead',
    providerId: 'opencode',
    providerBackendId: 'opencode-cli',
    model: 'test-model',
    color: 'blue',
    cwd: fixture.projectPath,
    joinedAt: Date.now(),
    subscriptions: [],
  });
  await json(path.join(fixture.claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  for (const teamName of [
    fixture.teamName,
    fixture.coldTeamName,
    fixture.raceTeamName,
    fixture.exhaustTeamName,
  ]) {
    const member = memberFor(teamName);
    const teamDir = path.join(fixture.claudeRoot, 'teams', teamName);
    await json(path.join(teamDir, 'config.json'), {
      name: teamName,
      description: 'Disposable renderer-only selectTeam latch fixture',
      color: 'blue',
      language: 'en',
      createdAt: Date.now(),
      leadAgentId: member.agentId,
      members: [member],
      projectPath: fixture.projectPath,
      projectPathHistory: [fixture.projectPath],
    });
    await json(path.join(teamDir, 'members.meta.json'), { version: 1, members: [member] });
    await json(path.join(teamDir, 'team.meta.json'), {
      version: 1,
      cwd: fixture.projectPath,
      providerId: 'opencode',
      model: 'test-model',
      prompt: 'Renderer fixture only. Never launch any provider.',
      createdAt: Date.now(),
    });
    await mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
    await json(path.join(teamDir, 'inboxes', 'user.json'), []);
    await mkdir(path.join(fixture.claudeRoot, 'tasks', teamName), { recursive: true });
  }
  await mkdir(path.join(fixture.claudeRoot, 'projects'), { recursive: true });
  const fixtureFile = path.join(root, 'fixture.json');
  await json(fixtureFile, fixture);
  return { fixture, fixtureFile };
}

async function validateFixture(fixtureFile: string): Promise<Fixture & { teamNames: string[] }> {
  assert(path.isAbsolute(fixtureFile), '--fixture must be an absolute path');
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8')) as Fixture & {
    teamNames: string[];
  };
  assert.equal(fixture.kind, 'select-team-latch-disposable-desktop-v2');
  assert(
    /^latch-e2e-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      fixture.teamName
    ),
    'Fixture team name must contain a random UUID'
  );
  assert.equal(fixture.coldTeamName, `${fixture.teamName}-cold`);
  assert.equal(fixture.raceTeamName, `${fixture.teamName}-race`);
  assert.equal(fixture.exhaustTeamName, `${fixture.teamName}-exhaust`);
  fixture.teamNames = [
    fixture.teamName,
    fixture.coldTeamName,
    fixture.raceTeamName,
    fixture.exhaustTeamName,
  ];
  const root = await realpath(fixture.root);
  assert.equal(path.dirname(root), await realpath(os.tmpdir()));
  assert(/^select-team-latch-desktop-e2e-[a-zA-Z0-9]+$/.test(path.basename(root)));
  const contained = async (candidate: string) => {
    assert(typeof candidate === 'string' && path.isAbsolute(candidate));
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    return resolved;
  };
  for (const key of [
    'claudeRoot',
    'userDataRoot',
    'claudeConfigDir',
    'multimodelDataHome',
    'multimodelCacheHome',
    'xdgConfigHome',
    'xdgDataHome',
    'xdgCacheHome',
    'xdgStateHome',
    'xdgRuntimeDir',
    'projectPath',
    'runtimeWrapperPath',
    'runtimeLedgerPath',
  ] as const) {
    fixture[key] = await contained(fixture[key]);
    const valueStat = await stat(fixture[key]);
    if (key === 'runtimeWrapperPath' || key === 'runtimeLedgerPath') {
      assert(valueStat.isFile());
    } else {
      assert(valueStat.isDirectory());
    }
  }
  assert(
    (await stat(fixture.runtimeWrapperPath)).mode & 0o111,
    'Fixture runtime wrapper is not executable'
  );
  await contained(fixtureFile);
  for (const teamName of fixture.teamNames) {
    await contained(path.join(fixture.claudeRoot, 'teams', teamName, 'config.json'));
  }
  return fixture;
}

function assertNoMatchingTeamProcess(teamNames: string[]) {
  const processTable = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const lines = processTable.split(/\r?\n/);
  const collisions = teamNames.flatMap((teamName) => {
    const escaped = teamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const teamArgument = new RegExp(`(?:^|\\s)--team-name(?:=|\\s+)${escaped}(?:\\s|$)`);
    const agentArgument = new RegExp(`(?:^|\\s)--agent-id(?:=\\s+|\\s)[^\\s]*@${escaped}(?:\\s|$)`);
    return lines.filter((line) => teamArgument.test(line) || agentArgument.test(line));
  });
  assert.deepEqual(
    collisions,
    [],
    `Fixture identity collides with a live process: ${collisions.join('\n')}`
  );
}

function getTargets(port: number): Promise<RendererTarget[]> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/json/list', agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.once('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`CDP ${port} returned HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(1_000, () => request.destroy(new Error('CDP request timed out')));
    request.once('error', reject);
  });
}

async function waitForRenderer(port: number) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await getTargets(port);
      const renderer = targets.find(
        (target) =>
          target.type === 'page' &&
          typeof target.url === 'string' &&
          target.url.startsWith('http://localhost:') &&
          typeof target.webSocketDebuggerUrl === 'string'
      );
      if (renderer) return renderer;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`dev:mcp renderer did not appear on ${port}: ${String(lastError)}`);
}

async function startApp(fixture: Fixture) {
  const nodeBinary = await realpath(process.execPath);
  const env = {
    ...process.env,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: fixture.claudeRoot,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: fixture.userDataRoot,
    CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
    CLAUDE_MULTIMODEL_DATA_HOME: fixture.multimodelDataHome,
    CLAUDE_MULTIMODEL_CACHE_HOME: fixture.multimodelCacheHome,
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    XDG_DATA_HOME: fixture.xdgDataHome,
    XDG_CACHE_HOME: fixture.xdgCacheHome,
    XDG_STATE_HOME: fixture.xdgStateHome,
    XDG_RUNTIME_DIR: fixture.xdgRuntimeDir,
    SHELL: '/bin/sh',
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    NODE_BINARY: nodeBinary,
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: fixture.runtimeWrapperPath,
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    pnpm_config_verify_deps_before_run: 'false',
  };
  appProcess = spawn('pnpm', ['dev:mcp'], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const child = appProcess;
  assert(child.pid && child.stdout && child.stderr, 'dev:mcp did not start with piped output');
  appProcessGroupId = child.pid;
  child.stdout.on('data', (chunk) => rememberAppLog(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => rememberAppLog(chunk, 'stderr'));
  appProcess.once('error', (error) =>
    rememberAppLog(
      `spawn error: ${error instanceof Error ? error.message : String(error)}\n`,
      'stderr'
    )
  );
  const exitedBeforeRenderer = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `pnpm dev:mcp exited before CDP was ready (${code ?? signal ?? 'unknown'})\n` +
            appLogTail.slice(-40).join('\n')
        )
      );
    });
  });
  const ownedPort: Promise<number> = (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      for (let index = appLogTail.length - 1; index >= 0; index -= 1) {
        const match = appLogTail[index].match(
          /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//
        );
        if (match) return Number(match[1]);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Owned dev:mcp did not report its actual CDP port');
  })();
  const port = await Promise.race([ownedPort, exitedBeforeRenderer]);
  const renderer = await Promise.race([waitForRenderer(port), exitedBeforeRenderer]);
  return { port, renderer };
}

interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<void>;
  screenshot(file: string): Promise<void>;
  on(method: string, listener: (event: CdpEvent) => void | Promise<void>): void;
  close(): Promise<void>;
}
interface CdpEvent {
  request: { url: string };
  requestId: string;
  responseStatusCode?: number;
  responseStatusText?: string;
  responseHeaders?: { name: string; value: string }[];
  frame?: { parentId?: string };
  type?: string;
  args?: { value?: unknown; description?: string }[];
}
class CdpClient {
  constructor(private readonly client: Cdp) {}
  static async connect(url: string): Promise<CdpClient> {
    return new CdpClient((await RawCdpClient.connect(url)) as Cdp);
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.send<T>(method, params);
  }
  evaluate<T = unknown>(expression: string): Promise<T> {
    return this.client.evaluate<T>(expression);
  }
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<void> {
    return this.client.waitFor(expression, label, timeoutMs);
  }
  on(method: string, listener: (event: CdpEvent) => void | Promise<void>): void {
    this.client.on(method, listener);
  }
  screenshot(file: string): Promise<void> {
    return this.client.screenshot(file);
  }
  close(): Promise<void> {
    return this.client.close();
  }
  async inputPoint(expression: string) {
    return this.evaluate<{ x: number; y: number } | null>(`(async () => {
      const root = (${expression});
      if (!(root instanceof HTMLElement)) return null;
      root.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const ratios = [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.35], [0.5, 0.65]];
      const candidates = [root, ...Array.from(root.querySelectorAll('h2,h3,p,span,div')).slice(0, 40)];
      for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        for (const [xRatio, yRatio] of ratios) {
          const x = rect.left + rect.width * xRatio;
          const y = rect.top + rect.height * yRatio;
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === root || root.contains(hit))) return { x, y };
        }
      }
      return null;
    })()`);
  }

  async hitTestDiagnostics(expression: string) {
    return this.evaluate(`(() => {
      const root = (${expression});
      if (!root) return 'selector matched nothing';
      const rect = root.getBoundingClientRect();
      const describe = (node) =>
        node ? \`\${node.tagName}#\${node.id || ''}.\${String(node.className || '').slice(0, 90)}\` : 'none';
      return JSON.stringify({
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        zoom: getComputedStyle(document.documentElement).zoom,
        centerBlocker: describe(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
        text: root.textContent?.slice(0, 60),
      });
    })()`);
  }

  async click(expression: string, { attempts = 24, delayMs = 250 } = {}) {
    let point: { x: number; y: number } | null = null;
    let diagnostics: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      point = await this.inputPoint(expression);
      if (point) break;
      // Transient overlays (the startup splash fade-out, portals) can hold the hit test.
      diagnostics = await this.hitTestDiagnostics(expression).catch(() => 'unknown');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    assert(
      point,
      `Element is not hit-testable after ${attempts} attempts: ${diagnostics ?? expression}`
    );
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      pointerType: 'mouse',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
      pointerType: 'mouse',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
      pointerType: 'mouse',
    });
  }
}

function fixtureBootstrap(fixture: Fixture & { teamNames: string[] }) {
  const callsSeed = fixture.teamNames.map((name) => `${JSON.stringify(name)}: 0`).join(', ');
  return `(() => {
    const names = ${JSON.stringify(fixture.teamNames)};
    const state = {
      teamName: ${JSON.stringify(fixture.teamName)},
      coldTeamName: ${JSON.stringify(fixture.coldTeamName)},
      raceTeamName: ${JSON.stringify(fixture.raceTeamName)},
      exhaustTeamName: ${JSON.stringify(fixture.exhaustTeamName)},
      projectPath: ${JSON.stringify(fixture.projectPath)},
      mode: 'success',
      holdTeam: null,
      staleTeam: null,
      calls: { ${callsSeed} },
      transports: { raw: 0, legacy: 0 },
      restoreCalls: 0,
      listCalls: 0,
      held: null,
      reset(mode = 'success') {
        if (this.held) throw new Error('Settle the pending held getData before reset');
        this.mode = mode;
        this.holdTeam = null;
        this.staleTeam = null;
        for (const name of names) this.calls[name] = 0;
        this.restoreCalls = 0;
        this.listCalls = 0;
      },
      armHold(teamName) {
        if (this.held) throw new Error('A held getData is already pending');
        this.holdTeam = teamName;
      },
      armStale(teamName) {
        this.staleTeam = teamName;
      },
      releaseHold() {
        if (!this.held) throw new Error('No held getData to release');
        const pending = this.held;
        this.held = null;
        pending.resolve();
      },
      lifecycleCalls() {
        return { reads: { ...this.calls }, transports: { ...this.transports }, restore: this.restoreCalls, list: this.listCalls };
      },
      createApi(realApi) {
        if (this.api) return this.api;
        const interceptData = (read, transport) => async (teamName, ...args) => {
              state.transports[transport] += 1;
              if (!names.includes(teamName)) throw new Error('Unexpected team getData: ' + teamName);
              state.calls[teamName] += 1;
              const call = read(teamName, ...args);
              if (state.mode === 'always_stale' && state.staleTeam === teamName) {
                // Invalidate the source authority before the read settles, as in the field report.
                window.__agentTeamsDevStore.getState().invalidateTaskDetailTeamSource(
                  window.__agentTeamsDevStore.getState().activeContextId, teamName);
                return await call;
              }
              if (state.mode === 'hold_once' && state.holdTeam === teamName) {
                state.holdTeam = null;
                return new Promise((resolve, reject) => {
                  state.held = {
                    resolve: async () => {
                      try { resolve(await call); } catch (error) { reject(error); }
                    },
                    reject
                  };
                });
              }
              return await call;
        };
        const raw = realApi.teams.readRecovery;
        const recovery = raw && new Proxy({}, {
          get: (_target, property) => {
            if (property === 'getData') return interceptData(raw.getData.bind(raw), 'raw');
            const value = Reflect.get(raw, property, raw);
            return typeof value === 'function' ? value.bind(raw) : value;
          }
        });
        const teams = new Proxy({}, {
          get: (_target, property) => {
            if (property === 'readRecovery') return recovery;
            if (property === 'getData') return interceptData(realApi.teams.getData.bind(realApi.teams), 'legacy');
            if (property === 'list') return async (...args) => {
              state.listCalls += 1;
              const result = await realApi.teams.list(...args);
              const seen = result.map((entry) => entry?.teamName).sort();
              if (JSON.stringify(seen) !== JSON.stringify([...names].sort()) ||
                  result.some((entry) => entry?.projectPath !== state.projectPath)) {
                throw new Error('Latch E2E list escaped its isolated fixture: ' + JSON.stringify(seen));
              }
              return result;
            };
            if (property === 'restoreTeam') return async (teamName) => {
              if (!names.includes(teamName)) throw new Error('Unexpected restore team: ' + teamName);
              state.restoreCalls += 1;
              // Stubbed transport only: the real restoreTeam store action still runs
              // and performs invalidateTeamLocalStateEpoch exactly as in production.
              return undefined;
            };
            const value = Reflect.get(realApi.teams, property, realApi.teams);
            return typeof value === 'function' ? value.bind(realApi.teams) : value;
          }
        });
        this.api = new Proxy({}, {
          get: (_target, property) => {
            if (property === 'teams') return teams;
            const value = Reflect.get(realApi, property, realApi);
            return typeof value === 'function' ? value.bind(realApi) : value;
          }
        });
        return this.api;
      }
    };
    window.__teamLatchE2E = state;
  })();`;
}

async function installApiInterception(
  client: CdpClient,
  fixture: Fixture & { teamNames: string[] }
) {
  let patchCount = 0;
  let patchError: unknown = null;
  const observedScriptPaths = new Set<string>();
  let resolveFirstPatch!: () => void;
  let rejectFirstPatch!: (error: unknown) => void;
  const firstPatch = new Promise<void>((resolve, reject) => {
    resolveFirstPatch = resolve;
    rejectFirstPatch = reject;
  });
  client.on('Fetch.requestPaused', async (event) => {
    const url = new URL(event.request.url);
    observedScriptPaths.add(url.pathname);
    const disableSettlement =
      withoutSettlement && url.pathname.endsWith('/store/team/selectTeamLoadLatch.ts');
    if (
      (!expectedApiModulePaths.has(url.pathname) && !disableSettlement) ||
      !event.responseStatusCode
    ) {
      await client.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    try {
      const bodyResult = await client.send<{ body: string; base64Encoded: boolean }>(
        'Fetch.getResponseBody',
        { requestId: event.requestId }
      );
      const source = bodyResult.base64Encoded
        ? Buffer.from(bodyResult.body, 'base64').toString('utf8')
        : bodyResult.body;
      if (disableSettlement) {
        const needle = /(export function settleLatchedSelectTeamLoad\([^]*?\)\s*\{)/g;
        assert.equal(
          [...source.matchAll(needle)].length,
          1,
          'Red control settlement function changed'
        );
        await client.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: event.responseStatusCode,
          responseHeaders: (event.responseHeaders ?? []).filter(
            (header) => !['content-length', 'content-encoding'].includes(header.name.toLowerCase())
          ),
          body: Buffer.from(source.replace(needle, '$1\n return; // E2E red control')).toString(
            'base64'
          ),
        });
        settlementControlPatches += 1;
        return;
      }
      const occurrences = source.split(apiNeedle).length - 1;
      assert.equal(occurrences, 1, 'Expected exactly one getImpl fixture injection needle');
      const replacement = `${apiNeedle.split('\n')[0]}\n  const latchFixture = window.__teamLatchE2E;\n  if (window.electronAPI && latchFixture?.createApi) return latchFixture.createApi(window.electronAPI);\n  ${apiNeedle.split('\n')[1]}`;
      const patched = source.replace(apiNeedle, replacement);
      const headers = (event.responseHeaders ?? []).filter(
        (header) => !['content-length', 'content-encoding'].includes(header.name.toLowerCase())
      );
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: event.responseStatusCode,
        responsePhrase: event.responseStatusText,
        responseHeaders: headers,
        body: Buffer.from(patched).toString('base64'),
      });
      patchCount += 1;
      resolveFirstPatch();
    } catch (error) {
      patchError = error;
      rejectFirstPatch(error);
      await client
        .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' })
        .catch(() => undefined);
    }
  });
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*api/index.ts*', resourceType: 'Script', requestStage: 'Response' },
      ...(withoutSettlement
        ? [
            {
              urlPattern: '*selectTeamLoadLatch.ts*',
              resourceType: 'Script',
              requestStage: 'Response',
            },
          ]
        : []),
    ],
  });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureBootstrap(fixture) });
  await client.send('Page.reload', { ignoreCache: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      firstPatch,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `API module was not intercepted; observed ${JSON.stringify(
                  [...observedScriptPaths].filter((v) => /api|renderer/i.test(v)).slice(-100)
                )}`
              )
            ),
          45_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (patchError) throw patchError;
  await client.waitFor(
    'window.__teamLatchE2E && window.__agentTeamsDevStore && window.electronAPI?.teams',
    'fixture API and dev store',
    90_000
  );
  return () => {
    if (patchError) throw patchError;
    return patchCount;
  };
}

const visible = (expression: string) => `(() => {
  const element = (${expression});
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
})()`;
// Every expression below takes a JavaScript expression (not a literal) that yields
// the team name inside the renderer, so the same helper works for all fixture teams.
const teamCard = (teamName: string) => `Array.from(document.querySelectorAll('[role="button"]'))
  .find((element) => element.querySelector('h3')?.textContent?.trim() === ${teamName})`;
const activeTeamTab = (teamName: string) => `(() => {
  const state = window.__agentTeamsDevStore?.getState?.();
  const pane = state?.paneLayout?.panes?.find((candidate) =>
    candidate.id === state?.paneLayout?.focusedPaneId);
  const tab = pane?.tabs?.find((candidate) => candidate.id === pane.activeTabId);
  return tab?.type === 'team' && tab.teamName === ${teamName};
})()`;
const loadingSkeleton = (teamName: string) => `Array.from(
    document.querySelectorAll('[role="status"][data-team-name]'))
  .some((element) => element.dataset.teamName === ${teamName} &&
    element.getBoundingClientRect().width > 0)`;
const storeLoadState = (teamName: string) => `(() => {
  const s = window.__agentTeamsDevStore?.getState?.();
  return JSON.stringify({
    ready: Boolean(s),
    loading: s?.selectedTeamLoading,
    team: s?.selectedTeamName,
    hasData: s?.selectedTeamData?.teamName === ${teamName},
    error: s?.selectedTeamError ?? null
  });
})()`;
const teamLoadedExpression = (teamName: string) => `(() => {
  const s = window.__agentTeamsDevStore?.getState?.();
  return Boolean(s) && !s.selectedTeamLoading &&
    s.selectedTeamData?.teamName === ${teamName};
})()`;
const teamLoadingExpression = (teamName: string) => `(() => {
  const s = window.__agentTeamsDevStore?.getState?.();
  return Boolean(s) && s.selectedTeamLoading && s.selectedTeamName === ${teamName};
})()`;

function isProcessGroupAlive(processGroupId: number) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === 'ESRCH' ||
      (error as NodeJS.ErrnoException)?.code === 'EPERM'
    )
      return false;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessGroupAlive(processGroupId);
}

async function stopOwnedApp() {
  await cdp?.close().catch(() => undefined);
  cdp = null;
  if (!appProcess && !appProcessGroupId) return;
  const child = appProcess;
  const processGroupId = appProcessGroupId ?? child?.pid;
  if (!processGroupId) return;
  if (process.platform === 'win32') {
    if (child?.exitCode === null) child.kill('SIGKILL');
  } else if (isProcessGroupAlive(processGroupId)) {
    try {
      process.kill(-processGroupId, 'SIGKILL');
    } catch {
      child?.kill('SIGKILL');
    }
    assert.equal(
      await waitForProcessGroupExit(processGroupId, 4_000),
      true,
      'Owned dev:mcp process group survived cleanup'
    );
  }
  appProcess = null;
  appProcessGroupId = null;
}

async function waitForAppLog(fragment: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appLogTail.some((line) => line.includes(fragment))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for app log: ${fragment}`);
}

async function run() {
  if (process.argv.includes('--seed')) {
    process.stdout.write(`${JSON.stringify(await seedFixture(), null, 2)}\n`);
    return;
  }
  const suppliedFixture = argument('--fixture');
  const seeded = suppliedFixture ? null : await seedFixture();
  const fixtureFile = suppliedFixture ?? seeded?.fixtureFile;
  assert(fixtureFile, 'No disposable fixture was created');
  const fixture = await validateFixture(fixtureFile);
  assertNoMatchingTeamProcess(fixture.teamNames);
  await mkdir(evidenceRoot, { recursive: true });
  let ownedApp = false;
  const evidence: Evidence = {
    kind: 'select-team-latch-desktop-e2e-v2',
    fixture: fixtureFile,
    evidenceRoot,
    providerLaunched: false,
    withoutSettlement,
    sourceHead: execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    sourceSha256: Object.fromEntries(
      await Promise.all(
        [
          'src/renderer/store/slices/teamSlice.ts',
          'src/renderer/store/team/selectTeamLoadLatch.ts',
          'scripts/e2e/select-team-latch-desktop.ts',
        ].map(async (file) => [
          file,
          createHash('sha256')
            .update(await readFile(path.join(repoRoot, file)))
            .digest('hex'),
        ])
      )
    ),
    cdpPort: null,
    rendererNavigations: 0,
    assertions: [],
    screenshots: [],
  };
  let succeeded = false;
  const record = (label: string) => {
    evidence.assertions.push(label);
    process.stdout.write(`PASS ${label}\n`);
  };
  const screenshot = async (name: string) => {
    const file = path.join(evidenceRoot, `${name}.png`);
    await cdp!.screenshot(file);
    evidence.screenshots.push(file);
  };
  // Renderer-side expressions for the three fixture teams (see seedFixture).
  const WARM = 'window.__teamLatchE2E.teamName';
  const COLD = 'window.__teamLatchE2E.coldTeamName';
  const RACE = 'window.__teamLatchE2E.raceTeamName';
  const EXHAUST = 'window.__teamLatchE2E.exhaustTeamName';
  const loadState = async (teamName: string) =>
    JSON.parse(await cdp!.evaluate<string>(storeLoadState(teamName))) as LoadState;
  const lifecycleCalls = () => cdp!.evaluate<Lifecycle>('window.__teamLatchE2E.lifecycleCalls()');
  const readCount = async (literalTeamName: string) =>
    (await lifecycleCalls()).reads[literalTeamName] ?? 0;

  /**
   * Vite answers the Team Details view's first lazy dependency discovery with a
   * one-off "optimized dependencies changed. reloading" full page reload. The
   * fixture bootstrap re-runs on the new document, so a probe written on it only
   * survives when the renderer actually stayed alive.
   */
  const rendererIsStable = async (waitMs = 2_500) => {
    const probe = `${Date.now()}-${Math.random()}`;
    await cdp!.evaluate(`window.__teamLatchE2E.probe = ${JSON.stringify(probe)}; null`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const survived = await cdp!.evaluate('window.__teamLatchE2E?.probe ?? null').catch(() => null);
    const storeReady = await cdp!
      .evaluate('Boolean(window.__agentTeamsDevStore?.getState?.())')
      .catch(() => false);
    return survived === probe && storeReady === true;
  };

  const settleRenderer = async (label: string, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await cdp!.waitFor(
          'window.__teamLatchE2E && window.__agentTeamsDevStore?.getState?.()',
          `${label}: renderer ready`,
          20_000
        );
        if (await rendererIsStable()) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `Renderer never settled during ${label}${lastError ? `: ${String(lastError)}` : ''}`
    );
  };

  const openTeamsTab = () =>
    cdp!.evaluate('window.__agentTeamsDevStore?.getState?.().openTeamsTab()');
  const openTeamThroughUi = async (teamName: string) => {
    await openTeamsTab();
    await cdp!.waitFor(`Boolean(${visible(teamCard(teamName))})`, 'fixture team card', 60_000);
    await cdp!.click(`(${teamCard(teamName)})?.querySelector('h3')`);
  };

  try {
    ({ port, renderer } = await startApp(fixture));
    ownedApp = true;
    evidence.cdpPort = port;
    process.stdout.write(`Using isolated dev:mcp CDP port ${port}\n`);
    cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
    await cdp!.send('Runtime.enable');
    await cdp!.send('Page.enable');
    cdp.on('Page.frameNavigated', (event) => {
      if (!event.frame?.parentId) evidence.rendererNavigations += 1;
    });
    cdp.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'warning' || event.type === 'error') {
        consoleWarnings.push(
          (event.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
        );
      }
    });
    await cdp!.send('Page.bringToFront');
    await cdp!.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp!.waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'native API and dev store',
      90_000
    );
    await waitForAppLog(
      'Startup fallback cleanup skipped because host registry cleanup is unavailable'
    );
    const readDeniedCalls = async () =>
      (await readFile(fixture.runtimeLedgerPath, 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    let deniedRuntimeCalls = await readDeniedCalls();
    evidence.appExercisedRuntimeWrapper = deniedRuntimeCalls.length >= 1;
    if (deniedRuntimeCalls.length === 0) {
      // Current main does not invoke the orchestrator CLI during startup, so the app
      // never reaches the wrapper on its own. Prove the deny-all wiring instead of
      // assuming it: the wrapper must refuse a lifecycle command and record that.
      let wrapperExit = 0;
      try {
        execFileSync(
          process.execPath,
          [fixture.runtimeWrapperPath, 'runtime', 'status', '--json'],
          { stdio: 'pipe' }
        );
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        wrapperExit = typeof status === 'number' ? status : -1;
      }
      assert.equal(
        wrapperExit,
        77,
        `Fixture runtime wrapper must refuse lifecycle commands, got exit ${wrapperExit}`
      );
      deniedRuntimeCalls = await readDeniedCalls();
    }
    assert(deniedRuntimeCalls.length >= 1, 'Fixture runtime wrapper did not deny startup commands');
    assert(
      !appLogTail.some((line) => line.includes('[OpenCode] startup fallback cleanup:')),
      'Offline UI fixture reached global OpenCode process fallback'
    );
    evidence.deniedRuntimeCalls = deniedRuntimeCalls.length;
    record('fixture runtime denied startup bridge commands; no provider was launched');

    const getPatchCount = await installApiInterception(cdp, fixture);
    assert(getPatchCount() >= 1);
    await cdp!.waitFor(
      `(() => { const s = window.__agentTeamsDevStore?.getState?.();
        return s && !s.teamsLoading &&
          s.teams?.some((t) => t.teamName === window.__teamLatchE2E.teamName); })()`,
      'hydrated fixture team list',
      90_000
    );
    record('exact Vite API response patched; isolated fixture team hydrated');

    // --- Warm-up: the first Team Details open makes Vite discover lazy dependencies and
    // answer with a one-off full page reload. Absorb it before timing any scenario. ---
    await openTeamThroughUi(WARM);
    await settleRenderer('warm-up team open');
    await cdp!.waitFor(teamLoadedExpression(WARM), 'warm-up team data loaded', 60_000);
    evidence.warmUpNavigations = evidence.rendererNavigations;
    assert(
      (await readCount(fixture.teamName)) > 0,
      'Warm-up bypassed the instrumented read transport'
    );

    // --- Scenario 1: golden path for a team that has never been loaded ---
    await openTeamThroughUi(COLD);
    await cdp!.waitFor(activeTeamTab(COLD), 'active fixture Team Details tab', 60_000);
    await cdp!.waitFor(teamLoadedExpression(COLD), 'cold team data loaded', 60_000);
    await cdp!.waitFor(`!(${loadingSkeleton(COLD)})`, 'cold team view rendered', 15_000);
    assert.equal(
      evidence.rendererNavigations,
      evidence.warmUpNavigations,
      'The renderer reloaded during the golden path, so timing evidence would be invalid'
    );
    assert(
      (await readCount(fixture.coldTeamName)) > 0,
      'Cold load bypassed the instrumented read transport'
    );
    await screenshot('01-team-loaded-golden-path');
    record('golden path: clicking a cold team card loads Team Details with no skeleton latch');

    // --- Scenario 2: the critical latch race, on a cold team so the user sees the skeleton ---
    await settleRenderer('before the race');
    await cdp!.evaluate('window.__teamLatchE2E.reset("hold_once")');
    await cdp!.evaluate(`window.__teamLatchE2E.armHold(${RACE})`);
    const beforeRace = await readCount(fixture.raceTeamName);
    // A real click starts the load; the fixture holds the renderer read open so the
    // invalidation below lands while the request is genuinely in flight.
    await openTeamThroughUi(RACE);
    await cdp!.waitFor(teamLoadingExpression(RACE), 'selectTeam in flight with held read', 15_000);
    await cdp!.waitFor(loadingSkeleton(RACE), 'loading skeleton visible during race', 10_000);
    await screenshot('02-loading-skeleton-during-race');
    await cdp!.waitFor('Boolean(window.__teamLatchE2E.held)', 'getData transport is held', 15000);
    // The production source invalidation lands only after the API transport starts.
    await cdp!.evaluate(`window.__agentTeamsDevStore.getState().invalidateTaskDetailTeamSource(
      window.__agentTeamsDevStore.getState().activeContextId, ${RACE})`);
    await cdp!.evaluate('window.__teamLatchE2E.releaseHold()');
    // Without the fix, loading stays true forever here (duplicate guard + stale discard).
    await cdp!.waitFor(
      teamLoadedExpression(RACE),
      'stale read recovered via bounded retry',
      20_000
    );
    const raceReads = (await readCount(fixture.raceTeamName)) - beforeRace;
    assert(raceReads >= 2, `Recovery must re-issue getData, got ${raceReads} read(s)`);
    assert.equal((await loadState(RACE)).error, null);
    await cdp!.waitFor(`!(${loadingSkeleton(RACE)})`, 'skeleton gone after recovery', 15_000);
    await screenshot('03-recovered-after-stale-race');
    record(
      `critical latch race: cold team recovered from one mid-flight invalidation with ${raceReads} reads and no skeleton latch`
    );

    // --- Scenario 3: retry budget exhausted on a never-loaded team ---
    // The exhaust team has no cached snapshot at any point, so this is the cold view the
    // reporter saw, entered the way a user enters it: a click on the team card.
    await cdp!.evaluate('window.__teamLatchE2E.reset("always_stale")');
    await cdp!.evaluate(`window.__teamLatchE2E.armStale(${EXHAUST})`);
    const beforeStale = await readCount(fixture.exhaustTeamName);
    consoleWarnings.length = 0;
    await openTeamThroughUi(EXHAUST);
    await cdp!.waitFor(teamLoadingExpression(EXHAUST), 'stale loop loading', 15_000);
    await cdp!.waitFor(loadingSkeleton(EXHAUST), 'cold skeleton visible during stale loop', 10_000);
    await screenshot('04a-cold-skeleton-during-stale-loop');
    await cdp!.waitFor(
      `!(${teamLoadingExpression(EXHAUST)})`,
      'loading released after retry budget',
      20_000
    );
    const staleReads = (await readCount(fixture.exhaustTeamName)) - beforeStale;
    // Entering through the UI can start two fresh attempts (the card click and the tab
    // activation), and each fresh attempt owns its own budget, so the bound is attempts
    // x (1 + retries) rather than a single fixed count. What must never happen is an
    // unbounded loop: the release has to come within two budgets.
    assert(
      staleReads >= 4 && staleReads <= 2 * 4,
      `Expected a bounded stale-read loop of 4..8 reads, got ${staleReads}`
    );
    assert(
      consoleWarnings.some((line) => /stale reads; releasing loading state/.test(line)),
      `Expected release warning, got: ${JSON.stringify(consoleWarnings)}`
    );
    const releasedState = await loadState(EXHAUST);
    assert(releasedState.error, 'Release must surface a retriable error, not a silent blank view');
    // The user has to see it: assert the rendered failure text, not only the store field.
    const renderedError = await cdp!.evaluate<{
      hasHeading: boolean;
      hasStaleReadDetail: boolean;
      detail: string | null;
    }>(
      `(() => { const text = document.body.innerText || ''; return {
        hasHeading: text.includes('Failed to load team'),
        hasStaleReadDetail: /after 3 stale reads/.test(text),
        detail: (text.match(/Failed to load team[^\\n]*/) || [null])[0] }; })()`
    );
    assert(
      renderedError.hasHeading && renderedError.hasStaleReadDetail,
      `Cold view must render the retriable error, got: ${JSON.stringify(renderedError)}`
    );
    assert(
      !(await cdp!.evaluate(`Boolean(${loadingSkeleton(EXHAUST)})`)),
      'The released cold view must not still be showing the loading skeleton'
    );
    await screenshot('04-released-with-error-after-budget');
    record(
      `persistent staleness: cold team released after ${staleReads} reads and renders "${renderedError.detail}"`
    );

    // --- Scenario 4: a later selection recovers normally ---
    // Re-selecting through the store rather than the card list: the released pane owns
    // the tab bar at this point, and what matters here is that the released latch left
    // no permanent damage, including in what the user sees.
    await cdp!.evaluate('window.__teamLatchE2E.reset("success")');
    await cdp!.evaluate(
      `window.__agentTeamsDevStore.getState().selectTeam(${EXHAUST}, { skipProjectAutoSelect: true })`
    );
    await cdp!.waitFor(teamLoadedExpression(EXHAUST), 'fresh selection loads cleanly', 20_000);
    assert.equal(
      (await loadState(EXHAUST)).error,
      null,
      'A fresh selection must clear the released error'
    );
    assert(
      !(await cdp!.evaluate(
        `(() => { const text = document.body.innerText || ''; return text.includes('Failed to load team'); })()`
      )),
      'The released error must disappear from the view once the team loads'
    );
    await cdp!.waitFor(
      `!(${loadingSkeleton(EXHAUST)})`,
      'skeleton gone after fresh selection',
      15_000
    );
    await screenshot('05-fresh-selection-normal');
    record(
      'fresh selection after release loads normally: no permanent damage from the latch guard'
    );

    assert.equal(
      evidence.rendererNavigations,
      evidence.warmUpNavigations,
      'Renderer reloaded during a scenario'
    );
    assert(
      (await lifecycleCalls()).transports.raw > 0,
      'The current raw read-recovery transport was bypassed'
    );
    evidence.fetchPatchCount = getPatchCount();
    evidence.settlementControlPatches = settlementControlPatches;
    evidence.finalLifecycle = await lifecycleCalls();
    await json(path.join(evidenceRoot, 'evidence.json'), evidence);
    succeeded = true;
    process.stdout.write(
      `selectTeam stale-read latch desktop E2E passed with ${evidence.assertions.length} assertions.\n`
    );
  } catch (error) {
    evidence.settlementControlPatches = settlementControlPatches;
    evidence.error = error instanceof Error ? error.stack : String(error);
    evidence.appLogTail = appLogTail.slice(-60);
    evidence.consoleWarnings = consoleWarnings.slice(-20);
    if (cdp) {
      evidence.rendererDiagnostics = await cdp
        .evaluate(
          `(() => ({
            fixture: window.__teamLatchE2E?.lifecycleCalls?.() ?? null,
            loadState: (() => { const s = window.__agentTeamsDevStore?.getState?.(); return s ? {
              loading: s.selectedTeamLoading, team: s.selectedTeamName,
              hasData: s.selectedTeamData?.teamName ?? null, error: s.selectedTeamError ?? null } : null; })(),
            skeletonTeams: Array.from(document.querySelectorAll('[role="status"][data-team-name]'))
              .filter((element) => element.getBoundingClientRect().width > 0)
              .map((element) => element.dataset.teamName),
            visibleTeamCards: Array.from(document.querySelectorAll('[role="button"]'))
              .map((element) => element.querySelector('h3')?.textContent?.trim())
              .filter(Boolean)
          }))()`
        )
        .catch((diagnosticError) => ({ error: String(diagnosticError) }));
      await cdp!.screenshot(path.join(evidenceRoot, 'failure-renderer.png')).catch(() => undefined);
    }
    await json(path.join(evidenceRoot, 'failure.json'), evidence).catch(() => undefined);
    throw error;
  } finally {
    if (ownedApp || appProcessGroupId) await stopOwnedApp();
    if (seeded && succeeded && process.env.AGENT_TEAMS_LATCH_E2E_KEEP !== '1') {
      await rm(seeded.fixture.root, { recursive: true, force: true });
    } else if (seeded && !succeeded) {
      process.stderr.write(
        `Retained failed disposable fixture for diagnosis: ${seeded.fixture.root}\n`
      );
    }
  }
}

let port: number;
let renderer: RendererTarget;
run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
