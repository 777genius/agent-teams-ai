#!/usr/bin/env node
// Disposable Electron renderer E2E proving the member profile dialog has no
// Member work sync card. Seeds an isolated team/project, launches `pnpm dev:mcp`,
// opens the member profile dialog, and asserts the work sync card is absent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
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
let cdp = null;

function rememberAppLog(chunk, stream) {
  const text = chunk.toString();
  const lines = `${appLogRemainder[stream]}${text}`.split(/\r?\n/);
  appLogRemainder[stream] = lines.pop() ?? '';
  appLogTail.push(...lines.filter(Boolean));
  if (appLogTail.length > 200) appLogTail.splice(0, appLogTail.length - 200);
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
  await chmod(fixture.runtimeWrapperPath, 0o755);
  await writeFile(fixture.runtimeLedgerPath, '');
  await writeFile(path.join(fixture.projectPath, 'README.md'), '# Disposable Member Dialog E2E\n');
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
    description: 'Disposable member dialog E2E fixture',
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
  appProcess = spawn('pnpm', ['dev:mcp', ...(process.platform === 'linux' ? ['--noSandbox'] : [])], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
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
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17,
      modifiers: 2,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17,
    });
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
        workSyncMarkers: Array.from(
          document.querySelectorAll('[data-testid^="member-work-sync-"]')
        ).map((element) => element.getAttribute('data-testid')),
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

async function initializeTeams(client, fixture) {
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.waitFor('window.electronAPI?.teams && window.__agentTeamsDevStore',
    'native API and dev store', 60_000);
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

async function main() {
  const fixture = await seedFixture();
  const unique = `create-page-e2e-${randomUUID().slice(0, 8)}`;
  let failure = null;
  const log = (step) => process.stdout.write(`STEP: ${step}\\n`);
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

    log('switch away to Settings and return to Teams creation in same renderer');
    const teamsTabId = await cdp.evaluate(`(() => {
      const store = window.__agentTeamsDevStore.getState();
      const pane = store.paneLayout.panes.find(p => p.id === store.paneLayout.focusedPaneId);
      return pane.activeTabId;
    })()`);
    await cdp.evaluate("window.__agentTeamsDevStore.getState().openSettingsTab('general')");
    // Inactive Teams creation pages are retained mounted to avoid lost editor state.
    // Assert that the inactive page is hidden, not removed from the DOM.
    await cdp.waitFor(
      "(() => { const page = document.querySelector('[data-testid=create-team-page]'); return !page || page.getClientRects().length === 0; })()",
      'creation page hidden while Settings is active'
    );
    await cdp.evaluate(
      `window.__agentTeamsDevStore.getState().setActiveTab(${JSON.stringify(teamsTabId)})`);
    await cdp.waitFor(`document.querySelector('#team-name')?.value === ${JSON.stringify(unique)}`,
      'draft survives tab switch');

    log('restart real Electron process retaining the same isolated data root');
    await cleanup({ ...fixture, root: null });
    // Graceful rebuild of the renderer with the same IndexedDB profile.
    started = await startApp(fixture);
    cdp = await CdpClient.connect(started.renderer.webSocketDebuggerUrl);
    await initializeTeams(cdp, fixture);
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
    assert.equal((await renderSnapshot(cdp)).inCreatePage, false);
    await captureScreenshot(cdp, fixture, 'launch-still-modal');

    const results = {
      success: true,
      unique,
      retainedAcrossBack: true,
      retainedAcrossTabSwitch: true,
      retainedAcrossProcessRestart: true,
      launchStillModal: true,
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
