#!/usr/bin/env node
// Reproducible Electron renderer E2E for the single-team Stop control.
//
// The harness creates only a disposable team/project, launches the real `pnpm
// dev:mcp` desktop app (or connects to an explicitly supplied local CDP port),
// and replaces only stop-related renderer API methods through response-stage
// CDP Fetch interception. It never launches a provider or invokes the real stop
// API. Evidence is written outside the repository.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const evidenceRoot = path.resolve(
  process.env.AGENT_TEAMS_STOP_E2E_EVIDENCE ??
    path.join(os.tmpdir(), 'agent-teams-stop-desktop-evidence')
);
const apiModuleSuffix = '/src/renderer/api/index.ts';
const expectedApiModulePaths = new Set([
  // electron-vite uses src/renderer as renderer root; App.tsx imports ./api.
  '/api/index.ts',
  apiModuleSuffix,
  `/@fs${repoRoot}${apiModuleSuffix}`,
  // Vite's FS_PREFIX ends in '/' and an absolute POSIX id begins with '/'.
  `/@fs/${repoRoot}${apiModuleSuffix}`,
]);
// This is intentionally the post-Vite transform, not the TypeScript source.
const apiNeedle = 'function getImpl() {\n  if (window.electronAPI) return window.electronAPI;';
const appLogTail = [];
const appLogRemainder = { stdout: '', stderr: '' };
let appProcess = null;
let appProcessGroupId = null;
let cdp = null;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function rememberAppLog(chunk, stream) {
  const text = chunk.toString();
  const lines = `${appLogRemainder[stream]}${text}`.split(/\r?\n/);
  appLogRemainder[stream] = lines.pop() ?? '';
  appLogTail.push(...lines.filter(Boolean));
  if (appLogTail.length > 250) appLogTail.splice(0, appLogTail.length - 250);
  if (process.env.AGENT_TEAMS_STOP_E2E_VERBOSE === '1') process.stdout.write(text);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function seedFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'team-stop-desktop-e2e-')));
  const runtimeLock = JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
  assert(/^\d+\.\d+\.\d+$/.test(runtimeLock.version), 'runtime.lock.json version is invalid');
  const fixture = {
    kind: 'team-stop-disposable-desktop-v1',
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
    teamName: `stop-e2e-${randomUUID()}`,
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
  ]) {
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
  await writeFile(path.join(fixture.projectPath, 'README.md'), '# Disposable Stop E2E project\n');
  const member = {
    name: 'team-lead',
    agentId: `team-lead@${fixture.teamName}`,
    agentType: 'team-lead',
    role: 'Lead',
    providerId: 'opencode',
    providerBackendId: 'opencode-cli',
    model: 'test-model',
    color: 'blue',
    cwd: fixture.projectPath,
    joinedAt: Date.now(),
    subscriptions: [],
  };
  const teamDir = path.join(fixture.claudeRoot, 'teams', fixture.teamName);
  await json(path.join(fixture.claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  await json(path.join(teamDir, 'config.json'), {
    name: fixture.teamName,
    description: 'Disposable renderer-only Stop E2E fixture',
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
  await mkdir(path.join(fixture.claudeRoot, 'tasks', fixture.teamName), { recursive: true });
  await mkdir(path.join(fixture.claudeRoot, 'projects'), { recursive: true });
  const fixtureFile = path.join(root, 'fixture.json');
  await json(fixtureFile, fixture);
  return { fixture, fixtureFile };
}

async function validateFixture(fixtureFile) {
  assert(path.isAbsolute(fixtureFile), '--fixture must be an absolute path');
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
  assert.equal(fixture.kind, 'team-stop-disposable-desktop-v1');
  assert(
    /^stop-e2e-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      fixture.teamName
    ),
    'Fixture team name must contain a random UUID'
  );
  const root = await realpath(fixture.root);
  assert.equal(path.dirname(root), await realpath(os.tmpdir()));
  assert(/^team-stop-desktop-e2e-[a-zA-Z0-9]+$/.test(path.basename(root)));
  const contained = async (candidate) => {
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
  ]) {
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
  assert(/^\d+\.\d+\.\d+$/.test(fixture.deliveryRuntimeVersion));
  await contained(fixtureFile);
  await contained(path.join(fixture.claudeRoot, 'teams', fixture.teamName, 'config.json'));
  return fixture;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)));
  });
}

function assertNoMatchingTeamProcess(teamName) {
  const processTable = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const escaped = teamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const teamArgument = new RegExp(`(?:^|\\s)--team-name(?:=|\\s+)${escaped}(?:\\s|$)`);
  const agentArgument = new RegExp(`(?:^|\\s)--agent-id(?:=|\\s+)[^\\s]*@${escaped}(?:\\s|$)`);
  const collisions = processTable
    .split(/\r?\n/)
    .filter((line) => teamArgument.test(line) || agentArgument.test(line));
  assert.deepEqual(
    collisions,
    [],
    `Fixture identity collides with a live process: ${collisions.join('\n')}`
  );
}

async function expectedDevMcpPort(preferred = 9222) {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('No free dev:mcp CDP port near 9222');
}

function getTargets(port) {
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

async function waitForRenderer(port) {
  const deadline = Date.now() + 90_000;
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

async function startApp(fixture) {
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
    // Avoid reading the user's interactive zsh profiles in this disposable UI fixture.
    SHELL: '/bin/sh',
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    NODE_BINARY: nodeBinary,
    // This executable answers only --version and denies every bridge/lifecycle
    // command. The renderer E2E must never touch a real runtime process.
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: fixture.runtimeWrapperPath,
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    // pnpm 11 otherwise treats the isolated XDG cache as a reason to run an
    // implicit install. The E2E dependency view is prepared by the caller and
    // must remain read-only during desktop launch.
    pnpm_config_verify_deps_before_run: 'false',
  };
  appProcess = spawn('pnpm', ['dev:mcp'], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  appProcessGroupId = appProcess.pid;
  appProcess.stdout.on('data', (chunk) => rememberAppLog(chunk, 'stdout'));
  appProcess.stderr.on('data', (chunk) => rememberAppLog(chunk, 'stderr'));
  appProcess.once('error', (error) => rememberAppLog(`spawn error: ${error.message}\n`, 'stderr'));
  const exitedBeforeRenderer = new Promise((_, reject) => {
    appProcess.once('exit', (code, signal) => {
      reject(
        new Error(
          `pnpm dev:mcp exited before CDP was ready (${code ?? signal ?? 'unknown'})\n` +
            appLogTail.slice(-40).join('\n')
        )
      );
    });
  });
  const ownedPort = (async () => {
    const deadline = Date.now() + 90_000;
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

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        Promise.resolve(listener(message.params)).catch((error) => {
          process.stderr.write(`CDP listener ${message.method} failed: ${String(error)}\n`);
        });
      }
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new CdpClient(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? 'Renderer evaluation failed'
      );
    }
    return response.result.value;
  }

  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastTransientError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return;
        lastTransientError = null;
      } catch (error) {
        if (
          !/execution context was destroyed|cannot find (?:default )?execution context/i.test(
            String(error)
          )
        ) {
          throw error;
        }
        lastTransientError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Timed out waiting for ${label}${lastTransientError ? `: ${String(lastTransientError)}` : ''}`
    );
  }

  async rect(expression) {
    return this.evaluate(`(() => {
      const element = (${expression});
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height }
        : null;
    })()`);
  }

  async inputPoint(expression) {
    return this.evaluate(`(async () => {
      const element = (${expression});
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const candidates = [
        [0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.35], [0.5, 0.65]
      ];
      for (const [xRatio, yRatio] of candidates) {
        const x = rect.left + rect.width * xRatio;
        const y = rect.top + rect.height * yRatio;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === element || element.contains(hit))) return { x, y };
      }
      return null;
    })()`);
  }

  async moveTo(expression) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 1,
      y: 1,
      pointerType: 'mouse',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const point = await this.inputPoint(expression);
    assert(point, `Element is not hit-testable: ${expression}`);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      pointerType: 'mouse',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x + 0.25,
      y: point.y,
      pointerType: 'mouse',
    });
  }

  async click(expression) {
    const point = await this.inputPoint(expression);
    assert(point, `Element is not hit-testable: ${expression}`);
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

  async key(key, code = key) {
    const virtualKey = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0;
    await this.send('Page.bringToFront');
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.waitFor('document.hasFocus()', 'focused renderer before keyboard input');
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: virtualKey,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: virtualKey,
    });
  }

  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(file, Buffer.from(result.data, 'base64'));
  }

  close() {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.once('close', resolve);
      this.socket.close();
    });
  }
}

function fixtureBootstrap(fixture) {
  return `(() => {
    const state = {
      teamName: ${JSON.stringify(fixture.teamName)},
      projectPath: ${JSON.stringify(fixture.projectPath)},
      mode: 'success',
      alive: true,
      stopCalls: 0,
      forceStopCalls: 0,
      processAliveCalls: 0,
      getDataCalls: 0,
      getDataThrowCalls: 0,
      listCalls: 0,
      deferred: null,
      reset(mode = 'success') {
        if (this.deferred) throw new Error('Settle the pending fixture stop before reset');
        this.mode = mode;
        this.alive = true;
        this.stopCalls = 0;
        this.forceStopCalls = 0;
        this.processAliveCalls = 0;
        this.getDataCalls = 0;
        this.getDataThrowCalls = 0;
        this.listCalls = 0;
      },
      resolveStop() {
        if (!this.deferred) throw new Error('No deferred Stop to resolve');
        this.alive = false;
        const pending = this.deferred;
        this.deferred = null;
        pending.resolve();
      },
      createApi(realApi) {
        if (this.api) return this.api;
        const teams = new Proxy({}, {
          get: (_target, property) => {
            if (property === 'list') return async (...args) => {
              state.listCalls += 1;
              const result = await realApi.teams.list(...args);
              if (result.length !== 1 || result[0]?.teamName !== state.teamName ||
                  result[0]?.projectPath !== state.projectPath) {
                throw new Error('Stop E2E list escaped its isolated fixture');
              }
              return result;
            };
            if (property === 'getData') return async (teamName, ...args) => {
              state.getDataCalls += 1;
              if (teamName !== state.teamName) throw new Error('Unexpected team getData: ' + teamName);
              if (state.mode === 'refresh_throw' && state.stopCalls > 0) {
                state.getDataThrowCalls += 1;
                throw new Error('fixture refresh failed after successful stop');
              }
              const result = await realApi.teams.getData(teamName, ...args);
              if (result.config?.projectPath !== state.projectPath) {
                throw new Error('Stop E2E getData escaped its isolated project');
              }
              return { ...result, isAlive: state.alive };
            };
            if (property === 'aliveList') return async () => state.alive ? [state.teamName] : [];
            if (property === 'processAlive') return async (teamName) => {
              state.processAliveCalls += 1;
              if (teamName !== state.teamName) throw new Error('Unexpected processAlive team');
              if (state.mode === 'status_unknown') throw new Error('fixture process probe failed');
              const alive = state.mode === 'still_running';
              state.alive = alive;
              return alive;
            };
            if (property === 'stop') return async (teamName) => {
              state.stopCalls += 1;
              if (teamName !== state.teamName) throw new Error('Unexpected stop team');
              if (state.mode === 'deferred') {
                if (state.deferred) throw new Error('Duplicate deferred Stop reached fixture API');
                return new Promise((resolve, reject) => { state.deferred = { resolve, reject }; });
              }
              if (state.mode === 'transport_offline' || state.mode === 'still_running' ||
                  state.mode === 'status_unknown') {
                throw new Error('fixture stop transport failed');
              }
              state.alive = false;
            };
            if (property === 'forceStop') return async () => {
              state.forceStopCalls += 1;
              throw new Error('forceStop must never be called by Stop UI E2E');
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
    window.__teamStopE2E = state;
  })();`;
}

async function installApiInterception(client, fixture) {
  let patchCount = 0;
  let patchError = null;
  const observedScriptPaths = new Set();
  let resolveFirstPatch;
  let rejectFirstPatch;
  const firstPatch = new Promise((resolve, reject) => {
    resolveFirstPatch = resolve;
    rejectFirstPatch = reject;
  });
  client.on('Fetch.requestPaused', async (event) => {
    const url = new URL(event.request.url);
    observedScriptPaths.add(url.pathname);
    // Vite may expose aliased imports as /@fs/<absolute repo>/src/.... Match
    // only this checkout's exact API module, never another renderer source.
    if (!expectedApiModulePaths.has(url.pathname) || !event.responseStatusCode) {
      await client.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    try {
      const bodyResult = await client.send('Fetch.getResponseBody', { requestId: event.requestId });
      const source = bodyResult.base64Encoded
        ? Buffer.from(bodyResult.body, 'base64').toString('utf8')
        : bodyResult.body;
      const occurrences = source.split(apiNeedle).length - 1;
      assert.equal(occurrences, 1, 'Expected exactly one getImpl fixture injection needle');
      const replacement = `${apiNeedle.split('\n')[0]}\n  const stopFixture = window.__teamStopE2E;\n  if (window.electronAPI && stopFixture?.createApi) return stopFixture.createApi(window.electronAPI);\n  ${apiNeedle.split('\n')[1]}`;
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
        .send('Fetch.failRequest', {
          requestId: event.requestId,
          errorReason: 'Failed',
        })
        .catch(() => undefined);
    }
  });
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api/index.ts*', resourceType: 'Script', requestStage: 'Response' }],
  });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureBootstrap(fixture) });
  await client.send('Page.reload', { ignoreCache: true });
  let timeout;
  try {
    await Promise.race([
      firstPatch,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `API module was not intercepted; observed ${JSON.stringify(
                  [...observedScriptPaths]
                    .filter((value) => /api|renderer/i.test(value))
                    .slice(-100)
                )}`
              )
            ),
          30_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (patchError) throw patchError;
  await client.waitFor(
    'window.__teamStopE2E && window.__agentTeamsDevStore && window.electronAPI?.teams',
    'fixture API and dev store',
    60_000
  );
  return () => {
    if (patchError) throw patchError;
    return patchCount;
  };
}

const visible = (expression) => `(() => {
  const element = (${expression});
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
})()`;
const teamCard = () => `Array.from(document.querySelectorAll('[role="button"]'))
  .find((element) => element.querySelector('h3')?.textContent?.trim() ===
    window.__teamStopE2E?.teamName)`;
const listStop = (
  teamName
) => `Array.from((${teamCard(teamName)})?.querySelectorAll('button') ?? [])
  .find((button) => /stop/i.test(button.getAttribute('aria-label') ?? '') &&
    !/force/i.test(button.getAttribute('aria-label') ?? ''))`;
const detailStop = `Array.from(document.querySelectorAll('button')).find((button) =>
  /^(stop|stopping\.\.\.)$/i.test(button.textContent?.trim() ?? '') &&
  button.getBoundingClientRect().width > 0)`;
const dialog = `document.querySelector('[role="dialog"][aria-modal="true"]')`;
const activeTabType = `(() => {
  const state = window.__agentTeamsDevStore?.getState();
  const pane = state?.paneLayout?.panes?.find((candidate) =>
    candidate.id === state.paneLayout.focusedPaneId);
  return pane?.tabs?.find((tab) => tab.id === pane.activeTabId)?.type ?? null;
})()`;
const activeTeamTab = `(() => {
  const state = window.__agentTeamsDevStore?.getState();
  const pane = state?.paneLayout?.panes?.find((candidate) =>
    candidate.id === state.paneLayout.focusedPaneId);
  const tab = pane?.tabs?.find((candidate) => candidate.id === pane.activeTabId);
  return tab?.type === 'team' ? { type: tab.type, teamName: tab.teamName } : null;
})()`;

function isProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH' || error?.code === 'EPERM') return false;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
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
  // Do not enter Electron's graceful shutdown path: it performs a global
  // orphan-process scan. This detached group belongs only to this harness.
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

async function waitForAppLog(fragment, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appLogTail.some((line) => line.includes(fragment))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for app log: ${fragment}`);
}

async function run() {
  if (process.argv.includes('--seed')) {
    const seeded = await seedFixture();
    process.stdout.write(`${JSON.stringify(seeded, null, 2)}\n`);
    return;
  }
  const suppliedFixture = argument('--fixture');
  const seeded = suppliedFixture ? null : await seedFixture();
  const fixtureFile = suppliedFixture ?? seeded.fixtureFile;
  const fixture = await validateFixture(fixtureFile);
  assertNoMatchingTeamProcess(fixture.teamName);
  await mkdir(evidenceRoot, { recursive: true });
  const externalCdp = argument('--cdp');
  let port;
  let renderer;
  let ownedApp = false;
  const evidence = {
    kind: 'team-stop-desktop-e2e-v1',
    fixture: fixtureFile,
    evidenceRoot,
    providerLaunched: false,
    cdpPort: null,
    externalCdp: Boolean(externalCdp),
    fixtureRuntimeWrapper: fixture.runtimeWrapperPath,
    deliveryRuntimeVersion: fixture.deliveryRuntimeVersion,
    deliveryRuntimeProofSeparate: true,
    assertions: [],
    screenshots: [],
  };
  let succeeded = false;
  const record = (label) => {
    evidence.assertions.push(label);
    process.stdout.write(`PASS ${label}\n`);
  };
  const screenshot = async (name) => {
    const file = path.join(evidenceRoot, `${name}.png`);
    await cdp.screenshot(file);
    evidence.screenshots.push(file);
  };
  const counts = () =>
    cdp.evaluate(`(() => {
      const state = window.__teamStopE2E;
      return state ? {
        stop: state.stopCalls,
        forceStop: state.forceStopCalls,
        probe: state.processAliveCalls,
        getData: state.getDataCalls,
        getDataThrows: state.getDataThrowCalls,
        list: state.listCalls,
        alive: state.alive,
        deferred: Boolean(state.deferred)
      } : null;
    })()`);
  const reset = async (mode) => {
    assert.equal(
      (await counts()).deferred,
      false,
      'Pending fixture Stop must be settled before reset'
    );
    await cdp.evaluate(`window.__teamStopE2E.reset(${JSON.stringify(mode)})`);
  };
  const setViewport = async (width, height = 900) => {
    // Renderer reloads reset Overlay state. Disable Chromium's gray viewport
    // size HUD immediately around every emulated resize so evidence is clean.
    await cdp.send('DOM.enable');
    await cdp.send('Overlay.enable');
    await cdp.send('Overlay.setShowViewportSizeOnResize', { show: false });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Overlay.setShowViewportSizeOnResize', { show: false });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await cdp.evaluate('window.scrollTo(0, 0)');
  };
  const assertFitsViewport = async (expression, label) => {
    const fit = await cdp.evaluate(`(() => {
      const element = (${expression});
      if (!(element instanceof HTMLElement)) return { exists: false };
      const rect = element.getBoundingClientRect();
      return { exists: true, left: rect.left, right: rect.right, width: rect.width,
        top: rect.top, bottom: rect.bottom, height: rect.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth };
    })()`);
    assert.equal(fit.exists, true, `${label} is missing`);
    assert(fit.width > 0 && fit.height > 0, `${label} has empty bounds`);
    assert(fit.left >= 0 && fit.right <= fit.viewportWidth, `${label} is horizontally clipped`);
    assert(fit.top >= 0 && fit.bottom <= fit.viewportHeight, `${label} is vertically clipped`);
    assert(
      fit.documentWidth <= fit.viewportWidth + 1,
      `${label} document overflows horizontally (${fit.documentWidth} > ${fit.viewportWidth})`
    );
    return fit;
  };
  const openList = async () => {
    await cdp.evaluate(`window.__agentTeamsDevStore.getState().openTeamsTab()`);
    await cdp.waitFor(`${activeTabType} === 'teams'`, 'active Teams tab');
    await cdp.waitFor(`Boolean(${teamCard(fixture.teamName)})`, 'fixture Team List card');
    assert(await cdp.rect(teamCard(fixture.teamName)), 'Fixture Team List card is not visible');
  };
  const assertOnlyStop = async (surfaceExpression) => {
    const result = await cdp.evaluate(`(() => {
      const root = (${surfaceExpression}) ?? document;
      const stop = Array.from(root.querySelectorAll('button')).filter((button) => {
        const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
        return /^(stop|stopping(?:\.\.\.)?|stop team)$/i.test(name) &&
          button.getBoundingClientRect().width > 0;
      });
      const forceStop = Array.from(root.querySelectorAll('button')).filter((button) => {
        const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
        return /force\s*stop/i.test(name) && button.getBoundingClientRect().width > 0;
      });
      return {
        count: stop.length,
        names: stop.map((button) =>
          (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()),
        forceStopNames: forceStop.map((button) =>
          (button.getAttribute('aria-label') ?? button.textContent ?? '').trim())
      };
    })()`);
    assert.equal(result.count, 1, `Expected one Stop control, got ${JSON.stringify(result.names)}`);
    assert.deepEqual(result.forceStopNames, [], 'Force Stop must not be visible');
  };
  const closeInfoDialogWithKeyboard = async () => {
    await cdp.waitFor(visible(dialog), 'information dialog');
    const info = await cdp.evaluate(`(() => {
      const root = ${dialog};
      const buttons = Array.from(root.querySelectorAll('button'));
      return { buttons: buttons.map((button) => button.textContent?.trim()),
        focused: root.contains(document.activeElement), activeText: document.activeElement?.textContent?.trim() };
    })()`);
    assert.equal(
      info.buttons.length,
      1,
      `Expected one dialog action: ${JSON.stringify(info.buttons)}`
    );
    assert.equal(info.focused, true, 'Dialog action must receive keyboard focus');
    await cdp.evaluate(`(() => {
      const button = document.activeElement;
      if (!(button instanceof HTMLButtonElement)) throw new Error('Dialog action lost focus');
      window.__teamStopE2E.keyboardProof = [];
      for (const type of ['keydown', 'keypress', 'keyup', 'click']) {
        document.addEventListener(type, (event) => {
          if (type === 'click' && event.target !== button) return;
          window.__teamStopE2E.keyboardProof.push({
            type: event.type,
            key: event.key ?? null,
            code: event.code ?? null,
            trusted: event.isTrusted,
            defaultPrevented: event.defaultPrevented,
            target: event.target instanceof HTMLElement ? {
              tag: event.target.tagName,
              text: event.target.textContent?.trim() ?? ''
            } : null,
            active: document.activeElement instanceof HTMLElement ? {
              tag: document.activeElement.tagName,
              text: document.activeElement.textContent?.trim() ?? ''
            } : null
          });
        }, { once: true });
      }
    })()`);
    await cdp.key('Enter', 'Enter');
    await cdp.waitFor(`!${dialog}`, 'dialog keyboard close');
    const keyboardProof = await cdp.evaluate('window.__teamStopE2E.keyboardProof');
    const eventTypes = keyboardProof.map((event) => event.type);
    assert.equal(
      eventTypes[0],
      'keydown',
      `Unexpected dialog keyboard events: ${JSON.stringify(keyboardProof)}`
    );
    assert(eventTypes.includes('keypress'), 'Dialog Enter must produce a keypress event');
    assert(eventTypes.includes('keyup'), 'Dialog Enter must produce a keyup event');
    assert(eventTypes.includes('click'), 'Dialog Enter must produce a native click');
    assert(
      keyboardProof.every((event) => event.trusted),
      'Dialog keyboard events must be trusted'
    );
  };

  try {
    if (externalCdp) {
      const endpoint = new URL(
        externalCdp.includes('://') ? externalCdp : `http://127.0.0.1:${externalCdp}`
      );
      assert(['127.0.0.1', 'localhost'].includes(endpoint.hostname));
      port = Number(endpoint.port || 9222);
      renderer = await waitForRenderer(port);
    } else {
      ownedApp = true;
      ({ port, renderer } = await startApp(fixture));
    }
    evidence.cdpPort = port;
    process.stdout.write(`Using isolated dev:mcp CDP port ${port}\n`);
    assert(
      renderer.url.includes(path.basename(repoRoot)) || renderer.url.startsWith('http://localhost:')
    );
    cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Overlay.enable');
    await cdp.send('Overlay.setShowViewportSizeOnResize', { show: false });
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'native API and dev store',
      60_000
    );
    if (!externalCdp) {
      await waitForAppLog(
        'Startup fallback cleanup skipped because host registry cleanup is unavailable'
      );
      assert(
        !appLogTail.some(
          (line) =>
            line.includes('[OpenCode] startup fallback cleanup:') ||
            line.includes('Failed to kill managed OpenCode serve pid=')
        ),
        'Offline UI fixture reached global OpenCode process fallback'
      );
      const deniedRuntimeCalls = (await readFile(fixture.runtimeLedgerPath, 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert(
        deniedRuntimeCalls.length >= 1,
        'Fixture runtime wrapper did not deny startup cleanup'
      );
      evidence.deniedRuntimeCalls = deniedRuntimeCalls;
      record(
        'fixture runtime denied startup bridge commands and global process fallback was skipped'
      );
    }

    const native = await cdp.evaluate(`(async () => {
      const teams = await window.electronAPI.teams.list();
      const data = teams.length === 1
        ? await window.electronAPI.teams.getData(teams[0].teamName)
        : null;
      return { teams: teams.map((team) => ({teamName: team.teamName, projectPath: team.projectPath})),
        dataTeam: data?.teamName, dataProject: data?.config?.projectPath };
    })()`);
    assert.deepEqual(native.teams, [
      { teamName: fixture.teamName, projectPath: fixture.projectPath },
    ]);
    assert.equal(native.dataTeam, fixture.teamName);
    assert.equal(native.dataProject, fixture.projectPath);
    record('native Electron API exposes only the disposable fixture and project root');
    await screenshot('00-native-isolated-as-launched');

    const getPatchCount = await installApiInterception(cdp, fixture);
    await cdp.waitFor('window.__teamStopE2E?.createApi', 'intercepted renderer API');
    assert(getPatchCount() >= 1);
    record('exact Vite API response patched while native preload API stayed frozen');
    const reloadFixture = async (mode) => {
      const previousPatchCount = getPatchCount();
      await cdp.send('Page.reload', { ignoreCache: true });
      const repatchDeadline = Date.now() + 60_000;
      while (getPatchCount() <= previousPatchCount && Date.now() < repatchDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        getPatchCount() > previousPatchCount,
        'Renderer reload did not reapply API interception'
      );
      await cdp.waitFor(
        'window.__teamStopE2E && window.__agentTeamsDevStore && window.electronAPI?.teams',
        'fixture API after renderer reload',
        60_000
      );
      await cdp.waitFor(
        `(() => { const state = window.__agentTeamsDevStore?.getState(); return Boolean(
          state?.paneLayout?.focusedPaneId && state?.paneLayout?.panes?.length && !state?.teamsLoading &&
          state?.teams?.some((team) => team.teamName === window.__teamStopE2E?.teamName)); })()`,
        'hydrated team store after renderer reload',
        60_000
      );
      await reset(mode);
    };
    const freshList = async (mode) => {
      await reloadFixture(mode);
      await openList();
    };
    const freshDetails = async (mode) => {
      await freshList(mode);
      await cdp.click(teamCard(fixture.teamName));
      await cdp.waitFor(
        `(() => { const tab = ${activeTeamTab}; return tab?.type === 'team' &&
          tab.teamName === window.__teamStopE2E?.teamName; })()`,
        'active fixture Team Details tab',
        60_000
      );
      await cdp.waitFor(visible(detailStop), 'detail Stop button', 60_000);
    };

    await setViewport(1280, 900);
    await reset('deferred');
    await openList();
    await assertOnlyStop(teamCard(fixture.teamName));
    const cardBox = await cdp.rect(teamCard(fixture.teamName));
    const listStopBox = await cdp.rect(listStop(fixture.teamName));
    assert(cardBox && listStopBox && listStopBox.width > 0 && listStopBox.height > 0);
    await cdp.moveTo(listStop(fixture.teamName));
    await cdp.waitFor('document.querySelector(\'[role="tooltip"]\')', 'Stop tooltip on hover');
    await cdp.waitFor(
      `Number.parseFloat(getComputedStyle(${listStop(fixture.teamName)}).opacity) >= 0.95`,
      'hovered Stop control opacity'
    );
    await screenshot('01-list-running-normal-tooltip');
    record('Team List normal viewport has one visible Stop and Radix hover tooltip');

    await cdp.key('Escape', 'Escape');
    await cdp.waitFor('!document.querySelector(\'[role="tooltip"]\')', 'hover tooltip close');
    for (let index = 0; index < 30; index += 1) {
      const focused = await cdp.evaluate(
        `document.activeElement === (${listStop(fixture.teamName)})`
      );
      if (focused) break;
      await cdp.key('Tab', 'Tab');
    }
    assert.equal(
      await cdp.evaluate(`document.activeElement === (${listStop(fixture.teamName)})`),
      true
    );
    await cdp.waitFor(
      'document.querySelector(\'[role="tooltip"]\')',
      'Stop tooltip on keyboard focus'
    );
    const listTabBefore = await cdp.evaluate(`window.__agentTeamsDevStore.getState().activeTabId`);
    await cdp.key('Enter', 'Enter');
    await cdp.key('Enter', 'Enter');
    await cdp.waitFor(`(${listStop(fixture.teamName)})?.disabled`, 'list stopping disabled state');
    const listCounts = await counts();
    assert.equal(listCounts.stop, 1);
    assert.equal(listCounts.forceStop, 0);
    assert.equal(listCounts.probe, 0);
    assert.equal(listCounts.alive, true);
    assert.equal(listCounts.deferred, true);
    assert.equal(
      await cdp.evaluate(`window.__agentTeamsDevStore.getState().activeTabId`),
      listTabBefore
    );
    const listBusy = await cdp.evaluate(`(() => { const button = ${listStop(fixture.teamName)};
      return { disabled: button.disabled, busy: button.getAttribute('aria-busy'), name: button.getAttribute('aria-label') }; })()`);
    assert.equal(listBusy.disabled, true);
    assert.equal(listBusy.busy, 'true');
    assert(/stopping/i.test(listBusy.name));
    record('keyboard Enter stays on the list card and same-tick repeat makes one Stop request');

    await setViewport(900, 780);
    await assertFitsViewport(teamCard(fixture.teamName), 'narrow Team List card');
    await assertFitsViewport(listStop(fixture.teamName), 'narrow Team List Stop');
    await screenshot('02-list-stopping-narrow');
    record('Team List narrow viewport keeps disabled Stopping control visible');
    await cdp.evaluate('window.__teamStopE2E.resolveStop()');
    await cdp.waitFor(`!(${listStop(fixture.teamName)})`, 'list success becomes offline');
    assert.equal((await counts()).forceStop, 0);

    await setViewport(1280, 900);
    await freshList('transport_offline');
    await cdp.click(listStop(fixture.teamName));
    await cdp.waitFor(
      'window.__teamStopE2E?.processAliveCalls === 1',
      'list offline process probe'
    );
    await cdp.waitFor(
      `!(${listStop(fixture.teamName)})`,
      'list transport error with offline probe becomes success'
    );
    assert.equal(await cdp.evaluate(`Boolean(${dialog})`), false);
    assert.equal((await counts()).stop, 1);

    await freshList('still_running');
    await cdp.click(listStop(fixture.teamName));
    await cdp.waitFor(visible(dialog), 'list still-running dialog');
    assert(
      /still running|still works|works still/i.test(await cdp.evaluate(`(${dialog}).innerText`))
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await counts()).stop, 1);
    assert.equal((await counts()).forceStop, 0);
    await closeInfoDialogWithKeyboard();

    await freshList('status_unknown');
    await cdp.click(listStop(fixture.teamName));
    await cdp.waitFor(visible(dialog), 'list unknown-status dialog');
    assert(/confirm|runtime|status/i.test(await cdp.evaluate(`(${dialog}).innerText`)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const listUnknownCounts = await counts();
    assert.equal(listUnknownCounts.stop, 1);
    assert.equal(listUnknownCounts.probe, 1);
    assert.equal(listUnknownCounts.forceStop, 0);
    await closeInfoDialogWithKeyboard();
    record('Team List reports transport outcomes without automatic retry or Force Stop');

    await setViewport(1280, 900);
    await freshDetails('deferred');
    await assertOnlyStop('document');
    await screenshot('03-details-running-normal');
    await cdp.click(detailStop);
    await cdp.click(detailStop).catch(() => undefined);
    await cdp.waitFor(`(${detailStop})?.disabled`, 'details stopping disabled state');
    let detailCounts = await counts();
    assert.equal(detailCounts.stop, 1);
    assert.equal(detailCounts.forceStop, 0);
    const detailBusy = await cdp.evaluate(`(() => { const button = ${detailStop}; return {
      disabled: button.disabled, busy: button.getAttribute('aria-busy'), text: button.textContent?.trim(),
      width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }; })()`);
    assert.equal(detailBusy.disabled, true);
    assert.equal(detailBusy.busy, 'true');
    assert(/stopping/i.test(detailBusy.text));
    assert(detailBusy.width > 0 && detailBusy.height > 0);
    await setViewport(900, 780);
    await assertFitsViewport(detailStop, 'narrow Team Details Stop');
    await screenshot('04-details-stopping-narrow');
    await cdp.evaluate('window.__teamStopE2E.resolveStop()');
    await cdp.waitFor(`!(${detailStop})`, 'details success becomes offline');
    record('Team Details normal and narrow viewports show one guarded dynamic Stop control');

    await setViewport(1280, 900);
    await freshDetails('transport_offline');
    await cdp.click(detailStop);
    await cdp.waitFor('window.__teamStopE2E?.processAliveCalls === 1', 'offline process probe');
    await cdp.waitFor(`!(${detailStop})`, 'transport error with offline probe becomes success');
    assert.equal(await cdp.evaluate(`Boolean(${dialog})`), false);
    assert.equal((await counts()).stop, 1);
    record('transport error plus processAlive=false succeeds silently without retry');

    await freshDetails('still_running');
    await cdp.click(detailStop);
    await cdp.waitFor(visible(dialog), 'still-running dialog');
    const stillText = await cdp.evaluate(`(${dialog}).innerText`);
    assert(/still running|still works|works still/i.test(stillText));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await counts()).stop, 1, 'still-running result must not auto-retry');
    assert.equal((await counts()).forceStop, 0);
    await setViewport(900, 780);
    await assertFitsViewport(dialog, 'narrow still-running dialog');
    await screenshot('05-details-still-running-dialog');
    await closeInfoDialogWithKeyboard();
    await cdp.click(detailStop);
    await cdp.waitFor('window.__teamStopE2E?.stopCalls === 2', 'manual Stop retry');
    assert.equal((await counts()).forceStop, 0);
    await closeInfoDialogWithKeyboard();
    record('still-running dialog has one focused Close action and retries only manually');

    await freshDetails('status_unknown');
    await cdp.click(detailStop);
    await cdp.waitFor(visible(dialog), 'unknown-status dialog');
    const unknownText = await cdp.evaluate(`(${dialog}).innerText`);
    assert(/confirm|runtime|status/i.test(unknownText));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const unknownCounts = await counts();
    assert.equal(unknownCounts.stop, 1);
    assert.equal(unknownCounts.probe, 1);
    assert.equal(unknownCounts.forceStop, 0);
    await setViewport(900, 780);
    await assertFitsViewport(dialog, 'narrow status-unknown dialog');
    await screenshot('06-details-status-unknown-dialog');
    await closeInfoDialogWithKeyboard();
    record('probe failure reports unknown status without automatic retry or Force Stop');

    await freshDetails('refresh_throw');
    const getDataBeforeRefreshFailure = (await counts()).getData;
    await cdp.click(detailStop);
    await cdp.waitFor(
      `window.__teamStopE2E?.stopCalls === 1 &&
      !document.querySelector('[role="dialog"]') && !(${detailStop})?.disabled`,
      'refresh failure settles'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refreshCounts = await counts();
    assert.equal(refreshCounts.stop, 1);
    assert.equal(refreshCounts.forceStop, 0);
    assert.equal(refreshCounts.alive, false);
    assert.equal(
      refreshCounts.getDataThrows,
      1,
      'Post-Stop refresh must exercise the throwing stub'
    );
    assert(
      refreshCounts.getData > getDataBeforeRefreshFailure,
      'Post-Stop refresh must make a new getData call'
    );
    record('refresh failure preserves successful Stop outcome and does not escape to real APIs');

    assert(
      getPatchCount() >= 1,
      'Fetch interception must remain installed through renderer reload/HMR'
    );
    evidence.fetchPatchCount = getPatchCount();
    evidence.finalCounters = await counts();
    await json(path.join(evidenceRoot, 'evidence.json'), evidence);
    succeeded = true;
    process.stdout.write(
      `Team Stop desktop E2E passed with ${evidence.assertions.length} assertions.\n`
    );
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error);
    evidence.appLogTail = appLogTail;
    if (cdp) {
      evidence.rendererDiagnostics = await cdp
        .evaluate(
          `(() => ({
        fixture: window.__teamStopE2E ? {
          stopCalls: window.__teamStopE2E.stopCalls,
          forceStopCalls: window.__teamStopE2E.forceStopCalls,
          processAliveCalls: window.__teamStopE2E.processAliveCalls,
          getDataCalls: window.__teamStopE2E.getDataCalls,
          getDataThrowCalls: window.__teamStopE2E.getDataThrowCalls,
          alive: window.__teamStopE2E.alive,
          deferred: Boolean(window.__teamStopE2E.deferred)
        } : null,
        keyboardProof: window.__teamStopE2E?.keyboardProof ?? null,
        activeElement: document.activeElement ? {
          tag: document.activeElement.tagName,
          text: document.activeElement.textContent?.trim(),
          ariaLabel: document.activeElement.getAttribute?.('aria-label'),
          disabled: document.activeElement.disabled ?? null
        } : null,
        activeTabId: window.__agentTeamsDevStore?.getState().activeTabId ?? null,
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((item) => item.innerText),
        stopButtons: Array.from(document.querySelectorAll('button')).filter((button) =>
          /stop/i.test((button.getAttribute('aria-label') ?? button.textContent ?? '').trim())
        ).map((button) => ({
          text: button.textContent?.trim(),
          ariaLabel: button.getAttribute('aria-label'),
          ariaBusy: button.getAttribute('aria-busy'),
          disabled: button.disabled,
          rect: button.getBoundingClientRect().toJSON()
        }))
      }))()`
        )
        .catch((diagnosticError) => ({ error: String(diagnosticError) }));
      await cdp.screenshot(path.join(evidenceRoot, 'failure-renderer.png')).catch(() => undefined);
    }
    await json(path.join(evidenceRoot, 'failure.json'), evidence).catch(() => undefined);
    throw error;
  } finally {
    if (ownedApp) await stopOwnedApp();
    else await cdp?.close().catch(() => undefined);
    if (seeded && succeeded && process.env.AGENT_TEAMS_STOP_E2E_KEEP !== '1') {
      await rm(seeded.fixture.root, { recursive: true, force: true });
    } else if (seeded && !succeeded) {
      process.stderr.write(
        `Retained failed disposable fixture for diagnosis: ${seeded.fixture.root}\n`
      );
    }
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
