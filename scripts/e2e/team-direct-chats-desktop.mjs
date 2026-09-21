#!/usr/bin/env node
// Isolated pnpm dev:mcp visual E2E for Messages chat list + 1:1 thread.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CdpClient } from './comment-notification/cdp.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const shotDir = path.join(os.tmpdir(), 'team-direct-chats-e2e-shots');
const appLogTail = [];
const appLogRemainder = { stdout: '', stderr: '' };
const keepApp = process.env.TEAM_DIRECT_CHATS_E2E_KEEP_APP === '1';
const attachPort = Number(process.env.TEAM_DIRECT_CHATS_E2E_ATTACH_PORT ?? 0);
const ownsFixture = attachPort === 0;
let appProcess = null;
let appProcessGroupId = null;
let cdp = null;

async function clickPoint(client, expression, label) {
  const point = await client.evaluate(`(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert(point, `missing click target: ${label}`);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
}

async function pressKey(client, key, code = key) {
  const escape = key === 'Escape';
  const keyCode = escape ? 27 : undefined;
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

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

function member(name, agentType, role, teamName, projectPath, color) {
  return {
    name,
    agentId: `${name}@${teamName}`,
    agentType,
    role,
    providerId: 'opencode',
    providerBackendId: 'opencode-cli',
    model: 'test-model',
    color,
    cwd: projectPath,
    joinedAt: Date.now(),
    subscriptions: [],
  };
}

async function seedFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'team-direct-chats-e2e-')));
  const fixtureNow = Date.now();
  const runtimeLock = JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
  const fixture = {
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
    teamName: `chats-e2e-${randomUUID()}`,
    runtimeWrapperPath: path.join(root, 'fixture-runtime-deny.cjs'),
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
      `const args = process.argv.slice(2);\n` +
      `if (args.length === 1 && args[0] === '--version') {\n` +
      `  process.stdout.write(${JSON.stringify(`${runtimeLock.version}\n`)});\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `process.stderr.write('fixture runtime denies all lifecycle and provider commands\\n');\n` +
      `process.exit(77);\n`
  );
  await chmod(fixture.runtimeWrapperPath, 0o755);
  await writeFile(path.join(fixture.projectPath, 'README.md'), '# Disposable chats E2E\n');
  const oscar = member('oscar', 'team-lead', 'Lead', fixture.teamName, fixture.projectPath, 'blue');
  const alice = member(
    'alice',
    'developer',
    'Developer',
    fixture.teamName,
    fixture.projectPath,
    'green'
  );
  oscar.joinedAt = fixtureNow - 600_000;
  alice.joinedAt = fixtureNow - 600_000;
  const teamDir = path.join(fixture.claudeRoot, 'teams', fixture.teamName);
  await json(path.join(fixture.claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  await json(path.join(teamDir, 'config.json'), {
    name: fixture.teamName,
    description: 'Disposable chats E2E fixture',
    color: 'blue',
    language: 'en',
    createdAt: fixtureNow - 600_000,
    leadAgentId: oscar.agentId,
    members: [oscar, alice],
    projectPath: fixture.projectPath,
    projectPathHistory: [fixture.projectPath],
  });
  await json(path.join(teamDir, 'members.meta.json'), { version: 1, members: [oscar, alice] });
  await json(path.join(teamDir, 'team.meta.json'), {
    version: 1,
    cwd: fixture.projectPath,
    providerId: 'opencode',
    model: 'test-model',
    prompt: 'Renderer fixture only. Never launch any provider.',
    createdAt: fixtureNow - 600_000,
  });
  await mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
  const directHistory = Array.from({ length: 64 }, (_, index) => {
    const sequence = index + 1;
    const fromAlice = sequence % 2 === 0;
    return {
      from: fromAlice ? 'alice' : 'user',
      to: fromAlice ? 'user' : 'alice',
      text: `Messenger history ${String(sequence).padStart(2, '0')}`,
      timestamp: new Date(fixtureNow - (180_000 - sequence * 1_000)).toISOString(),
      messageId: `dm-history-${String(sequence).padStart(2, '0')}`,
      read: sequence < 62,
      source: fromAlice ? 'inbox' : 'user_sent',
    };
  });
  await json(path.join(teamDir, 'inboxes', 'user.json'), [
    ...directHistory.filter((message) => message.from === 'alice'),
    {
      from: 'alice',
      to: 'user',
      text: 'Need you to review the chat list',
      timestamp: new Date(fixtureNow - 60_000).toISOString(),
      messageId: 'dm-alice-user',
      read: false,
      source: 'inbox',
    },
  ]);
  await json(path.join(teamDir, 'inboxes', 'alice.json'), [
    ...directHistory.filter((message) => message.from === 'user'),
    {
      from: 'user',
      to: 'alice',
      text: 'Opening a 1:1 with you',
      timestamp: new Date(fixtureNow - 120_000).toISOString(),
      messageId: 'dm-user-alice',
      read: true,
      source: 'user_sent',
    },
  ]);
  await mkdir(path.join(fixture.claudeRoot, 'projects'), { recursive: true });
  await mkdir(path.join(fixture.claudeRoot, 'tasks', fixture.teamName), { recursive: true });
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
  appProcess = spawn('pnpm', ['dev:mcp'], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
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
    },
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
      await cdp.close();
    } catch {
      // already gone
    }
    cdp = null;
  }
  if (keepApp) {
    process.stdout.write(
      `Leaving isolated dev:mcp running (PID ${appProcessGroupId}, fixture ${fixture.root})\n`
    );
    return;
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
  if (ownsFixture && fixture?.root && process.env.TEAM_DIRECT_CHATS_E2E_KEEP !== '1') {
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const fixture = attachPort
    ? {
        root: process.env.TEAM_DIRECT_CHATS_E2E_FIXTURE_ROOT,
        claudeRoot: path.join(process.env.TEAM_DIRECT_CHATS_E2E_FIXTURE_ROOT, '.claude'),
        projectPath: process.env.TEAM_DIRECT_CHATS_E2E_PROJECT_PATH,
        teamName: process.env.TEAM_DIRECT_CHATS_E2E_TEAM_NAME,
      }
    : await seedFixture();
  if (!fixture.root || !fixture.projectPath || !fixture.teamName) {
    throw new Error('Attach mode requires fixture root, project path, and team name');
  }
  if (attachPort) {
    const userInboxPath = path.join(fixture.claudeRoot, 'teams', fixture.teamName, 'inboxes', 'user.json');
    const userInbox = JSON.parse(await readFile(userInboxPath, 'utf8'));
    const resetInbox = userInbox.filter((message) => message.messageId !== 'dm-live-append');
    if (resetInbox.length !== userInbox.length) await json(userInboxPath, resetInbox);
  }
  await mkdir(shotDir, { recursive: true });
  let failure = null;
  try {
    const { port, renderer } = attachPort
      ? { port: attachPort, renderer: await waitForRenderer(attachPort) }
      : await startApp(fixture);
    process.stdout.write(`Using isolated dev:mcp CDP port ${port}\n`);
    cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    if (attachPort) await cdp.send('Page.reload', { ignoreCache: true });
    // Keep renderer lifecycle deterministic without stealing macOS focus from the user.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await cdp.waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'native API and dev store',
      60_000
    );
    await cdp.waitFor(
      `(() => { const state = window.__agentTeamsDevStore?.getState(); return Boolean(
        state?.paneLayout?.focusedPaneId && !state?.teamsLoading &&
        state?.teams?.some((team) => team.teamName === ${JSON.stringify(fixture.teamName)})); })()`,
      'hydrated fixture team',
      60_000
    );
    await cdp.evaluate(`window.__agentTeamsDevStore.getState().openTeamsTab()`);
    await cdp.waitFor(
      `Boolean(Array.from(document.querySelectorAll('[role="button"]')).find((element) =>
        element.querySelector('h3')?.textContent?.trim() === ${JSON.stringify(fixture.teamName)}))`,
      'fixture team card',
      60_000
    );
    await cdp.evaluate(
      `window.__agentTeamsDevStore.getState().openTeamTab(${JSON.stringify(
        fixture.teamName
      )}, ${JSON.stringify(fixture.projectPath)})`
    );
    await cdp.waitFor(
      `(() => {
        const state = window.__agentTeamsDevStore?.getState();
        const pane = state?.paneLayout?.panes?.find((candidate) =>
          candidate.id === state.paneLayout.focusedPaneId);
        const tab = pane?.tabs?.find((candidate) => candidate.id === pane.activeTabId);
        return tab?.type === 'team' && tab.teamName === ${JSON.stringify(fixture.teamName)};
      })()`,
      'opened fixture team tab',
      60_000
    );
    await cdp.waitFor(
      `(() => {
        const data = window.__agentTeamsDevStore?.getState()?.selectedTeamData;
        return data?.teamName === ${JSON.stringify(fixture.teamName)} &&
          Boolean(data?.members?.some((member) => member.name === 'alice'));
      })()`,
      'loaded fixture team data',
      60_000
    );
    await cdp.evaluate(`window.__agentTeamsDevStore.getState().setMessagesPanelMode('sidebar')`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label') === 'Back to chats')?.click()`);
    await cdp.waitFor(
      `Boolean(Array.from(document.querySelectorAll('button')).find((button) =>
        (button.getAttribute('aria-label') ?? '').includes('Group chat')))`,
      'chat list Group chat row',
      60_000
    );
    if (!attachPort) {
      await clickPoint(
        cdp,
        `Array.from(document.querySelectorAll('button')).find((button) =>
          button.getAttribute('aria-label') === 'Message panel actions')`,
        'Message panel actions initial normalization'
      );
      const initialSortEnabled = await cdp.evaluate(
        `Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((item) =>
          item.textContent?.includes('Sort by new messages'))?.getAttribute('aria-checked') === 'true'`
      );
      if (initialSortEnabled) {
        await clickPoint(
          cdp,
          `Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((item) =>
            item.textContent?.includes('Sort by new messages'))`,
          'disable persisted chat sorting'
        );
      }
      await pressKey(cdp, 'Escape', 'Escape');
      await cdp.waitFor(
        `!Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).some((item) =>
          item.textContent?.includes('Sort by new messages'))`,
        'initial message panel actions closed',
        10_000
      );
    }
    const listUi = await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('button[aria-label]')).map((button) => ({
        label: button.getAttribute('aria-label') ?? '',
        preview: button.innerText,
      }));
      return {
        body: (document.body?.innerText ?? '').slice(0, 1200),
        rows: rows.filter((row) =>
          row.label.includes('Group chat') || row.label.includes('alice') || row.label.includes('oscar')
        ),
      };
    })()`);
    assert(
      listUi.rows.some((row) => row.label.includes('Group chat')),
      `missing Group chat row: ${JSON.stringify(listUi.rows)}`
    );
    assert(
      listUi.rows.some((row) => row.label.includes('alice')),
      `missing alice row: ${JSON.stringify(listUi.rows)}`
    );
    assert(
      listUi.rows.some((row) => row.label.includes('oscar')),
      `missing oscar row: ${JSON.stringify(listUi.rows)}`
    );
    const aliceRow = listUi.rows.find((row) => row.label.includes('alice'));
    assert.match(aliceRow.label, /unread/);
    assert.match(aliceRow.preview, /Need you to review the chat list/);
    if (!attachPort) {
      const rosterOrder =
        await cdp.evaluate(`(() => Array.from(document.querySelectorAll('button[aria-label]'))
        .map((button) => button.getAttribute('aria-label') ?? '')
        .filter((label) => label.includes('Group chat') || label.includes('alice') || label.includes('oscar'))
        .map((label) => label.split(',')[0]))()`);
      assert.deepEqual(rosterOrder, ['Group chat', 'oscar', 'alice']);
      await clickPoint(
        cdp,
        `Array.from(document.querySelectorAll('button')).find((button) =>
          button.getAttribute('aria-label') === 'Message panel actions')`,
        'Message panel actions'
      );
      await cdp.waitFor(
        `Boolean(Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((item) =>
          item.textContent?.includes('Sort by new messages')))`,
        'sort chats checkbox',
        10_000
      );
      const sortItem = await cdp.evaluate(`(() => {
        const item = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((entry) =>
          entry.textContent?.includes('Sort by new messages'));
        return { checked: item?.getAttribute('aria-checked') ?? null };
      })()`);
      assert.equal(sortItem.checked, 'false');
      await cdp.screenshot(path.join(shotDir, 'sort-menu.png'));
      await clickPoint(
        cdp,
        `Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((item) =>
          item.textContent?.includes('Sort by new messages'))`,
        'Sort by new messages'
      );
      await cdp.waitFor(
        `Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((item) =>
          item.textContent?.includes('Sort by new messages'))?.getAttribute('aria-checked') === 'true'`,
        'sort chats checkbox checked',
        10_000
      );
      await pressKey(cdp, 'Escape', 'Escape');
    }
    await cdp.screenshot(path.join(shotDir, 'chat-list.png'));
    await clickPoint(
      cdp,
      `Array.from(document.querySelectorAll('button')).find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('alice,'))`,
      'alice chat row'
    );
    await cdp.waitFor(
      `Boolean(Array.from(document.querySelectorAll('button')).find((button) =>
        button.getAttribute('aria-label') === 'Back to chats'))`,
      'thread back button',
      30_000
    );
    await cdp.waitFor(
      `(document.body?.innerText ?? '').includes('Need you to review the chat list')`,
      'alice thread message',
      90_000
    );
    const threadUi = await cdp.evaluate(`(() => {
      const body = document.body?.innerText ?? '';
      return {
        hasBack: Boolean(Array.from(document.querySelectorAll('button')).find((button) =>
          button.getAttribute('aria-label') === 'Back to chats')),
        hasComposer: Boolean(document.querySelector('textarea')),
        hasLockedAlice: Boolean(document.querySelector('.message-composer-target-selectors')?.textContent?.includes('alice')),
        hasPicker: Boolean(document.querySelector('.message-composer-target-selectors button')),
        recipientArrows: document.querySelectorAll('.lucide-move-right').length,
        hasDm: body.includes('Need you to review the chat list'),
        titleHasAlice: body.includes('alice'),
      };
    })()`);
    assert.equal(threadUi.hasBack, true);
    await clickPoint(
      cdp,
      `Array.from(document.querySelectorAll('button')).find((button) =>
        button.getAttribute('aria-label') === 'Message panel actions')`,
      'Message panel actions in thread'
    );
    await cdp.waitFor(
      `Boolean(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
        item.textContent?.includes('Collapse all') || item.textContent?.includes('Expand all')))`,
      'thread utility menu',
      10_000
    );
    const threadMenuHasSort = await cdp.evaluate(
      `Boolean(Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((item) =>
        item.textContent?.includes('Sort by new messages')))`
    );
    assert.equal(threadMenuHasSort, false);
    await pressKey(cdp, 'Escape', 'Escape');
    assert.equal(threadUi.hasComposer, true);
    assert.equal(threadUi.hasLockedAlice, true);
    assert.equal(threadUi.hasPicker, false);
    assert.equal(threadUi.recipientArrows, 0);
    assert.equal(threadUi.hasDm, true);
    await cdp.waitFor(
      `(() => {
        const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
        return scroll instanceof HTMLElement &&
          Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) <= 2;
      })()`,
      'conversation opens at latest message',
      15_000
    );
    const initialMessengerLayout = await cdp.evaluate(`(() => {
      const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
      const footer = document.querySelector('[data-messages-thread-footer="true"]');
      const rows = Array.from(document.querySelectorAll('[data-timeline-row-key]'));
      const text = rows.map((row) => row.textContent ?? '');
      const history62 = text.findIndex((value) => value.includes('Messenger history 62'));
      const history64 = text.findIndex((value) => value.includes('Messenger history 64'));
      const latest = text.findIndex((value) => value.includes('Need you to review the chat list'));
      return {
        footerOutsideScroll: footer instanceof HTMLElement &&
          scroll instanceof HTMLElement && !scroll.contains(footer),
        historyBeforeLatest: history62 >= 0 && history64 > history62 && latest > history64,
        virtualized: rows.some((row) => row.hasAttribute('data-index')),
      };
    })()`);
    assert.deepEqual(initialMessengerLayout, {
      footerOutsideScroll: true,
      historyBeforeLatest: true,
      virtualized: false,
    });

    const revealedRemainingHistory = await cdp.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.trim() === 'Show all' ||
        /^Show \\d+ more$/.test(candidate.textContent?.trim() ?? ''));
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert.equal(revealedRemainingHistory, true, 'missing remaining history control');
    await cdp.waitFor(
      `Boolean(document.querySelector('[data-timeline-row-key][data-index]'))`,
      'virtualized conversation history',
      15_000
    );
    await cdp.evaluate(`(() => {
      const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
      if (!(scroll instanceof HTMLElement)) return false;
      scroll.scrollTop = Math.max(0, Math.round((scroll.scrollHeight - scroll.clientHeight) * 0.45));
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`);
    await cdp.waitFor(
      `(() => {
        const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
        if (!(scroll instanceof HTMLElement)) return false;
        const scrollRect = scroll.getBoundingClientRect();
        const row = Array.from(document.querySelectorAll('[data-timeline-row-key]')).find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > scrollRect.top + 1 && rect.top < scrollRect.bottom - 1;
        });
        if (!(row instanceof HTMLElement)) return false;
        window.__teamChatE2eReadingAnchor = {
          key: row.dataset.timelineRowKey,
          top: row.getBoundingClientRect().top - scrollRect.top,
        };
        return Boolean(window.__teamChatE2eReadingAnchor.key);
      })()`,
      'reading anchor captured',
      10_000
    );
    await cdp.evaluate(`(() => {
      const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
      if (!(scroll instanceof HTMLElement)) return false;
      // The first synthetic event advances the virtual range. Re-emit once
      // its DOM window has settled so the viewport owner captures that range,
      // matching the follow-up events produced by an actual user scroll.
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      const scrollRect = scroll.getBoundingClientRect();
      const row = Array.from(document.querySelectorAll('[data-timeline-row-key]')).find(
        (candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > scrollRect.top + 1 && rect.top < scrollRect.bottom - 1;
        }
      );
      if (!(row instanceof HTMLElement)) return false;
      window.__teamChatE2eReadingAnchor = {
        key: row.dataset.timelineRowKey,
        top: row.getBoundingClientRect().top - scrollRect.top,
      };
      return Boolean(window.__teamChatE2eReadingAnchor.key);
    })()`);
    const userInboxPath = path.join(
      fixture.claudeRoot,
      'teams',
      fixture.teamName,
      'inboxes',
      'user.json'
    );
    const userInbox = JSON.parse(await readFile(userInboxPath, 'utf8'));
    userInbox.push({
      from: 'alice',
      to: 'user',
      text: 'Messenger live append',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      messageId: 'dm-live-append',
      read: false,
      source: 'inbox',
    });
    await json(userInboxPath, userInbox);
    await cdp.waitFor(
      `window.__agentTeamsDevStore.getState()
        .teamMessagesByName[${JSON.stringify(fixture.teamName)}]
        ?.canonicalMessages?.some((message) => message.messageId === 'dm-live-append') === true`,
      'live append loaded into the canonical feed',
      30_000
    );
    await cdp.waitFor(
      `(() => {
        const anchor = window.__teamChatE2eReadingAnchor;
        const row = anchor?.key
          ? document.querySelector('[data-timeline-row-key="' + CSS.escape(anchor.key) + '"]')
          : null;
        const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
        return row instanceof HTMLElement &&
          scroll instanceof HTMLElement &&
          Math.abs(
            row.getBoundingClientRect().top - scroll.getBoundingClientRect().top -
              Math.max(anchor.top, -Math.max(0, row.getBoundingClientRect().height - 4))
          ) <= 2 &&
          Boolean(document.querySelector('[data-conversation-latest="true"]'));
      })()`,
      'reading anchor preserved after live append',
      30_000
    );
    await clickPoint(
      cdp,
      `document.querySelector('[data-conversation-latest="true"]')`,
      'To latest'
    );
    await cdp.waitFor(
      `(() => {
        const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
        return scroll instanceof HTMLElement &&
          Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) <= 2 &&
          !document.querySelector('[data-conversation-latest="true"]');
      })()`,
      'returned to latest message',
      15_000
    );
    await cdp.screenshot(path.join(shotDir, 'direct-thread.png'));

    const composerState = await cdp.evaluate(`(() => {
      const container = document.querySelector('[data-messages-thread-container="true"]');
      const textarea = container?.querySelector('textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) return null;
      textarea.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(textarea, 'Unsent full-screen draft');
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: textarea.value,
      }));
      textarea.setSelectionRange(7, 18);
      window.__teamChatE2eComposer = textarea;
      window.__teamChatE2eScroll = container.querySelector('[data-messages-thread-scroll]') ??
        Array.from(container.querySelectorAll('div')).find((element) =>
          getComputedStyle(element).overflowY === 'auto');
      return {
        focused: document.activeElement === textarea,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
    })()`);
    assert.deepEqual(composerState, { focused: true, start: 7, end: 18 });

    const toggleFullScreen = async (expected, label, expectedFocus = 'switch') => {
      const toggled = await cdp.evaluate(`(() => {
        const toggle = document.querySelector('[role="switch"][aria-label="Full Screen"]');
        if (!(toggle instanceof HTMLElement)) return false;
        toggle.focus();
        toggle.click();
        return true;
      })()`);
      assert.equal(toggled, true, `missing Full Screen switch: ${label}`);
      await cdp.waitFor(
        `(() => {
          const toggle = document.querySelector('[role="switch"][aria-label="Full Screen"]');
          const focusMatches = ${JSON.stringify(expectedFocus)} === 'composer'
            ? document.activeElement instanceof HTMLTextAreaElement &&
              document.querySelector('[data-messages-thread-slot="main"]')?.contains(document.activeElement)
            : document.activeElement === toggle;
          return toggle?.getAttribute('aria-checked') === ${JSON.stringify(String(expected))} && focusMatches;
        })()`,
        `Full Screen ${expected ? 'ON' : 'OFF'}: ${label}`,
        10_000
      );
    };

    await toggleFullScreen(true, 'alice thread initial expansion');
    const expandedUi = await cdp.evaluate(`(() => {
      const composer = window.__teamChatE2eComposer;
      const scroll = window.__teamChatE2eScroll;
      const main = document.querySelector('[data-messages-thread-slot="main"]');
      const content = main?.previousElementSibling;
      const alice = Array.from(document.querySelectorAll('button[aria-label]')).find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('alice,'));
      return {
        sameComposer: composer instanceof HTMLTextAreaElement && main?.contains(composer),
        sameScroll: scroll instanceof HTMLElement && main?.contains(scroll),
        draft: composer instanceof HTMLTextAreaElement ? composer.value : null,
        start: composer instanceof HTMLTextAreaElement ? composer.selectionStart : null,
        end: composer instanceof HTMLTextAreaElement ? composer.selectionEnd : null,
        selectedAlice: alice?.getAttribute('aria-current') ?? null,
        groupVisible: Boolean(Array.from(document.querySelectorAll('button[aria-label]')).find((button) =>
          (button.getAttribute('aria-label') ?? '').includes('Group chat'))),
        contentInert: content?.hasAttribute('inert') ?? false,
        contentHidden: content?.getAttribute('aria-hidden') ?? null,
        liveContainers: document.querySelectorAll('[data-messages-thread-container="true"]').length,
        terminalLauncherVisible: Boolean(
          document.querySelector('[data-testid="open-terminal-floating-button"]')
        ),
      };
    })()`);
    assert.deepEqual(expandedUi, {
      sameComposer: true,
      sameScroll: true,
      draft: 'Unsent full-screen draft',
      start: 7,
      end: 18,
      selectedAlice: 'true',
      groupVisible: true,
      contentInert: true,
      contentHidden: 'true',
      liveContainers: 1,
      terminalLauncherVisible: false,
    });
    await cdp.screenshot(path.join(shotDir, 'direct-thread-full-screen.png'));

    for (let index = 0; index < 10; index += 1) {
      await toggleFullScreen(index % 2 === 1, `identity cycle ${index + 1}`);
    }
    await toggleFullScreen(false, 'return live thread to sidebar');
    const repeatedToggleState = await cdp.evaluate(`(() => {
      const composer = window.__teamChatE2eComposer;
      const scroll = window.__teamChatE2eScroll;
      const sidebar = document.querySelector('[data-messages-thread-slot="sidebar"]');
      return {
        sameComposer: composer instanceof HTMLTextAreaElement && sidebar?.contains(composer),
        sameScroll: scroll instanceof HTMLElement && sidebar?.contains(scroll),
        draft: composer instanceof HTMLTextAreaElement ? composer.value : null,
        start: composer instanceof HTMLTextAreaElement ? composer.selectionStart : null,
        end: composer instanceof HTMLTextAreaElement ? composer.selectionEnd : null,
        liveContainers: document.querySelectorAll('[data-messages-thread-container="true"]').length,
      };
    })()`);
    assert.deepEqual(repeatedToggleState, {
      sameComposer: true,
      sameScroll: true,
      draft: 'Unsent full-screen draft',
      start: 7,
      end: 18,
      liveContainers: 1,
    });

    const mentionPrepared = await cdp.evaluate(`(() => {
      const textarea = window.__teamChatE2eComposer;
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      textarea.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(textarea, '@a');
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: textarea.value,
      }));
      textarea.setSelectionRange(2, 2);
      textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
      return true;
    })()`);
    assert.equal(mentionPrepared, true);
    await cdp.waitFor(
      `(() => {
        const popup = document.querySelector('[data-mention-suggestions="above"]');
        const textarea = window.__teamChatE2eComposer;
        if (!(popup instanceof HTMLElement) || !(textarea instanceof HTMLElement)) return false;
        const popupRect = popup.getBoundingClientRect();
        const textareaRect = textarea.getBoundingClientRect();
        return popupRect.bottom <= textareaRect.top + 2 && popupRect.top >= 0;
      })()`,
      'mention suggestions above footer',
      10_000
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const mentionGeometry = await cdp.evaluate(`(() => {
      const popup = document.querySelector('[data-mention-suggestions="above"]');
      const textarea = window.__teamChatE2eComposer;
      const footer = document.querySelector('[data-messages-thread-footer="true"]');
      if (!(popup instanceof HTMLElement) || !(textarea instanceof HTMLElement)) return null;
      const popupRect = popup.getBoundingClientRect();
      const textareaRect = textarea.getBoundingClientRect();
      return {
        aboveTextarea: popupRect.bottom <= textareaRect.top + 2,
        notClippedByFooter: !(footer instanceof HTMLElement) || !footer.contains(popup),
        inViewport: popupRect.top >= 0 && popupRect.bottom <= innerHeight,
      };
    })()`);
    assert.deepEqual(mentionGeometry, {
      aboveTextarea: true,
      notClippedByFooter: true,
      inViewport: true,
    });
    await cdp.screenshot(path.join(shotDir, 'mention-suggestions-above.png'));
    await pressKey(cdp, 'Escape', 'Escape');
    await cdp.evaluate(`(() => {
      const textarea = window.__teamChatE2eComposer;
      if (!(textarea instanceof HTMLTextAreaElement)) return;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(textarea, 'Unsent full-screen draft');
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: textarea.value,
      }));
      textarea.setSelectionRange(7, 18);
    })()`);

    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label') === 'Back to chats')?.click()`);
    await cdp.waitFor(
      `Boolean(Array.from(document.querySelectorAll('button')).find((button) =>
        (button.getAttribute('aria-label') ?? '').includes('Group chat')))`,
      'returned to chat list',
      15_000
    );
    await toggleFullScreen(true, 'list opens Group chat', 'composer');
    await cdp.waitFor(
      `(() => {
        const main = document.querySelector('[data-messages-thread-slot="main"]');
        const selected = Array.from(document.querySelectorAll('button[aria-current="true"]'));
        return main?.querySelector('[data-messages-thread-container="true"]') &&
          selected.some((button) => (button.getAttribute('aria-label') ?? '').includes('Group chat'));
      })()`,
      'expanded Group chat selected from list',
      15_000
    );
    await cdp.screenshot(path.join(shotDir, 'group-chat-full-screen.png'));
    await toggleFullScreen(false, 'leave full screen for bottom sheet');
    await cdp.evaluate(`window.__agentTeamsDevStore.getState().setMessagesPanelMode('bottom-sheet')`);
    await cdp.waitFor(
      `Boolean(document.querySelector('button[aria-label="Message bottom sheet actions"]')) &&
        Boolean(document.querySelector('[data-messages-thread-footer="true"]'))`,
      'bottom sheet messenger thread',
      15_000
    );
    await cdp.waitFor(
      `(() => {
        const footer = document.querySelector('[data-messages-thread-footer="true"]');
        return footer instanceof HTMLElement && footer.getBoundingClientRect().bottom <= innerHeight + 1;
      })()`,
      'bottom sheet footer layout',
      10_000
    );
    const bottomSheetGeometry = await cdp.evaluate(`(() => {
      const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
      const footer = document.querySelector('[data-messages-thread-footer="true"]');
      if (!(scroll instanceof HTMLElement) || !(footer instanceof HTMLElement)) return null;
      const scrollRect = scroll.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      return {
        footerOutsideScroll: !scroll.contains(footer),
        noOverlap: scrollRect.bottom <= footerRect.top + 1,
        footerReachable: footerRect.top < innerHeight && footerRect.bottom <= innerHeight + 1,
        oneOuterScrollOwner: document.querySelectorAll('[data-messages-thread-scroll="true"]').length,
        terminalLauncherVisible: Boolean(
          document.querySelector('[data-testid="open-terminal-floating-button"]')
        ),
      };
    })()`);
    assert.deepEqual(bottomSheetGeometry, {
      footerOutsideScroll: true,
      noOverlap: true,
      footerReachable: true,
      oneOuterScrollOwner: 1,
      terminalLauncherVisible: false,
    });
    await cdp.screenshot(path.join(shotDir, 'group-chat-bottom-sheet.png'));
    await clickPoint(
      cdp,
      `document.querySelector('button[aria-label="Message bottom sheet actions"]')`,
      'Message bottom sheet actions'
    );
    await clickPoint(
      cdp,
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
        item.textContent?.includes('Collapse sheet'))`,
      'Collapse sheet'
    );
    await cdp.waitFor(
      `!document.querySelector('[data-messages-thread-container="true"]')`,
      'bottom sheet header-only collapse',
      10_000
    );
    await clickPoint(
      cdp,
      `document.querySelector('button[aria-label="Message bottom sheet actions"]')`,
      'Message bottom sheet actions collapsed'
    );
    await clickPoint(
      cdp,
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
        item.textContent?.includes('Expand sheet'))`,
      'Expand sheet'
    );
    await cdp.waitFor(
      `(() => {
        const scroll = document.querySelector('[data-messages-thread-scroll="true"]');
        return scroll instanceof HTMLElement &&
          Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) <= 2;
      })()`,
      'bottom sheet reopens at latest',
      15_000
    );
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          teamName: fixture.teamName,
          shots: shotDir,
          appPid: appProcessGroupId,
          fixtureRoot: fixture.root,
          cdpPort: port,
          keptOpen: keepApp,
        },
        null,
        2
      ) + '\n'
    );
  } catch (error) {
    failure = error;
    try {
      const snapshot = await cdp?.evaluate(`(() => {
        const state = window.__agentTeamsDevStore?.getState?.();
        return {
          selectedTeamName: state?.selectedTeamName,
          teams: (state?.teams ?? []).map((team) => team.teamName),
          members: (state?.selectedTeamData?.members ?? []).map((member) => member.name),
          messagesMode: state?.messagesPanelMode,
          body: (document.body?.innerText ?? '').slice(0, 1200),
        };
      })()`);
      process.stderr.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } catch (dumpError) {
      process.stderr.write(`dump failed: ${String(dumpError)}\n`);
    }
    try {
      await cdp?.screenshot(path.join(shotDir, 'failure.png'));
    } catch {
      // ignore
    }
  } finally {
    await cleanup(fixture);
  }
  if (failure) throw failure;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.stderr.write(`${appLogTail.slice(-40).join('\n')}\n`);
  process.exitCode = 1;
});
