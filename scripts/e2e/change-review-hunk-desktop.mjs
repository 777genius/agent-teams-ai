#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const electronViteBin = path.join(repoRoot, 'node_modules/electron-vite/bin/electron-vite.js');
const fixtureRoot = path.resolve(
  process.env.AGENT_TEAMS_CHANGES_E2E_ROOT ??
    path.join(os.tmpdir(), 'agent-teams-change-review-desktop-e2e')
);
const devMcpMode = process.argv.includes('--dev-mcp');
const singleWindowMode = process.argv.includes('--single-window');
const keepFixture = process.env.AGENT_TEAMS_CHANGES_E2E_KEEP === '1';
const skipBuild = process.env.AGENT_TEAMS_CHANGES_E2E_SKIP_BUILD === '1';
const selectTeamButton = `Array.from(document.querySelectorAll('button'))
  .find((button) => button.textContent?.trim() === 'Select Team')`;
const sandboxTeamCard = `Array.from(document.querySelectorAll('[role="button"]'))
  .find((element) => element.querySelector('h3')?.textContent?.trim() === 'changes-e2e')`;
const sandboxKanbanTaskCard = `document.querySelector(
  '.kanban-task-card[data-task-id="changes-history-e2e"]'
)`;
const kanbanTabButton = `Array.from(document.querySelectorAll('button'))
  .find((button) => button.textContent?.trim() === 'Kanban')`;
const visibleElement = (expression) => `(() => {
  const element = (${expression});
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
})()`;
const historyPopoverLayer = `Array.from(
  document.querySelectorAll('[data-radix-popper-content-wrapper]')
).find((wrapper) => wrapper.textContent?.includes('Review action history'))`;
const historyPopover = `(${historyPopoverLayer})?.querySelector('[data-state="open"]')`;
const visibleHistoryPopover = visibleElement(historyPopover);
const visibleRejectHunkButton = `Array.from(document.querySelectorAll('button[title^="Reject change"]'))
  .find((button) => {
    const rect = button.getBoundingClientRect();
    const toolbar = button.closest('[data-review-floating-toolbar="true"]');
    return rect.width > 0 && rect.height > 0 && toolbar?.textContent?.includes('1 of 12');
  })`;
const visibleAcceptHunkButton = `Array.from(document.querySelectorAll('button[title^="Accept change"]'))
  .find((button) => {
    const rect = button.getBoundingClientRect();
    const toolbar = button.closest('[data-review-floating-toolbar="true"]');
    return rect.width > 0 && rect.height > 0 && toolbar?.textContent?.includes('1 of 12');
  })`;
const reviewedLine = (index, value) => `Array.from(document.querySelectorAll('.cm-line'))
  .find((line) => line.textContent?.includes(${JSON.stringify(`reviewed_${index} = '${value}'`)}))`;
const appLogTail = [];
let appProcess = null;
let client = null;

function rememberAppLog(chunk) {
  const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
  appLogTail.push(...lines);
  if (appLogTail.length > 200) appLogTail.splice(0, appLogTail.length - 200);
  if (process.env.AGENT_TEAMS_CHANGES_E2E_VERBOSE === '1') process.stdout.write(chunk);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with ${code ?? signal}`));
    });
  });
}

async function findAvailablePort(start = 9410) {
  for (let port = start; port < start + 100; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No free CDP port for Changes desktop E2E');
}

function seedFixture() {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/seed-change-review-e2e.mjs')],
    {
      cwd: repoRoot,
      env: { ...process.env, AGENT_TEAMS_CHANGES_E2E_ROOT: fixtureRoot },
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) {
    throw new Error(`Unable to seed Changes fixture: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function readCdpTargets(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/json/list',
        agent: false,
        headers: { Connection: 'close' },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.once('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`CDP returned HTTP ${response.statusCode ?? 'unknown'}`));
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

async function waitForCdp(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (appProcess?.exitCode !== null) {
      throw new Error(`Electron exited before CDP became ready (${appProcess.exitCode})`);
    }
    try {
      const targets = await readCdpTargets(port);
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          !target.url.startsWith('devtools://') &&
          typeof target.webSocketDebuggerUrl === 'string'
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP did not become ready: ${String(lastError)}`);
}

async function startApp(port, fixture) {
  const args = devMcpMode
    ? [electronViteBin, 'dev', '--remoteDebuggingPort', String(port)]
    : [electronViteBin, 'preview', '--skipBuild', '--', `--remote-debugging-port=${port}`];
  appProcess = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: devMcpMode ? 'development' : 'production',
      AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
      AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: fixture.claudeRoot,
      AGENT_TEAMS_ELECTRON_USER_DATA_DIR: fixture.userDataRoot,
      // Changes does not exercise the OpenCode MCP transport. Avoid coupling this
      // renderer E2E to a second background service and its independent startup timeout.
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
      // Keep the local MCP Node probe deterministic. The E2E never launches agents.
      NODE_BINARY: process.execPath,
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH:
        process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || process.execPath,
    },
  });
  appProcess.stdout.on('data', rememberAppLog);
  appProcess.stderr.on('data', rememberAppLog);
  const webSocketUrl = await waitForCdp(port, devMcpMode ? 90_000 : 60_000);
  client = await CdpClient.connect(webSocketUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Page.bringToFront');
  await ensureSandboxNavigation();
}

async function ensureSandboxNavigation() {
  await client.waitFor(
    `(${sandboxKanbanTaskCard}) || (${selectTeamButton})`,
    'sandbox team navigation',
    devMcpMode ? 90_000 : 60_000
  );
  const navigationDeadline = Date.now() + 60_000;
  while (!(await client.evaluate(`Boolean(${sandboxKanbanTaskCard})`))) {
    if (Date.now() >= navigationDeadline) {
      throw new Error('Timed out recovering sandbox team navigation after renderer reload');
    }
    if (await client.evaluate(`Boolean(${visibleElement(sandboxTeamCard)})`)) {
      await client.domClick(visibleElement(sandboxTeamCard));
    } else if (await client.evaluate(`Boolean(${visibleElement(kanbanTabButton)})`)) {
      await client.domClick(visibleElement(kanbanTabButton));
    } else if (await client.evaluate(`Boolean(${visibleElement(selectTeamButton)})`)) {
      await client.domClick(visibleElement(selectTeamButton));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function reloadRenderer() {
  if (!client) throw new Error('Cannot reload Changes before CDP is connected');
  const loaded = client.waitForEvent('Page.loadEventFired', 60_000);
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await ensureSandboxNavigation();
}

async function restartApp(port, fixture) {
  if (singleWindowMode) {
    await reloadRenderer();
    return;
  }
  await stopApp();
  await startApp(port, fixture);
}

function isProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return false;
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

async function stopApp() {
  await client?.close().catch(() => undefined);
  client = null;
  if (!appProcess) return;
  const child = appProcess;
  const pid = child.pid;
  const waitForExit = (timeoutMs) => {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (didExit) => {
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve(didExit);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once('exit', onExit);
    });
  };
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    const gracefulExit = waitForExit(2_000);
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await gracefulExit;
    if (!(await waitForProcessGroupExit(pid, 2_000))) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      await waitForProcessGroupExit(pid, 2_000);
    }
  }
  appProcess = null;
}

async function killAppImmediately() {
  await client?.close().catch(() => undefined);
  client = null;
  if (!appProcess || appProcess.exitCode !== null) {
    appProcess = null;
    return;
  }
  const child = appProcess;
  const exited = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  assert.equal(await exited, true, 'Electron did not exit after SIGKILL');
  appProcess = null;
}

async function waitForAppExit(timeoutMs = 30_000) {
  if (!appProcess || appProcess.exitCode !== null) {
    await client?.close().catch(() => undefined);
    client = null;
    if (appProcess && process.platform !== 'win32') {
      assert.equal(
        await waitForProcessGroupExit(appProcess.pid, timeoutMs),
        true,
        'Electron process group survived the guarded close request'
      );
    }
    appProcess = null;
    return;
  }
  const child = appProcess;
  const didExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.equal(didExit, true, 'Electron did not exit after the guarded close request');
  if (process.platform !== 'win32') {
    assert.equal(
      await waitForProcessGroupExit(child.pid, timeoutMs),
      true,
      'Electron process group survived the guarded close request'
    );
  }
  await client?.close().catch(() => undefined);
  client = null;
  appProcess = null;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) {
        const waiters = this.eventWaiters.get(message.method);
        if (!waiters) return;
        this.eventWaiters.delete(message.method);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(message.params);
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP closed'));
      this.pending.clear();
      for (const waiters of this.eventWaiters.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('CDP closed'));
        }
      }
      this.eventWaiters.clear();
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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) ?? new Set();
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.eventWaiters.delete(method);
          reject(new Error(`Timed out waiting for CDP event ${method}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
      this.eventWaiters.set(method, waiters);
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
      if (await this.evaluate(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async elementRect(expression) {
    return this.evaluate(`(() => {
      const element = (${expression});
      if (!element) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
  }

  async moveTo(expression) {
    const rect = await this.elementRect(expression);
    assert(rect, `Element not visible: ${expression}`);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
  }

  async click(expression) {
    const rect = await this.elementRect(expression);
    assert(rect, `Element not visible: ${expression}`);
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  async domClick(expression) {
    const clicked = await this.evaluate(`(() => {
      const element = (${expression});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`);
    assert.equal(clicked, true, `Element not clickable: ${expression}`);
  }

  async pressEscape() {
    const key = {
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async screenshot(filePath) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(filePath, Buffer.from(result.data, 'base64'));
  }

  close() {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.once('close', resolve);
      this.socket.close();
    });
  }
}

const buttonWithText = (text) => `Array.from(document.querySelectorAll('button'))
  .find((element) => element.textContent?.trim() === ${JSON.stringify(text)} &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)`;
const enabledButtonWithText = (text) => `(() => {
  const button = ${buttonWithText(text)};
  return button && !button.disabled ? button : null;
})()`;

async function discardActiveRecoveryBranch(label) {
  await client.domClick(enabledButtonWithText('Discard recovery branch'));
  const confirmDiscard = `Array.from(
    document.querySelectorAll('[role="alertdialog"] button')
  ).find((button) => button.textContent?.trim() === 'Discard recovery branch' && !button.disabled)`;
  await client.waitFor(confirmDiscard, `${label} discard confirmation`);
  await client.domClick(confirmDiscard);
}

async function openReview() {
  await client.domClick(sandboxKanbanTaskCard);
  const taskDialog = `Array.from(document.querySelectorAll('[role="dialog"]'))
    .find((dialog) => Array.from(dialog.querySelectorAll('h2'))
      .some((heading) => heading.textContent?.trim() === 'Verify durable Changes history'))`;
  await client.waitFor(taskDialog, 'task dialog');
  const fileRow = `(${taskDialog})?.querySelector(
    '[role="button"][aria-label="src/review-history.ts"]'
  )`;
  const changesSection = `Array.from((${taskDialog})?.querySelectorAll('section') ?? [])
    .find((section) => Array.from(section.querySelectorAll('span'))
      .some((span) => span.textContent?.trim() === 'Changes'))`;
  const expandChanges = `(${changesSection})?.querySelector(
    'button[aria-label="Expand section"]'
  )`;
  const collapseChanges = `(${changesSection})?.querySelector(
    'button[aria-label="Collapse section"]'
  )`;
  await client.waitFor(
    `(${fileRow}) || (${expandChanges}) || (${collapseChanges})`,
    'Changes section readiness',
    45_000
  );
  const changesDeadline = Date.now() + 45_000;
  while (!(await client.evaluate(`Boolean(${fileRow})`)) && Date.now() < changesDeadline) {
    if (await client.evaluate(`Boolean(${expandChanges})`)) {
      await client.domClick(expandChanges);
    }
    try {
      await client.waitFor(
        `(${fileRow}) || (${expandChanges})`,
        'task file change or remounted collapsed section',
        Math.min(5_000, Math.max(250, changesDeadline - Date.now()))
      );
    } catch {
      // A slow task refresh can keep the section open while its file summaries load.
      // Retry until the total deadline, and reopen if a remount collapsed the section.
    }
  }
  assert.equal(
    await client.evaluate(`Boolean(${fileRow})`),
    true,
    'Task Changes section did not expose the synthetic file before the deadline'
  );
  await client.domClick(fileRow);
  await client.waitFor(
    `/\\b\\d+ (?:pending|accepted|rejected)\\b/.test(document.body?.innerText ?? '')`,
    'hunk review dialog',
    45_000
  );
}

async function assertDiskLines(filePath, expectedFirst, expectedSecond) {
  const content = await readFile(filePath, 'utf8');
  assert.match(content, new RegExp(`^export const reviewed_0 = '${expectedFirst}';`, 'm'));
  assert.match(content, new RegExp(`^export const reviewed_1 = '${expectedSecond}';`, 'm'));
  return content;
}

async function waitForDiskLines(filePath, expectedFirst, expectedSecond, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
    if (
      content.includes(`export const reviewed_0 = '${expectedFirst}';`) &&
      content.includes(`export const reviewed_1 = '${expectedSecond}';`)
    ) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return assertDiskLines(filePath, expectedFirst, expectedSecond);
}

async function readPersistedReviewScope(fixture) {
  const scopeKey = 'task-changes-history-e2e';
  const scopeDir = path.join(
    fixture.claudeRoot,
    'teams',
    fixture.teamName,
    'review-decisions',
    'v2',
    scopeKey
  );
  const entries = (await readdir(scopeDir)).filter((entry) => entry.endsWith('.json'));
  assert.equal(entries.length, 1, 'Expected one exact persisted Changes scope');
  const filePath = path.join(scopeDir, entries[0]);
  const raw = await readFile(filePath, 'utf8');
  const persisted = JSON.parse(raw);
  const fileStats = await stat(filePath, { bigint: true });
  assert.equal(persisted.scopeKey, scopeKey, 'Persisted Changes scope key mismatch');
  assert.equal(typeof persisted.scopeToken, 'string', 'Persisted Changes scope token missing');
  return {
    scopeKey,
    scopeToken: persisted.scopeToken,
    revision: persisted.revision,
    raw,
    mtimeNs: fileStats.mtimeNs,
  };
}

async function invokeReviewApi(method, args) {
  return client.evaluate(
    `window.electronAPI.review[${JSON.stringify(method)}](...${JSON.stringify(args)})`
  );
}

async function moveDecisionCandidateToPriorSnapshot(fixture, scope, candidateId) {
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const currentScopeHash = hash(scope.scopeToken);
  const priorScopeHash = hash(`${scope.scopeToken}:prior-e2e-snapshot`);
  const conflictRoot = path.join(
    fixture.claudeRoot,
    'teams',
    fixture.teamName,
    'review-decisions',
    'conflicts',
    'v1',
    scope.scopeKey
  );
  const currentPath = path.join(conflictRoot, currentScopeHash, `${candidateId}.json`);
  const candidate = JSON.parse(await readFile(currentPath, 'utf8'));
  candidate.scopeTokenHash = priorScopeHash;
  const identity = {
    scopeKey: candidate.scopeKey,
    scopeTokenHash: candidate.scopeTokenHash,
    expectedRevision: candidate.expectedRevision,
    hunkDecisions: candidate.hunkDecisions,
    fileDecisions: candidate.fileDecisions,
    hunkContextHashesByFile: candidate.hunkContextHashesByFile,
    reviewActionHistory: candidate.reviewActionHistory,
    reviewRedoHistory: candidate.reviewRedoHistory,
    textBlobs: candidate.textBlobs,
    fileSummaryBlobs: candidate.fileSummaryBlobs,
  };
  candidate.id = hash(JSON.stringify(identity));
  const priorDir = path.join(conflictRoot, priorScopeHash);
  await mkdir(priorDir, { recursive: true });
  await writeFile(path.join(priorDir, `${candidate.id}.json`), JSON.stringify(candidate), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rm(currentPath);
  return candidate.id;
}

async function waitForReviewDecisions(scope, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    lastSnapshot = await invokeReviewApi('loadDecisions', [
      'changes-e2e',
      scope.scopeKey,
      scope.scopeToken,
    ]);
    if (lastSnapshot && predicate(lastSnapshot)) return lastSnapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: ${JSON.stringify(lastSnapshot)}`);
}

async function waitForStableReviewDecisions(scope, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    const current = await invokeReviewApi('loadDecisions', [
      'changes-e2e',
      scope.scopeKey,
      scope.scopeToken,
    ]);
    if (current && previous?.revision === current.revision) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label}: ${JSON.stringify(previous)}`);
}

async function waitForPersistedRevisionAfter(fixture, previousRevision, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastRevision = null;
  while (Date.now() < deadline) {
    try {
      const persisted = await readPersistedReviewScope(fixture);
      lastRevision = persisted.revision;
      if (persisted.revision > previousRevision) return persisted;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label}: expected revision > ${previousRevision}, found ${lastRevision}`);
}

async function assertViewportFits() {
  const metrics = await client.evaluate(`(() => {
    const root = document.documentElement;
    const toolbar = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Undo')?.parentElement;
    const rect = toolbar?.getBoundingClientRect();
    return {
      innerWidth,
      innerHeight,
      horizontalOverflow: root.scrollWidth > root.clientWidth,
      toolbarFits: !rect || (rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight),
    };
  })()`);
  assert.equal(metrics.horizontalOverflow, false, 'Changes must not overflow horizontally');
  assert.equal(metrics.toolbarFits, true, 'Changes toolbar must fit in the launched window');
  assert(metrics.innerWidth >= 700 && metrics.innerHeight >= 600, 'Unexpected Electron viewport');
}

async function main() {
  if (singleWindowMode && !devMcpMode) {
    throw new Error('--single-window is supported only with --dev-mcp');
  }
  const fixture = seedFixture();
  await mkdir(fixtureRoot, { recursive: true });
  const port = await findAvailablePort(Number(process.env.AGENT_TEAMS_CHANGES_E2E_PORT) || 9410);
  const historyScreenshot = path.join(fixtureRoot, 'durable-history.png');
  const acceptedHistoryScreenshot = path.join(fixtureRoot, 'accepted-history.png');
  const conflictScreenshot = path.join(fixtureRoot, 'external-conflict.png');
  const finalScreenshot = path.join(fixtureRoot, 'final.png');

  if (!devMcpMode && !skipBuild) {
    await run(process.execPath, [electronViteBin, 'build'], {
      env: { ...process.env, AGENT_TEAMS_DISABLE_SOURCEMAPS: '1' },
    });
  }

  await startApp(port, fixture);
  await openReview();
  await assertViewportFits();
  await assertDiskLines(fixture.changedFile, 'after-0', 'after-1');

  await client.waitFor(enabledButtonWithText('Accept All'), 'Accept All for history restore');
  await client.domClick(enabledButtonWithText('Accept All'));
  await client.waitFor(`document.body?.innerText.includes('12 accepted')`, 'bulk Accept action');
  await waitForDiskLines(fixture.changedFile, 'after-0', 'after-1');

  // Build a mixed bulk/file history, jump backward in one durable transaction,
  // restart at the midpoint, then jump forward through Redo. Same-file disk-chain
  // composition is covered by the IPC and SIGKILL suites without relying on hover order.
  await client.waitFor(enabledButtonWithText('Reject'), 'file Reject after bulk Accept');
  await client.domClick(enabledButtonWithText('Reject'));
  await client.waitFor(`document.body?.innerText.includes('12 rejected')`, 'file Reject action');
  await waitForDiskLines(fixture.changedFile, 'before-0', 'before-1');

  const historyButton = visibleElement(`Array.from(
    document.querySelectorAll('button[aria-label^="Review history:"]')
  ).find((button) => {
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })`);
  const historyDismissTarget = visibleElement(`Array.from(document.querySelectorAll('h2'))
    .find((heading) => heading.textContent?.startsWith('Changes for task #'))`);
  const ensureHistoryOpen = async (label) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await client.evaluate(`Boolean(${visibleHistoryPopover})`)) {
        return;
      }
      await client.waitFor(historyButton, `${label} trigger`);
      await client.domClick(historyButton);
      try {
        await client.waitFor(visibleHistoryPopover, label, 3_000);
        return;
      } catch {
        // A restart can remount the trigger between its rect lookup and pointer release.
      }
    }
    throw new Error(`Unable to open ${label}`);
  };
  const ensureHistoryClosed = async (label) => {
    const waitForExitLayer = () =>
      client.waitFor(`!(${historyPopoverLayer})`, `${label} exit layer`, 3_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await client.evaluate(`Boolean(${visibleHistoryPopover})`))) {
        await waitForExitLayer();
        return;
      }
      const explicitCloseButton = `(${visibleHistoryPopover})?.querySelector(
        'button[aria-label="Close review history"]'
      )`;
      if (await client.evaluate(`Boolean(${explicitCloseButton})`)) {
        await client.domClick(explicitCloseButton);
        try {
          await client.waitFor(`!(${visibleHistoryPopover})`, label, 1_000);
          await waitForExitLayer();
          return;
        } catch (error) {
          if (!(await client.evaluate(`Boolean(${visibleHistoryPopover})`))) throw error;
          // A concurrent history update can keep the semantic popover open; continue fallbacks.
        }
      }
      await client.pressEscape();
      try {
        await client.waitFor(`!(${visibleHistoryPopover})`, label, 750);
        await waitForExitLayer();
        return;
      } catch (error) {
        if (!(await client.evaluate(`Boolean(${visibleHistoryPopover})`))) throw error;
        // An action can remount the Radix layer after Escape was delivered to the old content.
      }
      if (!(await client.evaluate(`Boolean(${visibleHistoryPopover})`))) {
        return;
      }
      if (await client.evaluate(`Boolean(${historyDismissTarget})`)) {
        await client.click(historyDismissTarget);
        try {
          await client.waitFor(`!(${visibleHistoryPopover})`, label, 1_000);
          await waitForExitLayer();
          return;
        } catch (error) {
          if (!(await client.evaluate(`Boolean(${visibleHistoryPopover})`))) throw error;
          // Radix may replace the dismissable layer while an action is committing.
        }
      }
      if (!(await client.evaluate(`Boolean(${visibleHistoryPopover})`))) {
        return;
      }
      await client.domClick(historyButton);
      try {
        await client.waitFor(`!(${visibleHistoryPopover})`, label, 1_000);
        await waitForExitLayer();
        return;
      } catch (error) {
        if (!(await client.evaluate(`Boolean(${visibleHistoryPopover})`))) throw error;
        // The toolbar can remount its trigger after a history action; retry the live trigger.
      }
      const navigationButton = `(${visibleHistoryPopover})?.querySelector(
        'button[data-review-history-action]'
      )`;
      if (await client.evaluate(`Boolean(${navigationButton})`)) {
        await client.domClick(navigationButton);
        try {
          await client.waitFor(`!(${visibleHistoryPopover})`, label, 1_000);
          await waitForExitLayer();
          return;
        } catch (error) {
          if (!(await client.evaluate(`Boolean(${visibleHistoryPopover})`))) throw error;
          // Navigating from a live history row explicitly closes the controlled popover.
        }
      }
    }
    throw new Error(`Unable to close ${label}`);
  };
  const performFirstHunkAction = async (buttonExpression, label) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await client.moveTo(reviewedLine(0, 'after-0'));
      const dispatched = await client.evaluate(`(() => {
        const element = (${buttonExpression});
        if (!(element instanceof HTMLElement)) return false;
        element.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          view: window,
        }));
        return true;
      })()`);
      if (dispatched) return;
      // CodeMirror can finish an async extension update after the pointer event and hide
      // the floating toolbar. Re-hover, but select and act in one renderer evaluation so
      // the live toolbar cannot disappear between separate CDP round trips.
    }
    throw new Error(`Unable to perform ${label} for exact hunk 1`);
  };
  const performActionWithBlockedResponse = async (buttonExpression, label) => {
    await client.waitFor(buttonExpression, `${label} trigger`);
    const scheduled = await client.evaluate(`(() => {
      const element = (${buttonExpression});
      if (!(element instanceof HTMLElement)) return false;
      setTimeout(() => {
        element.click();
        // Let the click handler's quiesce await continue and dispatch the real IPC call,
        // then block the next renderer task before the main process can deliver its result.
        setTimeout(() => {
          const deadline = performance.now() + 15_000;
          while (performance.now() < deadline) {}
        }, 0);
      }, 0);
      return true;
    })()`);
    if (!scheduled) throw new Error(`Unable to schedule blocked-response ${label}`);
  };
  const restoreConfirm = `Array.from(document.querySelectorAll('[role="alertdialog"] button'))
    .find((button) => button.textContent?.trim() === 'Restore' && !button.disabled)`;
  const enabledUndoCheckpointRestore = `(() => {
    const section = Array.from(document.querySelectorAll('section'))
      .find((candidate) => candidate.textContent?.includes('Undo stack'));
    return Array.from(section?.querySelectorAll('button[data-review-history-restore]') ?? [])
      .find((button) => !button.disabled);
  })()`;
  const enabledRedoCheckpointRestore = `(() => {
    const section = Array.from(document.querySelectorAll('section'))
      .find((candidate) => candidate.textContent?.includes('Redo stack'));
    return Array.from(section?.querySelectorAll('button[data-review-history-restore]') ?? [])
      .find((button) => !button.disabled);
  })()`;
  await ensureHistoryOpen('history for older Undo checkpoint');
  await client.waitFor(enabledUndoCheckpointRestore, 'older Undo checkpoint restore');
  await client.domClick(enabledUndoCheckpointRestore);
  await client.waitFor(
    `document.querySelector('[role="alertdialog"]')?.textContent.includes('undo 1 review action') &&
      document.querySelector('[data-review-history-impact]')?.textContent.includes('1 net disk transition') &&
      document.querySelector('[data-review-history-impact]')?.textContent.includes('Update') &&
      document.querySelector('[data-review-history-impact]')?.textContent.includes('src/review-history.ts') &&
      document.querySelector('[data-review-history-disk-transition="update"]')?.textContent.includes('+12') &&
      document.querySelector('[data-review-history-disk-transition="update"]')?.textContent.includes('-12')`,
    'Undo checkpoint confirmation'
  );
  await client.domClick(restoreConfirm);
  await client.waitFor(
    `document.body?.innerText.includes('12 accepted') &&
      document.querySelector('button[aria-label^="Review history: 1 undo, 1 redo"]')`,
    'durable midpoint history restore'
  );
  await waitForDiskLines(fixture.changedFile, 'after-0', 'after-1');

  await restartApp(port, fixture);
  await openReview();
  await client.waitFor(
    `document.querySelector('button[aria-label^="Review history: 1 undo, 1 redo"]')`,
    'midpoint history after restart'
  );
  await waitForDiskLines(fixture.changedFile, 'after-0', 'after-1');
  await ensureHistoryOpen('history for Redo checkpoint');
  await client.waitFor(enabledRedoCheckpointRestore, 'Redo checkpoint restore');
  await client.domClick(enabledRedoCheckpointRestore);
  await client.waitFor(
    `document.querySelector('[role="alertdialog"]')?.textContent.includes('redo 1 review action') &&
      document.querySelector('[data-review-history-impact]')?.textContent.includes('1 net disk transition') &&
      document.querySelector('[data-review-history-impact]')?.textContent.includes('Update') &&
      document.querySelector('[data-review-history-impact]')?.textContent.includes('src/review-history.ts') &&
      document.querySelector('[data-review-history-disk-transition="update"]')?.textContent.includes('+12') &&
      document.querySelector('[data-review-history-disk-transition="update"]')?.textContent.includes('-12')`,
    'Redo checkpoint confirmation'
  );
  await client.domClick(restoreConfirm);
  await client.waitFor(
    `document.body?.innerText.includes('12 rejected') &&
      document.querySelector('button[aria-label^="Review history: 2 undo, 0 redo"]')`,
    'durable forward history restore'
  );
  await waitForDiskLines(fixture.changedFile, 'before-0', 'before-1');

  // Return to the seeded state so the existing single-action recovery matrix remains independent.
  await client.domClick(enabledButtonWithText('Undo'));
  await client.waitFor(`document.body?.innerText.includes('12 accepted')`, 'first cleanup Undo');
  await waitForDiskLines(fixture.changedFile, 'after-0', 'after-1');
  await client.domClick(enabledButtonWithText('Undo'));
  await client.waitFor(`document.body?.innerText.includes('12 pending')`, 'second cleanup Undo');
  await waitForDiskLines(fixture.changedFile, 'after-0', 'after-1');
  await ensureHistoryClosed('closed history after cleanup Undo');

  // dev:mcp adds Vite reload/focus timing that is unrelated to the hunk-hover controls.
  // Keep this mode focused on durable Restore and divergent-branch recovery; the
  // production-preview path below continues to exercise guarded process-close recovery.
  if (devMcpMode) {
    await client.waitFor(
      `Boolean(document.querySelector('button[aria-label*="; saved"]'))`,
      'settled history before final dev restart'
    );
    const persistenceBeforeHydration = await readPersistedReviewScope(fixture);
    const decisionsBeforeHydration = await waitForStableReviewDecisions(
      persistenceBeforeHydration,
      'Durable history did not settle before hydration'
    );

    await restartApp(port, fixture);
    await openReview();
    await client.waitFor(
      `document.body?.innerText.includes('12 pending') &&
        document.querySelector('button[aria-label^="Review history: 0 undo, 2 redo"]')`,
      'restored start checkpoint after final dev restart'
    );
    await assertDiskLines(fixture.changedFile, 'after-0', 'after-1');
    await assertViewportFits();

    const persistenceScope = await readPersistedReviewScope(fixture);
    await client.waitFor(
      `Boolean(document.querySelector('button[aria-label*="; saved"]'))`,
      'hydrated history persistence acknowledgement'
    );
    const decisionsAfterHydration = await waitForStableReviewDecisions(
      persistenceScope,
      'Hydrated history revision did not settle'
    );
    const persistenceAfterHydration = await readPersistedReviewScope(fixture);
    assert.equal(
      decisionsAfterHydration.revision,
      decisionsBeforeHydration.revision,
      'Passive history hydration must not advance the durable revision'
    );
    assert.equal(
      persistenceAfterHydration.raw,
      persistenceBeforeHydration.raw,
      'Passive history hydration must not rewrite the durable payload'
    );
    assert.equal(
      persistenceAfterHydration.mtimeNs,
      persistenceBeforeHydration.mtimeNs,
      'Passive history hydration must not touch the durable file'
    );
    const reviewCloseButton = `Array.from(document.querySelectorAll('h2'))
      .find((heading) => heading.textContent?.startsWith('Changes for task #'))
      ?.parentElement?.parentElement?.querySelector('button')`;
    await client.domClick(reviewCloseButton);
    await client.waitFor(
      `!Array.from(document.querySelectorAll('h2'))
        .some((heading) => heading.textContent?.startsWith('Changes for task #'))`,
      'closed review before conflict-test reset'
    );
    const restoredStart = await waitForStableReviewDecisions(
      persistenceScope,
      'Closed durable history revision did not settle'
    );
    const cleared = await invokeReviewApi('clearDecisions', [
      fixture.teamName,
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      restoredStart.revision,
    ]);
    assert.equal(cleared.revision, restoredStart.revision + 1, 'Exact clear must advance revision');

    await reloadRenderer();
    await openReview();
    await client.waitFor(
      `document.body?.innerText.includes('12 pending') &&
        !document.body?.innerText.includes('A conflicting recovery branch is safe on disk')`,
      'empty conflict-test base revision'
    );

    await performFirstHunkAction(visibleAcceptHunkButton, 'conflict branch hunk Accept');
    await client.waitFor(
      `document.body?.innerText.includes('11 pending') &&
        document.body?.innerText.includes('1 accepted')`,
      'one-hunk recovery branch'
    );
    const recoveryBranch = await waitForReviewDecisions(
      persistenceScope,
      (snapshot) =>
        snapshot.revision > cleared.revision &&
        snapshot.reviewActionHistory.length === 1 &&
        Object.values(snapshot.hunkDecisions).includes('accepted'),
      'one-hunk branch was not persisted'
    );

    await client.domClick(enabledButtonWithText('Undo'));
    await client.waitFor(`document.body?.innerText.includes('12 pending')`, 'conflict branch Undo');
    const conflictBase = await waitForReviewDecisions(
      persistenceScope,
      (snapshot) =>
        snapshot.revision > recoveryBranch.revision &&
        snapshot.reviewActionHistory.length === 0 &&
        snapshot.reviewRedoHistory.length === 1,
      'conflict base Undo was not persisted'
    );

    await client.domClick(enabledButtonWithText('Accept All'));
    await client.waitFor(`document.body?.innerText.includes('12 accepted')`, 'current branch');
    const currentBranch = await waitForReviewDecisions(
      persistenceScope,
      (snapshot) =>
        snapshot.revision > conflictBase.revision &&
        snapshot.reviewActionHistory.length === 1 &&
        snapshot.reviewRedoHistory.length === 0 &&
        Object.values(snapshot.fileDecisions).includes('accepted'),
      'current Accept All branch was not persisted'
    );

    const staleSave = await client.evaluate(`(async () => {
      try {
        const value = await window.electronAPI.review.saveDecisions(...${JSON.stringify([
          fixture.teamName,
          persistenceScope.scopeKey,
          persistenceScope.scopeToken,
          recoveryBranch.hunkDecisions,
          recoveryBranch.fileDecisions,
          recoveryBranch.hunkContextHashesByFile,
          recoveryBranch.reviewActionHistory,
          cleared.revision,
          recoveryBranch.reviewRedoHistory,
        ])});
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    })()`);
    assert.equal(staleSave.ok, false, 'Divergent stale save must not replace the current branch');
    assert.match(
      staleSave.error,
      /revision|changed|stale/i,
      'Expected an explicit stale CAS error'
    );
    const capturedCandidates = await invokeReviewApi('loadDecisionConflictCandidates', [
      fixture.teamName,
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
    ]);
    assert.equal(capturedCandidates.length, 1, 'Losing branch must be durable before reload');
    assert.equal(
      capturedCandidates[0].observedCurrentRevision,
      currentBranch.revision,
      'Recovery choice must bind to the exact visible revision'
    );

    await reloadRenderer();
    await openReview();
    await client.waitFor(
      `document.body?.innerText.includes('A conflicting recovery branch is safe on disk') &&
        document.body?.innerText.includes('12 accepted')`,
      'durable recovery banner after reload'
    );
    await client.waitFor(
      `(${buttonWithText('Undo')})?.disabled === true &&
        (${buttonWithText('Reject')})?.disabled === true`,
      'review actions locked by recovery choice'
    );

    await client.domClick(enabledButtonWithText('Switch to recovery'));
    await client.waitFor(
      `document.body?.innerText.includes('11 pending') &&
        document.body?.innerText.includes('1 accepted') &&
        Boolean(${enabledButtonWithText('Switch to recovery')})`,
      'recovered one-hunk branch and current backup'
    );
    await client.domClick(enabledButtonWithText('Switch to recovery'));
    await client.waitFor(
      `document.body?.innerText.includes('12 accepted') &&
        Boolean(${enabledButtonWithText('Discard recovery branch')})`,
      'reversible switch back to current branch'
    );
    await discardActiveRecoveryBranch('current-branch backup');
    await client.waitFor(
      `!document.body?.innerText.includes('A conflicting recovery branch is safe on disk') &&
        document.body?.innerText.includes('12 accepted') &&
        Boolean(${enabledButtonWithText('Reject')})`,
      'explicit current-branch resolution'
    );

    await reloadRenderer();
    await openReview();
    await client.waitFor(
      `document.body?.innerText.includes('12 accepted') &&
        !document.body?.innerText.includes('A conflicting recovery branch is safe on disk')`,
      'resolved branch after final reload'
    );
    const remainingCandidates = await invokeReviewApi('loadDecisionConflictCandidates', [
      fixture.teamName,
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
    ]);
    assert.equal(remainingCandidates.length, 0, 'Resolved recovery copies must stay cleared');
    await assertDiskLines(fixture.changedFile, 'after-0', 'after-1');
    await assertViewportFits();

    const priorSnapshotSave = await client.evaluate(`(async () => {
      try {
        const value = await window.electronAPI.review.saveDecisions(...${JSON.stringify([
          fixture.teamName,
          persistenceScope.scopeKey,
          persistenceScope.scopeToken,
          recoveryBranch.hunkDecisions,
          recoveryBranch.fileDecisions,
          recoveryBranch.hunkContextHashesByFile,
          recoveryBranch.reviewActionHistory,
          cleared.revision,
          recoveryBranch.reviewRedoHistory,
        ])});
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    })()`);
    assert.equal(
      priorSnapshotSave.ok,
      false,
      'Prior-snapshot fixture must begin as a CAS conflict'
    );
    const [currentSnapshotCandidate] = await invokeReviewApi('loadDecisionConflictCandidates', [
      fixture.teamName,
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
    ]);
    assert.equal(
      currentSnapshotCandidate.origin,
      'current-snapshot',
      'New CAS conflict must first belong to the active snapshot'
    );
    const priorCandidateId = await moveDecisionCandidateToPriorSnapshot(
      fixture,
      persistenceScope,
      currentSnapshotCandidate.id
    );
    const [priorSnapshotCandidate] = await invokeReviewApi('loadDecisionConflictCandidates', [
      fixture.teamName,
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
    ]);
    assert.equal(priorSnapshotCandidate.id, priorCandidateId);
    assert.equal(priorSnapshotCandidate.origin, 'prior-snapshot');
    assert.equal(priorSnapshotCandidate.recoverability, 'different-review-snapshot');

    await restartApp(port, fixture);
    await openReview();
    await client.waitFor(
      `document.body?.innerText.includes('An earlier review snapshot has a saved branch') &&
        (${buttonWithText('Switch to recovery')})?.disabled === true &&
        Boolean(${enabledButtonWithText('Discard recovery branch')})`,
      'prior-snapshot recovery inbox after restart'
    );
    await client.waitFor(
      `(${buttonWithText('Undo')})?.disabled === true &&
        (${buttonWithText('Reject')})?.disabled === true`,
      'prior-snapshot recovery locks review actions'
    );
    await discardActiveRecoveryBranch('prior-snapshot');
    await client.waitFor(
      `!document.body?.innerText.includes('A conflicting recovery branch is safe on disk') &&
        Boolean(${enabledButtonWithText('Reject')})`,
      'prior-snapshot recovery dismissed explicitly'
    );
    await restartApp(port, fixture);
    await openReview();
    await client.waitFor(
      `document.body?.innerText.includes('12 accepted') &&
        !document.body?.innerText.includes('A conflicting recovery branch is safe on disk')`,
      'prior-snapshot discard persisted after restart'
    );

    const beforeLostResponse = await readPersistedReviewScope(fixture);
    await performActionWithBlockedResponse(
      enabledButtonWithText('Reject'),
      'lost-response file Reject'
    );
    await waitForPersistedRevisionAfter(
      fixture,
      beforeLostResponse.revision,
      'Main process did not durably commit the blocked-response Reject'
    );
    await killAppImmediately();
    await startApp(port, fixture);
    await openReview();
    await client.waitFor(
      `document.body?.innerText.includes('12 rejected') &&
        Boolean(${enabledButtonWithText('Undo')})`,
      'lost-response file Reject recovered after SIGKILL'
    );
    await waitForDiskLines(fixture.changedFile, 'before-0', 'before-1');
    await client.domClick(enabledButtonWithText('Undo'));
    await client.waitFor(
      `document.body?.innerText.includes('12 accepted')`,
      'lost-response file Reject Undo'
    );
    await waitForDiskLines(fixture.changedFile, 'after-0', 'after-1');

    process.stdout.write(
      `Changes desktop E2E passed (dev:mcp${singleWindowMode ? ', single-window' : ''}): ` +
        'Accept All -> Reject file -> Restore back -> hydrate -> Restore forward -> ' +
        'Undo to start -> hydrate -> stale branch -> reload -> reversible recovery -> ' +
        'Discard backup -> reload -> prior snapshot -> discard -> reload -> ' +
        'blocked response -> SIGKILL -> exact Undo\n'
    );
    return;
  }

  await performFirstHunkAction(visibleRejectHunkButton, 'hunk Reject');
  await client.waitFor(`document.body?.innerText.includes('11 pending')`, 'one rejected hunk');
  await waitForDiskLines(fixture.changedFile, 'before-0', 'after-1');

  await client.waitFor(enabledButtonWithText('Undo'), 'enabled Undo after Reject');
  await client.domClick(enabledButtonWithText('Undo'));
  await client.waitFor(`document.body?.innerText.includes('12 pending')`, 'Undo result');
  await waitForDiskLines(fixture.changedFile, 'after-0', 'after-1');
  await client.waitFor(enabledButtonWithText('Redo'), 'enabled Redo after Undo');

  await client.domClick(enabledButtonWithText('Redo'));
  await client.waitFor(`document.body?.innerText.includes('11 pending')`, 'Redo result');
  await waitForDiskLines(fixture.changedFile, 'before-0', 'after-1');

  await restartApp(port, fixture);
  await openReview();
  await client.waitFor(
    `document.body?.innerText.includes('#E2E-101')`,
    'stable task display id before history'
  );
  await client.waitFor(enabledButtonWithText('Undo'), 'enabled durable Undo after restart');
  await assertDiskLines(fixture.changedFile, 'before-0', 'after-1');
  await ensureHistoryOpen('durable review history');
  await client.waitFor(
    `document.body?.innerText.includes('Review action history') &&
      document.body?.innerText.includes('Reject hunk') &&
      document.body?.innerText.includes('src/review-history.ts · hunk 1') &&
      document.body?.textContent.includes('Next undo')`,
    'exact durable action preview after restart'
  );
  await client.waitFor(
    `Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]'))
      .some((wrapper) => {
        const rect = wrapper.getBoundingClientRect();
        return wrapper.textContent?.includes('Review action history') &&
          rect.width > 0 && rect.height > 0 &&
          wrapper.getAnimations().every((animation) =>
            animation.playState === 'finished' || animation.playState === 'idle');
      })`,
    'settled review history animation'
  );
  await client.screenshot(historyScreenshot);
  await client.click(enabledButtonWithText('Undo'));
  await client.waitFor(enabledButtonWithText('Redo'), 'enabled durable Redo after restart Undo');
  await waitForDiskLines(fixture.changedFile, 'after-0', 'after-1');

  const externallyEdited = (await readFile(fixture.changedFile, 'utf8')).replace(
    "export const reviewed_0 = 'after-0';",
    "export const reviewed_0 = 'external-0';"
  );
  await writeFile(fixture.changedFile, externallyEdited, 'utf8');
  await client.waitFor(
    `document.body?.innerText.includes('Changed on disk') && ${buttonWithText('Reload from disk')}`,
    'visible external change conflict'
  );
  assert.equal(await client.evaluate(`Boolean(${buttonWithText('Redo')}?.disabled)`), true);
  assert.equal(await client.evaluate(`Boolean(${buttonWithText('Keep my draft')})`), false);
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');
  await client.screenshot(conflictScreenshot);

  await client.waitFor(
    enabledButtonWithText('Reload from disk'),
    'enabled Reload after durable history settles'
  );
  await client.domClick(enabledButtonWithText('Reload from disk'));
  await client.waitFor(
    `!document.body?.innerText.includes('Changed on disk') &&
      !(${buttonWithText('Redo')}) && !(${historyButton})`,
    'resolved external change conflict'
  );
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');
  await assertViewportFits();

  await restartApp(port, fixture);
  await openReview();
  assert.equal(await client.evaluate(`Boolean(${buttonWithText('Redo')})`), false);
  assert.equal(
    await client.evaluate(`document.body?.innerText.includes('Changed on disk')`),
    false
  );
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');
  await assertViewportFits();
  await client.waitFor(
    `document.body?.innerText.includes('#E2E-101')`,
    'stable task display id after restart'
  );
  await client.screenshot(finalScreenshot);

  await performFirstHunkAction(visibleAcceptHunkButton, 'hunk Accept');
  await client.waitFor(`document.body?.innerText.includes('11 pending')`, 'one accepted hunk');
  await client.waitFor(
    `document.querySelector('button[aria-label^="Review history:"][aria-label$="; saved"]')`,
    'immediately durable accepted action'
  );
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');

  await killAppImmediately();
  await startApp(port, fixture);
  await openReview();
  await client.waitFor(enabledButtonWithText('Undo'), 'durable accepted Undo after forced restart');
  await ensureHistoryOpen('accepted review history after forced restart');
  await client.waitFor(
    `document.body?.innerText.includes('Accept hunk') &&
      document.body?.innerText.includes('src/review-history.ts · hunk 1') &&
      document.querySelector('[data-review-history-persistence="saved"]')`,
    'exact accepted action after forced restart'
  );
  await client.screenshot(acceptedHistoryScreenshot);
  await client.click(enabledButtonWithText('Undo'));
  await client.waitFor(`document.body?.innerText.includes('12 pending')`, 'accepted Undo result');
  await client.waitFor(enabledButtonWithText('Redo'), 'accepted Redo after forced restart Undo');
  await client.waitFor(
    `document.querySelector('button[aria-label^="Review history:"][aria-label$="; saved"]')`,
    'saved accepted Undo before closing history'
  );
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');
  await ensureHistoryClosed('closed accepted history before the guarded-close action');

  await performFirstHunkAction(visibleAcceptHunkButton, 'hunk Accept');
  await client.waitFor(`document.body?.innerText.includes('11 pending')`, 'accepted before close');
  await client.evaluate(`void window.electronAPI?.windowControls?.close()`);
  await waitForAppExit();

  await startApp(port, fixture);
  await openReview();
  await client.waitFor(enabledButtonWithText('Undo'), 'accepted Undo after guarded app close');
  await client.waitFor(
    `document.body?.innerText.includes('11 pending') &&
      document.querySelector('button[aria-label^="Review history:"][aria-label$="; saved"]')`,
    'accepted history after guarded app close'
  );
  await client.domClick(enabledButtonWithText('Undo'));
  await client.waitFor(
    `document.body?.innerText.includes('12 pending')`,
    'guarded close Undo result'
  );
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');

  process.stdout.write(
    `Changes desktop E2E passed (${devMcpMode ? 'dev:mcp' : 'preview'}): ` +
      `Accept All -> Reject file -> Restore back -> restart -> Restore forward -> ` +
      `exact disk/history -> ` +
      `Reject -> Undo -> Redo -> restart -> exact history -> external conflict -> Reload -> ` +
      `restart -> Accept -> durable ack -> SIGKILL -> restart -> exact Undo -> ` +
      `Accept -> guarded app close -> restart -> exact Undo\n` +
      `Artifacts: ${historyScreenshot}, ${conflictScreenshot}, ${finalScreenshot}, ` +
      `${acceptedHistoryScreenshot}\n`
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Changes desktop E2E failed: ${error.stack ?? error}\n`);
  if (client) {
    const diagnostics = await client
      .evaluate(
        `({
        url: location.href,
        title: document.title,
        bodyTail: document.body?.innerText.slice(-3000) ?? '',
        hunkToolbars: Array.from(document.querySelectorAll('[data-review-floating-toolbar="true"]'))
          .map((toolbar) => ({
            text: toolbar.textContent,
            display: getComputedStyle(toolbar).display,
            rect: toolbar.getBoundingClientRect().toJSON(),
          })),
      })`
      )
      .catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
    process.stderr.write(`Renderer diagnostics:\n${JSON.stringify(diagnostics, null, 2)}\n`);
  }
  if (appLogTail.length > 0) {
    process.stderr.write(`Electron log tail:\n${appLogTail.join('\n')}\n`);
  }
  process.exitCode = 1;
} finally {
  await stopApp();
  if (!keepFixture && process.exitCode !== 1) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
