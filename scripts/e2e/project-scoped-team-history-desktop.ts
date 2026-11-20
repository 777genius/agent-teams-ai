#!/usr/bin/env -S pnpm exec tsx
/**
 * Real Electron renderer -> preload -> main -> native team-files smoke.
 * Synthetic, disposable data only. No provider process or user project is used.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error The existing shared CDP transport has no TypeScript declaration.
import { CdpClient } from './comment-notification/cdp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const keep = process.env.PROJECT_TEAM_E2E_KEEP === '1';
const logs: string[] = [];
let app: ChildProcess | undefined;
let debuggerPort: number | null = null;
let lastReconnectMs = 0;
let cdp: {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
} | undefined;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function json(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'project-team-desktop-')));
  const claudeRoot = path.join(root, '.claude');
  const userData = path.join(root, 'user-data');
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const projectC = path.join(root, 'project-empty');
  const token = randomUUID().replaceAll('-', '').slice(0, 14);
  const logical = 'history-' + token;
  const nativeA = 'ptc-' + token + '-a';
  const nativeB = 'ptc-' + token + '-b';
  const screenshots = process.env.PROJECT_TEAM_E2E_ARTIFACT_DIR ?? path.join(root, 'screenshots');
  const audit = path.join(root, 'runtime-audit.ndjson');
  const runtimeScript = path.join(root, 'fixture-runtime-deny.cjs');
  const runtimeCommand = process.platform === 'win32'
    ? path.join(root, 'fixture-runtime-deny.cmd')
    : runtimeScript;
  const env = {
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claudeRoot,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'multimodel-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'multimodel-cache'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
  };
  await Promise.all([
    projectA, projectB, projectC, screenshots, ...Object.values(env),
    path.join(claudeRoot, 'projects'),
  ].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(path.join(projectA, 'README.md'), '# Disposable project A\n');
  await writeFile(path.join(projectB, 'README.md'), '# Disposable project B\n');
  const lockedRuntime = JSON.parse(
    await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8')
  ) as { version: string };
  const node = await realpath(process.execPath);
  await writeFile(runtimeScript, [
    '#!' + node,
    "'use strict';",
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args.length === 1 && args[0] === '--version') {",
    '  console.log(' + JSON.stringify(lockedRuntime.version) + '); process.exit(0);',
    '}',
    "if (args.length === 1 && args[0] === '--help') { console.log('Usage: synthetic'); process.exit(0); }",
    'fs.appendFileSync(' + JSON.stringify(audit) + ", JSON.stringify(args) + '\\n');",
    "process.stderr.write('Disposable smoke denies all real agent execution\\n'); process.exit(77);",
  ].join('\n') + '\n');
  if (process.platform === 'win32') {
    await writeFile(runtimeCommand, '@echo off\r\n"' + node + '" "' + runtimeScript + '" %*\r\n');
  } else {
    await chmod(runtimeScript, 0o755);
  }
  await writeFile(audit, '');

  // This is the existing app-profile scope encoding. Never copy real profile
  // markers or credentials from the user's HOME into a test fixture.
  const profileScope = createHash('sha256')
    .update(JSON.stringify([userData, claudeRoot])).digest('hex');
  const owner = {
    schemaVersion: 1, profileScope, claimedAt: new Date().toISOString(), reason: 'create',
  };
  const joinedAt = Date.now() - 60_000;
  const members = (name: string) => [
    {
      name: 'lead', agentId: 'lead@' + name, agentType: 'team-lead',
      role: 'Lead', providerId: 'opencode', providerBackendId: 'opencode-cli',
      model: 'test-model', joinedAt, cwd: projectA,
    },
    {
      name: 'alice', agentId: 'alice@' + name, agentType: 'developer',
      role: 'Developer', providerId: 'opencode', providerBackendId: 'opencode-cli',
      model: 'test-model', joinedAt, cwd: projectA,
    },
  ];
  const rootTeams = path.join(claudeRoot, 'teams');
  const rootTasks = path.join(claudeRoot, 'tasks');
  const logicalDir = path.join(rootTeams, logical);
  await json(path.join(claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  await json(path.join(logicalDir, 'team.meta.json'), {
    version: 1, createdAt: joinedAt, cwd: projectA, displayName: 'History fixture',
    projectContextMode: 'per_project', prompt: 'Disposable fixture only. Do not run providers.',
  });
  await json(path.join(logicalDir, 'members.meta.json'), {
    version: 1, members: members(logical),
  });
  await json(path.join(logicalDir, '.agent-teams-owner.json'), owner);
  await mkdir(path.join(rootTasks, logical), { recursive: true });
  const contexts: {
    id: string; projectKey: string; projectPath: string;
    executionTeamName: string; state: 'ready';
  }[] = [];
  for (const [alias, cwd, subject, message] of [
    [nativeA, projectA, 'PROJECT_A_TASK_ONLY', 'PROJECT_A_CHAT_ONLY'],
    [nativeB, projectB, 'PROJECT_B_TASK_ONLY', 'PROJECT_B_CHAT_ONLY'],
  ]) {
    const teamDir = path.join(rootTeams, alias);
    const ownMembers = members(alias).map((item) => ({ ...item, cwd }));
    await json(path.join(teamDir, 'config.json'), {
      name: alias, createdAt: joinedAt, description: 'Disposable project context',
      leadAgentId: 'lead@' + alias, members: ownMembers, projectPath: cwd,
      projectPathHistory: [cwd], leadSessionId: 'lead-' + alias,
    });
    await json(path.join(teamDir, 'team.meta.json'), {
      version: 1, cwd, createdAt: joinedAt, projectContextMode: 'shared',
    });
    await json(path.join(teamDir, 'members.meta.json'), { version: 1, members: ownMembers });
    await json(path.join(teamDir, '.agent-teams-owner.json'), owner);
    await json(path.join(teamDir, 'inboxes', 'user.json'), [{
      from: 'alice', to: 'user', text: message, timestamp: new Date().toISOString(),
      read: false, messageId: randomUUID(), source: 'inbox',
    }]);
    await json(path.join(rootTasks, alias, '1.json'), {
      id: '1', subject, description: 'Isolation sentinel', owner: 'alice',
      status: 'pending', createdAt: new Date().toISOString(), projectPath: cwd,
    });
    contexts.push({
      id: randomUUID(), projectKey: cwd, projectPath: cwd,
      executionTeamName: alias, state: 'ready',
    });
  }
  const indexPath = path.join(logicalDir, 'project-contexts.json');
  await json(indexPath, { version: 1, logicalTeamName: logical, contexts });
  // Ordinary (shared) teams for cross-team messages: one works in project A, one
  // in a project where the per-project team never ran.
  const partnerA = 'partner-' + token + '-a';
  const partnerC = 'partner-' + token + '-c';
  for (const [partner, cwd] of [[partnerA, projectA], [partnerC, projectC]]) {
    const teamDir = path.join(rootTeams, partner);
    const ownMembers = members(partner).map((item) => ({ ...item, cwd }));
    await json(path.join(teamDir, 'config.json'), {
      name: partner, createdAt: joinedAt, description: 'Disposable cross-team partner',
      leadAgentId: 'lead@' + partner, members: ownMembers, projectPath: cwd,
      projectPathHistory: [cwd],
    });
    await json(path.join(teamDir, 'team.meta.json'), {
      version: 1, cwd, createdAt: joinedAt, projectContextMode: 'shared',
    });
    await json(path.join(teamDir, 'members.meta.json'), { version: 1, members: ownMembers });
    await json(path.join(teamDir, '.agent-teams-owner.json'), owner);
    await mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
    await mkdir(path.join(rootTasks, partner), { recursive: true });
  }
  return {
    root, env, claudeRoot, rootTeams, indexPath, logical,
    nativeA, nativeB, projectA, projectB, projectC, partnerA, partnerC,
    screenshots, audit, runtimeCommand,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function start(f: Fixture): Promise<void> {
  // CI Chromium's SUID helper is not configured setuid/root. Disable the
  // sandbox ONLY for this disposable Electron smoke, never in production.
  // Windows pnpm resolves to pnpm.cmd on Node 22+, requiring cmd.exe.
  app = spawn('pnpm', ['dev:mcp'], {
    cwd: repoRoot, detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, ...f.env,
      NODE_BINARY: await realpath(process.execPath),
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: f.runtimeCommand,
      CLAUDE_TERMINAL_DAEMON_BINARY: f.runtimeCommand,
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
      AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
      ELECTRON_DISABLE_SANDBOX: '1',
      pnpm_config_verify_deps_before_run: 'false',
    },
  });
  app.on('error', (error) => logs.push('launcher error: ' + String(error)));
  for (const stream of [app.stdout, app.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      logs.push(chunk.toString());
      if (logs.length > 300) logs.shift();
    });
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error('Owned Electron exited: ' + app.exitCode);
    const match = logs.join('').match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//);
    if (match) {
      try {
        const targets = await fetch('http://127.0.0.1:' + match[1] + '/json/list')
          .then((r) => r.json()) as {
            type: string; url: string; webSocketDebuggerUrl: string;
          }[];
        const renderer = targets.find(
          (target) => target.type === 'page' && target.url.startsWith('http://localhost:')
        );
        if (renderer) {
          debuggerPort = Number(match[1]);
          cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
          return;
        }
      } catch {
        // Dev server and renderer are not ready yet.
      }
    }
    await pause(120);
  }
  throw new Error('Owned Electron renderer did not appear');
}

/** Electron can replace the inspected DevTools target on renderer reload (macOS).
 * Reconnect to the same disposable application's active renderer, never to
 * another process or an arbitrary page. */
async function reconnectRenderer(): Promise<boolean> {
  if (debuggerPort === null) return false;
  const targets = await fetch('http://127.0.0.1:' + debuggerPort + '/json/list')
    .then((response) => response.json()) as {
      type: string; url: string; webSocketDebuggerUrl: string;
    }[];
  const renderer = targets.find(
    (target) => target.type === 'page' && target.url.startsWith('http://localhost:')
  );
  if (!renderer) return false;
  const next = await CdpClient.connect(renderer.webSocketDebuggerUrl);
  const old = cdp;
  cdp = next;
  if (old && old !== next) void old.close().catch(() => undefined);
  return true;
}

function visibleTask(alias: string, task: string): string {
  const selector = JSON.stringify('[data-team-name="' + alias + '"]');
  // Team tabs remain mounted. The grid also mounts actual cards with opacity-0
  // behind a temporary skeleton overlay. Neither hidden tabs nor invisible
  // task text prove that the user can see a project-specific Kanban card.
  return 'Array.from(document.querySelectorAll(' + selector + ')).some(' +
    'pane => pane.getClientRects().length > 0 && ' +
    'Array.from(pane.querySelectorAll(".kanban-task-card")).some(card => ' +
    'card.getClientRects().length > 0 && !card.closest(".opacity-0") && ' +
    'getComputedStyle(card).visibility !== "hidden" && ' +
    'card.textContent?.includes(' + JSON.stringify(task) + ')))';
}

function hasVisibleTeam(alias: string): string {
  return 'Array.from(document.querySelectorAll(' +
    JSON.stringify('[data-team-name="' + alias + '"]') +
    ')).some(node => node.getClientRects().length > 0)';
}

async function waitFor(expression: string, label: string, timeoutMs = 45_000) {
  assert(cdp);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate('(async () => Boolean(await (' + expression + ')))()')) return;
    } catch (error) {
      const message = String(error);
      const lostTarget = /inspected target navigated or closed|CDP connection closed|target closed|WebSocket is not open/i.test(message);
      const transientContext = /execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(message);
      if (!lostTarget && !transientContext) throw error;
      if (lostTarget && Date.now() - lastReconnectMs > 500) {
        lastReconnectMs = Date.now();
        await reconnectRenderer().catch(() => false);
      }
    }
    await pause(75);
  }
  throw new Error('Timed out: ' + label);
}

async function selectProject(f: Fixture, id: 'project-a' | 'project-b' | 'project-empty') {
  assert(cdp);
  const projects = [
    { id: 'project-a', name: 'A', path: f.projectA, sessions: [], createdAt: 1 },
    { id: 'project-b', name: 'B', path: f.projectB, sessions: [], createdAt: 1 },
    { id: 'project-empty', name: 'Empty', path: f.projectC, sessions: [], createdAt: 1 },
  ];
  // The renderer may reload between startup and navigation on CI. Poll
  // the actual state change until the live dev-store bridge is available.
  await waitFor('(() => { const store = window.__agentTeamsDevStore;' +
    'if (!store || typeof store.setState !== "function") return false;' +
    'store.setState(' + JSON.stringify({
      projects, selectedRepositoryId: null, selectedWorktreeId: null,
      selectedProjectId: id, activeProjectId: id,
    }) + '); return true; })()', 'select project ' + id, 60_000);
}

async function verifyNative(f: Fixture) {
  assert(cdp);
  const input = JSON.stringify(f);
  const state = await cdp.evaluate('(async () => { const f = ' + input + ';' +
    'const teams = await window.electronAPI.teams.list();' +
    'const a = await window.electronAPI.teams.getProjectContextView(f.logical, f.projectA);' +
    'const b = await window.electronAPI.teams.getProjectContextView(f.logical, f.projectB);' +
    'const empty = await window.electronAPI.teams.getProjectContextView(f.logical, f.projectC);' +
    'const aa = await window.electronAPI.teams.getData(f.nativeA);' +
    'const bb = await window.electronAPI.teams.getData(f.nativeB);' +
    'const ma = await window.electronAPI.teams.getMessagesPage(f.nativeA, { limit: 100 });' +
    'const mb = await window.electronAPI.teams.getMessagesPage(f.nativeB, { limit: 100 });' +
    'return {' +
      'teamNames: teams.map(x => x.teamName),' +
      'a, b, empty,' +
      'taskA: aa.tasks.map(t => t.subject), taskB: bb.tasks.map(t => t.subject),' +
      'messagesA: ma.messages.map(m => m.text), messagesB: mb.messages.map(m => m.text)' +
    '}; })()') as {
    teamNames: string[];
    a: { state: string; executionTeamName?: string };
    b: { state: string; executionTeamName?: string };
    empty: { state: string };
    taskA: string[]; taskB: string[]; messagesA: string[]; messagesB: string[];
  };
  assert(state.teamNames.includes(f.logical), 'Logical team absent from renderer team list');
  assert(!state.teamNames.includes(f.nativeA) && !state.teamNames.includes(f.nativeB),
    'Verified owned aliases leaked into visible team list');
  assert.equal(state.a.state, 'ready', `Project A native view: ${JSON.stringify(state.a)}`);
  assert.equal(state.a.executionTeamName, f.nativeA);
  assert.equal(state.b.state, 'ready', `Project B native view: ${JSON.stringify(state.b)}`);
  assert.equal(state.b.executionTeamName, f.nativeB);
  assert.equal(state.empty.state, 'empty');
  assert(state.taskA.includes('PROJECT_A_TASK_ONLY') && !state.taskA.includes('PROJECT_B_TASK_ONLY'));
  assert(state.taskB.includes('PROJECT_B_TASK_ONLY') && !state.taskB.includes('PROJECT_A_TASK_ONLY'));
  assert(state.messagesA.includes('PROJECT_A_CHAT_ONLY') && !state.messagesA.includes('PROJECT_B_CHAT_ONLY'));
  assert(state.messagesB.includes('PROJECT_B_CHAT_ONLY') && !state.messagesB.includes('PROJECT_A_CHAT_ONLY'));
}

async function verifyUi(f: Fixture) {
  assert(cdp);
  await selectProject(f, 'project-a');
  await waitFor('(() => { const store = window.__agentTeamsDevStore;' +
    'if (!store?.getState) return false; const s = store.getState();' +
    'if (!s.openTeamTab || !s.setMessagesPanelMode) return false;' +
    's.openTeamTab(' + JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectA) +
    '); s.setMessagesPanelMode("sidebar"); return true; })()', 'open project team tab', 60_000);

  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'), 'A task through UI');
  const friendlyHeading = await cdp.evaluate('(() => document.querySelector(' +
    JSON.stringify('[data-team-name="' + f.nativeA + '"] h2') +
    ')?.textContent?.trim() === "History fixture")()');
  assert.equal(friendlyHeading, true, 'Project runtime alias leaked as the visible team title');
  assert.equal(await cdp.evaluate(hasVisibleTeam(f.nativeB)), false);
  await cdp.screenshot(path.join(f.screenshots, 'history-a.png'));

  await selectProject(f, 'project-b');
  await waitFor(visibleTask(f.nativeB, 'PROJECT_B_TASK_ONLY'), 'B task through UI');
  assert.equal(await cdp.evaluate(hasVisibleTeam(f.nativeA)), false);
  await cdp.screenshot(path.join(f.screenshots, 'history-b.png'));

  await selectProject(f, 'project-a');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'), 'restored A task through UI');

  try {
    await cdp.send('Page.reload');
  } catch (error) {
    // macOS may replace the inspected renderer target as Page.reload executes.
    // The following waitFor() reconnects to the new target before asserting UI.
    if (!/inspected target navigated or closed|CDP connection closed|target closed/i.test(String(error))) {
      throw error;
    }
  }
  await waitFor('window.electronAPI?.teams && window.__agentTeamsDevStore', 'renderer after reload', 60_000);
  await waitFor('(async () => Boolean((await window.electronAPI.startup.getStatus()).ready))()', 'app after reload', 60_000);
  await selectProject(f, 'project-a');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectA) + '))()');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'), 'A history after reload');
  await verifyNative(f);
  await cdp.screenshot(path.join(f.screenshots, 'history-after-reload.png'));
}

async function verifyAliasRedirect(f: Fixture) {
  assert(cdp);
  const view = await cdp.evaluate('(async () => {' +
    'const f = ' + JSON.stringify(f) + ';' +
    'return window.electronAPI.teams.getProjectContextView(f.nativeA, f.projectA);' +
    '})()') as { mode: string; state: string; logicalTeamName?: string; projectPath?: string };
  assert.deepEqual(view, {
    mode: 'per_project', state: 'redirect',
    logicalTeamName: f.logical, projectPath: f.projectA,
  }, 'A verified project alias must resolve to its logical team and project');

  // Open via the original physical task identity, as global task deep links do,
  // while another project is selected: it must land on the logical team tab.
  await selectProject(f, 'project-b');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.nativeA) + '))()');
  await waitFor('(() => { const s = window.__agentTeamsDevStore.getState();' +
    'const tab = s.getAllPaneTabs().find((t) => t.id === s.activeTabId);' +
    'return tab?.teamName === ' + JSON.stringify(f.logical) + '; })()',
    'alias deep link redirected to the logical team tab');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'),
    'project A task after the alias redirect');
  assert.equal(await cdp.evaluate(hasVisibleTeam(f.nativeB)), false,
    'Project B leaked into the redirected project A history');
  await cdp.screenshot(path.join(f.screenshots, 'history-alias-redirect.png'));
}


async function readJsonFile<T = Record<string, unknown>>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function waitForJson<T = Record<string, unknown>>(
  file: string,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    try {
      last = await readJsonFile<T>(file);
      if (predicate(last)) return last;
    } catch {
      // The file is being replaced atomically; read again.
    }
    await pause(100);
  }
  throw new Error('Timed out: ' + label + ' (last: ' + JSON.stringify(last)?.slice(0, 400) + ')');
}

async function ipcOutcome(expression: string): Promise<{ ok: boolean; error?: string }> {
  assert(cdp);
  return await cdp.evaluate('(async () => { try { await (' + expression + '); return { ok: true }; }' +
    ' catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; } })()') as {
    ok: boolean; error?: string;
  };
}

async function clickSelector(selector: string, label: string) {
  assert(cdp);
  await waitFor('(() => { const el = document.querySelector(' + JSON.stringify(selector) + ');' +
    'return Boolean(el) && !el.disabled; })()', label);
  await cdp.evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
}

async function setField(selector: string, value: string) {
  assert(cdp);
  await waitFor('Boolean(document.querySelector(' + JSON.stringify(selector) + '))',
    'field ' + selector);
  await cdp.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + ');' +
    'const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;' +
    'Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ' + JSON.stringify(value) + ');' +
    'el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
}

async function clickDialogSave() {
  assert(cdp);
  const save = '(() => Array.from(document.querySelectorAll("[role=dialog] button"))' +
    '.find((b) => b.textContent?.trim() === "Save"))()';
  await waitFor('(() => { const b = ' + save + '; return Boolean(b) && !b.disabled; })()',
    'Save button enabled');
  await cdp.evaluate('(() => { const b = ' + save + '; b.click(); return true; })()');
}

async function openEditDialog(f: Fixture) {
  assert(cdp);
  await selectProject(f, 'project-a');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectA) + '))()');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'), 'project A open for editing');
  await clickSelector('button[aria-label="Edit team"]', 'the Edit team pencil of a per-project team');
  await waitFor('Boolean(document.querySelector("#edit-team-name"))', 'Edit team dialog');
}

/**
 * A per-project team is one team: the real Edit Team dialog edits its logical
 * definition (the single source of truth); the project copies are refreshed
 * from it and their tasks, inboxes and history stay untouched; editing is
 * refused while a project context is not stopped; a project copy is never
 * edited directly.
 */
async function verifyDefinitionEdit(f: Fixture) {
  assert(cdp);
  const logicalDir = path.join(f.rootTeams, f.logical);
  const aliasFile = (alias: string, name: string) => path.join(f.rootTeams, alias, name);
  const history = async () => JSON.stringify([
    await readJsonFile(path.join(f.claudeRoot, 'tasks', f.nativeA, '1.json')),
    await readJsonFile(path.join(f.claudeRoot, 'tasks', f.nativeB, '1.json')),
    await readJsonFile(aliasFile(f.nativeA, path.join('inboxes', 'user.json'))),
    await readJsonFile(aliasFile(f.nativeB, path.join('inboxes', 'user.json'))),
  ]);
  const historyBefore = await history();
  const indexBefore = await readFile(f.indexPath, 'utf8');
  const activeNames = (file: { members?: { name: string; removedAt?: number }[] }) =>
    (file.members ?? []).filter((member) => !member.removedAt).map((member) => member.name);

  // 1. The same editor as before, opened from the per-project team screen.
  await openEditDialog(f);
  assert.equal(await cdp.evaluate('document.querySelector("#edit-team-name").value'),
    'History fixture', 'The dialog must show the saved team definition');
  await cdp.screenshot(path.join(f.screenshots, 'edit-dialog.png'));
  await setField('#edit-team-name', 'History fixture edited');
  await setField('#edit-team-description', 'Edited through the real dialog');
  await clickSelector('[role=dialog] button[title="orange"]', 'orange color choice');
  // Saved lead instructions are part of the same definition and the same dialog.
  const leadPrompt = 'Lead instructions edited through the real dialog';
  await waitFor('Boolean(document.querySelector("#edit-team-lead-prompt"))',
    'lead instructions field in the dialog of a per-project team');
  await setField('#edit-team-lead-prompt', leadPrompt);
  await cdp.screenshot(path.join(f.screenshots, 'edit-dialog-lead-prompt.png'));
  await clickDialogSave();
  await waitFor('!document.querySelector("#edit-team-name")', 'Edit team dialog closed after save');

  const logicalMeta = await waitForJson<Record<string, unknown>>(
    path.join(logicalDir, 'team.meta.json'),
    (meta) => meta.displayName === 'History fixture edited' && meta.prompt === leadPrompt,
    'logical team metadata and lead instructions saved'
  );
  assert.equal(logicalMeta.description, 'Edited through the real dialog');
  assert.equal(logicalMeta.prompt, leadPrompt);
  assert.equal(logicalMeta.color, 'orange');
  assert.equal(logicalMeta.projectContextMode, 'per_project');
  const logicalConfigExists = await readFile(path.join(logicalDir, 'config.json'), 'utf8')
    .then(() => true, () => false);
  assert.equal(logicalConfigExists, false,
    'The logical definition must stay config-less (no second source of truth)');
  // The stopped project copies are projections of it.
  for (const alias of [f.nativeA, f.nativeB]) {
    await waitForJson<Record<string, unknown>>(
      aliasFile(alias, 'config.json'),
      (config) => config.description === 'Edited through the real dialog' && config.color === 'orange' &&
        config.name === 'History fixture edited',
      'project copy ' + alias + ' shows the edited name, description and color'
    );
    // The lead instructions are projected into the stopped copy's saved launch settings,
    // never into its config.json.
    await waitForJson<Record<string, unknown>>(
      aliasFile(alias, 'team.meta.json'),
      (meta) => meta.prompt === leadPrompt,
      'project copy ' + alias + ' carries the edited lead instructions'
    );
    assert.equal(
      (await readJsonFile<Record<string, unknown>>(aliasFile(alias, 'config.json'))).prompt,
      undefined,
      'Lead instructions must not leak into config.json of ' + alias
    );
  }
  // Reopening the dialog shows the saved instructions from the definition.
  await openEditDialog(f);
  assert.equal(await cdp.evaluate('document.querySelector("#edit-team-lead-prompt").value'), leadPrompt,
    'The dialog must show the saved lead instructions after reopening');
  await cdp.evaluate('(() => Array.from(document.querySelectorAll("[role=dialog] button"))' +
    '.find((b) => b.textContent?.trim() === "Cancel")?.click())()');
  await waitFor('!document.querySelector("#edit-team-name")', 'dialog closed after the check');
  await waitFor('document.querySelector(' + JSON.stringify('[data-team-name="' + f.nativeA + '"] h2') +
    ')?.textContent?.trim() === "History fixture edited"', 'edited team name visible on the screen');
  await cdp.screenshot(path.join(f.screenshots, 'edit-after-metadata.png'));

  // 2. Roster: add a teammate through the real Add member dialog of the team screen, see it
  // in the logical definition and in every project copy.
  await selectProject(f, 'project-a');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectA) + '))()');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'), 'project A open for adding a member');
  await clickSelector('button[aria-label="Add"]', 'Add member button of a per-project team');
  await setField('[role=dialog] input[placeholder="member-name"]', 'carol');
  const dialogText = await cdp.evaluate('document.querySelector("[role=dialog]").innerText') as string;
  assert(dialogText.includes('History fixture edited') && !dialogText.includes('ptc-'),
    'The Add member dialog must name the team, not its project copy: ' + dialogText.slice(0, 200));
  await cdp.screenshot(path.join(f.screenshots, 'add-member-dialog.png'));
  const addSubmit = '(() => Array.from(document.querySelectorAll("[role=dialog] button"))' +
    '.find((b) => b.textContent?.trim() === "Add member"))()';
  await waitFor('(() => { const b = ' + addSubmit + '; return Boolean(b) && !b.disabled; })()', 'Add member enabled');
  await cdp.evaluate('(() => { ' + 'const b = ' + addSubmit + '; b.click(); return true; })()');
  await waitFor('!document.querySelector("[role=dialog] input[placeholder=\'member-name\']")',
    'Add member dialog closed after save');
  const logicalMembers = await waitForJson<{ members: { name: string; removedAt?: number }[] }>(
    path.join(logicalDir, 'members.meta.json'),
    (file) => activeNames(file).includes('carol'),
    'carol in the logical roster'
  );
  assert(activeNames(logicalMembers).includes('alice'));
  for (const alias of [f.nativeA, f.nativeB]) {
    await waitForJson<{ members: { name: string; removedAt?: number }[] }>(
      aliasFile(alias, 'members.meta.json'),
      (file) => activeNames(file).includes('carol') && activeNames(file).includes('alice'),
      'carol projected into ' + alias
    );
  }

  // 3. Roster through the dialog: it lists the saved definition, the trash button removes carol.
  await openEditDialog(f);
  await clickSelector('[role=dialog] button[aria-label="Remove carol"]', 'remove carol in the dialog');
  await clickDialogSave();
  await waitFor('!document.querySelector("#edit-team-name")', 'Edit team dialog closed after roster save');
  await waitForJson<{ members: { name: string; removedAt?: number }[] }>(
    path.join(logicalDir, 'members.meta.json'),
    (file) => !activeNames(file).includes('carol') && activeNames(file).includes('alice'),
    'carol removed from the logical roster'
  );
  for (const alias of [f.nativeA, f.nativeB]) {
    await waitForJson<{ members: { name: string; removedAt?: number }[] }>(
      aliasFile(alias, 'members.meta.json'),
      (file) => !activeNames(file).includes('carol') && activeNames(file).includes('alice'),
      'carol removal projected into ' + alias
    );
  }
  await cdp.screenshot(path.join(f.screenshots, 'edit-after-roster.png'));

  // 3b. A project without history shows the placeholder screen; the team is still editable there.
  await selectProject(f, 'project-empty');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectC) + '))()');
  await waitFor('document.body.innerText.includes("Not launched in this project yet")',
    'placeholder screen of a project without history');
  const editButton = '(() => Array.from(document.querySelectorAll("button"))' +
    '.find((b) => b.textContent?.trim() === "Edit team"))()';
  await waitFor('Boolean(' + editButton + ')', 'Edit team on the placeholder screen');
  await cdp.evaluate('(() => { const b = ' + editButton + '; b.click(); return true; })()');
  await waitFor('Boolean(document.querySelector("#edit-team-name"))', 'Edit team dialog from the placeholder');
  assert.equal(await cdp.evaluate('document.querySelector("#edit-team-name").value'),
    'History fixture edited', 'The placeholder editor must show the same saved definition');
  await cdp.screenshot(path.join(f.screenshots, 'edit-from-empty-project.png'));
  await cdp.evaluate('(() => Array.from(document.querySelectorAll("[role=dialog] button"))' +
    '.find((b) => b.textContent?.trim() === "Cancel")?.click())()');
  await waitFor('!document.querySelector("#edit-team-name")', 'placeholder editor closed');

  // 4. History is never touched by editing.
  assert.equal(await history(), historyBefore, 'Editing the team mutated project tasks or inboxes');
  assert.equal(await readFile(f.indexPath, 'utf8'), indexBefore,
    'Editing the team mutated the durable context mapping');

  // 5. A project copy is a projection: refused, nothing written.
  const direct = await ipcOutcome('window.electronAPI.teams.updateConfig(' + JSON.stringify(f.nativeA) +
    ', { description: "direct edit" })');
  assert(!direct.ok && /project copy/i.test(direct.error ?? ''),
    'Direct edit of a project copy must be refused: ' + JSON.stringify(direct));
  assert.notEqual((await readJsonFile<Record<string, unknown>>(aliasFile(f.nativeA, 'config.json'))).description,
    'direct edit');

  // 6. Gate: a project that is not stopped/reconciled blocks every edit; nothing is written.
  const blockedContext = {
    id: randomUUID(), projectKey: f.projectC, projectPath: f.projectC,
    executionTeamName: f.nativeA.replace(/-a$/, '-c'), state: 'reserved',
  };
  const index = JSON.parse(indexBefore) as { contexts: unknown[] };
  await writeFile(f.indexPath, JSON.stringify({ ...index, contexts: [...index.contexts, blockedContext] }, null, 2));
  try {
    const blocked = await ipcOutcome('window.electronAPI.teams.updateConfig(' + JSON.stringify(f.logical) +
      ', { description: "must not apply" })');
    assert(!blocked.ok && /prepared|running|launching/i.test(blocked.error ?? ''),
      'Editing while a project is not stopped must be refused: ' + JSON.stringify(blocked));
    const blockedMember = await ipcOutcome('window.electronAPI.teams.addMember(' + JSON.stringify(f.logical) +
      ', { name: "dave" })');
    assert(!blockedMember.ok, 'Adding a member while a project is not stopped must be refused');
    assert.equal((await readJsonFile<Record<string, unknown>>(path.join(logicalDir, 'team.meta.json'))).description,
      'Edited through the real dialog');
    assert(!activeNames(await readJsonFile(path.join(logicalDir, 'members.meta.json'))).includes('dave'));
  } finally {
    await writeFile(f.indexPath, indexBefore);
  }
}

interface StoredSchedule {
  id: string; teamName: string; executionMode?: string; taskFirst?: boolean; cronExpression: string;
  launchConfig: { cwd: string; prompt: string };
}
interface StoredRun {
  id: string; teamName: string; status: string; summary?: string; error?: string;
  linkedTaskId?: string; executionTeamName?: string;
}

/**
 * Schedules belong to the one logical team: created from the real team screen with the project
 * chosen in the dialog, stored once under the logical team, fired against the ready project copy
 * (the fixture runtime denies agents, so the launch is refused by the runtime and recorded), and
 * never creatable for a project copy.
 */
async function verifySchedules(f: Fixture) {
  assert(cdp);
  const schedulesDir = path.join(f.claudeRoot, 'agent-teams-schedules');
  const schedulesFile = path.join(schedulesDir, 'schedules.json');
  const readSchedules = async (): Promise<StoredSchedule[]> =>
    await readJsonFile<StoredSchedule[]>(schedulesFile).catch(() => []);
  assert.deepEqual(await readSchedules(), [], 'The fixture must start without schedules');

  // 1. The section is available on the per-project team screen (it used to say "unavailable").
  await selectProject(f, 'project-a');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectA) + '))()');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'), 'project A open for schedules');
  const section = '[data-team-name="' + f.nativeA + '"] [data-section-id="schedules"]';
  await clickSelector(section + ' > div > button', 'Schedules section header');
  const addSchedule = '(() => Array.from(document.querySelectorAll(' + JSON.stringify(section + ' button') + '))' +
    '.find((b) => b.textContent?.trim() === "Add Schedule"))()';
  await waitFor('Boolean(' + addSchedule + ')', 'Add Schedule button of a per-project team');
  assert.equal(await cdp.evaluate('document.querySelector(' + JSON.stringify(section) + ').innerText.includes("unavailable")'),
    false, 'Schedules must not be reported as unavailable for a per-project team');
  await cdp.screenshot(path.join(f.screenshots, 'schedules-section.png'));

  // 2. Create one through the real dialog; the project is the one shown, set explicitly.
  await cdp.evaluate('(() => { ' + 'const b = ' + addSchedule + '; b.click(); return true; })()');
  await waitFor('Boolean(document.querySelector("#dialog-prompt"))', 'schedule dialog');
  await setField('#dialog-prompt', 'SCHEDULED_PROJECT_A_PROMPT');
  const dialogText = await cdp.evaluate('document.querySelector("[role=dialog]").innerText') as string;
  assert(!dialogText.includes('ptc-'), 'The schedule dialog must name the team, not its copy: ' + dialogText.slice(0, 200));
  await cdp.screenshot(path.join(f.screenshots, 'schedule-dialog.png'));
  const create = '(() => Array.from(document.querySelectorAll("[role=dialog] button"))' +
    '.find((b) => b.textContent?.trim() === "Create Schedule"))()';
  await waitFor('(() => { const b = ' + create + '; return Boolean(b) && !b.disabled; })()', 'Create Schedule enabled', 60_000);
  await cdp.evaluate('(() => { ' + 'const b = ' + create + '; b.click(); return true; })()');
  // The team keeps a one-time launch prompt: scheduling asks to review it once, like for any team.
  await clickSelector('#schedule-saved-prompt-reviewed', 'saved prompt review checkbox');
  await waitFor('document.querySelector("#schedule-saved-prompt-reviewed")?.getAttribute("data-state") === "checked"',
    'saved prompt review confirmed');
  await cdp.evaluate('(() => { ' + 'const b = ' + create + '; b.click(); return true; })()');
  await waitFor('!document.querySelector("#dialog-prompt")', 'schedule dialog closed after create');

  const created = (await waitForJson<StoredSchedule[]>(
    schedulesFile, (list) => list.length === 1, 'the schedule is stored'
  ))[0];
  assert.equal(created.teamName, f.logical, 'The schedule must be stored under the logical team');
  assert.equal(created.launchConfig.cwd, f.projectA, 'The schedule must keep the project it was made for');
  assert.equal(created.launchConfig.prompt, 'SCHEDULED_PROJECT_A_PROMPT');
  await waitFor('document.querySelector(' + JSON.stringify(section) + ').innerText.includes("project-a")',
    'the project of the schedule is shown in the list');
  await cdp.screenshot(path.join(f.screenshots, 'schedules-created.png'));

  // 3. The same single list is shown from the other project, and says which project each is for.
  await selectProject(f, 'project-b');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectB) + '))()');
  await waitFor(visibleTask(f.nativeB, 'PROJECT_B_TASK_ONLY'), 'project B open for schedules');
  const sectionB = '[data-team-name="' + f.nativeB + '"] [data-section-id="schedules"]';
  const openedB = await cdp.evaluate('Boolean(document.querySelector(' + JSON.stringify(sectionB + ' [aria-label=\"Run now\"]') + '))');
  if (!openedB) await clickSelector(sectionB + ' > div > button', 'Schedules section header of project B');
  await waitFor('document.querySelector(' + JSON.stringify(sectionB) + ').innerText.includes("project-a")',
    'the schedule made for project A is listed under the same team in project B');

  // 4. A project copy is never a schedule target; nothing is stored for it.
  const forCopy = await ipcOutcome('window.electronAPI.schedules.create(' + JSON.stringify({
    teamName: f.nativeA, executionMode: 'agent', taskFirst: true, cronExpression: '0 9 * * 1-5',
    timezone: 'UTC', launchConfig: { cwd: f.projectA, prompt: 'copy', providerId: 'opencode' },
  }) + ')');
  assert(!forCopy.ok && /project copy|belong to the team/i.test(forCopy.error ?? ''),
    'A schedule for a project copy must be refused: ' + JSON.stringify(forCopy));
  assert.equal((await readSchedules()).length, 1, 'A refused schedule must not be stored');

  // The project of a schedule is fixed: moving it to another project is refused by the server too.
  const moved = await ipcOutcome('window.electronAPI.schedules.update(' + JSON.stringify(created.id) +
    ', ' + JSON.stringify({ launchConfig: { cwd: f.projectB } }) + ')');
  assert(!moved.ok && /can not be changed/i.test(moved.error ?? ''),
    'Moving a schedule to another project must be refused: ' + JSON.stringify(moved));
  assert.equal((await readSchedules())[0].launchConfig.cwd, f.projectA,
    'A refused move must leave the project of the schedule unchanged');
  const relative = await ipcOutcome('window.electronAPI.schedules.create(' + JSON.stringify({
    teamName: f.logical, executionMode: 'agent', taskFirst: true, cronExpression: '0 9 * * 1-5',
    timezone: 'UTC', launchConfig: { cwd: 'project-a', prompt: 'relative', providerId: 'opencode' },
  }) + ')');
  assert(!relative.ok && /absolute folder/i.test(relative.error ?? ''),
    'A relative project folder must be refused: ' + JSON.stringify(relative));

  // 5. Run now: the work goes to the copy of the chosen project; the run is recorded either way.
  const runsFile = path.join(schedulesDir, 'runs', created.id + '.json');
  const tasksOfCopy = path.join(f.claudeRoot, 'tasks', f.nativeA);
  await selectProject(f, 'project-a');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectA) + '))()');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'), 'project A open for the run');
  const runNow = section + ' button[aria-label="Run now"]';
  if (!await cdp.evaluate('Boolean(document.querySelector(' + JSON.stringify(runNow) + '))')) {
    await clickSelector(section + ' > div > button', 'Schedules section header of project A');
  }
  await clickSelector(runNow, 'Run now');
  const runs = await waitForJson<StoredRun[]>(
    runsFile,
    (list) => list.length > 0 && !['pending', 'warming_up', 'warm', 'running'].includes(list[0].status),
    'the scheduled run is recorded', 90_000
  );
  const recorded = runs[0];
  assert.equal(recorded.teamName, f.logical, 'The run belongs to the logical team');
  // The fixture runtime denies every agent, so the launch of the copy is refused by it: the work
  // is saved, the run is a recorded skip (never a failure that counts toward auto-pause).
  assert.equal(recorded.status, 'skipped', 'Unexpected run: ' + JSON.stringify(recorded));
  assert.match(recorded.summary ?? '',
    /^Task saved; (selected agent did not become ready|team launch failed)/,
    'Unexpected run reason: ' + JSON.stringify(recorded));
  assert(recorded.linkedTaskId, 'The run must link the task it saved: ' + JSON.stringify(recorded));
  assert.equal(recorded.executionTeamName, f.nativeA,
    'The run must say which project copy holds its task: ' + JSON.stringify(recorded));
  const taskFile = await readJsonFile<Record<string, unknown>>(
    path.join(tasksOfCopy, recorded.linkedTaskId + '.json')
  ).catch(() => null);
  assert(taskFile, 'The scheduled task must be on the board of the project copy');
  assert(JSON.stringify(taskFile).includes('SCHEDULED_PROJECT_A_PROMPT'),
    'The task on the copy must carry the scheduled instructions');
  assert.deepEqual(
    (await readdir(path.join(f.claudeRoot, 'tasks', f.nativeB))).sort(), ['1.json'],
    'The other project must not get the scheduled task'
  );
  assert.deepEqual(await readdir(path.join(f.claudeRoot, 'tasks', f.logical)), [],
    'The logical team must never get a board of its own');
  await cdp.screenshot(path.join(f.screenshots, 'schedule-run.png'));

  // 6. The global Schedules page opens the same dialog without any project: editing a schedule
  // made for project B must keep B, although the team was created in project A.
  const forB = await ipcOutcome('window.electronAPI.schedules.create(' + JSON.stringify({
    teamName: f.logical, executionMode: 'agent', taskFirst: true, reviewedSavedPrompt: true,
    label: 'SCHEDULE_FOR_B', cronExpression: '0 9 * * 1-5', timezone: 'UTC',
    launchConfig: { cwd: f.projectB, prompt: 'SCHEDULED_PROJECT_B_PROMPT', providerId: 'anthropic' },
  }) + ')');
  assert(forB.ok, 'A schedule for project B must be accepted: ' + JSON.stringify(forB));
  const gone = await ipcOutcome('window.electronAPI.schedules.create(' + JSON.stringify({
    teamName: f.logical, executionMode: 'agent', taskFirst: true, reviewedSavedPrompt: true,
    cronExpression: '0 9 * * 1-5', timezone: 'UTC',
    launchConfig: { cwd: path.join(f.root, 'no-such-project'), prompt: 'never', providerId: 'anthropic' },
  }) + ')');
  assert(!gone.ok && /folder/i.test(gone.error ?? ''),
    'A schedule for a folder that does not exist must be refused: ' + JSON.stringify(gone));
  const both = await waitForJson<StoredSchedule[]>(
    schedulesFile, (list) => list.length === 2, 'both schedules are stored'
  );
  const scheduleB = both.find((item) => item.launchConfig.cwd === f.projectB);
  assert(scheduleB, 'The schedule for project B is stored');

  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openSchedulesTab())()');
  const rowOfB = '(() => Array.from(document.querySelectorAll("[data-testid=schedule-list-item]"))' +
    '.find((row) => row.querySelector("button[aria-label=SCHEDULE_FOR_B]")))()';
  await waitFor('Boolean(' + rowOfB + ')', 'the schedule of project B on the Schedules page');
  await cdp.evaluate('(() => { const row = ' + rowOfB + ';' +
    'row.querySelector("button[aria-label=\\"More actions\\"]").click(); return true; })()');
  const editItem = '(() => Array.from(document.querySelectorAll("button"))' +
    '.find((b) => b.textContent?.trim() === "Edit"))()';
  await waitFor('Boolean(' + editItem + ')', 'Edit in the schedule menu');
  await cdp.evaluate('(() => { const b = ' + editItem + '; b.click(); return true; })()');
  await setField('[role=dialog] input[placeholder="0 9 * * 1-5"]', '0 10 * * 1-5');
  await cdp.screenshot(path.join(f.screenshots, 'schedules-page-edit.png'));
  const save = '(() => Array.from(document.querySelectorAll("[role=dialog] button"))' +
    '.find((b) => b.textContent?.trim() === "Save Changes"))()';
  await waitFor('(() => { const b = ' + save + '; return Boolean(b) && !b.disabled; })()',
    'Save Changes enabled', 60_000);
  await cdp.evaluate('(() => { const b = ' + save + '; b.click(); return true; })()');
  await waitFor('!document.querySelector("#dialog-prompt")', 'schedule dialog closed after save');
  const edited = await waitForJson<StoredSchedule[]>(
    schedulesFile,
    (list) => list.some((item) => item.id === scheduleB.id && item.cronExpression === '0 10 * * 1-5'),
    'the edited time of the schedule of project B is saved'
  );
  assert.equal(edited.find((item) => item.id === scheduleB.id)?.launchConfig.cwd, f.projectB,
    'Editing the time on the Schedules page must keep the project of the schedule');
  return recorded;
}

/**
 * Cross-team messages to and from a per-project team, through the real app:
 * the picker list, delivery to the copy of the sender's project only, the
 * refusal for a project without history, the copy as a sender, the routes the
 * MCP tools use (through the real controller package) and the badge label.
 */
async function verifyCrossTeam(f: Fixture) {
  assert(cdp);
  const inboxText = (team: string) =>
    readFile(path.join(f.rootTeams, team, 'inboxes', 'lead.json'), 'utf8').catch(() => '');
  const send = (fromTeam: string, toTeam: string, text: string) =>
    'window.electronAPI.crossTeam.send(' +
    JSON.stringify({ fromTeam, fromMember: 'lead', toTeam, text }) + ')';

  const targets = await cdp.evaluate(
    '(async () => (await window.electronAPI.crossTeam.listTargets()).map(t => t.teamName))()'
  ) as string[];
  assert(targets.includes(f.logical), 'Per-project team missing from cross-team targets: ' +
    JSON.stringify(targets));
  assert(!targets.includes(f.nativeA) && !targets.includes(f.nativeB),
    'Project copies leaked into cross-team targets');

  const beforeIndex = await readFile(f.indexPath, 'utf8');
  const sent = await cdp.evaluate(
    '(async () => await ' + send(f.partnerA, f.logical, 'CROSS_TEAM_TO_PROJECT_A') + ')()'
  ) as { toTeam?: string };
  assert.equal(sent.toTeam, f.nativeA, 'A message from project A must go to the project A copy');
  assert((await inboxText(f.nativeA)).includes('CROSS_TEAM_TO_PROJECT_A'));
  assert(!(await inboxText(f.nativeB)).includes('CROSS_TEAM_TO_PROJECT_A'),
    'A message for project A leaked into the project B history');
  assert.equal(await inboxText(f.logical), '', 'The per-project team got an inbox of its own');

  const refused = await ipcOutcome(send(f.partnerC, f.logical, 'CROSS_TEAM_NO_HISTORY'));
  assert(!refused.ok && /has no history in project/.test(refused.error ?? ''),
    'Expected an actionable refusal for a project without history: ' + JSON.stringify(refused));
  assert.equal(await readFile(f.indexPath, 'utf8'), beforeIndex,
    'A cross-team message created or changed a project context');

  const own = await ipcOutcome(send(f.nativeA, f.logical, 'CROSS_TEAM_TO_ITSELF'));
  assert(!own.ok && /same team/.test(own.error ?? ''), 'A copy reached its own team: ' +
    JSON.stringify(own));

  await cdp.evaluate('(async () => await ' +
    send(f.nativeB, f.partnerA, 'CROSS_TEAM_FROM_PROJECT_B') + ')()');
  const partnerInbox = JSON.parse(await inboxText(f.partnerA) || '[]') as
    { from?: string; text?: string }[];
  const fromCopy = partnerInbox.find((row) => row.text?.includes('CROSS_TEAM_FROM_PROJECT_B'));
  // The stored sender stays the copy: a reply to it must reach that copy, not another project.
  assert.equal(fromCopy?.from, f.nativeB + '.lead', 'Reply route lost');

  // The MCP tools run in the controller package, which asks this app over HTTP.
  const { createController } = createRequire(import.meta.url)('agent-teams-controller') as {
    createController(options: { teamName: string; claudeDir: string }): {
      crossTeam: {
        resolveCrossTeamRecipient(flags: { toTeam: string }): Promise<string>;
        listCrossTeamTargets(): Promise<{ teamName: string }[]>;
        sendCrossTeamMessage(flags: { toTeam: string; text: string }): unknown;
      };
    };
  };
  const fromA = createController({ teamName: f.partnerA, claudeDir: f.claudeRoot }).crossTeam;
  const fromC = createController({ teamName: f.partnerC, claudeDir: f.claudeRoot }).crossTeam;
  const mcpTargets = (await fromA.listCrossTeamTargets()).map((target) => target.teamName);
  assert(mcpTargets.includes(f.logical) && !mcpTargets.includes(f.nativeA) &&
    !mcpTargets.includes(f.nativeB), 'MCP targets: ' + JSON.stringify(mcpTargets));
  const recipient = await fromA.resolveCrossTeamRecipient({ toTeam: f.logical });
  assert.equal(recipient, f.nativeA, 'MCP routing from project A');
  fromA.sendCrossTeamMessage({ toTeam: recipient, text: 'MCP_CROSS_TEAM_TO_PROJECT_A' });
  assert((await inboxText(f.nativeA)).includes('MCP_CROSS_TEAM_TO_PROJECT_A'));
  assert(!(await inboxText(f.nativeB)).includes('MCP_CROSS_TEAM_TO_PROJECT_A'));
  await assert.rejects(fromC.resolveCrossTeamRecipient({ toTeam: f.logical }),
    (error: Error & { code?: string }) => error.code === 'NO_PROJECT_HISTORY');
  assert.equal(await readFile(f.indexPath, 'utf8'), beforeIndex);

  // The partner sees the copy as "<team> · project-b", never as its copy name.
  await selectProject(f, 'project-a');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.partnerA) + ', ' + JSON.stringify(f.projectA) + '))()');
  const badge = JSON.stringify('[data-cross-team-badge="' + f.nativeB + '"]');
  await waitFor('Array.from(document.querySelectorAll(' + badge + ')).some(el => ' +
    'el.getClientRects().length > 0 && el.textContent.endsWith(" · project-b") && ' +
    '!el.textContent.includes("ptc-"))', 'cross-team badge with the team and project label');
  await cdp.screenshot(path.join(f.screenshots, 'cross-team-badge.png'));
}

async function run() {
  const f = await fixture();
  let success = false;
  try {
    await start(f);
    // On Windows the same real Electron renderer startup can exceed 60 s:
    // the separate creation-page E2E reaches its first interaction after
    // ~75 s on GitHub-hosted Windows. Do not misclassify a slow startup as
    // a project-history regression. Keep one bounded, observed readiness gate.
    const rendererStartupBudgetMs = process.platform === 'win32' ? 180_000 : 60_000;
    await waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'renderer bridge',
      rendererStartupBudgetMs
    );
    await waitFor(
      '(async () => Boolean((await window.electronAPI.startup.getStatus()).ready))()',
      'app startup',
      rendererStartupBudgetMs
    );
    const beforeIndex = await readFile(f.indexPath, 'utf8');
    await verifyNative(f);
    assert.equal(await readFile(f.indexPath, 'utf8'), beforeIndex,
      'Read-only project navigation mutated durable context mapping');
    await verifyUi(f);
    await verifyAliasRedirect(f);
    await verifyDefinitionEdit(f);
    await verifyCrossTeam(f);
    const readAudit = async () => (await readFile(f.audit, 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const auditBeforeSchedule = (await readAudit()).length;
    const scheduledRun = await verifySchedules(f);
    // Even in CI, never launch an actual provider or substitute test credentials.
    // Only the scheduled launch of the stopped project copy may reach the denying runtime.
    const fullAudit = await readAudit();
    assert.equal(scheduledRun.status, 'skipped');
    const audit = fullAudit.slice(0, auditBeforeSchedule);
    const afterSchedule = fullAudit.slice(auditBeforeSchedule);
    const isLaunch = (args: string[]) => args.includes('--print') && args.includes('stream-json');
    const isReadOnly = (args: string[]) =>
      (args[0] === 'runtime' && ['status', 'providers', 'opencode-command'].includes(args[1])) ||
      (args[0] === 'auth' && args[1] === 'status') || (args[0] === 'model' && args[1] === 'list');
    assert.equal(afterSchedule.filter(isLaunch).length, 1,
      'The scheduled run must reach the runtime with exactly one launch of the project copy');
    const unexpectedAfter = afterSchedule.filter((args) => !isLaunch(args) && !isReadOnly(args));
    assert.equal(unexpectedAfter.length, 0, 'Unexpected runtime calls after the scheduled run: ' +
      JSON.stringify(unexpectedAfter.map((args) => args.slice(0, 2).map((token) =>
        /^(?:--?)?[a-zA-Z][a-zA-Z0-9-]{0,32}$/.test(token) ? token : '[redacted]'))));
    // Startup probes may query runtime read-only capabilities; any provider or
    // team launch command is forbidden by the synthetic runtime fixture.
    const unexpected = audit.filter((args) =>
      args[0] !== 'runtime' || !['status', 'providers', 'opencode-command'].includes(args[1])
    );
    // Preserve the strict deny policy. Report only command/subcommand tokens,
    // never full argv, user paths, provider settings or possible credentials.
    const commandHeads = unexpected.map((args) =>
      args.slice(0, 2).map((token) =>
        /^(?:--?)?[a-zA-Z][a-zA-Z0-9-]{0,32}$/.test(token) ? token : '[redacted]')
    );
    assert.equal(unexpected.length, 0,
      'Unexpected native model/provider lifecycle call: ' + JSON.stringify(commandHeads));
    success = true;
    console.log(JSON.stringify({
      ok: true, scope: 'real Electron / typed preload / main / native task + inbox / A-B-A / renderer reload / edit the per-project team definition / cross-team messages (IPC, controller over HTTP, badge) / schedules of a per-project team',
      team: f.logical, sandbox: f.root, screenshotDir: f.screenshots,
      providerExecution: false, scheduledRun: { status: scheduledRun.status, summary: scheduledRun.summary },
    }, null, 2));
  } catch (error) {
    await cdp?.screenshot(path.join(f.screenshots, 'failure.png')).catch(() => undefined);
    await json(path.join(f.screenshots, 'failure.json'), {
      error: String(error), logs: logs.slice(-80),
      visibleBody: await cdp?.evaluate('document.body?.innerText').catch(() => null),
    });
    throw error;
  } finally {
    // macOS can keep DevTools open even after all E2E assertions passed.
    // Stop only our detached Electron process group before closing its CDP link.
    let teardownFinished = false;
    const cleanupWatchdog = setTimeout(() => {
      console.error('[project-history-e2e] lingering handles after teardown; exiting harness');
      process.exit(teardownFinished && success ? 0 : 1);
    }, 15_000);
    if (app?.pid) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(-app.pid, 'SIGTERM');
        }
      } catch { /* owned app already exited */ }
    }
    // An unresponsive DevTools close must never consume the CI job timeout.
    await Promise.race([
      cdp?.close().catch(() => undefined) ?? Promise.resolve(),
      pause(2_000),
    ]);
    app?.stdout?.destroy();
    app?.stderr?.destroy();
    app?.unref();
    if (success && !keep && process.env.PROJECT_TEAM_E2E_REMOVE_FIXTURE === '1') {
      await rm(f.root, { recursive: true, force: true });
    }
    teardownFinished = true;
    // Unref only after cleanup: failures cannot silently exit before reporting.
    cleanupWatchdog.unref();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
