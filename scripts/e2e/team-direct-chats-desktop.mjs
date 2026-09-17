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
let appProcess = null;
let appProcessGroupId = null;
let cdp = null;

async function clickPoint(client, expression, label) {
  const clicked = await client.evaluate(`(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX,
      clientY,
      view: window,
    };
    element.focus();
    element.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0, buttons: 1 }));
    element.dispatchEvent(new PointerEvent('pointerup', { ...base, button: 0, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX, clientY, view: window }));
    return true;
  })()`);
  assert.equal(clicked, true, `missing click target: ${label}`);
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
  const alice = member('alice', 'developer', 'Developer', fixture.teamName, fixture.projectPath, 'green');
  const teamDir = path.join(fixture.claudeRoot, 'teams', fixture.teamName);
  await json(path.join(fixture.claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  await json(path.join(teamDir, 'config.json'), {
    name: fixture.teamName,
    description: 'Disposable chats E2E fixture',
    color: 'blue',
    language: 'en',
    createdAt: Date.now(),
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
    createdAt: Date.now(),
  });
  await mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
  await json(path.join(teamDir, 'inboxes', 'user.json'), [
    {
      from: 'alice',
      to: 'user',
      text: 'Need you to review the chat list',
      timestamp: '2026-09-17T12:00:00.000Z',
      messageId: 'dm-alice-user',
      read: false,
      source: 'inbox',
    },
  ]);
  await json(path.join(teamDir, 'inboxes', 'alice.json'), [
    {
      from: 'user',
      to: 'alice',
      text: 'Opening a 1:1 with you',
      timestamp: '2026-09-17T11:50:00.000Z',
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
    const request = http.get({ host: '127.0.0.1', port, path: '/json/list', agent: false }, (response) => {
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
    });
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
  if (fixture?.root && process.env.TEAM_DIRECT_CHATS_E2E_KEEP !== '1') {
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const fixture = await seedFixture();
  await mkdir(shotDir, { recursive: true });
  let failure = null;
  try {
    const { port, renderer } = await startApp(fixture);
    process.stdout.write(`Using isolated dev:mcp CDP port ${port}\n`);
    cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
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
    await cdp.waitFor(
      `Boolean(Array.from(document.querySelectorAll('button')).find((button) =>
        (button.getAttribute('aria-label') ?? '').includes('This team')))`,
      'chat list This team row',
      60_000
    );
    const listUi = await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('button[aria-label]')).map((button) => ({
        label: button.getAttribute('aria-label') ?? '',
        preview: button.innerText,
      }));
      return {
        body: (document.body?.innerText ?? '').slice(0, 1200),
        rows: rows.filter((row) =>
          row.label.includes('This team') || row.label.includes('alice') || row.label.includes('oscar')
        ),
      };
    })()`);
    assert(
      listUi.rows.some((row) => row.label.includes('This team')),
      `missing This team row: ${JSON.stringify(listUi.rows)}`
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
    const rosterOrder = await cdp.evaluate(`(() => Array.from(document.querySelectorAll('button[aria-label]'))
      .map((button) => button.getAttribute('aria-label') ?? '')
      .filter((label) => label.includes('This team') || label.includes('alice') || label.includes('oscar'))
      .map((label) => label.split(',')[0]))()`);
    assert.deepEqual(rosterOrder, ['This team', 'oscar', 'alice']);
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
      return {
        checked: item?.getAttribute('aria-checked') ?? null,
        text: item?.textContent ?? '',
      };
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
    await cdp.waitFor(
      `(() => {
        const names = Array.from(document.querySelectorAll('button[aria-label]'))
          .map((button) => button.getAttribute('aria-label') ?? '')
          .filter((label) => label.includes('This team') || label.includes('alice') || label.includes('oscar'))
          .map((label) => label.split(',')[0]);
        return names[0] === 'This team' && names[1] === 'alice' && names[2] === 'oscar';
      })()`,
      'attention chat raised after sort',
      10_000
    );
    await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
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
      15_000
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
    await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(threadUi.hasComposer, true);
    assert.equal(threadUi.hasLockedAlice, true);
    assert.equal(threadUi.hasPicker, false);
    assert.equal(threadUi.recipientArrows, 0);
    assert.equal(threadUi.hasDm, true);
    await cdp.screenshot(path.join(shotDir, 'direct-thread.png'));
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label') === 'Back to chats')?.click()`);
    await cdp.waitFor(
      `Boolean(Array.from(document.querySelectorAll('button')).find((button) =>
        (button.getAttribute('aria-label') ?? '').includes('This team')))`,
      'returned to chat list',
      15_000
    );
    process.stdout.write(
      JSON.stringify({ ok: true, teamName: fixture.teamName, shots: shotDir }, null, 2) + '\n'
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
