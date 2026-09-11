#!/usr/bin/env node
// Isolated pnpm dev:mcp E2E for OpenCode Provider Settings Test UX.
// Seeds only a disposable project. Does not open the native folder picker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const evidenceRoot = path.resolve(
  process.env.AGENT_TEAMS_OPENCODE_TEST_E2E_EVIDENCE ??
    path.join(os.tmpdir(), 'agent-teams-opencode-local-test-evidence')
);
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
  if (appLogTail.length > 250) appLogTail.splice(0, appLogTail.length - 250);
  if (process.env.AGENT_TEAMS_OPENCODE_TEST_E2E_VERBOSE === '1') process.stdout.write(text);
}

function encodeClaudeProjectDir(absolutePath) {
  const encoded = absolutePath.replace(/[/\\]/g, '-');
  return encoded.startsWith('-') ? encoded : `-${encoded}`;
}

async function seedFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'atlpoclt')));
  const fixture = {
    kind: 'opencode-local-test-desktop-v1',
    root,
    claudeRoot: path.join(root, 'claude'),
    userDataRoot: path.join(root, 'user-data'),
    claudeConfigDir: path.join(root, 'claude-config'),
    xdgConfigHome: path.join(root, 'xdg-config'),
    xdgDataHome: path.join(root, 'xdg-data'),
    xdgCacheHome: path.join(root, 'xdg-cache'),
    xdgStateHome: path.join(root, 'xdg-state'),
    xdgRuntimeDir: path.join(root, 'xdg-runtime'),
    projectPath: path.join(root, 'sandbox'),
  };
  for (const key of [
    'claudeRoot',
    'userDataRoot',
    'claudeConfigDir',
    'xdgConfigHome',
    'xdgDataHome',
    'xdgCacheHome',
    'xdgStateHome',
    'xdgRuntimeDir',
    'projectPath',
  ]) {
    await mkdir(fixture[key], { recursive: true });
  }
  await writeFile(path.join(fixture.projectPath, 'README.md'), '# Disposable Ollama Test E2E\n');
  await writeFile(
    path.join(fixture.claudeRoot, 'agent-teams-config.json'),
    `${JSON.stringify({
      general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'dashboard' },
    })}\n`
  );
  await mkdir(path.join(fixture.xdgConfigHome, 'opencode'), { recursive: true });
  await writeFile(
    path.join(fixture.xdgConfigHome, 'opencode', 'opencode.json'),
    `${JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:11434/v1' },
        },
      },
    })}\n`
  );
  const encoded = encodeClaudeProjectDir(fixture.projectPath);
  const sessionDir = path.join(fixture.claudeRoot, 'projects', encoded);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, 'session-ollama-test.jsonl'),
    `${JSON.stringify({
      type: 'user',
      cwd: fixture.projectPath,
      sessionId: 'session-ollama-test',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'sandbox session' },
      isMeta: false,
    })}\n`
  );
  return fixture;
}

function getTargets(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/json/list', agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
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
  const env = {
    ...process.env,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: fixture.claudeRoot,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: fixture.userDataRoot,
    CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    XDG_DATA_HOME: fixture.xdgDataHome,
    XDG_CACHE_HOME: fixture.xdgCacheHome,
    XDG_STATE_HOME: fixture.xdgStateHome,
    XDG_RUNTIME_DIR: fixture.xdgRuntimeDir,
    SHELL: '/bin/sh',
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    NODE_BINARY: await realpath(process.execPath),
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    pnpm_config_verify_deps_before_run: 'false',
  };
  delete env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
  appProcess = spawn('pnpm', ['dev:mcp'], {
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
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        if (!/execution context was destroyed|cannot find (?:default )?execution context/i.test(String(error))) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async waitUntil(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return;
      } catch (error) {
        if (!/execution context was destroyed|cannot find (?:default )?execution context/i.test(String(error))) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async click(selector) {
    const point = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    assert(point, `Missing clickable element ${selector}`);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    });
  }

  async close() {
    this.socket.close();
  }
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopOwnedApp() {
  await cdp?.close().catch(() => undefined);
  cdp = null;
  const child = appProcess;
  const processGroupId = appProcessGroupId ?? child?.pid;
  if (process.platform !== 'win32' && processGroupId && isProcessGroupAlive(processGroupId)) {
    try {
      process.kill(-processGroupId, 'SIGKILL');
    } catch {
      child?.kill('SIGKILL');
    }
  } else if (child?.exitCode === null) {
    child.kill('SIGKILL');
  }
  appProcess = null;
  appProcessGroupId = null;
}

async function run() {
  const fixture = await seedFixture();
  await mkdir(evidenceRoot, { recursive: true });
  let succeeded = false;
  try {
    const { port, renderer } = await startApp(fixture);
    process.stdout.write(`Using isolated dev:mcp CDP port ${port}\n`);
    cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.bringToFront');
    await cdp.waitFor(
      'window.electronAPI && window.__agentTeamsDevStore',
      'native API and dev store',
      90_000
    );
    await cdp.evaluate(`window.__agentTeamsDevStore.getState().openDashboard?.()`);
    await cdp.waitUntil(
      `(async () => {
        const projects = await window.electronAPI.getProjects();
        return projects.some((project) => project.path === ${JSON.stringify(fixture.projectPath)});
      })()`,
      'sandbox project from getProjects',
      60_000
    );
    await cdp.waitFor(
      'Boolean(document.querySelector(\'[data-testid="runtime-manage-opencode"]\'))',
      'OpenCode Manage control',
      90_000
    );
    const manageState = await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="runtime-manage-opencode"]');
      if (!(button instanceof HTMLElement)) return { missing: true };
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      return {
        disabled: button instanceof HTMLButtonElement ? button.disabled : null,
        text: button.textContent?.trim() ?? '',
        rect,
        hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML?.slice(0, 300) ?? null,
      };
    })()`);
    process.stdout.write(`Manage OpenCode: ${JSON.stringify(manageState)}\n`);
    await cdp.evaluate(`document.querySelector('[data-testid="runtime-manage-opencode"]')?.click()`);
    await cdp.waitFor(
      `Boolean(document.querySelector('[role="dialog"]')) || Boolean(document.querySelector('[data-testid="runtime-provider-project-context-select"]'))`,
      'provider settings dialog',
      60_000
    );
    const dialogDump = await cdp.evaluate(`(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map((item) => ({
        title: item.querySelector('h2,h3')?.textContent?.trim() ?? null,
        testIds: Array.from(item.querySelectorAll('[data-testid]')).map((node) => node.getAttribute('data-testid')),
        text: item.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 500),
      }));
      return {
        dialogs,
        picker: Boolean(document.querySelector('[data-testid="runtime-provider-project-context-select"]')),
        activeTab: window.__agentTeamsDevStore?.getState()?.activeTabId ?? null,
      };
    })()`);
    process.stdout.write(`Dialog dump: ${JSON.stringify(dialogDump, null, 2)}\n`);
    await cdp.waitFor(
      'Boolean(document.querySelector(\'[data-testid="runtime-provider-project-context-select"]\'))',
      'Providers project picker',
      60_000
    );
    const before = await cdp.evaluate(`(() => ({
      hint: document.querySelector('[data-testid="runtime-provider-providers-test-project-hint"]')?.textContent ?? null,
      picker: Boolean(document.querySelector('[data-testid="runtime-provider-project-context-select"]')),
    }))()`);
    assert.equal(before.picker, true);
    assert.match(before.hint ?? '', /Select a project context before testing models/i);
    process.stdout.write('PASS Providers tab shows project picker and Test hint without a project\n');

    const projectInventory = await cdp.evaluate(`(async () => {
      const projects = await window.electronAPI.getProjects();
      const recent = await window.electronAPI.getDashboardRecentProjects?.();
      return {
        projects: projects.map((project) => ({
          name: project.name,
          path: project.path,
          filesystemState: project.filesystemState ?? null,
        })),
        recent: recent?.projects?.map((project) => ({
          name: project.name,
          path: project.primaryPath,
          filesystemState: project.filesystemState ?? null,
        })) ?? null,
      };
    })()`);
    process.stdout.write(`Project inventory: ${JSON.stringify(projectInventory, null, 2)}\n`);
    await cdp.waitUntil(
      `(() => {
        const trigger = document.querySelector('[data-testid="runtime-provider-project-context-trigger"]');
        return trigger instanceof HTMLElement && trigger.getAttribute('data-disabled') !== 'true' && !trigger.disabled;
      })()`,
      'project picker enabled',
      30_000
    );
    const triggerState = await cdp.evaluate(`(() => {
      const trigger = document.querySelector('[data-testid="runtime-provider-project-context-trigger"]');
      return trigger instanceof HTMLElement
        ? {
            disabled: trigger.disabled,
            dataDisabled: trigger.getAttribute('data-disabled'),
            expanded: trigger.getAttribute('aria-expanded'),
            text: trigger.textContent?.trim() ?? '',
          }
        : null;
    })()`);
    process.stdout.write(`Project trigger: ${JSON.stringify(triggerState)}\n`);
    await cdp.evaluate(`document.querySelector('[data-testid="runtime-provider-project-context-trigger"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const optionDump = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="option"],[role="listbox"] *')).map((item) => ({
      role: item.getAttribute('role'),
      text: item.textContent?.trim()?.slice(0, 80) ?? '',
    })).slice(0, 40)`);
    process.stdout.write(`Select options: ${JSON.stringify(optionDump, null, 2)}\n`);
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('[role="option"]')).some((item) => item.textContent?.includes(${JSON.stringify(path.basename(fixture.projectPath))}))`,
      'sandbox project option',
      15_000
    );
    await cdp.evaluate(`(() => {
      const option = Array.from(document.querySelectorAll('[role="option"]')).find((item) =>
        item.textContent?.includes(${JSON.stringify(path.basename(fixture.projectPath))})
      );
      if (!(option instanceof HTMLElement)) throw new Error('Missing sandbox option');
      option.click();
    })()`);
    await cdp.waitFor(
      '!document.querySelector(\'[data-testid="runtime-provider-providers-test-project-hint"]\')',
      'project hint dismissed',
      15_000
    );
    process.stdout.write('PASS selecting the sandbox project dismisses the Test hint\n');

    await cdp.waitFor(
      '!document.querySelector(\'[data-testid="runtime-provider-loading-skeleton"]\')',
      'OpenCode catalog finished loading',
      90_000
    );
    const catalogDump = await cdp.evaluate(`(() => ({
      rowCount: document.querySelectorAll('[data-testid^="runtime-provider-directory-row-"]').length,
      hasOllama: Boolean(document.querySelector('[data-testid="runtime-provider-directory-row-ollama"]')),
    }))()`);
    process.stdout.write(`Catalog dump: ${JSON.stringify(catalogDump, null, 2)}\n`);
    const search = 'document.querySelector(\'[data-testid="runtime-provider-search"]\')';
    await cdp.waitFor(search, 'provider search', 60_000);
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="runtime-provider-search"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('Missing search');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'olla');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await cdp.waitFor(
      'Boolean(document.querySelector(\'[data-testid="runtime-provider-directory-row-ollama"]\'))',
      'Ollama directory row',
      90_000
    );
    await cdp.evaluate(`document.querySelector('[data-testid="runtime-provider-directory-row-ollama"]')?.click()`);
    await cdp.waitFor(
      'document.querySelector(\'[data-testid^="runtime-provider-model-test-"]\') instanceof HTMLButtonElement',
      'Ollama Test button',
      90_000
    );
    await cdp.waitUntil(
      `(() => {
        const button = document.querySelector('[data-testid^="runtime-provider-model-test-"]');
        return button instanceof HTMLButtonElement && !button.disabled;
      })()`,
      'enabled Ollama Test button',
      60_000
    );
    const testState = await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid^="runtime-provider-model-test-"]');
      return {
        testId: button?.getAttribute('data-testid') ?? null,
        disabled: button instanceof HTMLButtonElement ? button.disabled : true,
        hint: document.querySelector('[data-testid^="runtime-provider-model-test-hint-"]')?.textContent ?? null,
      };
    })()`);
    assert.equal(testState.disabled, false, `Test stayed disabled: ${JSON.stringify(testState)}`);
    process.stdout.write(`PASS Test is enabled for ${testState.testId}\n`);
    await cdp.evaluate(
      `document.querySelector(${JSON.stringify(`[data-testid="${testState.testId}"]`)})?.click()`
    );
    await cdp.waitFor(
      `Boolean(document.querySelector('[data-testid^="runtime-provider-model-result-"]'))`,
      'model test result',
      120_000
    );
    const result = await cdp.evaluate(`document.querySelector('[data-testid^="runtime-provider-model-result-"]')?.textContent`);
    assert(typeof result === 'string' && result.length > 0, 'Missing Test result text');
    process.stdout.write(`PASS Test produced a result: ${result.slice(0, 160)}\n`);
    succeeded = true;
  } catch (error) {
    await writeFile(
      path.join(evidenceRoot, 'failure.json'),
      `${JSON.stringify({ error: String(error), appLogTail: appLogTail.slice(-80) }, null, 2)}\n`
    ).catch(() => undefined);
    throw error;
  } finally {
    await stopOwnedApp();
    if (succeeded) {
      await rm(fixture.root, { recursive: true, force: true });
    } else {
      process.stderr.write(`Retained failed fixture: ${fixture.root}\n`);
    }
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
