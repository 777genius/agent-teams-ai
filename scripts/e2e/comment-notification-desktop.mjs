#!/usr/bin/env node
// Real desktop/store/IPC/filesystem test. Never launches a team or provider.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { CdpClient } from './comment-notification/cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'comment-notification-TEST-'));
const home = path.join(artifacts, 'home');
const claude = path.join(home, '.claude');
const team = `comment-e2e-${randomUUID()}`;
const teamDir = path.join(claude, 'teams', team);
const taskDir = path.join(claude, 'tasks', team);
const project = path.join(artifacts, 'TEST-project');
const nativeLog = path.join(artifacts, 'native-notifications.ndjson');
const evidence = {
  kind: 'comment-notification-desktop-v1',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  artifacts,
  team,
  checks: [],
  snapshots: [],
  passed: false,
};
const children = new Set();
let cdp;
let app;
const desktopLog = createWriteStream(path.join(artifacts, 'desktop.log'));
let interceptError;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file);
};
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interceptError) throw interceptError;
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function child(command, args, env, detached = false) {
  const process = spawn(command, args, {
    cwd: repo,
    env,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(process);
  process.output = '';
  process.spawnFailure = null;
  process.on('error', (error) => {
    process.spawnFailure = error;
  });
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('data', (chunk) => {
      process.output += chunk.toString();
      if (process === app) desktopLog.write(chunk);
    });
  }
  return process;
}
async function stop(process, group = false) {
  if (!process) return;
  const signal = (name) => {
    try {
      if (group) globalThis.process.kill(-process.pid, name);
      else process.kill(name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  await delay(1500);
  // Only this harness's detached app process group, never shared hosts.
  signal('SIGKILL');
  children.delete(process);
}
const old = new Date(Date.now() - 86400000).toISOString();
const comment = (id, author, createdAt = old) => ({
  id,
  author,
  createdAt,
  text: `TEST_${id}`,
  type: 'regular',
});
const task = {
  id: 'abcd1234',
  subject: 'TEST comment notifications',
  description: 'Disposable fixture only',
  status: 'pending',
  owner: 'active-teammate',
  blocks: [],
  blockedBy: [],
  comments: [
    comment('historical-active', 'active-teammate'),
    comment('historical-removed', 'removed-teammate'),
  ],
};
const taskFile = path.join(taskDir, `${task.id}.json`);
const inboxFile = path.join(teamDir, 'inboxes', 'team-lead.json');
let env;
async function seed() {
  const roots = {
    HOME: home,
    TMPDIR: path.join(artifacts, 'tmp'),
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    CLAUDE_CONFIG_DIR: path.join(artifacts, 'claude-config'),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(artifacts, 'user-data'),
  };
  for (const key of ['CONFIG', 'CACHE', 'DATA', 'STATE', 'RUNTIME'])
    roots[`XDG_${key}_${key === 'RUNTIME' ? 'DIR' : 'HOME'}`] = path.join(
      artifacts,
      `xdg-${key.toLowerCase()}`
    );
  roots.CLAUDE_MULTIMODEL_DATA_HOME = path.join(artifacts, 'multimodel-data');
  roots.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(artifacts, 'multimodel-cache');
  for (const directory of [...Object.values(roots), project, taskDir])
    await mkdir(directory, { recursive: true });
  await chmod(roots.XDG_RUNTIME_DIR, 0o700);
  env = {
    // Keep only host settings needed to launch the desktop. Provider credentials
    // and runtime/home overrides must never enter the disposable app.
    ...Object.fromEntries(
      ['PATH', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'TZ'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]]
      )
    ),
    ...roots,
    SHELL: '/bin/sh',
    GOMAXPROCS: '2',
    COREPACK_HOME: process.env.COREPACK_HOME || '/root/.cache/node/corepack',
    pnpm_config_verify_deps_before_run: 'false',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
  };
  env.CLAUDE_DEV_RUNTIME_DISABLE_GH = '1';
  // electron-vite translates this into --no-sandbox for root-owned Linux CI.
  if (process.getuid?.() === 0) env.NO_SANDBOX = '1';
  const version = JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8')).version;
  const deny = path.join(artifacts, 'deny-runtime.cjs');
  await writeFile(
    deny,
    `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.slice(2).join(' ') === '--version') { console.log(${JSON.stringify(version)}); } else { fs.appendFileSync(${JSON.stringify(path.join(artifacts, 'runtime-denied.ndjson'))}, JSON.stringify(process.argv.slice(2))+'\\n'); process.exitCode = 77; }\n`
  );
  await chmod(deny, 0o755);
  env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = deny;
  const members = ['team-lead', 'active-teammate'].map((name) => ({
    name,
    agentId: `${name}@${team}`,
    agentType: name === 'team-lead' ? 'team-lead' : 'general-purpose',
    cwd: project,
    joinedAt: Date.now() - 86400000,
    color: 'blue',
    subscriptions: [],
  }));
  await json(path.join(teamDir, 'config.json'), {
    name: team,
    description: 'TEST only',
    createdAt: Date.now() - 86400000,
    leadAgentId: members[0].agentId,
    members,
    projectPath: project,
  });
  await json(path.join(teamDir, 'members.meta.json'), { version: 1, members });
  await json(path.join(teamDir, 'team.meta.json'), {
    version: 1,
    cwd: project,
    createdAt: Date.now() - 86400000,
  });
  await json(path.join(claude, 'agent-teams-config.json'), {
    general: { appLocale: 'en', theme: 'dark', defaultTab: 'teams' },
    notifications: {
      enabled: true,
      soundEnabled: false,
      notifyOnTaskComments: true,
      notifyOnLeadInbox: true,
      notifyOnUserInbox: true,
    },
  });
  await mkdir(path.join(claude, 'projects'), { recursive: true });
  await json(taskFile, task);
  await json(inboxFile, []);
  await json(path.join(teamDir, 'comment-notification-journal.json'), []);
  const history = [true, false].map((isRead, index) => ({
    id: `preserved-${index}`,
    isRead,
    createdAt: Date.now() - 60000,
    timestamp: Date.now() - 60000,
    sessionId: `team:${team}`,
    projectId: team,
    filePath: '',
    source: 'task_comment',
    category: 'team',
    teamEventType: 'task_comment',
    message: `TEST preserved history ${index}`,
    dedupeKey: `preserved-${index}`,
    context: { projectName: team },
  }));
  evidence.preservedHistory = history;
  await json(path.join(claude, 'agent-teams-notifications.json'), history);
  await writeFile(nativeLog, '');
  await json(path.join(artifacts, 'fixture.json'), { roots, team, project });
}
async function startBus() {
  const bus = child('dbus-daemon', ['--session', '--nofork', '--print-address=1'], env);
  await until(() => {
    if (bus.spawnFailure) throw bus.spawnFailure;
    if (bus.exitCode !== null) throw new Error(`Private D-Bus failed: ${bus.output}`);
    return bus.output.includes('\n');
  }, 'private D-Bus address');
  env.DBUS_SESSION_BUS_ADDRESS = bus.output.split('\n')[0].trim();
  const recorder = child(
    '/usr/bin/python3',
    [path.join(repo, 'scripts/e2e/comment-notification/notifications.py'), nativeLog],
    env
  );
  await until(() => {
    if (recorder.spawnFailure) throw recorder.spawnFailure;
    if (recorder.exitCode !== null)
      throw new Error(`OS notification observation unavailable: ${recorder.output}`);
    return recorder.output.includes('READY');
  }, 'native notification recorder');
  evidence.notificationBoundary =
    'Private org.freedesktop.Notifications.Notify service; real Electron notifications';
}
async function startApp() {
  app = child('pnpm', ['dev:mcp'], env, true);
  let port;
  await until(
    () => {
      if (app.spawnFailure) throw app.spawnFailure;
      if (app.exitCode !== null) throw new Error(`Desktop exited: ${app.output.slice(-4000)}`);
      port = app.output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
      return port;
    },
    'owned dev:mcp CDP port',
    180000
  );
  let target;
  await until(
    async () => {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = targets.find(
          (item) => item.type === 'page' && item.url.startsWith('http://localhost:')
        );
        return target;
      } catch {
        return false;
      }
    },
    'owned Electron renderer',
    60000
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.waitFor(
    'window.electronAPI && window.__agentTeamsDevStore',
    'real Electron API and dev store',
    60000
  );
  // Opening the fixture through real IPC brings its idle inbox into watch scope.
  await cdp.evaluate(`(async () => {
    window.__commentInboxEvents = [];
    window.electronAPI.teams.onTeamChange((_event, data) => {
      if (data.teamName === ${JSON.stringify(team)}) window.__commentInboxEvents.push(data);
    });
    await window.electronAPI.teams.getData(${JSON.stringify(team)});
  })()`);
  await refresh();
}
const state = 'window.__agentTeamsDevStore';
async function refresh() {
  await cdp.evaluate(`${state}.getState().fetchAllTasks()`);
  await cdp.waitFor(
    `${state}.getState().globalTasksInitialized && !${state}.getState().globalTasksLoading`,
    'task snapshot'
  );
  const tasks = await cdp.evaluate(`${state}.getState().globalTasks`);
  assert(
    tasks.some((item) => item.id === task.id && item.teamName === team),
    'Real IPC must load fixture task'
  );
}
async function history() {
  return cdp.evaluate('window.electronAPI.notifications.get({limit:200})');
}
async function native() {
  const text = await readFile(nativeLog, 'utf8');
  return text.trim()
    ? text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}
async function snapshot(label, expectedTotal, expectedNative) {
  // Negative checks span watcher debounce + async notification persistence.
  await delay(2500);
  const stored = await history();
  const shown = await native();
  assert.equal(stored.total, expectedTotal, `${label}: history total`);
  assert.equal(stored.unreadCount, expectedTotal - 1, `${label}: unread count`);
  for (const original of evidence.preservedHistory)
    assert.deepEqual(
      stored.notifications.find((row) => row.id === original.id),
      original,
      `${label}: preexisting history unchanged`
    );
  assert.equal(shown.length, expectedNative, `${label}: OS notification count`);
  assert(
    !stored.notifications.some((row) => /TEST_historical|TEST_recovered/.test(row.message)),
    `${label}: no old notification rows`
  );
  const screenshot = path.join(artifacts, `${evidence.snapshots.length}-${label}.png`);
  await cdp.screenshot(screenshot);
  evidence.snapshots.push({ label, stored, native: shown, screenshot });
  evidence.checks.push(label);
  await json(path.join(artifacts, 'evidence.json'), evidence);
}
async function appendComment(value) {
  task.comments.push(value);
  await json(taskFile, task);
  await refresh();
}
async function forwarded(marker) {
  let messages;
  await until(async () => {
    messages = JSON.parse(await readFile(inboxFile, 'utf8'));
    return messages.some(
      (item) => item.messageKind === 'task_comment_notification' && item.text.includes(marker)
    );
  }, `real main journal delivery for ${marker}`);
  evidence.forwarded = messages;
}
async function control(marker) {
  const messages = JSON.parse(await readFile(inboxFile, 'utf8'));
  messages.push({
    from: 'removed-teammate',
    text: marker,
    timestamp: new Date().toISOString(),
    read: false,
    messageId: randomUUID(),
  });
  await json(inboxFile, messages);
}
async function firstSnapshotRace() {
  // Delay only the transport call; real detector, clock, data and notification IPC remain intact.
  const needle = 'function getImpl() {\n  if (window.electronAPI) return window.electronAPI;';
  const replacement = `function getImpl() {
    if (window.electronAPI) {
      if (!window.__commentSnapshotGate) {
        let release;
        const ready = new Promise(resolve => { release = resolve; });
        const gate = window.__commentSnapshotGate = { waiting: 0, release, released: false };
        gate.api = { ...window.electronAPI, teams: { ...window.electronAPI.teams,
          getAllTasks: async (...args) => { gate.waiting++; await ready; return window.electronAPI.teams.getAllTasks(...args); }
        }};
      }
      return window.__commentSnapshotGate.api;
    }`;
  let patches = 0;
  cdp.on('Fetch.requestPaused', async (event) => {
    try {
      const pathname = new URL(event.request.url).pathname;
      if (!pathname.endsWith('/api/index.ts')) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        return;
      }
      const response = await cdp.send('Fetch.getResponseBody', { requestId: event.requestId });
      const body = response.base64Encoded
        ? Buffer.from(response.body, 'base64').toString()
        : response.body;
      assert(body.includes(needle), 'Transport gate must match real Vite API module');
      patches++;
      await cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
        body: Buffer.from(body.replace(needle, replacement)).toString('base64'),
      });
    } catch (error) {
      interceptError = error;
    }
  });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api/index.ts*', requestStage: 'Response' }],
  });
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.waitFor(
    'window.__commentSnapshotGate?.waiting > 0 && window.__agentTeamsDevStore',
    'initial task IPC held',
    60000
  );
  assert.equal(
    await cdp.evaluate(`${state}.getState().globalTasksInitialized`),
    false,
    'Must precede first snapshot baseline'
  );
  task.comments.push(comment('first-snapshot-fresh', 'active-teammate', new Date().toISOString()));
  await json(taskFile, task);
  await forwarded('TEST_first-snapshot-fresh');
  await cdp.evaluate(`${state}.getState().fetchConfig()`);
  await cdp.evaluate('window.__commentSnapshotGate.release()');
  await refresh();
  assert(patches > 0);
  evidence.firstSnapshotTransportPatches = patches;
  await cdp.send('Fetch.disable');
}
try {
  assert.equal(process.platform, 'linux', 'Native boundary recorder requires Linux');
  assert(process.env.DISPLAY, 'Run with xvfb-run -a');
  console.log(JSON.stringify({ artifacts }));
  await seed();
  await startBus();
  await startApp();
  await forwarded('TEST_historical-removed');
  await snapshot('historical-startup', 2, 0);
  // Establish inbox baseline using a real watched file event, then prove it with a control.
  const inboxEventCount = () =>
    cdp.evaluate('window.__commentInboxEvents.filter((event) => event.type === "inbox").length');
  const baselineEvents = await inboxEventCount();
  await json(inboxFile, JSON.parse(await readFile(inboxFile, 'utf8')));
  await until(
    async () => (await inboxEventCount()) > baselineEvents,
    'engaged inbox watcher event'
  );
  await delay(1500);
  await control('TEST_CONTROL_BASELINE');
  await until(
    async () => (await history()).total === 3,
    'ordinary inbox control proves active watcher/baseline'
  );
  await snapshot('ordinary-inbox-control', 3, 1);
  const recoveryStarted = Date.now();
  await appendComment(comment('recovered-after-baseline', 'removed-teammate'));
  await forwarded('TEST_recovered-after-baseline');
  const recovered = evidence.forwarded.find((row) =>
    row.text.includes('TEST_recovered-after-baseline')
  );
  assert(
    Date.parse(recovered.timestamp) >= recoveryStarted,
    'Historical recovery must produce a new envelope timestamp'
  );
  await snapshot('historical-recovery-after-baseline', 3, 1);
  await appendComment(comment('fresh-once', 'active-teammate', new Date().toISOString()));
  await forwarded('TEST_fresh-once');
  await until(async () => (await history()).total === 4, 'new comment stored');
  await snapshot('fresh-comment-once', 4, 2);
  let current = await history();
  assert.equal(
    current.notifications.filter(
      (row) => row.teamEventType === 'task_comment' && row.message.includes('TEST_fresh-once')
    ).length,
    1
  );
  assert(
    (await native()).some((row) => row.body.includes('TEST_fresh-once')),
    'Fresh comment reached actual OS boundary'
  );
  task.comments.reverse();
  await json(taskFile, task);
  await refresh();
  await refresh();
  await snapshot('refresh-and-reorder', 4, 2);
  await firstSnapshotRace();
  await forwarded('TEST_first-snapshot-fresh');
  await until(async () => (await history()).total === 5, 'fresh first-snapshot comment stored');
  await snapshot('fresh-in-first-snapshot', 5, 3);
  assert((await native()).some((row) => row.body.includes('TEST_first-snapshot-fresh')));
  await cdp.evaluate(
    `(async () => { const config = await window.electronAPI.config.update('notifications', {notifyOnTaskComments:false}); ${state}.setState({appConfig:config}); })()`
  );
  await appendComment(comment('toggle-off', 'active-teammate', new Date().toISOString()));
  await forwarded('TEST_toggle-off');
  await until(async () => (await history()).total === 6, 'muted comment still stored');
  await snapshot('comment-toggle-no-lead-duplicate', 6, 3);
  current = await history();
  assert.equal(
    current.notifications.filter(
      (row) => row.message.includes('TEST_toggle-off') && row.teamEventType === 'task_comment'
    ).length,
    1
  );
  await control('TEST_CONTROL_AFTER_TOGGLE');
  await until(
    async () => (await history()).total === 7,
    'ordinary inbox works with comment toggle disabled'
  );
  await snapshot('ordinary-inbox-after-toggle', 7, 4);
  // Restore toggle before both restart checks so replay cannot hide behind muted settings.
  await cdp.evaluate(
    `(async () => { const config = await window.electronAPI.config.update('notifications', {notifyOnTaskComments:true}); ${state}.setState({appConfig:config}); })()`
  );
  const previousTimeOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.waitFor(`performance.timeOrigin !== ${previousTimeOrigin}`, 'new renderer document');
  await cdp.waitFor('window.__agentTeamsDevStore', 'renderer restarted');
  await refresh();
  await snapshot('renderer-restart-no-replay', 7, 4);
  await cdp.close();
  cdp = null;
  await stop(app, true);
  app = null;
  await startApp();
  await snapshot('app-restart-no-replay', 7, 4);
  evidence.runtimeDenied = await readFile(
    path.join(artifacts, 'runtime-denied.ndjson'),
    'utf8'
  ).catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  evidence.blockedRuntimeCalls = evidence.runtimeDenied.trim()
    ? evidence.runtimeDenied
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  // The app probes provider status/bridge availability at startup. The fixture
  // rejects these with exit 77; no real runtime is reachable through this path.
  assert(
    evidence.blockedRuntimeCalls.every(
      (args) =>
        (args[0] === 'runtime' &&
          (args[1] === 'opencode-command' || (args[1] === 'status' && args.includes('--summary')))) ||
        (args.length === 5 &&
          args[2] === '--json' &&
          args[3] === '--provider' &&
          ['anthropic', 'codex', 'opencode'].includes(args[4]) &&
          ((args[0] === 'auth' && args[1] === 'status') ||
            (args[0] === 'model' && args[1] === 'list')))
    ),
    'Only blocked startup availability probes expected; no lifecycle commands'
  );
  evidence.passed = true;
  evidence.completedAt = new Date().toISOString();
} catch (error) {
  evidence.error = error.stack || String(error);
  if (cdp) await cdp.screenshot(path.join(artifacts, 'failure.png')).catch(() => {});
  process.exitCode = 1;
} finally {
  await cdp?.close().catch(() => {});
  await stop(app, true);
  for (const process of children) await stop(process);
  await new Promise((resolve, reject) => {
    desktopLog.once('error', reject);
    desktopLog.end(resolve);
  });
  await json(path.join(artifacts, 'evidence.json'), evidence);
  console.log(JSON.stringify({ passed: evidence.passed, artifacts, error: evidence.error }));
}
