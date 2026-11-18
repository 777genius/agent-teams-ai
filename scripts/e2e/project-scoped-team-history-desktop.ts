#!/usr/bin/env -S pnpm exec tsx
/**
 * Real Electron renderer -> preload -> main -> native team-files smoke.
 * Synthetic, disposable data only. No provider process or user project is used.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  return {
    root, env, claudeRoot, rootTeams, indexPath, logical,
    nativeA, nativeB, projectA, projectB, projectC,
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
  // Tabs are intentionally kept mounted but hidden. querySelector() can select
  // an earlier *hidden* tab, producing a false failure despite visible task data.
  return 'Array.from(document.querySelectorAll(' + selector + ')).some(' +
    'node => node.getClientRects().length > 0 && node.textContent?.includes(' +
    JSON.stringify(task) + '))';
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

async function selectProject(f: Fixture, id: 'project-a' | 'project-b') {
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

async function verifyRetainedAfterModeChange(f: Fixture) {
  assert(cdp);
  const result = await cdp.evaluate('(async () => {' +
    'const f = ' + JSON.stringify(f) + ';' +
    'await window.electronAPI.teams.setProjectContextMode(f.logical, "shared");' +
    'const current = await window.electronAPI.teams.getProjectContextView(f.logical, f.projectA);' +
    'const old = await window.electronAPI.teams.getProjectContextView(f.nativeA, f.projectA);' +
    'return { current, old };' +
    '})()') as {
      current: { mode: string; state: string; executionTeamName?: string };
      old: { mode: string; state: string; executionTeamName?: string; logicalTeamName?: string };
    };
  assert.deepEqual(result.current, {
    mode: 'shared', state: 'ready', executionTeamName: f.logical,
  }, 'The shared mode must govern new work after switching');
  assert.equal(result.old.state, 'retained', 'Previously isolated project history was lost');
  assert.equal(result.old.executionTeamName, f.nativeA);
  assert.equal(result.old.logicalTeamName, f.logical);

  // Open via the original physical task identity, as global task deep links do.
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.nativeA) + ', ' + JSON.stringify(f.projectA) + '))()');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'),
    'retained project A task through real Electron after switching to shared');
  assert.equal(await cdp.evaluate(hasVisibleTeam(f.nativeB)), false,
    'Old project B leaked into retained A history');
  await cdp.screenshot(path.join(f.screenshots, 'history-retained-after-shared.png'));
}

async function verifyRetainedSharedAfterProjectIsolation(f: Fixture) {
  assert(cdp);
  const teamDir = path.join(f.rootTeams, f.logical);
  const joinedAt = Date.now() - 90_000;
  // Simulate a previously shared native team whose tasks and inbox must stay
  // addressable after the user opts into per-project isolation.
  await json(path.join(teamDir, 'config.json'), {
    name: f.logical, createdAt: joinedAt, projectPath: f.projectA,
    projectPathHistory: [f.projectA],
    leadAgentId: 'lead@' + f.logical,
    leadSessionId: 'lead-legacy-shared', members: [
      {
        name: 'lead', agentId: 'lead@' + f.logical, agentType: 'team-lead',
        role: 'Lead', providerId: 'opencode', providerBackendId: 'opencode-cli',
        model: 'test-model', joinedAt, cwd: f.projectA,
      },
      {
        name: 'alice', agentId: 'alice@' + f.logical, agentType: 'developer',
        role: 'Developer', providerId: 'opencode', providerBackendId: 'opencode-cli',
        model: 'test-model', joinedAt, cwd: f.projectA,
      },
    ],
  });
  await json(path.join(f.claudeRoot, 'tasks', f.logical, '1.json'), {
    id: '1', subject: 'LEGACY_SHARED_TASK_ONLY', description: 'Previously shared history',
    owner: 'alice', status: 'pending', createdAt: new Date().toISOString(),
    projectPath: f.projectA,
  });
  await json(path.join(teamDir, 'inboxes', 'user.json'), [{
    from: 'alice', to: 'user', text: 'LEGACY_SHARED_CHAT_ONLY',
    timestamp: new Date().toISOString(), read: false, messageId: randomUUID(),
  }]);

  await cdp.evaluate('(async () => {' +
    'const f = ' + JSON.stringify(f) + ';' +
    'await window.electronAPI.teams.setProjectContextMode(f.logical, "per_project");' +
    'await window.__agentTeamsDevStore.getState().fetchTeams();' +
    'return true; })()');
  await waitFor('(() => window.__agentTeamsDevStore?.getState()?.teamByName?.[' +
    JSON.stringify(f.logical) + ']?.projectContextMode === "per_project")()',
    'per-project mode after legacy shared history');

  // Task navigation explicitly requests the old physical logical-team
  // history; ordinary team navigation must still use the selected project.
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', undefined, "1"))()');
  await waitFor(visibleTask(f.logical, 'LEGACY_SHARED_TASK_ONLY'),
    'retained shared task through real Electron after enabling isolation');
  assert.equal(await cdp.evaluate(hasVisibleTeam(f.nativeB)), false,
    'Project B data leaked into retained shared history');
  await cdp.screenshot(path.join(f.screenshots, 'history-retained-shared-after-project.png'));

  await selectProject(f, 'project-a');
  await cdp.evaluate('(() => window.__agentTeamsDevStore.getState().openTeamTab(' +
    JSON.stringify(f.logical) + ', ' + JSON.stringify(f.projectA) + '))()');
  await waitFor(visibleTask(f.nativeA, 'PROJECT_A_TASK_ONLY'),
    'current A history remains available after retained shared task');
}

async function run() {
  const f = await fixture();
  let success = false;
  try {
    await start(f);
    await waitFor('window.electronAPI?.teams && window.__agentTeamsDevStore', 'renderer bridge', 60_000);
    await waitFor('(async () => Boolean((await window.electronAPI.startup.getStatus()).ready))()', 'app startup', 60_000);
    const beforeIndex = await readFile(f.indexPath, 'utf8');
    await verifyNative(f);
    assert.equal(await readFile(f.indexPath, 'utf8'), beforeIndex,
      'Read-only project navigation mutated durable context mapping');
    await verifyUi(f);
    await verifyRetainedAfterModeChange(f);
    await verifyRetainedSharedAfterProjectIsolation(f);
    // Even in CI, never launch an actual provider or substitute test credentials.
    const audit = (await readFile(f.audit, 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    // Startup probes may query runtime read-only capabilities; any provider or
    // team launch command is forbidden by the synthetic runtime fixture.
    assert(audit.every((args) =>
      args[0] === 'runtime' && ['status', 'providers', 'opencode-command'].includes(args[1])
    ), 'Unexpected native model/provider lifecycle call');
    success = true;
    console.log(JSON.stringify({
      ok: true, scope: 'real Electron / typed preload / main / native task + inbox / A-B-A / renderer reload',
      team: f.logical, sandbox: f.root, screenshotDir: f.screenshots,
      providerExecution: false,
    }, null, 2));
  } catch (error) {
    await cdp?.screenshot(path.join(f.screenshots, 'failure.png')).catch(() => undefined);
    await json(path.join(f.screenshots, 'failure.json'), {
      error: String(error), logs: logs.slice(-80),
      visibleBody: await cdp?.evaluate('document.body?.innerText').catch(() => null),
    });
    throw error;
  } finally {
    await cdp?.close().catch(() => undefined);
    if (app?.pid) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(-app.pid, 'SIGTERM');
        }
      } catch { /* owned app already exited */ }
    }
    if (success && !keep && process.env.PROJECT_TEAM_E2E_REMOVE_FIXTURE === '1') {
      await rm(f.root, { recursive: true, force: true });
    }
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
