#!/usr/bin/env node
// Disposable Electron E2E for the Teams creation page. Seeds an isolated
// team/project, exercises Back/resume, tab switches, process restart, copy and
// config-only creation, and verifies launch still opens its original dialog.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const appLogTail = [];
const appLogRemainder = { stdout: '', stderr: '' };
let appProcess = null;
let appProcessGroupId = null;
let mainInspectorWebSocketUrl = null;
let expectedMainInspectorPort = null;
let cdp = null;
let inputSelectAllDomFallbacks = 0;

function rememberAppLog(chunk, stream) {
  const text = chunk.toString();
  const lines = `${appLogRemainder[stream]}${text}`.split(/\r?\n/);
  appLogRemainder[stream] = lines.pop() ?? '';
  for (const line of lines) {
    const target = line.match(/Debugger listening on (ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/[a-z0-9-]+)/i);
    if (target && Number(target[2]) === expectedMainInspectorPort)
      mainInspectorWebSocketUrl = target[1];
  }
  appLogTail.push(...lines.filter(Boolean));
  if (appLogTail.length > 200) appLogTail.splice(0, appLogTail.length - 200);
}

// Use an explicit, available port: electron-vite treats --inspect=0 as disabled.
async function findFreeInspectorPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback inspector port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function seedFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'teams-create-page-e2e-')));
  const runtimeLock = JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
  const fixture = {
    kind: 'teams-create-page-desktop-v1',
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
    teamName: `teams-create-page-e2e-${randomUUID()}`,
    memberName: 'team-lead',
    runtimeScriptPath: path.join(root, 'fixture-runtime-deny.cjs'),
    runtimeWrapperPath: path.join(
      root, process.platform === 'win32' ? 'fixture-runtime-deny.cmd' : 'fixture-runtime-deny.cjs'
    ),
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
    fixture.runtimeScriptPath,
    `#!${nodeBinary}\n'use strict';\n` +
      `const fs = require('node:fs');\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args.length === 1 && args[0] === '--version') {\n` +
      `  process.stdout.write(${JSON.stringify(`${runtimeLock.version}\n`)});\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `if (args.length === 1 && args[0] === '--help') {\n` +
      `  process.stdout.write('Usage: fixture\\n  -p, --print\\n');\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `fs.appendFileSync(${JSON.stringify(fixture.runtimeLedgerPath)}, JSON.stringify({ args, at: Date.now() }) + '\\n');\n` +
      `process.stderr.write('fixture runtime denies all lifecycle and provider commands\\n');\n` +
      `process.exit(77);\n`
  );
  if (process.platform === 'win32') {
    // Dev bootstrap uses the project's Windows-shell-aware runner for .cmd.
    // Keep the test runtime deny-all; never point this fixture at real providers.
    await writeFile(
      fixture.runtimeWrapperPath,
      `@echo off\r\n"${nodeBinary}" "${fixture.runtimeScriptPath}" %*\r\n`
    );
  } else {
    await chmod(fixture.runtimeScriptPath, 0o755);
  }
  await writeFile(fixture.runtimeLedgerPath, '');
  await writeFile(path.join(fixture.projectPath, 'README.md'), '# Disposable Teams Creation Page E2E\n');
  const member = {
    name: fixture.memberName,
    agentId: `${fixture.memberName}@${fixture.teamName}`,
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
    description: 'Disposable Teams creation E2E fixture',
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
  await mkdir(path.join(fixture.claudeRoot, 'projects'), { recursive: true });
  await mkdir(path.join(fixture.claudeRoot, 'tasks', fixture.teamName), { recursive: true });
  await json(path.join(root, 'fixture.json'), fixture);
  return fixture;
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
  // Never use a previous process's DevTools URL while launching the new one.
  appLogTail.length = 0;
  mainInspectorWebSocketUrl = null;
  appLogRemainder.stdout = '';
  appLogRemainder.stderr = '';
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
    ...(process.platform === 'win32' ? {} : { SHELL: '/bin/sh' }),
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    NODE_BINARY: nodeBinary,
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: fixture.runtimeWrapperPath,
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    pnpm_config_verify_deps_before_run: 'false',
  };
  // Windows pnpm is a .cmd shim, which cannot be spawned as a POSIX executable.
  // Keep a known launcher PID for taskkill /T on teardown (including restart).
  const windows = process.platform === 'win32';
  const inspectorPort = await findFreeInspectorPort();
  expectedMainInspectorPort = inspectorPort;
  appProcess = spawn(
    windows ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    windows ? ['/d', '/s', '/c', `pnpm dev:mcp --inspect=${inspectorPort}`] : ['dev:mcp', `--inspect=${inspectorPort}`, ...(process.platform === 'linux' ? ['--noSandbox'] : [])],
    {
      cwd: repoRoot,
      detached: !windows,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }
  );
  appProcessGroupId = appProcess.pid;
  appProcess.stdout.on('data', (chunk) => rememberAppLog(chunk, 'stdout'));
  appProcess.stderr.on('data', (chunk) => rememberAppLog(chunk, 'stderr'));
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
  // electron-vite --inspect exposes the *main process* on loopback; renderer
  // CDP cannot access BrowserWindow.webContents.zoomFactor or menu accelerators.
  const inspectorWebSocketDebuggerUrl = await Promise.race([
    (async () => {
      const deadline = Date.now() + 10_000;
      while (!mainInspectorWebSocketUrl && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (!mainInspectorWebSocketUrl)
        throw new Error('Main-process loopback V8 inspector was not started');
      return mainInspectorWebSocketUrl;
    })(),
    exitedBeforeRenderer,
  ]);
  return { port, renderer, inspectorWebSocketDebuggerUrl };
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

  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 30_000) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
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
          !/execution context was destroyed|cannot find (?:default )?execution context|CDP command timed out: Runtime\.evaluate/i.test(
            String(error)
          )
        ) {
          throw error;
        }
        lastTransientError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(
      `Timed out waiting for ${label}${lastTransientError ? `: ${String(lastTransientError)}` : ''}`
    );
  }

  async click(expression) {
    await this.waitFor(expression, expression);
    const target = await this.evaluate(`(() => {
      const element = ${expression};
      if (!element || element.disabled) return null;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null;
    })()`);
    assert(target, `Missing/disabled/hidden E2E click target: ${expression}`);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1,
    });
  }

  async fill(selector, value) {
    const expression = `document.querySelector(${JSON.stringify(selector)})`;
    await this.click(expression);
    const mac = process.platform === 'darwin';
    const modifier = mac ? 4 : 2; // CDP: Meta or Control
    const modifierKey = mac ? 'Meta' : 'Control';
    const modifierCode = mac ? 'MetaLeft' : 'ControlLeft';
    const modifierCodeValue = mac ? 91 : 17;
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: modifierKey, code: modifierCode,
      windowsVirtualKeyCode: modifierCodeValue, modifiers: modifier,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      modifiers: modifier,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      modifiers: modifier,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: modifierKey, code: modifierCode,
      windowsVirtualKeyCode: modifierCodeValue,
    });
    // macOS Electron can ignore an emulated Cmd+A accelerator despite receiving
    // the key events. Verify selection, then use Blink's native edit command.
    const entireValueSelected = async () => this.evaluate(`(() => {
      const input = ${expression};
      return !!input && input.selectionStart === 0 &&
        input.selectionEnd === input.value.length;
    })()`);
    if (!(await entireValueSelected()) && mac) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'],
      });
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4,
      });
    }
    if (!(await entireValueSelected()) && mac) {
      // CDP's synthetic Command+A is sometimes ignored by Electron/macOS.
      // Try an actual triple-click before the last-resort DOM selection.
      const bounds = await this.evaluate(`(() => {
        const rect = ${expression}.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...bounds, button: 'left', clickCount: 3,
      });
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...bounds, button: 'left', clickCount: 3,
      });
    }
    if (!(await entireValueSelected()) && mac) {
      inputSelectAllDomFallbacks++;
      // Fixture-only fallback; recorded in the E2E report, never treated as
      // evidence that the native macOS keyboard accelerator works.
      // Pass the selector as data to CDP, never interpolate it into evaluated code.
      const global = await this.send('Runtime.evaluate', { expression: 'window' });
      assert(global.result?.objectId, 'No renderer global object for selection fallback');
      const selected = await this.send('Runtime.callFunctionOn', {
        objectId: global.result.objectId,
        functionDeclaration: 'function(selector) { const input = document.querySelector(selector); input?.focus(); input?.select(); }',
        arguments: [{ value: selector }],
      });
      assert(!selected.exceptionDetails, 'DOM selection fallback raised a renderer exception');
    }
    assert(await entireValueSelected(), `Input select-all failed for ${selector}`);
    await this.send('Input.insertText', { text: value });
    await this.waitFor(
      `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
      `field ${selector}=${value}`
    );
  }

  close() {
    this.socket.close();
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error?.code === 'ESRCH' || error?.code === 'EPERM') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cleanup(fixture) {
  if (cdp) {
    try {
      cdp.close();
    } catch {
      // already gone
    }
    cdp = null;
  }
  if (appProcessGroupId && process.platform !== 'win32') {
    try {
      process.kill(-appProcessGroupId, 'SIGKILL');
    } catch {
      appProcess?.kill('SIGKILL');
    }
    await waitForProcessGroupExit(appProcessGroupId, 4_000);
  } else if (appProcess?.pid && process.platform === 'win32') {
    // Killing only cmd.exe leaves the child pnpm/Electron processes alive and
    // contaminates the second launch or the next CI job.
    const launcherPid = appProcess.pid;
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(launcherPid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else if (appProcess?.pid) {
    appProcess.kill('SIGKILL');
  }
  appProcess = null;
  appProcessGroupId = null;
  if (fixture?.root && process.env.TEAMS_CREATE_PAGE_E2E_KEEP !== '1') {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(fixture.root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 7) {
          process.stderr.write(`Fixture cleanup failed: ${String(error)}\n`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}

async function dumpRenderer(client, label) {
  if (!client) return;
  try {
    const snapshot = await client.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return {
        label: ${JSON.stringify(label)},
        dialog: Boolean(dialog),
        creationPageName: document.querySelector('[data-testid="create-team-page"] #team-name')?.value ?? null,
        bodyText: (document.body?.innerText ?? '').slice(0, 800),
      };
    })()`);
    process.stderr.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Renderer dump failed: ${String(error)}\n`);
  }
}

async function captureScreenshot(client, fixture, label) {
  const dir = process.env.TEAMS_CREATE_E2E_ARTIFACT_DIR || path.join(fixture.root, 'artifacts');
  await mkdir(dir, { recursive: true });
  const result = await client.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(dir, `teams-create-${label}.png`), Buffer.from(result.data, 'base64'));
}

async function initializeTeams(client, fixture, { afterRestart = false } = {}) {
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  try {
    // Cold macOS CI may finish Vite's dev renderer bundle after 60s while
    // Electron main/preload are ready. Wait boundedly for the actual renderer;
    // keep real IPC/store readiness mandatory, never bypass failed startup.
    await client.waitFor('window.electronAPI?.teams && window.__agentTeamsDevStore',
      'native API and dev store', afterRestart && process.platform === 'win32' ? 180_000 : 150_000);
  } catch (error) {
    let startupStatus = null;
    try {
      startupStatus = await client.evaluate(
        "window.electronAPI?.startup?.getStatus?.().catch(() => null) ?? null"
      );
    } catch {
      // The renderer may not have a working preload at all.
    }
    throw new Error(
      `Electron renderer did not initialize after ${afterRestart ? 'process restart' : 'cold start'}; ` +
        `startup status: ${JSON.stringify(startupStatus)}. ${String(error)}`
    );
  }
  const names = await client.evaluate(
    `window.electronAPI.teams.list().then(rows => rows.map(team => team.teamName))`);
  assert(names.includes(fixture.teamName), 'Sandbox team is missing from native API');
  await client.evaluate(
    `window.__agentTeamsDevStore.getState().openTeamsTab(${JSON.stringify(fixture.projectPath)})`);
  await client.waitFor(
    `(() => {
      const s = window.__agentTeamsDevStore?.getState();
      return s && !s.teamsLoading && s.teams?.some(t => t.teamName === ${JSON.stringify(fixture.teamName)});
    })()`,
    'hydrated Teams list', 60_000
  );
}

function createButtonExpression(label) {
  return `Array.from(document.querySelectorAll('button'))
    .find(button => button.textContent?.trim() === ${JSON.stringify(label)}
      && !button.disabled && button.getBoundingClientRect().width > 0)`;
}

/**
 * Use a genuine CDP mouse click only after the nested Advanced toggle is in
 * view. Offscreen CDP clicks can be silently ignored on Linux.
 */
async function expandCreateAdvancedCli(client, toggle, inputSelector) {
  const input = `document.querySelector(${JSON.stringify(inputSelector)})`;
  if (await client.evaluate(`Boolean(${input})`)) return;
  await client.waitFor(toggle, 'create-page Advanced CLI toggle');
  // The Radix optional section animates its height with overflow hidden.
  // A button can have a viewport rect yet be clipped and miss CDP mouse input.
  await client.waitFor(`(() => {
    const button = (${toggle});
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const content = button.closest('.optional-settings-content');
    if (content?.getAnimations().some(animation => animation.playState === 'running')) return false;
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return rect.width > 0 && rect.height > 0 &&
      x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight &&
      Boolean(hit && button.contains(hit));
  })()`, 'Advanced CLI toggle fully visible and receiving pointer events');
  await client.click(toggle);
  await client.waitFor(`Boolean(${input})`, 'Advanced CLI input expanded');
}

async function setBrowserWindowZoom(inspector, factor) {
  return inspector.evaluate(
    "(() => {" +
    "const moduleRequire = typeof require === 'function' ? require : process.mainModule?.require?.bind(process.mainModule);" +
    "if (!moduleRequire) throw new Error('Electron main inspector cannot require modules');" +
    "const { BrowserWindow } = moduleRequire('electron');" +
    "const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://localhost:'));" +
    "if (!win) throw new Error('Isolated app BrowserWindow not found');" +
    "win.webContents.setZoomFactor(" + JSON.stringify(factor) + ");" +
    "return win.webContents.getZoomFactor();" +
    "})()"
  );
}

async function exerciseScheduleUx(client, fixture, log, inspectorWebSocketDebuggerUrl) {
  const scheduleLabel = 'schedule-visual-e2e-' + randomUUID().slice(0, 8);
  log('reject invalid cron and timezone at the actual native IPC boundary');
  for (const { timing, expectedError } of [
    { timing: { cronExpression: 'not a cron', timezone: 'UTC' }, expectedError: /cron/i },
    { timing: { cronExpression: '0 9 * * *', timezone: 'Mars/Olympus' }, expectedError: /time ?zone/i },
  ]) {
    const invalidInput = {
      teamName: fixture.teamName,
      ...timing,
      launchConfig: { cwd: fixture.projectPath, prompt: 'No execution' },
    };
    const result = await client.evaluate(
      'window.electronAPI.schedules.create(' + JSON.stringify(invalidInput) +
        ').then(() => "UNEXPECTED_SUCCESS", error => String(error?.message ?? error))'
    );
    assert.notEqual(result, 'UNEXPECTED_SUCCESS', 'Native IPC accepted invalid schedule timing');
    assert(expectedError.test(result), 'Native IPC returned an unrelated error: ' + result);
  }

  log('open real Schedules UI in isolated Electron');
  await client.evaluate('window.__agentTeamsDevStore.getState().openSchedulesTab()');
  await client.waitFor(createButtonExpression('Add Schedule'), 'Schedules screen ready', 45_000);
  await client.click(createButtonExpression('Add Schedule'));
  await client.waitFor("document.querySelector('[role=dialog] #schedule-label')",
    'actual schedule editor loaded', 45_000);
  await captureScreenshot(client, fixture, 'schedules-editor-opened');
  // The empty-state page also has a "Create Schedule" button behind the modal.
  // Target the enabled dialog submit, not the background trigger.
  const saveButton = "Array.from(document.querySelectorAll('[role=dialog] button'))" +
    ".find(button => button.textContent?.trim() === 'Create Schedule')";
  await client.click(saveButton);
  await client.waitFor(
    "document.querySelector('[role=dialog]')?.textContent?.includes('Team is required')",
    'pristine form shows a reason after Save', 20_000);
  await captureScreenshot(client, fixture, 'schedules-pristine-submit-validation');

  log('select the fixture team and review its saved one-time startup prompt');
  await client.click("document.querySelector('[role=dialog] button[role=combobox]')");
  const teamOption = "Array.from(document.querySelectorAll('[cmdk-item]'))" +
    ".find(option => option.textContent?.includes(" + JSON.stringify(fixture.teamName) + "))";
  await client.click(teamOption);
  await client.waitFor(
    "document.querySelector('#schedule-saved-prompt-reviewed')",
    'saved prompt acknowledgement visible before Save', 45_000);
  await captureScreenshot(client, fixture, 'schedules-old-prompt-review');

  await client.fill('#schedule-label', scheduleLabel);
  await client.fill('#dialog-prompt', 'Review the fixture project and write a short status update.');
  log('invalid cron is field-level visible and blocks Save');
  await client.fill('input[placeholder="0 9 * * 1-5"]', 'not a cron');
  await client.waitFor("(" + saveButton + ")?.disabled === true",
    'invalid cron blocks the Create Schedule action');
  await captureScreenshot(client, fixture, 'schedules-invalid-cron');
  assert.equal(
    (await client.evaluate('window.electronAPI.schedules.list()')).some(s => s.label === scheduleLabel),
    false, 'Invalid cron was persisted before Save'
  );

  await client.fill('input[placeholder="0 9 * * 1-5"]', '*/30 * * * *');
  await client.click("document.querySelector('#schedule-saved-prompt-reviewed')");
  await client.waitFor("(" + saveButton + ")?.disabled === false",
    'valid schedule and reviewed old prompt allow Save', 45_000);
  await captureScreenshot(client, fixture, 'schedules-ready-to-create');
  await client.click(saveButton);
  await client.waitFor("!document.querySelector('[role=dialog]')",
    'schedule saved through the actual UI', 45_000);
  const savedSchedules = await client.evaluate('window.electronAPI.schedules.list()');
  const scheduled = savedSchedules.find(s => s.label === scheduleLabel);
  assert(scheduled?.taskFirst === true && scheduled.teamName === fixture.teamName,
    'New UI schedule did not persist its selected team and task-first mode');
  assert.equal(scheduled.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone,
    'Schedule changed the selected local IANA timezone');
  const invalidEditResult = await client.evaluate(
    'window.electronAPI.schedules.update(' + JSON.stringify(scheduled.id) +
      ', { cronExpression: "not a cron" }).then(() => "UNEXPECTED_SUCCESS", ' +
      'error => String(error?.message ?? error))'
  );
  assert.notEqual(invalidEditResult, 'UNEXPECTED_SUCCESS',
    'Native IPC accepted invalid edit of an active schedule');
  assert(/cron/i.test(invalidEditResult),
    'Native IPC rejected invalid edit for the wrong reason: ' + invalidEditResult);
  const afterRejectedEdit = (await client.evaluate('window.electronAPI.schedules.list()'))
    .find(s => s.id === scheduled.id);
  assert.equal(afterRejectedEdit?.cronExpression, '*/30 * * * *',
    'Rejected timing edit corrupted the saved active schedule');
  assert.equal(afterRejectedEdit?.status, 'active',
    'Rejected timing edit deactivated the saved schedule');

  log('exercise list presentation in dark/light and native Electron 200% zoom');
  for (const theme of ['light', 'dark']) {
    await client.evaluate(
      "window.__agentTeamsDevStore.setState(s => ({ appConfig: { ...s.appConfig, general: { ...s.appConfig?.general, theme: " +
        JSON.stringify(theme) + " } } }))"
    );
    await client.waitFor(
      "document.documentElement.classList.contains(" + JSON.stringify(theme) + ")",
      'schedules ' + theme + ' theme applied');
    await captureScreenshot(client, fixture, 'schedules-list-' + theme);
  }
  const initialViewportWidth = await client.evaluate('window.innerWidth');
  const zoomInspector = await CdpClient.connect(inspectorWebSocketDebuggerUrl);
  try {
    await zoomInspector.send('Runtime.enable');
    const factor = await setBrowserWindowZoom(zoomInspector, 2);
    assert(Math.abs(factor - 2) <= 0.05, 'Schedule window did not accept native 200% zoom');
    await client.waitFor(
      'window.innerWidth < ' + JSON.stringify(initialViewportWidth * 0.7),
      'native Electron zoom narrowed the schedules viewport');
    const zoomGeometry = await client.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-testid=schedule-list-item]'))
        .find(el => el.textContent?.includes(${JSON.stringify(scheduleLabel)}) &&
          el.querySelector('button[aria-label="More actions"]'));
      const container = row?.closest('.overflow-y-auto');
      const viewport = container?.getBoundingClientRect();
      const rect = row?.querySelector('button[aria-label="More actions"]')?.getBoundingClientRect();
      return { actionLeft: rect?.left, actionRight: rect?.right, actionWidth: rect?.width,
        paneLeft: viewport?.left, paneRight: viewport?.right, paneWidth: viewport?.width,
        paneScrollWidth: container?.scrollWidth, windowWidth: window.innerWidth };
    })()`);
    assert(
      zoomGeometry.actionWidth > 0 && zoomGeometry.actionLeft >= zoomGeometry.paneLeft &&
        zoomGeometry.actionRight <= zoomGeometry.paneRight,
      'Schedule actions overflowed pane at native Electron 200% zoom: ' + JSON.stringify(zoomGeometry)
    );
    await captureScreenshot(client, fixture, 'schedules-list-native-electron-zoom-200');
  } finally {
    try {
      await setBrowserWindowZoom(zoomInspector, 1);
    } finally {
      zoomInspector.close();
    }
  }
  await client.waitFor(
    'window.innerWidth >= ' + JSON.stringify(initialViewportWidth * 0.95),
    'schedules viewport restored after native zoom');

  log('capture the schedule UI at a genuinely narrow viewport');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 700, height: 760, deviceScaleFactor: 1, mobile: false,
  });
  try {
    await client.waitFor('window.innerWidth <= 700', 'narrow renderer viewport');
    const narrowActionsVisible = await client.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-testid=schedule-list-item]'))
        .find(el => el.textContent?.includes(${JSON.stringify(scheduleLabel)}) &&
          el.querySelector('button[aria-label="More actions"]'));
      const rect = row?.querySelector('button[aria-label="More actions"]')?.getBoundingClientRect();
      return !!rect && rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
    })()`);
    assert(narrowActionsVisible, 'Schedule actions overflowed narrow viewport');
    await captureScreenshot(client, fixture, 'schedules-list-narrow-700');
  } finally {
    await client.send('Emulation.clearDeviceMetricsOverride');
  }

  log('edit the real schedule without migrating its task-first semantics');
  const more = "Array.from(document.querySelectorAll('[data-testid=schedule-list-item]'))" +
    ".find(row => row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
    "row.querySelector('button[aria-label=\\\"More actions\\\"]'))" +
    "?.querySelector('button[aria-label=\\\"More actions\\\"]')";
  await client.click(more);
  await client.click(createButtonExpression('Edit'));
  await client.waitFor("document.querySelector('[role=dialog] #schedule-label')",
    'existing schedule editor loaded', 45_000);
  await client.fill('input[placeholder="0 9 * * 1-5"]', '0 * * * *');
  await client.waitFor(createButtonExpression('Save Changes'), 'edited schedule can save');
  await captureScreenshot(client, fixture, 'schedules-edit');
  await client.click(createButtonExpression('Save Changes'));
  await client.waitFor("!document.querySelector('[role=dialog]')", 'schedule edit persisted');
  const afterEdit = (await client.evaluate('window.electronAPI.schedules.list()'))
    .find(s => s.id === scheduled.id);
  assert.equal(afterEdit?.cronExpression, '0 * * * *');
  assert.equal(afterEdit.taskFirst, true, 'Edit silently changed schedule execution semantics');

  log('pause and resume the schedule through the real actions menu');
  await client.click(more);
  await client.click(createButtonExpression('Pause'));
  await client.waitFor(
    "Array.from(document.querySelectorAll('[data-testid=schedule-list-item]')).some(row => " +
      "row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
      "row.textContent?.includes('Paused'))",
    'schedule paused in the UI', 45_000);
  const pausedRecord = (await client.evaluate('window.electronAPI.schedules.list()'))
    .find(s => s.id === scheduled.id);
  assert.equal(pausedRecord?.status, 'paused', 'Pause action did not persist');
  await captureScreenshot(client, fixture, 'schedules-paused');

  await client.click(more);
  await client.click(createButtonExpression('Resume'));
  await client.waitFor(
    "Array.from(document.querySelectorAll('[data-testid=schedule-list-item]')).some(row => " +
      "row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
      "row.textContent?.includes('Active'))",
    'schedule resumed in the UI', 45_000);
  const resumedRecord = (await client.evaluate('window.electronAPI.schedules.list()'))
    .find(s => s.id === scheduled.id);
  assert.equal(resumedRecord?.status, 'active', 'Resume action did not persist');
  await captureScreenshot(client, fixture, 'schedules-resumed');

  log('run now and inspect the actual schedule run history');
  const runNow = "Array.from(document.querySelectorAll('[data-testid=schedule-list-item]'))" +
    ".find(row => row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
    "row.querySelector('button[aria-label=\\\"Run now\\\"]'))" +
    "?.querySelector('button[aria-label=\\\"Run now\\\"]')";
  await client.click(runNow);
  await client.waitFor(
    "Array.from(document.querySelectorAll('[role=status]')).some(el => el.textContent?.includes('Run requested'))",
    'run-now feedback visible', 45_000);
  const createdRuns = await client.evaluate(
    'window.electronAPI.schedules.getRuns(' + JSON.stringify(scheduled.id) + ')');
  assert(createdRuns.length > 0, 'Run now created no persisted run');
  const expand = "Array.from(document.querySelectorAll('[data-testid=schedule-list-item]'))" +
    ".find(row => row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
    "row.querySelector('button[aria-expanded]'))?.querySelector('button[aria-expanded]')";
  await client.click(expand);
  await client.waitFor(
    "Array.from(document.querySelectorAll('[data-testid=schedule-list-item]')).some(row => " +
      "row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
      "row.querySelector('div[role=button]'))",
    'run history row visible');
  await captureScreenshot(client, fixture, 'schedules-run-history');
  await client.click("Array.from(document.querySelectorAll('[data-testid=schedule-list-item]'))" +
    ".find(row => row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
    "row.querySelector('div[role=button]'))?.querySelector('div[role=button]')");
  await client.waitFor(
    "document.querySelector('[role=dialog]')?.textContent?.includes('Run Log')",
    'run log dialog opened');
  await captureScreenshot(client, fixture, 'schedules-run-log');
  await client.click("Array.from(document.querySelectorAll('[role=dialog] button'))" +
    ".find(button => button.textContent?.trim() === 'Close')");
  await client.waitFor("!document.querySelector('[role=dialog]')",
    'run log dialog closed');

  log('destructive action demands confirmation and Cancel preserves the record');
  await client.click(more);
  await client.click(createButtonExpression('Delete'));
  await client.waitFor("document.querySelector('[role=dialog][aria-label=Delete]')",
    'schedule deletion confirmation');
  await captureScreenshot(client, fixture, 'schedules-delete-confirm');
  await client.click("document.querySelector('[role=dialog][aria-label=Delete] button:not([data-confirm-btn])')");
  assert((await client.evaluate('window.electronAPI.schedules.list()')).some(s => s.id === scheduled.id),
    'Cancel deleted a scheduled task');
  await client.waitFor("!document.querySelector('[role=dialog]')",
    'delete confirmation closed');

  await client.click(more);
  await client.click(createButtonExpression('Delete'));
  await client.click("document.querySelector('[role=dialog][aria-label=Delete] button[data-confirm-btn]')");
  await client.waitFor(
    "!Array.from(document.querySelectorAll('[data-testid=schedule-list-item]')).some(row => " +
      "row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
      "row.querySelector('button[aria-label=\\\"More actions\\\"]'))",
    'confirmed schedule disappeared from UI', 45_000);
  assert.equal(
    (await client.evaluate('window.electronAPI.schedules.list()')).some(s => s.id === scheduled.id),
    false, 'Confirmed deletion was not persisted'
  );
  await captureScreenshot(client, fixture, 'schedules-deleted');
  return { scheduleLabel, scheduleId: scheduled.id, createdAndDeleted: true };
}

/**
 * Real Electron zh-TW acceptance after the English create/launch/schedules
 * scenarios. Use a fresh startup with a persisted locale setting, then exercise
 * the actual member-row MCP selector, input, and screenshot through CDP.
 * Never invoke a model or relax the normal create-page assertions.
 */
async function exerciseTraditionalChineseMcpUi(fixture, log) {
  log('restart isolated native Electron in zh-TW for member MCP UI qualification');
  await cleanup({ ...fixture, root: null });
  const configPath = path.join(fixture.claudeRoot, 'agent-teams-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert(config.general && typeof config.general === 'object',
    'Persistent native app config missing general settings');
  config.general.appLocale = 'zh-TW';
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

  // A real task from the disposable on-disk team board is needed to inspect
  // the translated task-detail dialog/tab. No provider or teammate is started.
  const taskId = '77';
  await json(path.join(fixture.claudeRoot, 'tasks', fixture.teamName, `${taskId}.json`), {
    id: taskId,
    displayId: taskId,
    subject: 'TEST zh-TW task detail',
    status: 'pending',
    owner: 'team-lead',
    createdBy: 'user',
    createdAt: new Date().toISOString(),
    projectPath: fixture.projectPath,
    description: 'Disposable UI localization test. Do not run a model.',
    prompt: 'No execution requested.',
    blocks: [],
    blockedBy: [],
    related: [],
    comments: [],
    historyEvents: [],
  });

  const started = await startApp(fixture);
  cdp = await CdpClient.connect(started.renderer.webSocketDebuggerUrl);
  await initializeTeams(cdp, fixture, { afterRestart: true });
  await cdp.waitFor("document.documentElement.lang === 'zh-TW'",
    'persisted Traditional Chinese locale in real renderer', 45_000);

  await cdp.evaluate('window.__agentTeamsDevStore.getState().openTeamsCreationPage()');
  await cdp.waitFor("document.querySelector('[data-testid=create-team-page] #team-name')",
    'native zh-TW create-team page', 45_000);
  // The name input appears before asynchronous draft state is fully restored.
  // Match the same enabled template-selector hydration gate as the original
  // English E2E, using its actual Traditional Chinese accessible label.
  await cdp.waitFor(
    `(() => { const button = document.querySelector('[data-testid=create-team-page] button[aria-label="團隊範本"]'); return button && !button.disabled; })()`,
    'hydrated native zh-TW create-team form', 45_000
  );
  // A previous config-only draft may persist Solo team; use the real toggle to
  // make the member roster visible instead of mutating component state directly.
  const solo = "document.querySelector('[data-testid=create-team-page] #solo-team')";
  if (await cdp.evaluate(`${solo}?.getAttribute('data-state') === 'checked'`))
    await cdp.click(solo);
  const add = "document.querySelector('[data-testid=create-team-page] button[aria-label=\"新增成員\"]')";
  await cdp.click(add);
  const row = '[data-testid=create-team-page] [data-role=member-row]';
  await cdp.waitFor(`document.querySelector(${JSON.stringify(row)})`,
    'member row created through translated UI');
  const mcpToggle = `Array.from(document.querySelectorAll(${JSON.stringify(row + ' button')}))
    .find(button => button.getAttribute('aria-label')?.includes('MCP')
      && !button.disabled && button.getBoundingClientRect().width > 0)`;
  await cdp.click(mcpToggle);

  const mode = `${row} [id$="-mcp-mode"]`;
  await cdp.click(`document.querySelector(${JSON.stringify(mode)})`);
  const strict = "Array.from(document.querySelectorAll('[role=option]'))" +
    ".find(option => option.textContent?.includes('嚴格的許可名單'))";
  await cdp.click(strict);

  const servers = `${row} input[id$="-mcp-servers"]`;
  await cdp.waitFor(
    `document.querySelector(${JSON.stringify(servers)})?.placeholder === 'github, sentry'`,
    'literal MCP server IDs and ASCII separator in rendered placeholder'
  );
  const label = await cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(servers)});
    const associated = input && document.querySelector('label[for="' + input.id + '"]');
    return { label: associated?.textContent?.trim() ?? null,
      placeholder: input?.placeholder ?? null };
  })()`);
  assert.equal(label.label, '伺服器名稱', 'Traditional Chinese MCP label not rendered');
  assert.equal(label.placeholder, 'github, sentry', 'MCP IDs localized into invalid names');

  await cdp.fill(servers, 'github, sentry');
  await cdp.waitFor(
    `document.querySelector(${JSON.stringify(servers)})?.value === 'github, sentry'`,
    'controlled strict allowlist input retains two actual server IDs'
  );
  const enteredValue = await cdp.evaluate(
    `document.querySelector(${JSON.stringify(servers)}).value`
  );
  assert.deepEqual(enteredValue.split(',').map(name => name.trim()), ['github', 'sentry'],
    'Native controlled MCP input did not retain two literal server IDs');
  await captureScreenshot(cdp, fixture, 'zh-tw-member-mcp-strict-allowlist');

  log('inspect native zh-TW task detail dialog and separate task tab');
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().openGlobalTaskDetail(${JSON.stringify(fixture.teamName)}, ${JSON.stringify(taskId)})`
  );
  await cdp.waitFor(
    "document.querySelector('[role=dialog] [data-task-detail-open-tab]')?.textContent?.trim() === '在獨立分頁中開啟'",
    'localized task detail dialog and open-tab action', 60_000
  );
  await captureScreenshot(cdp, fixture, 'zh-tw-task-detail-dialog');
  await cdp.click("document.querySelector('[role=dialog] [data-task-detail-open-tab]')");
  await cdp.waitFor(
    `(() => {
      const s = window.__agentTeamsDevStore.getState();
      const activeTab = s.paneLayout.panes.some(p => p.tabs.some(t =>
        t.id === p.activeTabId && t.taskDetail && t.teamName === ${JSON.stringify(fixture.teamName)}));
      const page = document.querySelector('[data-task-detail-page][data-task-detail-task-id="77"]');
      const visible = page && page.getClientRects().length > 0 && page.getBoundingClientRect().height > 0;
      return !s.globalTaskDetail && activeTab && visible &&
        page.getAttribute('data-task-detail-team') === ${JSON.stringify(fixture.teamName)} &&
        page.getAttribute('data-origin-current') === 'true' &&
        page.querySelector('h1')?.textContent?.includes('TEST zh-TW task detail');
    })()`,
    'fully hydrated visible localized task detail in active native tab', 60_000
  );
  await captureScreenshot(cdp, fixture, 'zh-tw-task-detail-tab');
  const taskDetailUiEvidence = {
    taskId,
    locale: await cdp.evaluate('document.documentElement.lang'),
    dialogOpenTabAction: '在獨立分頁中開啟',
    dialogScreenshot: 'teams-create-zh-tw-task-detail-dialog.png',
    tabScreenshot: 'teams-create-zh-tw-task-detail-tab.png',
    nativeTaskTabVisible: true,
  };
  return {
    locale: await cdp.evaluate('document.documentElement.lang'),
    taskDetailUiEvidence,
    strictAllowlistVisible: true,
    placeholder: label.placeholder,
    parsedServerNames: enteredValue.split(',').map(name => name.trim()),
    screenshot: 'teams-create-zh-tw-member-mcp-strict-allowlist.png',
    controlEditedThroughNativeCdp: true,
  };
}


/**
 * Windows-only native E2E: launch a disposable teammate-shaped process from
 * the real Electron Main process while its BrowserWindow is visible.
 * It spawns cmd/git/PowerShell without forcing windowsHide on the tool children.
 * This verifies Main -> native process console inheritance, NOT actual provider
 * inference or TeamProvisioningMemberLifecycle product launch.
 */
async function exerciseWindowsElectronConsoleProbe(inspectorUrl, client, fixture, log) {
  assert.equal(process.platform, 'win32');
  const inspector = await CdpClient.connect(inspectorUrl);
  const nodeBinary = await realpath(process.execPath);
  const scriptPath = path.join(repoRoot, 'scripts/e2e/windows-teammate-console-native.mjs');
  const fixtureMarker = 'native-custody-' + randomUUID();
  try {
    await inspector.send('Runtime.enable');
    // The native IPC/store can hydrate before React finishes rendering Teams.
    // A skeleton-only screenshot must never qualify as a usable GUI.
    await client.waitFor(
      "Array.from(document.querySelectorAll('.team-row-zebra-card')).some(card => " +
        "card.textContent?.includes(" + JSON.stringify(fixture.teamName) + ") && " +
        "card.getBoundingClientRect().width > 0 && card.getBoundingClientRect().height > 0)",
      'actual seeded team card visibly rendered', 60_000
    );
    const rendererFocusedBefore = await client.evaluate('document.hasFocus()');
    const expression = [
      '(async () => {',
      "  const req = typeof require === 'function' ? require : process.mainModule?.require?.bind(process.mainModule);",
      "  if (!req) throw new Error('Electron main module require unavailable');",
      "  const { spawn, spawnSync } = req('node:child_process');",
      "  const { BrowserWindow } = req('electron');",
      "  const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://localhost:'));",
      "  if (!win) throw new Error('Real Electron test BrowserWindow missing');",
      '  const mainFocusedBefore = win.isFocused();',
      '  let mainBlurEvents = 0;',
      '  const onMainBlur = () => { mainBlurEvents++; };',
      "  win.on('blur', onMainBlur);",
      '  const child = spawn(' + JSON.stringify(nodeBinary) + ', [' +
        JSON.stringify(scriptPath) + ", '--teammate-fixture', " + JSON.stringify(fixtureMarker) + "], " +
        "{ detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });",
      '  return await new Promise((resolve, reject) => {',
      '    let settled = false, ready = false, stderr = ""; const tools = [];',
      '    const finish = (error, value) => {',
      '      if (settled) return; settled = true; clearTimeout(deadline);',
      "      win.off('blur', onMainBlur);",
      "      if (error && child.pid && child.exitCode === null && child.signalCode === null) {",
      '        // Terminate only the original marker-bound fixture process tree.',
      '        const result = spawnSync(' + JSON.stringify(nodeBinary) + ', [' +
        JSON.stringify(scriptPath) + ", '--kill-owned-fixture', String(child.pid), " +
        JSON.stringify(fixtureMarker) +
        "], { windowsHide: true, timeout: 30000, encoding: 'utf8' });",
      '        if (result.error || result.status !== 0) {',
      '          child.kill("SIGKILL");',
      '          error = new Error("Verified fixture cleanup failed: " + (error?.message || String(error)));',
      '        }',
      '      }',
      '      if (error) reject(error); else resolve(value);',
      '    };',
      "    const deadline = setTimeout(() => finish(new Error('Electron-owned native teammate timeout')), 25000);",
      "    child.stderr?.on('data', b => { stderr = (stderr + b.toString()).slice(-2000); });",
      "    child.on('message', msg => {",
      "      if (msg?.type === 'tool') tools.push(msg);",
      "      if (msg?.type === 'ready') {",
      "        if (msg.pid !== child.pid) return finish(new Error('Native teammate PID mismatch'));",
      "        ready = true; child.send({ type: 'stop' });",
      '      }',
      '    });',
      "    child.once('error', err => finish(err));",
      "    child.once('close', (code, signal) => {",
      "      if (!ready || code !== 0) return finish(new Error('Native teammate failed: ' + (signal || code) + ' ' + stderr));",
      "      finish(null, { mainElectronPid: process.pid, teammatePid: child.pid,",
      "        detached: false, windowsHide: true, mainFocusedBefore, mainFocusedAfter: win.isFocused(), mainBlurEvents, tools });",
      '    });',
      '  });',
      '})()',
    ].join('\n');
    // This one evaluation may spend 25s in the child, followed by 30s of
    // marker-verified cleanup. Other CDP calls retain their 30s default.
    const evidence = await inspector.evaluate(expression, 70_000);
    assert.equal(evidence.detached, false);
    assert.equal(evidence.windowsHide, true);
    assert.ok(evidence.mainElectronPid > 0 && evidence.teammatePid > 0);
    assert.deepEqual(evidence.tools.map(tool => tool.name), ['cmd', 'git', 'powershell']);
    assert.ok(evidence.tools.every(tool => tool.exitCode === 0 && tool.pid > 0));
    const powershell = evidence.tools.find(tool => tool.name === 'powershell');
    assert.equal(powershell?.consoleWindowVisible, false,
      'Real Electron-owned PowerShell unexpectedly had a visible console');
    assert.ok(['none', 'hidden'].includes(powershell.consoleState),
      'Real Electron-owned PowerShell console state was not verified');
    const rendererFocusedAfter = await client.evaluate('document.hasFocus()');
    const focusObservable = evidence.mainFocusedBefore === true && rendererFocusedBefore === true;
    if (focusObservable) {
      assert.equal(evidence.mainFocusedAfter, true, 'Electron app lost native focus during tool calls');
      assert.equal(evidence.mainBlurEvents, 0, 'Electron app temporarily lost focus during tool calls');
      assert.equal(rendererFocusedAfter, true, 'Electron renderer lost focus during tool calls');
    }
    await captureScreenshot(client, fixture, 'windows-electron-console');
    const result = {
      schemaVersion: 1, success: true, scope: 'real Electron Main -> fixture teammate -> native tool calls',
      realElectronMainHosted: true, hydratedTeamCardVerified: true,
      realProductTeammateLaunch: false,
      realVendorRuntimeOrModel: false, actualConsoleWindowsEnumerated: false,
      cmdGitWindowVisibilityUnknown: true, powershellConsoleNotVisibleVerified: true,
      powershellConsoleState: powershell.consoleState,
      nativeFocusObservable: focusObservable, rendererFocusedBefore, rendererFocusedAfter,
      ...evidence, screenshot: 'teams-create-windows-electron-console.png',
    };
    const outDir = process.env.TEAMS_CREATE_E2E_ARTIFACT_DIR || os.tmpdir();
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'teams-create-windows-console-result.json'),
      JSON.stringify(result, null, 2) + '\n');
    log('Windows Electron Main native console fixture completed');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    inspector.close();
  }
}

async function main() {
  const fixture = await seedFixture();
  const unique = `create-page-e2e-${randomUUID().slice(0, 8)}`;
  let failure = null;
  const log = (step) => process.stdout.write(`STEP: ${step}\n`);
  const renderSnapshot = async (client) => {
    return client.evaluate(`(() => {
      const page = document.querySelector('[data-testid="create-team-page"]');
      const dialog = document.querySelector('[role="dialog"]');
      return {
        inCreatePage: Boolean(page),
        pageName: page?.querySelector('#team-name')?.value ?? null,
        dialogOpen: Boolean(dialog),
        bodyText: document.body?.innerText?.slice(0, 800) ?? '',
      };
    })()`);
  };
  try {
    log('start isolated Electron profile');
    let started = await startApp(fixture);
    cdp = await CdpClient.connect(started.renderer.webSocketDebuggerUrl);
    await initializeTeams(cdp, fixture);
    if (process.argv.includes('--windows-console-only')) {
      await exerciseWindowsElectronConsoleProbe(started.inspectorWebSocketDebuggerUrl, cdp, fixture, log);
      return;
    }

    log('click real Create Team button');
    await cdp.click(createButtonExpression('Create Team'));
    await cdp.waitFor("document.querySelector('[data-testid=create-team-page] input#team-name')",
      'creation page and team name');
    let shot = await renderSnapshot(cdp);
    assert.equal(shot.inCreatePage, true);
    // A settings dialog is allowed later, but Create itself must not trap focus.
    assert.equal(shot.dialogOpen, false, 'Create opened a dialog instead of a page');
    await captureScreenshot(cdp, fixture, 'opened');
    // The input can render before the asynchronous persisted form and prompt drafts hydrate.
    // Wait for the real UI's hydration gate before testing per-name defaults.
    await cdp.waitFor(
      `(() => { const button = document.querySelector('[data-testid=create-team-page] button[aria-label="Team template"]'); return button && !button.disabled; })()`,
      'create-team form and prompt draft hydration'
    );

    log('restore unedited Advanced CLI defaults for a saved team name');
    const customArgsSelector = '[data-testid=create-team-page] input[placeholder="--max-turns 5"]';
    const preferencesTeamName = `${unique}-saved-defaults`;
    await cdp.evaluate(`localStorage.setItem(${JSON.stringify(`team:lastCustomArgs:${preferencesTeamName}`)}, '--max-turns 2')`);
    assert.equal(
      await cdp.evaluate(`localStorage.getItem(${JSON.stringify(`team:lastCustomArgs:${preferencesTeamName}`)})`),
      '--max-turns 2', 'E2E setup did not persist the saved CLI preference'
    );
    await cdp.fill('#team-name', preferencesTeamName);
    const optionalSettingsButton = `Array.from(document.querySelectorAll('[data-testid=create-team-page] button'))
      .find(button => button.textContent?.includes('Optional launch settings')
        && button.getBoundingClientRect().width > 0)`;
    await cdp.click(optionalSettingsButton);
    const createAdvancedToggle = `Array.from(document.querySelectorAll('[data-testid=create-team-page] button'))
      .find(button => button.textContent?.trim() === 'Advanced' && !button.disabled
        && button.getBoundingClientRect().width > 0)`;
    await expandCreateAdvancedCli(cdp, createAdvancedToggle, customArgsSelector);
    try {
      await cdp.waitFor(
        `document.querySelector(${JSON.stringify(customArgsSelector)})?.value === '--max-turns 2'`,
        'untouched per-name Advanced CLI defaults restored'
      );
    } catch (error) {
      const observed = await cdp.evaluate(`(() => ({
        name: document.querySelector('#team-name')?.value,
        stored: localStorage.getItem(${JSON.stringify(`team:lastCustomArgs:${preferencesTeamName}`)}),
        actual: document.querySelector(${JSON.stringify(customArgsSelector)})?.value ?? null,
      }))()`);
      throw new Error(`Advanced CLI preference mismatch: ${JSON.stringify(observed)}`, { cause: error });
    }

    log('edit Advanced CLI while the team name is explicitly empty');
    await cdp.fill('#team-name', '');
    await cdp.waitFor("document.querySelector('#team-name')?.value === ''", 'unnamed editor ready');
    await cdp.fill(customArgsSelector, '--max-turns 5');
    log('naming and renaming a team preserves in-progress Advanced CLI overrides');
    await cdp.fill('#team-name', unique);
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(customArgsSelector)})?.value === '--max-turns 5'`,
      'unnamed Advanced CLI edits retained after naming the team'
    );
    await captureScreenshot(cdp, fixture, 'edited');
    await cdp.fill('#team-name', unique + '-renamed');
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(customArgsSelector)})?.value === '--max-turns 5'`,
      'Advanced CLI input retained after team-name change'
    );
    await cdp.fill('#team-name', unique);

    await cdp.evaluate("(() => { window.__createPageBeforeBack = document.querySelector('[data-testid=create-team-page]'); return true; })()");
    log('Back to Teams and resume saved draft');
    await cdp.click("document.querySelector('[data-testid=create-team-page] button[aria-label=\"Back to teams\"]')");
    await cdp.waitFor("!document.querySelector('[data-testid=create-team-page]')",
      'creation page closed on Back');
    await cdp.waitFor('!window.__createPageBeforeBack?.isConnected', 'original editor unmounted after Back');
    await cdp.waitFor(createButtonExpression('Continue creating'), 'Continue creating button');
    await cdp.click(createButtonExpression('Continue creating'));
    await cdp.waitFor(`document.querySelector('#team-name')?.value === ${JSON.stringify(unique)}`,
      'same team name restored after Back');
    await cdp.waitFor(
      "document.querySelector('[data-testid=create-team-page]') !== window.__createPageBeforeBack",
      'new editor node created on resume'
    );
    await cdp.evaluate('delete window.__createPageBeforeBack');
    // Resume hydrates the form and text drafts independently of restoring its name.
    // Do not open the optional controls while they may still remount.
    await cdp.waitFor(
      `(() => { const button = document.querySelector('[data-testid=create-team-page] button[aria-label="Team template"]'); return button && !button.disabled; })()`,
      'resumed creation form and text drafts hydrated'
    );
    const optionalExpandedAfterResume = await cdp.evaluate(
      `${optionalSettingsButton}?.getAttribute('aria-expanded') === 'true'`
    );
    if (!optionalExpandedAfterResume) await cdp.click(optionalSettingsButton);
    await expandCreateAdvancedCli(cdp, createAdvancedToggle, customArgsSelector);
    try {
      await cdp.waitFor(
        `document.querySelector(${JSON.stringify(customArgsSelector)})?.value === '--max-turns 5'`,
        'Advanced CLI edit retained after real editor unmount and resume'
      );
    } catch (error) {
      const observed = await cdp.evaluate(`(() => ({
        name: document.querySelector('#team-name')?.value,
        actual: document.querySelector(${JSON.stringify(customArgsSelector)})?.value ?? null,
        advancedButtonCount: [...document.querySelectorAll('[data-testid=create-team-page] button')].filter(b => b.textContent?.trim() === 'Advanced').length,
        optionalOpen: document.querySelector('[data-testid=create-team-page] button[aria-expanded="true"]')?.textContent?.trim().slice(0, 50) ?? null,
      }))()`);
      throw new Error(`Advanced CLI resume mismatch: ${JSON.stringify(observed)}`, { cause: error });
    }
    await captureScreenshot(cdp, fixture, 'resumed');

    log('open Providers Settings through the real model picker and resume the draft');
    const teamsTabId = await cdp.evaluate(`(() => {
      const store = window.__agentTeamsDevStore.getState();
      const pane = store.paneLayout.panes.find(p => p.id === store.paneLayout.focusedPaneId);
      return pane.activeTabId;
    })()`);
    const leadModelTrigger = `document.querySelector('[data-role=lead-row] button[aria-label*=" provider, "]')`;
    await cdp.click(leadModelTrigger);
    await cdp.waitFor(
      "document.querySelector('[data-testid=team-model-selector-manage-providers]')",
      'Manage providers action in Create Team model picker'
    );
    const refreshControl = await cdp.evaluate(`(() => {
      const refresh = document.querySelector('[data-testid=team-model-selector-refresh-providers]');
      const manage = document.querySelector('[data-testid=team-model-selector-manage-providers]');
      const refreshBox = refresh?.getBoundingClientRect();
      const manageBox = manage?.getBoundingClientRect();
      return {
        label: refresh?.getAttribute('aria-label') ?? null,
        visible: Boolean(refreshBox && refreshBox.width > 0 && refreshBox.height > 0),
        besideManage: Boolean(refreshBox && manageBox && refreshBox.left >= manageBox.right - 1),
      };
    })()`);
    assert(refreshControl.label, 'Provider refresh icon must be accessible');
    assert.equal(refreshControl.visible, true, 'Provider refresh icon must be visible');
    assert.equal(refreshControl.besideManage, true,
      'Provider refresh icon must appear beside Manage Providers');

    log('click provider refresh and verify native-store checks in the isolated Electron session');
    // Observe real store actions without replacing their implementation or
    // bypassing native IPC. The fixture runtime denies external provider commands.
    await cdp.evaluate(`(() => {
      const store = window.__agentTeamsDevStore;
      const names = [
        'invalidateCliStatus',
        'invalidateOpenCodeRuntimeStatus',
        'invalidateCodexRuntimeStatus',
        'fetchCliProviderStatus',
      ];
      const original = Object.fromEntries(names.map(name => [name, store.getState()[name]]));
      const probe = { calls: [], original };
      window.__teamProviderRefreshProbe = probe;
      store.setState(Object.fromEntries(names.map(name => [
        name,
        (...args) => {
          probe.calls.push({ name, args });
          return original[name](...args);
        },
      ])));
    })()`);
    await cdp.click("document.querySelector('[data-testid=team-model-selector-refresh-providers]')");
    await cdp.waitFor(`(() => {
      const calls = window.__teamProviderRefreshProbe?.calls ?? [];
      return calls.some(call => call.name === 'invalidateCliStatus') &&
        calls.some(call => call.name === 'invalidateOpenCodeRuntimeStatus') &&
        calls.some(call => call.name === 'invalidateCodexRuntimeStatus');
    })()`, 'manual provider refresh initiated all runtime invalidations');
    await cdp.waitFor(`(() => {
      const button = document.querySelector('[data-testid=team-model-selector-refresh-providers]');
      const calls = window.__teamProviderRefreshProbe?.calls ?? [];
      const checked = calls.filter(call =>
        call.name === 'fetchCliProviderStatus' &&
        call.args[1]?.checkReason === 'manual_refresh'
      ).map(call => call.args[0]);
      return button && !button.disabled &&
        ['anthropic', 'codex', 'opencode'].every(id => checked.includes(id));
    })()`, 'manual refresh completed with every enabled provider checked', 120_000);
    const providerRefreshCalls = await cdp.evaluate(
      'window.__teamProviderRefreshProbe.calls'
    );
    assert.equal(
      providerRefreshCalls.filter(call => call.name === 'invalidateCliStatus').length, 1,
      'One click must invalidate CLI status exactly once'
    );
    await cdp.evaluate(`(() => {
      const store = window.__agentTeamsDevStore;
      store.setState(window.__teamProviderRefreshProbe.original);
      delete window.__teamProviderRefreshProbe;
    })()`);
    assert.equal(
      await cdp.evaluate("document.querySelector('#team-name')?.value"),
      unique,
      'Manual provider refresh must preserve the unsaved Create Team draft'
    );
    await captureScreenshot(cdp, fixture, 'provider-refreshed');

    await cdp.click("document.querySelector('[data-testid=team-model-selector-manage-providers]')");
    await cdp.waitFor(`(() => {
      const store = window.__agentTeamsDevStore.getState();
      const pane = store.paneLayout.panes.find(p => p.id === store.paneLayout.focusedPaneId);
      return pane.tabs.find(t => t.id === pane.activeTabId)?.type === 'settings';
    })()`, 'Manage providers navigated to Settings');
    // Inactive Teams creation pages are retained mounted to avoid lost editor state.
    // Assert that the inactive page is hidden, not removed from the DOM.
    await cdp.waitFor(
      "(() => { const page = document.querySelector('[data-testid=create-team-page]'); return !page || page.getClientRects().length === 0; })()",
      'creation page hidden while Settings is active'
    );
    await cdp.evaluate(
      `window.__agentTeamsDevStore.getState().setActiveTab(${JSON.stringify(teamsTabId)})`);
    await cdp.waitFor(`document.querySelector('#team-name')?.value === ${JSON.stringify(unique)}`,
      'draft survives the Manage providers Settings trip');
    await cdp.click(leadModelTrigger);
    await cdp.waitFor("!document.querySelector('[data-testid=team-model-selector-manage-providers]')",
      'model picker collapsed on return');
    log('render creation page in both themes and at 200% CSS zoom');
    for (const theme of ['light', 'dark']) {
      await cdp.evaluate(
        "window.__agentTeamsDevStore.setState(s => ({ appConfig: { ...s.appConfig, general: { ...s.appConfig?.general, theme: " +
          JSON.stringify(theme) + " } } }))"
      );
      await cdp.waitFor(
        "document.documentElement.classList.contains(" + JSON.stringify(theme) + ")",
        theme + ' theme applied'
      );
      await captureScreenshot(cdp, fixture, 'theme-' + theme);
    }
    // Layout-only proxy for 200% zoom. Native Electron zoom is a separate host capability.
    await cdp.evaluate("document.documentElement.style.zoom = '2'");
    await cdp.waitFor(
      "document.querySelector('[data-testid=create-team-page] button[aria-label=\"Back to teams\"]')?.getBoundingClientRect().width > 0",
      'page Back action remains visible at CSS zoom 200%'
    );
    await captureScreenshot(cdp, fixture, 'css-zoom-200');
    await cdp.evaluate("document.documentElement.style.zoom = ''");

    log('verify actual BrowserWindow.zoomFactor=2 in isolated Electron main process');
    const zoomBaseline = await cdp.evaluate(
      "window.electronAPI.getZoomFactor().then(factor => ({ factor, innerWidth: window.innerWidth }))"
    );
    assert(zoomBaseline.factor >= 0.95 && zoomBaseline.factor <= 1.05,
      'Electron test must start at 100% native zoom');
    // This local inspector is enabled only in the disposable E2E launch. It
    // changes a *real* BrowserWindow property, not CSS zoom or CDP pinch scale.
    const inspector = await CdpClient.connect(started.inspectorWebSocketDebuggerUrl);
    const setActualZoom = (factor) => setBrowserWindowZoom(inspector, factor);
    try {
      await inspector.send('Runtime.enable');
      const actualFactor = await setActualZoom(2);
      assert(Math.abs(actualFactor - 2) <= 0.05,
        'BrowserWindow did not accept native 200% zoom');
      await cdp.waitFor(
        "window.innerWidth < " + JSON.stringify(zoomBaseline.innerWidth * 0.70),
        'actual Electron zoom narrowed layout viewport'
      );
      const visibleAtZoom = await cdp.evaluate(`(() => {
        const back = document.querySelector('[data-testid=create-team-page] button[aria-label="Back to teams"]');
        if (!back) return false;
        const rect = back.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          rect.right > 0 && rect.left < window.innerWidth &&
          rect.bottom > 0 && rect.top < window.innerHeight &&
          getComputedStyle(back).visibility === 'visible';
      })()`);
      assert(visibleAtZoom, 'Back button disappeared at native Electron 200% zoom');
      const headerLayout = await cdp.evaluate(`(() => {
        const header = document.querySelector('[data-testid="create-team-page"] > header');
        const title = header?.querySelector('h1')?.getBoundingClientRect();
        const parent = header?.getBoundingClientRect();
        const actions = Array.from(header?.querySelectorAll('button') ?? [])
          .filter((button) => button.getAttribute('aria-label') !== 'Back to teams')
          .map((button) => button.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0);
        const intersects = (a, b) =>
          a.left < b.right - 1 && a.right > b.left + 1 &&
          a.top < b.bottom - 1 && a.bottom > b.top + 1;
        return {
          titleVisible: Boolean(title && title.width > 0 && title.height > 0),
          actionsVisible: actions.length,
          overlap: Boolean(title && actions.some((rect) => intersects(title, rect))),
          overflow: Boolean(parent && actions.some((rect) =>
            rect.left < parent.left - 1 || rect.right > parent.right + 1)),
        };
      })()`);
      assert(
        headerLayout.titleVisible && headerLayout.actionsVisible >= 2 &&
          !headerLayout.overlap && !headerLayout.overflow,
        'Create Team header title/actions overlap or overflow at native 200% zoom: ' +
          JSON.stringify(headerLayout)
      );
      await captureScreenshot(cdp, fixture, 'native-electron-zoom-200');
      assert(Math.abs((await setActualZoom(1)) - 1) <= 0.05,
        'BrowserWindow did not restore 100% zoom');
      await cdp.waitFor(
        "window.innerWidth >= " + JSON.stringify(zoomBaseline.innerWidth * 0.95),
        'actual Electron layout restored after native zoom reset'
      );
    } finally {
      inspector.close();
    }
    assert.equal(
      await cdp.evaluate("document.querySelector('#team-name')?.value"),
      unique, 'Native zoom and reset changed unsaved draft'
    );

    log('split into two panes and prevent duplicate creation editors');
    const paneCount = await cdp.evaluate("(() => { " +
      "const s = window.__agentTeamsDevStore.getState(); " +
      "const settings = s.getAllPaneTabs().find(t => t.type === 'settings'); " +
      "const owner = s.paneLayout.panes.find(p => p.tabs.some(t => t.teamsCreationPage)); " +
      "if (!settings || !owner) throw new Error('Missing staged Settings/Teams tabs'); " +
      "s.splitPane(owner.id, settings.id, 'right'); " +
      "window.__agentTeamsDevStore.getState().openTeamsCreationPage(); " +
      "return window.__agentTeamsDevStore.getState().paneLayout.panes.length; " +
    "})()");
    assert.equal(paneCount, 2, 'Split-pane creation view did not create two panes');
    await cdp.waitFor(
      "document.querySelector('[data-testid=create-team-page]')?.getBoundingClientRect().width > 0",
      'single creation editor visible in split pane'
    );
    const editorCount = await cdp.evaluate(
      "window.__agentTeamsDevStore.getState().getAllPaneTabs().filter(t => t.teamsCreationPage).length"
    );
    assert.equal(editorCount, 1, 'A second writable creation editor was opened');
    // A pane split can remount CreateTeamDialog: verify session-only CLI edits survive.
    const inputStillMounted = await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(customArgsSelector)}))`);
    if (!inputStillMounted) {
      const optionalButton = `Array.from(document.querySelectorAll('[data-testid=create-team-page] button'))
        .find(button => button.textContent?.includes('Optional launch settings')
          && button.getBoundingClientRect().width > 0)`;
      const expanded = await cdp.evaluate(`${optionalButton}?.getAttribute('aria-expanded') === 'true'`);
      if (!expanded) await cdp.click(optionalButton);
      await expandCreateAdvancedCli(cdp, createAdvancedToggle, customArgsSelector);
    }
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(customArgsSelector)})?.value === '--max-turns 5'`,
      'Advanced CLI edits survived pane split / editor remount'
    );
    // Clear the test-only override before the actual process restart and native save.
    await cdp.fill(customArgsSelector, ' ');
    await captureScreenshot(cdp, fixture, 'split-pane');
    await cdp.evaluate("(() => { " +
      "const s = window.__agentTeamsDevStore.getState(); " +
      "const settings = s.paneLayout.panes.find(p => p.tabs.some(t => t.type === 'settings')); " +
      "if (settings) s.closePane(settings.id); " +
      "window.__agentTeamsDevStore.getState().openTeamsCreationPage(); " +
    "})()");

    log('restart real Electron process retaining the same isolated data root');
    await cleanup({ ...fixture, root: null });
    // Graceful rebuild of the renderer with the same IndexedDB profile.
    started = await startApp(fixture);
    cdp = await CdpClient.connect(started.renderer.webSocketDebuggerUrl);
    await initializeTeams(cdp, fixture, { afterRestart: true });
    const restored = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid=create-team-page] #team-name');
      return el ? { inPage: true, value: el.value } : { inPage: false, value: null };
    })()`);
    if (!restored.inPage) {
      await cdp.click(createButtonExpression('Continue creating'));
    }
    await cdp.waitFor(`document.querySelector('#team-name')?.value === ${JSON.stringify(unique)}`,
      'draft survived real Electron restart');
    await captureScreenshot(cdp, fixture, 'restarted');

    log('Launch existing sandbox team must still open a modal');
    await cdp.click("document.querySelector('[data-testid=create-team-page] button[aria-label=\"Back to teams\"]')");
    await cdp.waitFor("!document.querySelector('[data-testid=create-team-page]')",
      'list restored');
    await cdp.waitFor("document.querySelector('button[aria-label=\"Launch team\"]')",
      'existing team Launch action', 30_000);
    await cdp.click("document.querySelector('button[aria-label=\"Launch team\"]')");
    await cdp.waitFor("document.querySelector('[role=dialog]')",
      'unchanged launch modal');
    // The lazy Suspense fallback also has role=dialog. Wait for the REAL
    // LaunchTeamDialog's project controls before signing off the launch path.
    await cdp.waitFor(
      "(() => { const d = document.querySelector('[role=dialog]'); return d && d.querySelectorAll('button').length >= 5 && d.innerText.includes('Project'); })()",
      'loaded launch dialog with existing project controls',
      45_000
    );
    assert.equal((await renderSnapshot(cdp)).inCreatePage, false);
    await captureScreenshot(cdp, fixture, 'launch-still-modal');

    // The real dialog is already verified above. Runtime/model controls are
    // intentionally collapsed under Optional launch settings in this fixture;
    // do not require hidden optional controls to exist before expansion.
    await captureScreenshot(cdp, fixture, 'launch-controls-loaded');

    log('close launch dialog without starting the deny-all runtime');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    await cdp.waitFor("!document.querySelector('[role=dialog]')", 'launch modal closed');

    log('create an actual config-only team from the restored screen');
    await cdp.click(createButtonExpression('Continue creating'));
    await cdp.waitFor(`document.querySelector('#team-name')?.value === ${JSON.stringify(unique)}`,
      'restored creation draft for config-only save');
    // Verify the documented debug override survives actual renderer -> IPC ->
    // persisted metadata. The fixture never launches tmux or a paid provider.
    await cdp.waitFor(
      `(() => { const button = document.querySelector('[data-testid=create-team-page] button[aria-label="Team template"]'); return button && !button.disabled; })()`,
      'hydrated form before native teammate-mode override'
    );
    const overrideSettingsExpanded = await cdp.evaluate(
      `${optionalSettingsButton}?.getAttribute('aria-expanded') === 'true'`
    );
    if (!overrideSettingsExpanded) await cdp.click(optionalSettingsButton);
    await expandCreateAdvancedCli(cdp, createAdvancedToggle, customArgsSelector);
    const allowedTeammateArgs = '--max-turns 5 --teammate-mode tmux';
    await cdp.fill(customArgsSelector, allowedTeammateArgs);
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(customArgsSelector)})?.value === ${JSON.stringify(allowedTeammateArgs)}`,
      'documented teammate override in real Advanced CLI editor'
    );
    await captureScreenshot(cdp, fixture, 'teammate-mode-override');
    // Press the real optional Validate control; the isolated runtime supplies
    // --help only, never a paid provider or a lifecycle command.
    const validateButton = `Array.from(document.querySelectorAll('[data-testid=create-team-page] button'))
      .find(button => button.textContent?.trim() === 'Validate' &&
        button.getClientRects().length > 0)`;
    await cdp.click(validateButton);
    await cdp.waitFor(
      "Array.from(document.querySelectorAll('[data-testid=create-team-page] .text-emerald-400'))" +
        ".some(el => el.textContent?.includes('All flags valid') && el.getClientRects().length > 0)",
      'supported teammate override accepted by real Validate IPC'
    );
    await captureScreenshot(cdp, fixture, 'teammate-mode-validated');
    await cdp.fill(customArgsSelector, '--max-turns=');
    await cdp.click(validateButton);
    await cdp.waitFor(
      "Array.from(document.querySelectorAll('[data-testid=create-team-page] span'))" +
        ".some(span => span.textContent?.trim() === 'Missing value: --max-turns' && span.getClientRects().length > 0)",
      'required-value error returned through real Validate IPC'
    );
    await captureScreenshot(cdp, fixture, 'missing-cli-value-validated');
    await cdp.fill(customArgsSelector, allowedTeammateArgs);
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(customArgsSelector)})?.value === ${JSON.stringify(allowedTeammateArgs)}`,
      'restore admitted extra args after real Validate error'
    );
    // The fixture has no project-list entries. Choose the disposable path
    // through the real UI rather than relying on the app's config-only fallback.
    await cdp.click(createButtonExpression('Custom path'));
    await cdp.fill(
      '[data-testid=create-team-page] input[aria-label="Custom working directory"]',
      fixture.projectPath
    );
    const launchChecked = await cdp.evaluate(
      "document.querySelector('#launch-team')?.getAttribute('data-state') === 'checked'"
    );
    if (launchChecked)
      await cdp.click("document.querySelector('[data-testid=create-team-page] #launch-team')");
    log('native config-only save rejection retains the editor and its working directory');
    const rejectedName = `blocked-create-e2e-${randomUUID().slice(0, 8)}`;
    const rejectedTasksDir = path.join(fixture.claudeRoot, 'tasks', rejectedName);
    // A dangling tasks directory forces a real native createConfig rejection.
    // This is disposable fixture state, not a mocked renderer promise.
    await mkdir(rejectedTasksDir, { recursive: true });
    await cdp.fill('#team-name', rejectedName);
    await cdp.waitFor(createButtonExpression('Create'), 'rejection scenario Create enabled');
    await cdp.click(createButtonExpression('Create'));
    await cdp.waitFor(
      "document.querySelector('[data-testid=create-team-page]')?.textContent.includes('Team already exists')",
      'native creation error visible without closing editor', 45_000
    );
    assert.equal(
      await cdp.evaluate("document.querySelector('[data-testid=create-team-page] #team-name')?.value"),
      rejectedName, 'Failed native creation discarded user-entered team name'
    );
    await captureScreenshot(cdp, fixture, 'save-rejected');
    await rm(rejectedTasksDir, { recursive: true, force: true });
    await cdp.fill('#team-name', unique);
    await cdp.waitFor(createButtonExpression('Create'), 'retry after rejection enabled', 45_000);
    await cdp.click(createButtonExpression('Create'));
    await cdp.waitFor("!document.querySelector('[data-testid=create-team-page]')",
      'config-only team created through real IPC', 45_000);
    const created = await cdp.evaluate(
      `window.electronAPI.teams.list().then(rows => rows.some(t => t.teamName === ${JSON.stringify(unique)}))`
    );
    assert.equal(created, true, 'Created config-only team was not persisted by native API');
    // Config-only teams deliberately have team.meta.json and members.meta.json.
    // config.json is CLI-created later during an actual runtime launch.
    const teamDir = path.join(fixture.claudeRoot, 'teams', unique);
    const createdMeta = JSON.parse(await readFile(path.join(teamDir, 'team.meta.json'), 'utf8'));
    const createdMembers = JSON.parse(await readFile(path.join(teamDir, 'members.meta.json'), 'utf8'));
    assert.equal(createdMeta.version, 1, 'Native team metadata has the wrong schema');
    assert.equal(createdMeta.cwd, fixture.projectPath, 'Saved working directory differs');
    assert.equal(createdMeta.extraCliArgs, allowedTeammateArgs,
      'Native create IPC rejected or dropped the documented teammate-mode override');
    // A config-only team may use the implicit lead without additional members.
    // Prove the typed roster metadata exists, not that it contains extra agents.
    assert.equal(createdMembers.version, 1, 'Native roster metadata has the wrong schema');
    assert(Array.isArray(createdMembers.members),
      'Native config-only creation did not persist roster metadata');
    await captureScreenshot(cdp, fixture, 'config-only-created');

    log('copy an existing sandbox team using the real Teams card');
    await cdp.evaluate(
      `window.__agentTeamsDevStore.getState().openTeamsTab(${JSON.stringify(fixture.projectPath)})`
    );
    const copyTarget =
      "Array.from(document.querySelectorAll('.team-row-zebra-card'))" +
      ".find(card => card.textContent?.includes(" + JSON.stringify(fixture.teamName) + "))" +
      "?.querySelector('button[aria-label=\"Copy team\"]')";
    await cdp.click(copyTarget);
    await cdp.waitFor(
      `document.querySelector('[data-testid=create-team-page] #team-name')?.value?.startsWith(${JSON.stringify(fixture.teamName)})`,
      'copy action initialized the new team identity from the selected card',
      30_000
    );
    const copiedName = await cdp.evaluate(
      "document.querySelector('[data-testid=create-team-page] #team-name')?.value"
    );
    assert.notEqual(copiedName, fixture.teamName, 'Copy reused the original identity');
    assert(copiedName.startsWith('teams-create-page-e2e-'),
      'Copy did not use the existing team name as its source');
    const editedCopyName = `copy-edited-e2e-${randomUUID().slice(0, 8)}`;
    await cdp.fill('#team-name', editedCopyName);
    await cdp.click(
      "document.querySelector('[data-testid=create-team-page] button[aria-label=\"Back to teams\"]')"
    );
    await cdp.waitFor(createButtonExpression('Continue creating'), 'resume copied draft');
    await cdp.click(createButtonExpression('Continue creating'));
    await cdp.waitFor(
      `document.querySelector('#team-name')?.value === ${JSON.stringify(editedCopyName)}`,
      'copy seed did not replay over an edited draft'
    );
    await captureScreenshot(cdp, fixture, 'copy-resumed-edits');
    log('template replacement must be cancelable without losing copied draft');
    await cdp.click(
      "Array.from(document.querySelectorAll('[data-testid=create-team-page] button'))" +
      ".find(b => b.textContent?.includes('Optional team details'))"
    );
    await cdp.waitFor("document.querySelector('#team-description')", 'expanded team details');
    const copiedDescription = await cdp.evaluate(
      "document.querySelector('#team-description')?.value"
    );
    assert.equal(
      copiedDescription,
      'Disposable Teams creation E2E fixture',
      'Copied team description did not hydrate from its persisted config'
    );
    const templateConfirmationExpression =
      "Array.from(document.querySelectorAll('[role=alertdialog]'))" +
      ".find(dialog => dialog.querySelector('h2')?.textContent === 'Apply team template?')";
    const selectTemplate = async () => {
      const trigger = "document.querySelector('[data-testid=create-team-page] button[aria-label=\"Team template\"]')";
      const option = "Array.from(document.querySelectorAll('[role=option]'))" +
        ".find(item => item.textContent?.includes('Software Product Team'))";
      // A ready Radix trigger can miss one native click while the creation form
      // commits its restored draft. Re-check the real hit target before retrying.
      const triggerReady = "(() => { const button = " + trigger +
        "; if (!button?.isConnected || button.disabled) return false;" +
        " button.scrollIntoView({block:'center',inline:'nearest'});" +
        " const rect=button.getBoundingClientRect();" +
        " const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);" +
        " return rect.width>0 && rect.height>0 && (hit===button || button.contains(hit)); })()";
      let optionReady = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await cdp.waitFor(triggerReady, 'visible unobstructed team template trigger', 15_000);
        await cdp.click(trigger);
        try {
          await cdp.waitFor(option, 'Software Product Team option', 4_000);
          optionReady = true;
          break;
        } catch (error) {
          const open = await cdp.evaluate(
            trigger + "?.getAttribute('aria-expanded') === 'true'"
          );
          // An open menu without the expected item is a genuine catalog/locale
          // mismatch, not a missed click. Do not toggle it closed to hide it.
          if (open || attempt === 2) throw error;
        }
      }
      assert(optionReady, 'Team template options did not open');
      await cdp.click(option);
      await cdp.waitFor(templateConfirmationExpression, 'template replacement confirmation');
    };
    await selectTemplate();
    // Wait for the dialog's focus and Tab-trap effects before testing keyboard containment.
    await cdp.waitFor(
      `(${templateConfirmationExpression})?.contains(document.activeElement)`,
      'template confirmation initial keyboard focus'
    );
    // A destructive confirmation must not expose background form fields to Tab.
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
    });
    assert(
      await cdp.evaluate(
        `(${templateConfirmationExpression})?.contains(document.activeElement)`
      ),
      'Template confirmation focus escaped into the background form'
    );
    await cdp.click(
      `Array.from((${templateConfirmationExpression})?.querySelectorAll('button') ?? [])` +
      ".find(button => button.textContent?.trim() === 'Cancel')"
    );
    assert.equal(await cdp.evaluate("document.querySelector('#team-description')?.value"),
      copiedDescription, 'Canceling template replacement discarded the copied description');
    await selectTemplate();
    await cdp.click(
      `Array.from((${templateConfirmationExpression})?.querySelectorAll('button') ?? [])` +
      ".find(button => button.textContent?.trim() === 'Apply template')"
    );
    await cdp.waitFor(
      "document.querySelector('#team-description')?.value === " +
      JSON.stringify('Design, build and validate apps, websites and digital products.'),
      'template applied after explicit confirmation'
    );
    await captureScreenshot(cdp, fixture, 'template-confirmed');

    log('create from actual Organization Map and verify native placement');
    const backToTeams =
      "document.querySelector('[data-testid=create-team-page] button[aria-label=\"Back to teams\"]')";
    const backHitTest = "(() => { const button=" + backToTeams +
      "; if (!button?.isConnected || button.disabled) return false;" +
      " button.scrollIntoView({block:'center',inline:'nearest'});" +
      " const r=button.getBoundingClientRect();" +
      " const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);" +
      " return r.width>0 && r.height>0 && (hit===button || button.contains(hit)); })()";
    // Radix confirmation can still be retiring when the create-page header
    // becomes visible. A missed native click should not silently strand the
    // draft, but never issue a second click once the page actually navigated.
    let navigatedBack = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await cdp.waitFor(backHitTest, 'unobstructed Back to teams', 15_000);
      await cdp.click(backToTeams);
      try {
        await cdp.waitFor(
          "!document.querySelector('[data-testid=create-team-page]')",
          'Back to teams navigation', 4_000
        );
        navigatedBack = true;
        break;
      } catch (error) {
        const stillOnForm = await cdp.evaluate(
          "Boolean(document.querySelector('[data-testid=create-team-page]'))"
        );
        if (!stillOnForm || attempt === 2) throw error;
      }
    }
    assert(navigatedBack, 'Back to teams did not navigate after bounded native clicks');
    await cdp.waitFor(createButtonExpression('Continue creating'), 'template draft retained');
    const organizationName = 'e2e-org-' + randomUUID().slice(0, 8);
    const organization = await cdp.evaluate(
      "window.electronAPI.organizations.createOrganization({ name: " +
      JSON.stringify(organizationName) + " }).then(s => s.organizations.find(o => o.name === " +
      JSON.stringify(organizationName) + "))"
    );
    assert(organization?.id && organization?.rootNodeId,
      'Native organization fixture has no root');
    // Opening a new lazy Organizations route can trigger a dev-only Vite reload.
    // Retry only the navigation/selection sequence, never the team creation itself.
    const confirmOrgReplace = "document.querySelector('[role=dialog] button[data-confirm-btn]')";
    const orgSelector =
      "Array.from(document.querySelectorAll('button[role=combobox]'))" +
      ".find(button => button.classList.contains('w-44') && !button.disabled && button.getBoundingClientRect().width > 0)";
    const organizationOption =
      "Array.from(document.querySelectorAll('[role=option]'))" +
      ".find(option => option.textContent?.trim() === " + JSON.stringify(organizationName) + ")";
    let organizationEntryReady = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await cdp.waitFor(
          "window.__agentTeamsDevStore?.getState",
          'renderer after potential Vite reload', 45_000
        );
        await cdp.evaluate("(() => {" +
          "const s = window.__agentTeamsDevStore.getState();" +
          "const tab = s.getAllPaneTabs().find(t => t.type === 'organizations');" +
          "if (tab) s.setActiveTab(tab.id);" +
          "else s.openTab({ type: 'organizations', label: 'Organizations' });" +
        "})()");
        await cdp.waitFor(
          `(${createButtonExpression('Edit')}) || (${createButtonExpression('Editing')})`,
          'Organization Map editor action', 20_000
        );
        if (!(await cdp.evaluate(`Boolean(${createButtonExpression('Editing')})`))) {
          await cdp.click(createButtonExpression('Edit'));
        }
        // Wait for the organization structure to finish loading before clicking.
        await cdp.waitFor(orgSelector, 'enabled Organization selector', 25_000);
        await cdp.click(orgSelector);
        await cdp.click(organizationOption);
        await cdp.waitFor(
          "Array.from(document.querySelectorAll('button[role=combobox]'))" +
          ".some(button => button.classList.contains('w-44') && button.textContent?.includes(" +
          JSON.stringify(organizationName) + "))",
          'new organization selected'
        );
        await cdp.click(createButtonExpression('Team here'));
        await cdp.waitFor(
          confirmOrgReplace,
          'replace-existing-draft confirmation from Organization Map', 20_000
        );
        organizationEntryReady = true;
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        log('Organization Map reloaded or selector changed; retry staged navigation');
      }
    }
    assert(organizationEntryReady, 'Organization Map entry could not open the creation page');
    await cdp.click("document.querySelector('[role=dialog] button[data-confirm-btn]')");
    await cdp.waitFor(
      "document.querySelector('[data-testid=create-team-page] input#team-name')",
      'creation page opened from Organization Map'
    );
    const creationSeed = await cdp.evaluate(
      "window.__agentTeamsDevStore.getState().getAllPaneTabs()" +
      ".find(t => t.type === 'teams' && t.teamsCreationPage)?.teamsCreationSeed"
    );
    assert.equal(creationSeed?.placement?.organizationId, organization.id);
    assert.equal(creationSeed?.placement?.parentUnitId, organization.rootNodeId);
    await captureScreenshot(cdp, fixture, 'organization-entry');

    log('duplicate team-name validation and recovery in organization editor');
    await cdp.fill('#team-name', fixture.teamName);
    await cdp.waitFor(
      "document.querySelector('[data-testid=create-team-page]')?.innerText.includes('Team name already exists')",
      'existing team name rejected'
    );
    const orgTeamName = 'org-team-e2e-' + randomUUID().slice(0, 8);
    await cdp.fill('#team-name', orgTeamName);
    await cdp.click(createButtonExpression('Custom path'));
    await cdp.fill(
      '[data-testid=create-team-page] input[aria-label="Custom working directory"]',
      fixture.projectPath
    );
    const orgLaunchChecked = await cdp.evaluate(
      "document.querySelector('#launch-team')?.getAttribute('data-state') === 'checked'"
    );
    if (orgLaunchChecked) {
      await cdp.click("document.querySelector('[data-testid=create-team-page] #launch-team')");
    }
    await cdp.click(createButtonExpression('Create'));
    await cdp.waitFor(
      "!document.querySelector('[data-testid=create-team-page]')",
      'organization team saved and editor closed', 45_000
    );
    const structure = await cdp.evaluate(
      "window.electronAPI.organizations.getOrganizationStructure()"
    );
    assert(
      structure.units.some(u => u.kind === 'team' &&
        u.teamName === orgTeamName && u.organizationId === organization.id),
      'Created team was not assigned to the requested organization'
    );
    await captureScreenshot(cdp, fixture, 'organization-created');

    const scheduleUiEvidence = await exerciseScheduleUx(cdp, fixture, log, started.inspectorWebSocketDebuggerUrl);
    const zhTwMcpUiEvidence = await exerciseTraditionalChineseMcpUi(fixture, log);

    const results = {
      success: true,
      scheduleUiEvidence,
      zhTwMcpUiEvidence,
      unique,
      retainedAcrossBack: true,
      retainedAcrossTabSwitch: true,
      manageProvidersNavigationRetainsDraft: true,
      retainedAcrossProcessRestart: true,
      advancedCliRetainedAcrossRename: true,
      teammateModeOverridePersistedThroughNativeUi: true,
      teammateModeOverrideValidatedThroughNativeUi: true,
      missingRequiredCliValueRejectedThroughNativeUi: true,
      advancedCliRetainedAcrossPaneSplit: true,
      advancedCliRetainedAcrossBackRemount: true,
      advancedCliRestoresUneditedDefaults: true,
      unnamedAdvancedCliEditsRetained: true,
      launchStillModal: true,
      launchContentLoaded: true,
      configOnlyCreatedThroughUi: true,
      nativeConfigOnlyRejectionKeepsDraft: true,
      copiedTeamUsesSharedEditor: true,
      copiedDraftDoesNotReplaySeed: true,
      templateReplacementCancelledAndConfirmed: true,
      organizationPlacementPersistedViaNativeApi: true,
      duplicateNameValidationRecovered: true,
      themeDarkLightRendered: true,
      cssZoom200Rendered: true,
      nativeElectronZoom200Rendered: true,
      splitPaneSingleEditor: true,
      macInputSelectionFallbackCount: inputSelectAllDomFallbacks,
      sandboxRoot: fixture.root,
    };
    const outDir = process.env.TEAMS_CREATE_E2E_ARTIFACT_DIR || os.tmpdir();
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'teams-create-page-result.json'),
      JSON.stringify(results, null, 2));
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } catch (error) {
    failure = error;
    await dumpRenderer(cdp, 'teams-create-page-failure');
    if (cdp) {
      try { await captureScreenshot(cdp, fixture, 'failure'); } catch { /* disconnected */ }
    }
  } finally {
    await cleanup(fixture);
  }
  if (failure) throw failure;
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.stderr.write(`${appLogTail.slice(-40).join('\n')}\n`);
  process.exitCode = 1;
});
