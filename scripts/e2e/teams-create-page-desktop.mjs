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

async function exerciseScheduleUx(client, fixture, log) {
  const scheduleLabel = 'schedule-visual-e2e-' + randomUUID().slice(0, 8);
  log('open real Schedules UI in isolated Electron');
  await client.evaluate('window.__agentTeamsDevStore.getState().openSchedulesTab()');
  await client.waitFor(createButtonExpression('Add Schedule'), 'Schedules screen ready', 45_000);
  await client.click(createButtonExpression('Add Schedule'));
  await client.waitFor("document.querySelector('[role=dialog] #schedule-label')",
    'actual schedule editor loaded', 45_000);
  await captureScreenshot(client, fixture, 'schedules-editor-opened');

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
  const saveButton = "Array.from(document.querySelectorAll('[role=dialog] button'))" +
    ".find(button => button.textContent?.trim() === 'Create Schedule')";
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
  log('exercise list presentation in dark/light and CSS 200% layout');
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
  await client.evaluate("document.documentElement.style.zoom = '2'");
  const zoomActionsVisible = await client.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('div.rounded-lg'))
      .find(el => el.textContent?.includes(${JSON.stringify(scheduleLabel)}) &&
        el.querySelector('button[aria-label="More actions"]'));
    const button = row?.querySelector('button[aria-label="More actions"]');
    const r = button?.getBoundingClientRect();
    return !!r && r.width > 0 && r.left >= 0 && r.right <= window.innerWidth;
  })()`);
  assert(zoomActionsVisible, 'Schedule actions overflowed viewport at 200% CSS zoom');
  await captureScreenshot(client, fixture, 'schedules-list-css-zoom-200');
  await client.evaluate("document.documentElement.style.zoom = ''");

  log('edit the real schedule without migrating its task-first semantics');
  const more = "Array.from(document.querySelectorAll('div.rounded-lg'))" +
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

  log('run now and inspect the actual schedule run history');
  const runNow = "Array.from(document.querySelectorAll('div.rounded-lg'))" +
    ".find(row => row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
    "row.querySelector('button[aria-label=\\\"Run now\\\"]'))" +
    "?.querySelector('button[aria-label=\\\"Run now\\\"]')";
  await client.click(runNow);
  await client.waitFor(
    "document.querySelector('[role=status]')?.textContent?.includes('Run started')",
    'run-now feedback visible', 45_000);
  const createdRuns = await client.evaluate(
    'window.electronAPI.schedules.getRuns(' + JSON.stringify(scheduled.id) + ')');
  assert(createdRuns.length > 0, 'Run now created no persisted run');
  const expand = "Array.from(document.querySelectorAll('div.rounded-lg'))" +
    ".find(row => row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
    "row.querySelector('button[aria-expanded]'))?.querySelector('button[aria-expanded]')";
  await client.click(expand);
  await client.waitFor(
    "Array.from(document.querySelectorAll('div.rounded-lg')).some(row => " +
      "row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
      "row.querySelector('div[role=button]'))",
    'run history row visible');
  await captureScreenshot(client, fixture, 'schedules-run-history');
  await client.click("Array.from(document.querySelectorAll('div.rounded-lg'))" +
    ".find(row => row.textContent?.includes(" + JSON.stringify(scheduleLabel) + ") && " +
    "row.querySelector('div[role=button]'))?.querySelector('div[role=button]')");
  await client.waitFor(
    "document.querySelector('[role=dialog]')?.textContent?.includes('Run Log')",
    'run log dialog opened');
  await captureScreenshot(client, fixture, 'schedules-run-log');
  await client.click("Array.from(document.querySelectorAll('[role=dialog] button'))" +
    ".find(button => button.textContent?.trim() === 'Close')");

  log('destructive action demands confirmation and Cancel preserves the record');
  await client.click(more);
  await client.click(createButtonExpression('Delete'));
  await client.waitFor("document.querySelector('[role=dialog][aria-label=Delete]')",
    'schedule deletion confirmation');
  await captureScreenshot(client, fixture, 'schedules-delete-confirm');
  await client.click("document.querySelector('[role=dialog][aria-label=Delete] button:not([data-confirm-btn])')");
  assert((await client.evaluate('window.electronAPI.schedules.list()')).some(s => s.id === scheduled.id),
    'Cancel deleted a scheduled task');

  await client.click(more);
  await client.click(createButtonExpression('Delete'));
  await client.click("document.querySelector('[role=dialog][aria-label=Delete] button[data-confirm-btn]')");
  await client.waitFor(
    "!Array.from(document.querySelectorAll('div.rounded-lg')).some(row => " +
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

    log('click real Create Team button');
    await cdp.click(createButtonExpression('Create Team'));
    await cdp.waitFor("document.querySelector('[data-testid=create-team-page] input#team-name')",
      'creation page and team name');
    let shot = await renderSnapshot(cdp);
    assert.equal(shot.inCreatePage, true);
    // A settings dialog is allowed later, but Create itself must not trap focus.
    assert.equal(shot.dialogOpen, false, 'Create opened a dialog instead of a page');
    await captureScreenshot(cdp, fixture, 'opened');

    log('enter team name with real Chromium keyboard events');
    await cdp.fill('#team-name', unique);
    await captureScreenshot(cdp, fixture, 'edited');

    log('Back to Teams and resume saved draft');
    await cdp.click("document.querySelector('[data-testid=create-team-page] button[aria-label=\"Back to teams\"]')");
    await cdp.waitFor("!document.querySelector('[data-testid=create-team-page]')",
      'creation page closed on Back');
    await cdp.waitFor(createButtonExpression('Continue creating'), 'Continue creating button');
    await cdp.click(createButtonExpression('Continue creating'));
    await cdp.waitFor(`document.querySelector('#team-name')?.value === ${JSON.stringify(unique)}`,
      'same team name restored after Back');
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
    const setActualZoom = async (factor) => {
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
    };
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
    assert(copiedDescription, 'Copied team description did not hydrate');
    const selectTemplate = async () => {
      await cdp.click(
        "document.querySelector('[data-testid=create-team-page] button[aria-label=\"Team template\"]')"
      );
      await cdp.click(
        "Array.from(document.querySelectorAll('[role=option]'))" +
        ".find(option => option.textContent?.includes('Software Product Team'))"
      );
      await cdp.waitFor(
        "document.querySelector('[role=dialog][aria-label=\"Apply team template?\"]')",
        'template replacement confirmation'
      );
    };
    await selectTemplate();
    // Wait for the dialog's focus and Tab-trap effects before testing keyboard containment.
    await cdp.waitFor(
      `document.querySelector('[role=dialog][aria-label="Apply team template?"]')?.contains(document.activeElement)`,
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
        "document.querySelector('[role=dialog][aria-label=\\\"Apply team template?\\\"]')?.contains(document.activeElement)"
      ),
      'Template confirmation focus escaped into the background form'
    );
    await cdp.click(
      "document.querySelector('[role=dialog][aria-label=\\\"Apply team template?\\\"] button:not([data-confirm-btn])')"
    );
    assert.equal(await cdp.evaluate("document.querySelector('#team-description')?.value"),
      copiedDescription, 'Canceling template replacement discarded the copied description');
    await selectTemplate();
    await cdp.click(
      "document.querySelector('[role=dialog][aria-label=\\\"Apply team template?\\\"] button[data-confirm-btn]')"
    );
    await cdp.waitFor(
      "document.querySelector('#team-description')?.value === " +
      JSON.stringify('Design, build and validate apps, websites and digital products.'),
      'template applied after explicit confirmation'
    );
    await captureScreenshot(cdp, fixture, 'template-confirmed');

    log('create from actual Organization Map and verify native placement');
    await cdp.click(
      "document.querySelector('[data-testid=create-team-page] button[aria-label=\"Back to teams\"]')"
    );
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

    const scheduleUiEvidence = await exerciseScheduleUx(cdp, fixture, log);

    const results = {
      success: true,
      scheduleUiEvidence,
      unique,
      retainedAcrossBack: true,
      retainedAcrossTabSwitch: true,
      manageProvidersNavigationRetainsDraft: true,
      retainedAcrossProcessRestart: true,
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
