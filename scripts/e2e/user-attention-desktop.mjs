#!/usr/bin/env node
// Real Electron / IPC / filesystem / renderer Attention Inbox proof, isolated fixture only.
// Run under xvfb-run on Linux. Does not launch an agent, provider or production team.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpClient } from './comment-notification/cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = process.env.ATTENTION_E2E_ARTIFACT_DIR ||
  await mkdtemp(path.join(os.tmpdir(), 'user-attention-e2e-'));
const claude = path.join(artifactRoot, 'home', '.claude');
const first = 'attention-' + randomUUID().slice(0, 8);
const second = 'attention-' + randomUUID().slice(0, 8);
const teams = [first, second];
const stamp = '2022-01-01T00:00:00.000Z';
const nowIso = () => new Date().toISOString();
let app = null;
let cdp = null;
let appOutput = '';
const evidence = {
  kind: 'user-attention-desktop-e2e-v1',
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  teams,
  checks: [],
  passed: false,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (file, payload) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(payload, null, 2) + '\n');
  await rename(temporary, file);
};
async function until(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (app && app.exitCode !== null)
      throw new Error('Electron exited during ' + label + ': ' + appOutput.slice(-1800));
    if (await check()) return;
    await delay(150);
  }
  throw new Error('Timed out: ' + label);
}
async function setup() {
  const envRoot = {
    HOME: path.join(artifactRoot, 'home'),
    TMPDIR: path.join(artifactRoot, 'tmp'),
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    CLAUDE_CONFIG_DIR: path.join(artifactRoot, 'config'),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(artifactRoot, 'user-data'),
  };
  for (const key of ['CONFIG', 'CACHE', 'DATA', 'STATE', 'RUNTIME']) {
    envRoot[`XDG_${key}_${key === 'RUNTIME' ? 'DIR' : 'HOME'}`] =
      path.join(artifactRoot, 'xdg-' + key.toLowerCase());
  }
  envRoot.CLAUDE_MULTIMODEL_DATA_HOME = path.join(artifactRoot, 'multimodel-data');
  envRoot.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(artifactRoot, 'multimodel-cache');
  const project = path.join(artifactRoot, 'project');
  for (const folder of [...Object.values(envRoot), project]) {
    await mkdir(folder, { recursive: true });
  }
  await chmod(envRoot.XDG_RUNTIME_DIR, 0o700);
  const version = JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8')).version;
  const deny = path.join(artifactRoot, 'runtime-deny.cjs');
  await writeFile(deny,
    '#!' + process.execPath + '\n' +
    'if (process.argv.slice(2).join(" ") === "--version") console.log(' +
    JSON.stringify(version) + '); else process.exitCode = 77;\n');
  await chmod(deny, 0o755);
  const env = {
    ...Object.fromEntries(
      ['PATH', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'TZ'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]]
      )
    ),
    ...envRoot,
    SHELL: '/bin/sh',
    GOMAXPROCS: '2',
    pnpm_config_verify_deps_before_run: 'false',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: deny,
  };
  if (process.getuid?.() === 0) env.NO_SANDBOX = '1';

  for (const team of teams) {
    const teamDir = path.join(claude, 'teams', team);
    const members = ['team-lead', team === first ? 'alice' : 'bob'].map((name) => ({
      name, agentId: name + '@' + team,
      agentType: name === 'team-lead' ? 'team-lead' : 'general-purpose',
      cwd: project, joinedAt: Date.now() - 86400000,
      color: 'blue', subscriptions: [],
    }));
    await json(path.join(teamDir, 'config.json'), {
      name: team, description: 'Isolated Attention Inbox proof',
      createdAt: Date.now() - 86400000,
      leadAgentId: members[0].agentId, members, projectPath: project,
    });
    await json(path.join(teamDir, 'members.meta.json'), { version: 1, members });
    await json(path.join(teamDir, 'team.meta.json'), {
      version: 1, cwd: project, createdAt: Date.now() - 86400000,
    });
    await json(path.join(teamDir, 'inboxes', 'user.json'), [{
      from: team === first ? 'alice' : 'bob',
      to: 'user', text: 'ATTENTION_E2E_DIRECT_' + team,
      timestamp: nowIso(), read: false, messageId: 'attention-dm-' + team,
    }]);
    await json(path.join(teamDir, 'inboxes', 'team-lead.json'), []);
  }
  const taskRoot = path.join(claude, 'tasks', first);
  await json(path.join(taskRoot, '1.json'), {
    id: '1', subject: 'ATTENTION_E2E_OLDEST_USER_DECISION',
    description: 'Human decision needed', status: 'pending',
    needsClarification: 'user', blocks: [], blockedBy: [],
    createdAt: stamp,
  });
  // Regression: older awaiting task must survive legacy globalTasks 500-row cap.
  for (let start = 2; start <= 522; start += 30) {
    await Promise.all(
      Array.from({ length: Math.min(30, 523 - start) }, (_, offset) => {
        const id = String(start + offset);
        return json(path.join(taskRoot, id + '.json'), {
          id, subject: 'Filler task ' + id, description: '',
          status: 'pending', blocks: [], blockedBy: [],
          createdAt: nowIso(),
        });
      })
    );
  }
  await json(path.join(claude, 'tasks', second, '1.json'), {
    id: '1', subject: 'ATTENTION_E2E_SECOND_TEAM',
    description: '', status: 'pending', needsClarification: 'user',
    blocks: [], blockedBy: [], createdAt: stamp,
  });
  await json(path.join(claude, 'agent-teams-config.json'), {
    general: { appLocale: 'en', theme: 'dark', defaultTab: 'dashboard' },
    notifications: { enabled: false, soundEnabled: false },
  });
  await mkdir(path.join(claude, 'projects'), { recursive: true });
  return env;
}
async function startDesktop(env) {
  app = spawn('pnpm', ['dev:mcp'], {
    cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.on('error', (error) => { appOutput += ' Spawn error: ' + String(error); });
  for (const stream of [app.stdout, app.stderr]) {
    stream.on('data', (chunk) => { appOutput = (appOutput + chunk.toString()).slice(-18000); });
  }
  let port;
  await until(() => {
    port = appOutput.match(/DevTools listening on ws:\/\/127\.0\.0\.1:([0-9]+)\//)?.[1];
    return port;
  }, 'Electron CDP port', 180000);
  let target;
  await until(async () => {
    try {
      const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = tabs.find((tab) => tab.type === 'page' &&
        tab.url.startsWith('http://localhost:'));
      return Boolean(target);
    } catch { return false; }
  }, 'Electron renderer');
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.waitFor('window.electronAPI && window.__agentTeamsDevStore',
    'real IPC bridge + store', 60000);
}
async function getSnapshot() {
  return cdp.evaluate('window.electronAPI.getUserAttentionSnapshot()');
}
async function checkDesktop() {
  await until(async () => {
    const snap = await getSnapshot();
    return snap.complete && snap.teams.length === 2 &&
      snap.teams.some((t) => t.teamName === first && t.tasks.length === 1 && t.messages.length === 1);
  }, 'live source-backed global attention');
  let snap = await getSnapshot();
  const oldest = snap.teams.find((t) => t.teamName === first);
  assert(oldest.tasks.some((t) => t.taskId === '1'), 'oldest task survives >500 candidates');
  assert.equal(oldest.tasks[0].requestedAt, null, 'legacy timestamp not fabricated');
  assert.equal(snap.teams.find((t) => t.teamName === second).messages.length, 1);
  evidence.checks.push('two teams + full task scan + direct unread');

  await cdp.evaluate('window.__agentTeamsDevStore.getState().openDashboard()');
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")',
    'dashboard attention panel', 60000);
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")?.textContent.includes("ATTENTION_E2E_OLDEST_USER_DECISION")',
    'dashboard awaiting task');
  const toolbar = await cdp.evaluate(
    'document.querySelector("button[aria-label=\\"Needs your attention\\"]") !== null');
  assert(toolbar, 'separate header attention button exists');
  evidence.checks.push('dashboard + header');
  const clickedAttention = await cdp.evaluate('(() => { const button = document.querySelector("button[aria-label=\\\"Needs your attention\\\"]"); if (!button) return false; button.click(); return true; })()');
  assert(clickedAttention, 'attention header icon opens the tab');
  await cdp.waitFor(
    'window.__agentTeamsDevStore.getState().openTabs.some((tab) => tab.type === "attention")',
    'full Attention tab opened');
  evidence.checks.push('header-to-full-tab navigation');
  await cdp.evaluate('window.__agentTeamsDevStore.getState().openDashboard()');

  const opened = await cdp.evaluate(`(() => {
    const panel = document.querySelector('[data-testid=user-attention-inbox]');
    const button = [...panel.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.includes('ATTENTION_E2E_OLDEST_USER_DECISION'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(opened, 'awaiting task button can be clicked');
  await cdp.waitFor(
    'window.__agentTeamsDevStore.getState().globalTaskDetail?.taskId === "1"',
    'task detail routed by canonical task ID');
  evidence.checks.push('task deep link');

  await cdp.evaluate('window.__agentTeamsDevStore.getState().closeGlobalTaskDetail()');
  await cdp.evaluate('window.__agentTeamsDevStore.getState().setMessagesPanelMode("sidebar")');
  const clickedChat = await cdp.evaluate(`(() => {
    const panel = document.querySelector('[data-testid=user-attention-inbox]');
    const button = [...panel.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.includes('alice'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clickedChat, 'user-addressed chat is clickable');
  await cdp.waitFor(
    'window.__agentTeamsDevStore.getState().openTabs.some((tab) => tab.type === "team" && tab.teamName === ${JSON.stringify(first)})',
    'exact team tab opened for chat');
  await until(async () => cdp.evaluate(`(async () => {
    const ui = await import('/components/team/sidebar/teamSidebarUiState.ts');
    const scope = ui.getTeamMessagesSidebarUiState(
      JSON.stringify(['local', ${JSON.stringify(first)}])
    ).conversationScope;
    return scope?.kind === 'direct' && scope.participant === 'alice';
  })()`), 'exact direct thread opened', 60000);
  evidence.checks.push('exact Messenger conversation navigation');

  await cdp.evaluate('window.__agentTeamsDevStore.getState().openDashboard()');

  // Engage the team watch scope before modifying its disposable task file.
  await cdp.evaluate(`window.electronAPI.teams.getData(${JSON.stringify(first)})`);
  await cdp.evaluate(`window.electronAPI.teams.setTaskClarification(${JSON.stringify(first)}, '2', 'user')`);
  await until(async () => {
    snap = await getSnapshot();
    return snap.teams.find((t) => t.teamName === first)?.tasks.length === 2;
  }, 'human clarification persisted by canonical controller setter');
  const added = snap.teams.find((t) => t.teamName === first).tasks.find((t) => t.taskId === '2');
  assert(Number.isFinite(Date.parse(added.requestedAt)), 'real transition timestamp recorded');
  await cdp.evaluate(`window.electronAPI.teams.setTaskClarification(${JSON.stringify(first)}, '2', 'user')`);
  const repeated = (await getSnapshot()).teams.find((t) => t.teamName === first)
    .tasks.find((t) => t.taskId === '2');
  assert.equal(repeated.requestedAt, added.requestedAt, 'same-value setter keeps request age');
  await cdp.evaluate(`window.electronAPI.teams.setTaskClarification(${JSON.stringify(first)}, '2', null)`);
  await until(async () => (await getSnapshot()).teams.find((t) => t.teamName === first)
    ?.tasks.every((t) => t.taskId !== '2'), 'cleared clarification removed');
  evidence.checks.push('controller transition / repeated setter / clear');

  // Read-state change is local and must not issue another backend task mutation.
  await cdp.evaluate(`(async () => {
    const reads = await import('/utils/teamMessageReadStorage.ts');
    reads.markRead(${JSON.stringify(first)}, ${JSON.stringify('attention-dm-' + first)});
  })()`);
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")?.textContent.includes("Unread chats")',
    'attention UI survives read update');
  evidence.checks.push('same Messenger read storage');

  await cdp.screenshot(path.join(artifactRoot, 'attention-dashboard.png'));
}
async function cleanup() {
  await cdp?.close().catch(() => {});
  if (!app) return;
  if (app.pid && process.platform !== 'win32') {
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await delay(1500);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
  } else {
    app.kill('SIGTERM');
  }
}
try {
  assert.equal(process.platform, 'linux', 'Linux desktop E2E with xvfb required');
  assert(process.env.DISPLAY, 'Set an isolated DISPLAY using xvfb-run -a');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const env = await setup();
  await startDesktop(env);
  await checkDesktop();
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack || String(error);
  process.exitCode = 1;
  await cdp?.screenshot(path.join(artifactRoot, 'failure.png')).catch(() => {});
} finally {
  await cleanup();
  evidence.completedAt = nowIso();
  await json(path.join(artifactRoot, 'evidence.json'), evidence);
  console.log(JSON.stringify({
    passed: evidence.passed, checks: evidence.checks,
    artifacts: artifactRoot, error: evidence.error,
  }));
}
