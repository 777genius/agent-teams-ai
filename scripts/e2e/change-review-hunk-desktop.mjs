#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const keepFixture = process.env.AGENT_TEAMS_CHANGES_E2E_KEEP === '1';
const skipBuild = process.env.AGENT_TEAMS_CHANGES_E2E_SKIP_BUILD === '1';
const selectTeamButton = `Array.from(document.querySelectorAll('button'))
  .find((button) => button.textContent?.trim() === 'Select Team')`;
const sandboxTeamCard = `Array.from(document.querySelectorAll('[role="button"]'))
  .find((element) => element.querySelector('h3')?.textContent?.trim() === 'changes-e2e')`;
const sandboxKanbanTaskCard = `document.querySelector(
  '.kanban-task-card[data-task-id="changes-history-e2e"]'
)`;
const sandboxKanbanTaskTitle = `Array.from((${sandboxKanbanTaskCard})?.querySelectorAll('h5') ?? [])
  .find((heading) => heading.textContent?.trim() === 'Verify durable Changes history')`;
const kanbanTabButton = `Array.from(document.querySelectorAll('button'))
  .find((button) => button.textContent?.trim() === 'Kanban')`;
const visibleElement = (expression) => `(() => {
  const element = (${expression});
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
})()`;
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
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/seed-change-review-e2e.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_TEAMS_CHANGES_E2E_ROOT: fixtureRoot },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Unable to seed Changes fixture: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function waitForCdp(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (appProcess?.exitCode !== null) {
      throw new Error(`Electron exited before CDP became ready (${appProcess.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
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
      // Node keeps runtime discovery deterministic. The E2E never launches agents.
      NODE_BINARY: process.execPath,
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: process.execPath,
    },
  });
  appProcess.stdout.on('data', rememberAppLog);
  appProcess.stderr.on('data', rememberAppLog);
  const webSocketUrl = await waitForCdp(port, devMcpMode ? 90_000 : 45_000);
  client = await CdpClient.connect(webSocketUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Page.bringToFront');
  await client.waitFor(
    `(${sandboxKanbanTaskCard}) || (${selectTeamButton})`,
    'sandbox team navigation'
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

function isProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
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
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP closed'));
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

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
      throw new Error(response.exceptionDetails.exception?.description ?? 'Renderer evaluation failed');
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

  async domMouseDown(expression) {
    const dispatched = await this.evaluate(`(() => {
      const element = (${expression});
      if (!(element instanceof HTMLElement)) return false;
      element.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        view: window,
      }));
      return true;
    })()`);
    assert.equal(dispatched, true, `Element cannot receive mouse down: ${expression}`);
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

async function openReview() {
  await client.evaluate(`(${sandboxKanbanTaskTitle})?.click()`);
  const taskDialog = `Array.from(document.querySelectorAll('[role="dialog"]'))
    .find((dialog) => Array.from(dialog.querySelectorAll('h2'))
      .some((heading) => heading.textContent?.trim() === 'Verify durable Changes history'))`;
  await client.waitFor(taskDialog, 'task dialog');
  const fileRow = `(${taskDialog})?.querySelector(
    '[role="button"][title="src/review-history.ts"]'
  )`;
  const expandChanges = `Array.from((${taskDialog})?.querySelectorAll('section') ?? [])
    .find((section) => Array.from(section.querySelectorAll('span'))
      .some((span) => span.textContent?.trim() === 'Changes'))
    ?.querySelector('button[aria-label="Expand section"]')`;
  await client.waitFor(`(${fileRow}) || (${expandChanges})`, 'Changes section readiness');
  if (!(await client.evaluate(`Boolean(${fileRow})`))) {
    await client.domClick(expandChanges);
    await client.waitFor(fileRow, 'task file change');
  }
  await client.domClick(fileRow);
  await client.waitFor(
    `document.body?.innerText.includes('12 pending') || document.body?.innerText.includes('11 pending')`,
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

  await client.moveTo(`document.querySelector('.cm-changedLine, .cm-insertedLine')`);
  await client.waitFor(`document.querySelector('button[title^="Reject change"]')`, 'hunk Reject');
  await client.domMouseDown(`document.querySelector('button[title^="Reject change"]')`);
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

  await stopApp();
  await startApp(port, fixture);
  await openReview();
  await client.waitFor(
    `document.body?.innerText.includes('#E2E-101')`,
    'stable task display id before history'
  );
  await client.waitFor(enabledButtonWithText('Undo'), 'enabled durable Undo after restart');
  await assertDiskLines(fixture.changedFile, 'before-0', 'after-1');
  const historyButton = `document.querySelector('button[aria-label^="Review history:"]')`;
  await client.waitFor(historyButton, 'durable review history trigger');
  await client.domClick(historyButton);
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
          wrapper.getAnimations({ subtree: true }).every((animation) =>
            animation.playState === 'finished' || animation.playState === 'idle');
      })`,
    'settled review history animation'
  );
  await client.screenshot(historyScreenshot);
  await client.domClick(historyButton);
  await client.waitFor(
    `!document.body?.innerText.includes('Review action history')`,
    'closed review history'
  );

  await client.domClick(enabledButtonWithText('Undo'));
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

  await client.domClick(buttonWithText('Reload from disk'));
  await client.waitFor(
    `!document.body?.innerText.includes('Changed on disk') &&
      !(${buttonWithText('Redo')}) && !(${historyButton})`,
    'resolved external change conflict'
  );
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');
  await assertViewportFits();

  await stopApp();
  await startApp(port, fixture);
  await openReview();
  assert.equal(await client.evaluate(`Boolean(${buttonWithText('Redo')})`), false);
  assert.equal(await client.evaluate(`document.body?.innerText.includes('Changed on disk')`), false);
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');
  await assertViewportFits();
  await client.waitFor(
    `document.body?.innerText.includes('#E2E-101')`,
    'stable task display id after restart'
  );
  await client.screenshot(finalScreenshot);

  await client.moveTo(`document.querySelector('.cm-changedLine, .cm-insertedLine')`);
  await client.waitFor(`document.querySelector('button[title^="Accept change"]')`, 'hunk Accept');
  await client.domMouseDown(`document.querySelector('button[title^="Accept change"]')`);
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
  await client.waitFor(historyButton, 'accepted review history after forced restart');
  await client.domClick(historyButton);
  await client.waitFor(
    `document.body?.innerText.includes('Accept hunk') &&
      document.body?.innerText.includes('src/review-history.ts · hunk 1') &&
      document.querySelector('[data-review-history-persistence="saved"]')`,
    'exact accepted action after forced restart'
  );
  await client.screenshot(acceptedHistoryScreenshot);
  // Escape propagation is already verified above. Toggle the controlled trigger here so
  // this crash-recovery leg stays focused on persistence rather than window focus state.
  await client.domClick(historyButton);
  await client.waitFor(
    `!document.body?.innerText.includes('Review action history')`,
    'closed accepted review history'
  );
  await client.domClick(enabledButtonWithText('Undo'));
  await client.waitFor(`document.body?.innerText.includes('12 pending')`, 'accepted Undo result');
  await client.waitFor(enabledButtonWithText('Redo'), 'accepted Redo after forced restart Undo');
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');

  await client.moveTo(`document.querySelector('.cm-changedLine, .cm-insertedLine')`);
  await client.waitFor(`document.querySelector('button[title^="Accept change"]')`, 'hunk Accept');
  await client.domMouseDown(`document.querySelector('button[title^="Accept change"]')`);
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
  await client.waitFor(`document.body?.innerText.includes('12 pending')`, 'guarded close Undo result');
  await assertDiskLines(fixture.changedFile, 'external-0', 'after-1');

  process.stdout.write(
    `Changes desktop E2E passed (${devMcpMode ? 'dev:mcp' : 'preview'}): ` +
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
      .evaluate(`({
        url: location.href,
        title: document.title,
        bodyTail: document.body?.innerText.slice(-3000) ?? '',
      })`)
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
