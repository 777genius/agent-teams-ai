#!/usr/bin/env node
// Real Electron / IPC / filesystem / renderer Attention Inbox proof, isolated fixture only.
// Run under xvfb-run on Linux. Does not launch an agent, provider or production team.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildOpenCodeAppProfileScope } from '../../src/main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv.ts';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TEAM_GROUP_CHAT_ID, DEFAULT_TEAM_GROUP_CHAT_NAME } from '../../src/features/team-group-chats/contracts/defaultTeamGroup.ts';
import { CdpClient } from './comment-notification/cdp.mjs';
import { checkBudgetDesktop } from './team-budget-real-electron.mjs';

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
  // Match the project-history smoke: CI's Chromium SUID helper is not configured.
  // Disable sandboxing only in this isolated Linux test process, never in the app.
  if (process.platform === 'linux' && (process.env.GITHUB_ACTIONS === 'true' || process.getuid?.() === 0)) {
    env.ELECTRON_DISABLE_SANDBOX = '1';
  }

  const profileScope = buildOpenCodeAppProfileScope(
    envRoot.AGENT_TEAMS_ELECTRON_USER_DATA_DIR, claude
  );
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
    // Test-owned synthetic teams need the same official profile ownership
    // marker as real app-created teams. Nothing outside artifactRoot is touched.
    await json(path.join(teamDir, '.agent-teams-owner.json'), {
      schemaVersion: 1, profileScope, claimedAt: nowIso(), reason: 'create',
    });
    const former = { ...members[1], name: 'former', agentId: 'former@' + team,
      removedAt: Date.now() - 3600000 };
    await json(path.join(teamDir, 'members.meta.json'), {
      version: 1, members: team === first ? [...members, former] : members,
    });
    await json(path.join(teamDir, 'team.meta.json'), {
      version: 1, cwd: project, createdAt: Date.now() - 86400000,
    });
    await json(path.join(teamDir, 'inboxes', 'user.json'), [{
      from: team === first ? 'alice' : 'bob',
      to: 'user', text: 'ATTENTION_E2E_DIRECT_' + team,
      timestamp: team === first ? stamp : nowIso(), read: false, messageId: 'attention-dm-' + team,
      ...(team === second ? { source: 'runtime_delivery', relayOfMessageId: 'attention-bob-delivery' } : {}),
    }, ...(team === second ? [{
      from: 'bob', to: 'user', text: ' ATTENTION_E2E_DIRECT_' + team + ' ',
      source: 'runtime_delivery', relayOfMessageId: 'attention-bob-delivery',
      timestamp: stamp, read: false, messageId: 'attention-dm-copy-' + team,
    }] : []), ...(team === first ? Array.from({ length: 60 }, (_, index) => ({
      from: 'alice', to: 'user', text: 'Newer already read ' + index,
      timestamp: new Date(Date.now() - (60 - index) * 1000).toISOString(),
      read: true, messageId: 'attention-read-filler-' + index,
    })) : [])]);
    await json(path.join(teamDir, 'inboxes', 'team-lead.json'), []);
    if (team === second) {
      await json(path.join(teamDir, 'group-chats.json'), {
        version: 1,
        groups: [{
          id: DEFAULT_TEAM_GROUP_CHAT_ID, name: DEFAULT_TEAM_GROUP_CHAT_NAME,
          createdAt: stamp, membership: { kind: 'auto', excludedMemberNames: [] },
          archivedAt: null,
        }],
      });
    }
  }
  const taskRoot = path.join(claude, 'tasks', first);
  await json(path.join(taskRoot, '1.json'), {
    id: '1', subject: 'ATTENTION_E2E_OLDEST_USER_DECISION',
    description: 'Human decision needed', status: 'pending',
    needsClarification: 'user', owner: 'team-lead', blocks: [], blockedBy: [],
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
  // Genuine Electron IPC and budget projection over a deterministic, private
  // usage ledger. The spending sample is synthetic; no provider is contacted.
  // The manual_import run is not deleted by automatic native-run discovery.
  const usageRunId = 'attention-budget-' + first;
  const usedAt = nowIso();
  await json(path.join(envRoot.AGENT_TEAMS_ELECTRON_USER_DATA_DIR,
    'data', 'token-usage', 'ledger.json'), {
    schemaVersion: 1,
    runs: {
      [usageRunId]: {
        appRunId: usageRunId, teamName: first, runtimeKind: 'anthropic',
        startedAt: usedAt, endedAt: usedAt, status: 'completed',
        source: 'manual_import', sources: [],
      },
    },
    events: {
      [usageRunId + '-event']: {
        id: usageRunId + '-event', appRunId: usageRunId,
        teamName: first, runtimeKind: 'anthropic',
        tokens: {
          inputTokens: 140, outputTokens: 10, cacheCreationTokens: 0,
          cacheReadTokens: 0, reasoningTokens: 0, audioTokens: 0, imageTokens: 0,
          totalTokens: 150,
        },
        cost: {
          estimatedUsd: 0, billableUsd: 0, apiEquivalentUsd: 0,
          source: 'unknown', billingMode: 'unknown',
        },
        usageSourceKind: 'log_parsed',
        occurredAt: usedAt, createdAt: usedAt,
      },
    },
    sourceStates: {},
  });
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
      snap.teams.some((t) => t.teamName === first && t.tasks.length === 1 &&
        t.messages.some((message) => message.messageId === 'attention-dm-' + first));
  }, 'live source-backed global attention');
  let snap = await getSnapshot();
  const oldest = snap.teams.find((t) => t.teamName === first);
  assert(oldest.tasks.some((t) => t.taskId === '1'), 'oldest task survives >500 candidates');
  assert.equal(oldest.tasks[0].requestedAt, null, 'legacy timestamp not fabricated');
  assert.equal(oldest.tasks[0].owner, 'team-lead', 'assigned owner survives filesystem and IPC projection');
  assert(oldest.messages.some((message) => message.messageId === 'attention-dm-' + first),
    'old unread message survives 60 newer messages');
  const relayTeam = snap.teams.find((t) => t.teamName === second);
  assert.deepEqual(relayTeam.messages.map((message) => message.messageId), ['attention-dm-' + second],
    'duplicate runtime relay retains only the canonical Messenger read identity');
  evidence.checks.push('two teams + full task scan + old unread beyond first 50 messages');

  await cdp.evaluate('window.__agentTeamsDevStore.getState().openDashboard()');
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")',
    'dashboard attention panel', 60000);
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")?.textContent.includes("ATTENTION_E2E_OLDEST_USER_DECISION")',
    'dashboard awaiting task');
  await cdp.waitFor(`(() => {
    const task = [...document.querySelectorAll('[data-testid=user-attention-inbox] button')]
      .find((button) => button.getClientRects().length > 0 &&
        button.getAttribute('aria-label')?.includes('ATTENTION_E2E_OLDEST_USER_DECISION'));
    return task?.getAttribute('aria-label').endsWith(' · lead') &&
      task.textContent.includes('lead') && task.querySelector('img[alt=""]');
  })()`, 'assigned owner is visible and announced on the task row');
  evidence.checks.push('task owner from persisted task through IPC to visible accessible row');
  const toolbar = await cdp.evaluate(
    'document.querySelector("button[aria-label=\\"Needs your attention\\"]") !== null');
  assert(toolbar, 'separate header attention button exists');
  evidence.checks.push('dashboard + header');

  // Prove responsive layout in the real Electron renderer at both viewport widths.
  // Restore the original viewport before the navigation tests continue.
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.waitFor(`(() => {
      const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
        .find((node) => node.getClientRects().length > 0);
      const columns = panel?.querySelector('[data-testid=attention-sections]');
      const style = columns && getComputedStyle(columns);
      return style?.display === 'grid' &&
        style.gridTemplateColumns.trim().split(' ').filter(Boolean).length === 2;
    })()`, 'wide Attention has two columns');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 800, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.waitFor(`(() => {
      const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
        .find((node) => node.getClientRects().length > 0);
      const columns = panel?.querySelector('[data-testid=attention-sections]');
      const style = columns && getComputedStyle(columns);
      return style?.display === 'grid' &&
        style.gridTemplateColumns.trim().split(' ').filter(Boolean).length === 1;
    })()`, 'narrow Attention has one column');
    evidence.checks.push('responsive Attention: 2 columns wide, 1 column narrow');
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
  const clickedAttention = await cdp.evaluate('(() => { const button = document.querySelector("button[aria-label=\\\"Needs your attention\\\"]"); if (!button) return false; button.click(); return true; })()');
  assert(clickedAttention, 'attention header icon opens the tab');
  await cdp.waitFor(
    'window.__agentTeamsDevStore.getState().openTabs.some((tab) => tab.type === "attention")',
    'full Attention tab opened');
  evidence.checks.push('header-to-full-tab navigation');

  // Exercise the actual shared Dialog + Select controls in the full Inbox.
  // Dashboard must remain unfiltered after applying/resetting on this tab.
  await cdp.waitFor(`Array.from(document.querySelectorAll('[data-testid=attention-filter-trigger]'))
    .some((button) => button.getClientRects().length > 0)`,
    'full Inbox filters visible next to search');
  const clickAt = async (selector) => {
    const clickablePoint = `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((item) => item.getClientRects().length > 0);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return !el.matches(':disabled') && hit && el.contains(hit) ? { x, y } : null;
    })()`;
    // Radix keeps the modal overlay mounted during its exit animation.
    // A visible trigger is not necessarily an actionable pointer target yet.
    await cdp.waitFor(clickablePoint, 'actionable filter control ' + selector);
    const point = await cdp.evaluate(clickablePoint);
    assert(point, 'actionable filter control ' + selector);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
  };
  await clickAt('[data-testid=attention-filter-trigger]');
  await cdp.waitFor('document.querySelector("[data-testid=attention-filter-dialog]")',
    'full Inbox filter dialog open');
  await cdp.waitFor('document.querySelector("[data-testid=attention-filter-waiting]")',
    'all four filter controls mounted');
  await cdp.waitFor(`(() => {
    const dialog = document.querySelector('[data-testid=attention-filter-dialog]');
    return dialog?.dataset.state === 'open' &&
      getComputedStyle(dialog).opacity === '1' &&
      !dialog.getAnimations().some((animation) => animation.pending || animation.playState === 'running');
  })()`, 'filter dialog opening animation settled');
  await cdp.screenshot(path.join(artifactRoot, 'attention-filters-dialog.png'));
  await clickAt('[data-testid=attention-filter-type]');
  await cdp.waitFor(`Array.from(document.querySelectorAll('[role=option]'))
    .some((row) => row.textContent.trim() === 'Awaiting your decision')`,
    'task option in native Select menu');
  const taskOption = await cdp.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('[role=option]'))
      .find((el) => el.textContent.trim() === 'Awaiting your decision');
    if (!row) return null;
    const box = row.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  assert(taskOption, 'task option position');
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: taskOption.x, y: taskOption.y,
    button: 'left', clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: taskOption.x, y: taskOption.y,
    button: 'left', clickCount: 1,
  });
  await cdp.waitFor(`document.querySelector('[data-testid=attention-filter-type]')
    ?.textContent.includes('Awaiting your decision')`,
    'task filter selected');
  await clickAt('[data-testid=attention-filter-apply]');
  await cdp.waitFor(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    const sections = panel?.querySelector('[data-testid=attention-sections]');
    return sections?.textContent.includes('Awaiting your decision') &&
      !sections.textContent.includes('Unread chats') &&
      panel?.querySelector('[data-testid=attention-filter-count]')?.textContent.trim() === '1';
  })()`, 'applied task filter hides chats but keeps tasks');
  await cdp.waitFor('!document.querySelector("[data-testid=attention-filter-dialog]")',
    'applied filter dialog fully closed');
  await clickAt('[data-testid=attention-filter-trigger]');
  await cdp.waitFor(`(() => {
    const dialog = document.querySelector('[data-testid=attention-filter-dialog]');
    return dialog?.dataset.state === 'open' &&
      dialog.querySelector('[data-testid=attention-filter-type]')?.textContent.includes('Awaiting your decision') &&
      dialog.querySelector('[data-testid=attention-filter-conversation]')?.disabled === true;
  })()`, 'filters reopen with applied choices and disabled chat scope');
  await clickAt('[data-testid=attention-filter-reset]');
  await clickAt('[data-testid=attention-filter-apply]');
  await cdp.waitFor(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    const sections = panel?.querySelector('[data-testid=attention-sections]');
    return sections?.textContent.includes('Unread chats') &&
      sections.textContent.includes('Awaiting your decision') &&
      !panel.querySelector('[data-testid=attention-filter-count]');
  })()`, 'filter reset restores both sections');
  evidence.checks.push('full Inbox filter dialog, apply/reset, preserved section order');
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
    `(() => { const detail = window.__agentTeamsDevStore.getState().globalTaskDetail;
      return detail?.teamName === ${JSON.stringify(first)} && detail.taskId === "1"; })()`,
    'task detail routed by canonical team and task ID');
  evidence.checks.push('task deep link');

  await cdp.evaluate('window.__agentTeamsDevStore.getState().closeGlobalTaskDetail()');
  await cdp.evaluate('window.__agentTeamsDevStore.getState().setMessagesPanelMode("sidebar")');

  // Prove the two unread conversations before opening one (opening may mark it read).
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    if (!panel) return false;
    const labels = [...panel.querySelectorAll('button[aria-label]')]
      .map((button) => button.getAttribute('aria-label') || '');
    return labels.some((label) => label.includes('alice')) &&
      labels.some((label) => label.includes('bob')) &&
      panel.textContent.includes(${JSON.stringify('ATTENTION_E2E_DIRECT_' + first)}) &&
      !panel.textContent.includes('Newer already read');
  })()`), 'two unread rows, oldest unread preview after migration');

  await cdp.evaluate(`(async () => {
    const reads = await import('/utils/teamMessageReadStorage.ts');
    const root = await window.electronAPI.config.getClaudeRootInfo();
    const scope = reads.getTeamMessageReadContextScope('local', root);
    reads.markRead(reads.getTeamMessageReadStorageKey(${JSON.stringify(first)}, scope), ${JSON.stringify('attention-dm-' + first)});
  })()`);
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    if (!panel) return false;
    const labels = [...panel.querySelectorAll('button[aria-label]')]
      .map((button) => button.getAttribute('aria-label') || '');
    return !labels.some((label) => label.includes('alice')) &&
      labels.some((label) => label.includes('bob'));
  })()`), 'alice disappears after reading while bob stays unread');
  evidence.checks.push('same Messenger read storage updates the exact chat row');

  await cdp.evaluate(`(async () => {
    const ui = await import('/components/team/sidebar/teamSidebarUiState.ts');
    const state = window.__agentTeamsDevStore.getState();
    const key = JSON.stringify([state.activeContextId, ${JSON.stringify(second)}]);
    const previous = ui.getTeamMessagesSidebarUiState(key);
    ui.setTeamMessagesSidebarUiState(key, {
      ...previous,
      messagesFilter: { ...previous.messagesFilter, from: new Set(['alice']), to: new Set(['other']) },
    });
  })()`);
  // Both the full Attention tab and Dashboard can remain mounted. Locate and
  // click the exact unread row in the visible panel in the same poll, after
  // the read-state update and sidebar fixture have settled.
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    const button = Array.from(panel?.querySelectorAll('button') ?? []).find((b) =>
      b.getClientRects().length > 0 && b.getAttribute('aria-label')?.includes('bob') &&
      b.textContent.includes(${JSON.stringify('ATTENTION_E2E_DIRECT_' + second)}));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`), 'unread bob chat is clickable in the visible Attention panel');
  await cdp.waitFor(
    `window.__agentTeamsDevStore.getState().openTabs.some((tab) =>
      tab.type === "team" && tab.teamName === ${JSON.stringify(second)})`,
    'exact second team tab opened for chat');
  await until(async () => cdp.evaluate(`(async () => {
    const ui = await import('/components/team/sidebar/teamSidebarUiState.ts');
    const chat = ui.getTeamMessagesSidebarUiState(
      JSON.stringify(['local', ${JSON.stringify(second)}])
    );
    return chat.conversationScope?.kind === 'direct' && chat.conversationScope.participant === 'bob' &&
      chat.messagesFilter.from.size === 0 && chat.messagesFilter.to.size === 0 &&
      document.body.innerText.includes(${JSON.stringify('ATTENTION_E2E_DIRECT_' + second)});
  })()`), 'exact bob thread and unread message visible despite stale participant filters', 60000);
  evidence.checks.push('cross-team Messenger conversation navigation');
  await until(async () => cdp.evaluate(`(async () => {
    const reads = await import('/utils/teamMessageReadStorage.ts');
    const root = await window.electronAPI.config.getClaudeRootInfo();
    const scope = reads.getTeamMessageReadContextScope('local', root);
    const direct = reads.getReadSet(reads.getTeamMessageReadStorageKey(${JSON.stringify(second)}, scope));
    return direct.has(${JSON.stringify('attention-dm-' + second)});
  })()`), 'Messenger marks the canonical direct relay read');
  await cdp.evaluate('window.__agentTeamsDevStore.getState().openDashboard()');
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    return Boolean(panel && !panel.textContent.includes(${JSON.stringify('ATTENTION_E2E_DIRECT_' + second)}));
  })()`), 'canonical direct relay disappears from Attention after reading');
  evidence.checks.push('duplicate direct relay clears via canonical Messenger read key');

  // Engage the team watch scope before modifying its disposable task file.
  await cdp.evaluate(`window.electronAPI.teams.getData(${JSON.stringify(first)})`);
  await cdp.evaluate(`window.electronAPI.teams.setTaskClarification(${JSON.stringify(first)}, '2', 'user')`);
  await until(async () => {
    snap = await getSnapshot();
    return snap.teams.find((t) => t.teamName === first)?.tasks.length === 2;
  }, 'human clarification persisted by canonical controller setter');
  const added = snap.teams.find((t) => t.teamName === first).tasks.find((t) => t.taskId === '2');
  assert(Number.isFinite(Date.parse(added.requestedAt)), 'real transition timestamp recorded');
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")?.textContent.includes("Filler task 2")',
    'live Dashboard reflects newly requested human clarification without reload', 30_000);
  await cdp.evaluate(`window.electronAPI.teams.setTaskClarification(${JSON.stringify(first)}, '2', 'user')`);
  const repeated = (await getSnapshot()).teams.find((t) => t.teamName === first)
    .tasks.find((t) => t.taskId === '2');
  assert.equal(repeated.requestedAt, added.requestedAt, 'same-value setter keeps request age');

  // Real Task Detail comment UI must submit the bound request generation through
  // the normal Electron IPC path. No second Mark Resolved click is permitted.
  const requestBeforeAnswer = await cdp.evaluate(
    `window.electronAPI.teams.getTask(${JSON.stringify(first)}, '2')`);
  assert.match(requestBeforeAnswer.clarificationRequestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const oldRequestId = requestBeforeAnswer.clarificationRequestId;
  await cdp.evaluate(`(() => {
    const panel = [...document.querySelectorAll('[data-testid=user-attention-inbox]')]
      .find((element) => element.getClientRects().length > 0);
    const button = [...(panel?.querySelectorAll('button') ?? [])].find((element) =>
      element.getAttribute('aria-label')?.includes('Filler task 2'));
    if (!button) throw new Error('Expected task answer deep link');
    button.click();
  })()`);
  // Wait for task-detail ownership before typing through Chromium's real input path.
  const answerField = `document.querySelector('[role="dialog"] textarea[id^="task-comment-input-"]')`;
  const answerButton = `${answerField}?.closest('.message-composer-flat-layout')?.querySelector('button.message-composer-send-button')`;
  await cdp.waitFor(`(() => {
    const field = ${answerField};
    return field && field.getClientRects().length > 0 && !field.disabled && !field.readOnly;
  })()`, 'writable task-scoped answer editor');
  await cdp.evaluate(`(() => {
    const field = ${answerField};
    field.focus();
    if (document.activeElement !== field) throw new Error('Task answer editor not focused');
  })()`);
  await cdp.send('Input.insertText', { text: 'Use PostgreSQL for this task' });
  await cdp.waitFor(`(() => {
    const button = ${answerButton};
    return ${answerField}?.value === 'Use PostgreSQL for this task' &&
      window.__agentTeamsDevStore.getState().taskDetailSessionById[${JSON.stringify(JSON.stringify(['local', first, '2']))}]?.commentText === 'Use PostgreSQL for this task' &&
      button && button.getClientRects().length > 0 && !button.disabled;
  })()`, 'task answer draft accepted and submit enabled');
  await cdp.evaluate(`(() => { const button = ${answerButton};
    if (!button || button.disabled || !button.getClientRects().length) throw new Error('Task answer submit missing');
    button.click(); })()`);
  await until(async () => {
    const task = await cdp.evaluate(
      `window.electronAPI.teams.getTask(${JSON.stringify(first)}, '2')`);
    return task.needsClarification === undefined &&
      task.clarificationRequestId === undefined &&
      task.status === 'pending' &&
      task.comments?.some((comment) => comment.id === 'clarification-answer-' + oldRequestId &&
        comment.text === 'Use PostgreSQL for this task');
  }, 'task comment and clarification cleared in same persisted task', 60_000);
  // The answer must also reach the owning agent or lead durably. This verifies
  // the existing notification journal rather than just a disappearing UI row.
  const expectedAnswerCommentId = 'clarification-answer-' + oldRequestId;
  const expectedNotificationId =
    'task-comment-forward:' + first + ':2:' + expectedAnswerCommentId;
  const leadInbox = path.join(claude, 'teams', first, 'inboxes', 'team-lead.json');
  await until(async () => {
    try {
      const messages = JSON.parse(await readFile(leadInbox, 'utf8'));
      return messages.some((message) =>
        message.messageId === expectedNotificationId &&
        message.commentId === expectedAnswerCommentId &&
        message.to === 'team-lead' &&
        message.source === 'system_notification');
    } catch { return false; }
  }, 'user answer notification persisted to owning lead', 60_000);
  evidence.checks.push('user answer notification persisted with stable id');

  await cdp.evaluate('window.__agentTeamsDevStore.getState().closeGlobalTaskDetail()');
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")?.textContent.includes("Filler task 2") === false',
    'answered task disappears without manually marking resolved', 30_000);
  const firstAnswer = await cdp.evaluate(
    `window.electronAPI.teams.getTask(${JSON.stringify(first)}, '2')`);
  await cdp.evaluate(`window.electronAPI.teams.addTaskComment(
    ${JSON.stringify(first)}, '2', {
      text: 'Use PostgreSQL for this task',
      answerClarificationRequestId: ${JSON.stringify(oldRequestId)}
    })`);
  const afterRetry = await cdp.evaluate(
    `window.electronAPI.teams.getTask(${JSON.stringify(first)}, '2')`);
  assert.deepEqual(afterRetry.comments, firstAnswer.comments,
    'uncertain duplicate submission does not append a comment');
  const answerNotices = JSON.parse(await readFile(leadInbox, 'utf8'))
    .filter((message) => message.commentId === expectedAnswerCommentId);
  assert.equal(answerNotices.length, 1,
    'retry does not deliver the same user answer notification twice');
  await cdp.evaluate(`window.electronAPI.teams.setTaskClarification(${JSON.stringify(first)}, '2', 'user')`);
  const newCycle = await cdp.evaluate(
    `window.electronAPI.teams.getTask(${JSON.stringify(first)}, '2')`);
  assert(newCycle.clarificationRequestId && newCycle.clarificationRequestId !== oldRequestId,
    'fresh question gets an independent generation');
  const staleOutcome = await cdp.evaluate(`window.electronAPI.teams.addTaskComment(
    ${JSON.stringify(first)}, '2', {
      text: 'Use PostgreSQL for this task',
      answerClarificationRequestId: ${JSON.stringify(oldRequestId)}
    }).then(() => 'accepted', () => 'rejected')`);
  assert.equal(staleOutcome, 'rejected', 'old response cannot clear new request');
  const freshAfterStale = await cdp.evaluate(
    `window.electronAPI.teams.getTask(${JSON.stringify(first)}, '2')`);
  assert.equal(freshAfterStale.clarificationRequestId, newCycle.clarificationRequestId);
  assert.equal(freshAfterStale.needsClarification, 'user');
  evidence.checks.push('real Task Detail user answer, atomic handoff, retry and stale-cycle E2E');
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")?.textContent.includes("Filler task 2")',
    'new clarification returns to live Dashboard', 30_000);
  // Test-only cleanup after asserting that the stale answer cannot clear B.
  await cdp.evaluate(`window.electronAPI.teams.setTaskClarification(${JSON.stringify(first)}, '2', null)`);

  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")?.textContent.includes("Filler task 2") === false',
    'live Dashboard removes resolved clarification without reload', 30_000);
  evidence.checks.push('controller transition / repeated setter / clear');
  evidence.checks.push('live Dashboard clarification appears and disappears');

  // Historical messages still need attention after their sender is removed.
  const formerInbox = path.join(claude, 'teams', first, 'inboxes', 'user.json');
  const existing = JSON.parse(await readFile(formerInbox, 'utf8'));
  await json(formerInbox, [...existing, {
    from: 'former', to: 'user', text: 'ATTENTION_E2E_REMOVED_MEMBER',
    timestamp: nowIso(), read: false, messageId: 'attention-former-' + first,
  }]);
  await until(async () => {
    const snapshot = await getSnapshot();
    const team = snapshot.teams.find((entry) => entry.teamName === first);
    return team?.directParticipants?.includes('alice') &&
      !team.directParticipants.includes('former') &&
      team.messages.some((message) => message.messageId === 'attention-former-' + first);
  }, 'removed member remains an unread candidate without an active direct thread', 90_000);

  // A long waiting task ranks above a newer one, without starving the chat list.
  // Legacy tasks have no known request timestamp, so they are accessible via More.
  for (let taskId = 3; taskId <= 12; taskId++) {
    await cdp.evaluate(`window.electronAPI.teams.setTaskClarification(${JSON.stringify(first)}, ${JSON.stringify(String(taskId))}, 'user')`);
  }
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    const buttons = [...(panel?.querySelectorAll('button[aria-label^="Open task"]') ?? [])];
    const more = panel?.querySelector('[data-testid=attention-tasks-more]');
    return panel?.querySelector('[data-testid=attention-task-count]')?.textContent.trim().endsWith('12') &&
      buttons[0]?.getAttribute('aria-label')?.includes('Filler task 3') &&
      buttons.length === 8 && Boolean(more) &&
      !panel.textContent.includes('Time unknown') &&
      panel.textContent.includes('Unread chats') &&
      [...panel.querySelectorAll('button')].some((button) =>
        button.getClientRects().length > 0 &&
        button.textContent.includes('ATTENTION_E2E_REMOVED_MEMBER'));
  })()`), 'longest known waiting decision first, eight tasks, chats still visible');
  const expanded = await cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    const more = panel?.querySelector('[data-testid=attention-tasks-more]');
    if (!more) return false;
    more.click();
    return true;
  })()`);
  assert(expanded, 'show more tasks control is actionable');
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    const buttons = [...(panel?.querySelectorAll('button[aria-label^="Open task"]') ?? [])];
    return buttons.length === 12 &&
      buttons[0]?.getAttribute('aria-label')?.includes('Filler task 3') &&
      buttons.some((button) => button.textContent.includes('ATTENTION_E2E_OLDEST_USER_DECISION')) &&
      !panel.textContent.includes('Time unknown') &&
      [...panel.querySelectorAll('button')].some((button) =>
        button.getClientRects().length > 0 &&
        button.textContent.includes('ATTENTION_E2E_REMOVED_MEMBER'));
  })()`), 'load more retains legacy decisions and the actual unread chat');
  evidence.checks.push('waiting-first decisions + recent chats + eight-at-a-time expansion');

  await cdp.screenshot(path.join(artifactRoot, 'attention-dashboard.png'));

  // The same unread historical message remains actionable after task expansion.
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    const row = Array.from(panel?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent.includes('ATTENTION_E2E_REMOVED_MEMBER'));
    if (!row) return false;
    row.click();
    return true;
  })()`), 'live removed-member Attention row is actionable', 90_000);
  await until(async () => cdp.evaluate(`(async () => {
    const ui = await import('/components/team/sidebar/teamSidebarUiState.ts');
    const state = window.__agentTeamsDevStore.getState();
    const active = state.getAllPaneTabs().find((tab) => tab.id === state.activeTabId);
    const chat = ui.getTeamMessagesSidebarUiState(JSON.stringify([state.activeContextId, ${JSON.stringify(first)}]));
    return active?.type === 'team' && active.teamName === ${JSON.stringify(first)} &&
      chat.conversationSurface === 'thread' && chat.conversationScope.kind === 'team-feed' &&
      !chat.messagesCollapsed && document.body.innerText.includes('ATTENTION_E2E_REMOVED_MEMBER');
  })()`), 'removed-member message opens the actual team-feed thread');
  await cdp.screenshot(path.join(artifactRoot, 'attention-removed-member.png'));
  evidence.checks.push('removed member unread message routes to an available team-feed');

  // The reserved All agents conversation is represented by team-feed, not a
  // custom group row. Persist one canonical incoming group message, without
  // creating any provider delivery or launching an agent.
  await cdp.evaluate('window.__agentTeamsDevStore.getState().openDashboard()');
  const groupMessageId = randomUUID();
  const groupInbox = path.join(claude, 'teams', second, 'inboxes', 'user.json');
  const groupRows = JSON.parse(await readFile(groupInbox, 'utf8'));
  await json(groupInbox, [...groupRows, {
    from: 'bob', to: 'user', text: '@user ATTENTION_E2E_STANDARD_GROUP',
    timestamp: nowIso(), read: false, messageId: groupMessageId,
    groupChatId: DEFAULT_TEAM_GROUP_CHAT_ID, groupChatName: DEFAULT_TEAM_GROUP_CHAT_NAME,
    groupMessageId, groupChatProtocolVersion: 1,
    groupRecipientNames: [], groupRecipientRunKeys: {},
  }]);
  await until(async () => {
    const snapshot = await getSnapshot();
    return snapshot.teams.find((entry) => entry.teamName === second)?.messages.some(
      (message) => message.messageId === groupMessageId &&
        message.groupChatId === DEFAULT_TEAM_GROUP_CHAT_ID);
  }, 'standard group mention present in canonical attention source', 90_000);
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    const row = Array.from(panel?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent.includes('ATTENTION_E2E_STANDARD_GROUP'));
    if (!row) return false;
    row.click();
    return true;
  })()`), 'open standard group mention through Attention', 90_000);
  await until(async () => cdp.evaluate(`(async () => {
    const ui = await import('/components/team/sidebar/teamSidebarUiState.ts');
    const state = window.__agentTeamsDevStore.getState();
    const active = state.getAllPaneTabs().find((tab) => tab.id === state.activeTabId);
    const chat = ui.getTeamMessagesSidebarUiState(JSON.stringify([state.activeContextId, ${JSON.stringify(second)}]));
    const customGroupComposer = [...document.querySelectorAll('[data-testid=group-chat-composer]')]
      .some(node => node.getClientRects().length > 0);
    return active?.type === 'team' && active.teamName === ${JSON.stringify(second)} &&
      chat.conversationSurface === 'thread' && chat.conversationScope.kind === 'team-feed' &&
      !chat.messagesCollapsed && !customGroupComposer &&
      document.body.innerText.includes('ATTENTION_E2E_STANDARD_GROUP');
  })()`), 'standard group uses Messenger team feed and normal composer');
  await cdp.screenshot(path.join(artifactRoot, 'attention-standard-group.png'));
  await until(async () => cdp.evaluate(`(async () => {
    const reads = await import('/utils/teamMessageReadStorage.ts');
    const root = await window.electronAPI.config.getClaudeRootInfo();
    const scope = reads.getTeamMessageReadContextScope('local', root);
    const group = reads.getReadSet(reads.getTeamMessageReadStorageKey(${JSON.stringify(second)}, scope, 'group'));
    const direct = reads.getReadSet(reads.getTeamMessageReadStorageKey(${JSON.stringify(second)}, scope));
    return group.has(${JSON.stringify(groupMessageId)}) && !direct.has(${JSON.stringify(groupMessageId)});
  })()`), 'visible standard group mention uses shared group read storage');
  await cdp.evaluate('window.__agentTeamsDevStore.getState().openDashboard()');
  await cdp.waitFor(
    'document.querySelector("[data-testid=user-attention-inbox]")?.textContent.includes("ATTENTION_E2E_STANDARD_GROUP") === false',
    'standard group mention disappears after being read in Messenger');

  evidence.checks.push('standard group mention opens team-feed and clears through shared group read state');

  // Complete every test-only request and mark all source messages read. The
  // dashboard should immediately shrink to its compact, explanatory state.
  await cdp.evaluate(`(async () => {
    const snapshot = await window.electronAPI.getUserAttentionSnapshot();
    for (const team of snapshot.teams) {
      for (const task of team.tasks) {
        await window.electronAPI.teams.setTaskClarification(team.teamName, task.taskId, null);
      }
    }
    const reads = await import('/utils/teamMessageReadStorage.ts');
    const root = await window.electronAPI.config.getClaudeRootInfo();
    const scope = reads.getTeamMessageReadContextScope('local', root);
    for (const team of snapshot.teams) {
      for (const message of team.messages) {
        const key = reads.getTeamMessageReadStorageKey(
          team.teamName, scope, message.groupChatId ? 'group' : undefined
        );
        reads.markRead(key, message.messageId);
      }
    }
  })()`);
  await until(async () => {
    const snapshot = await getSnapshot();
    return snapshot.complete && snapshot.teams.every((team) => team.tasks.length === 0);
  }, 'all test-only human decisions resolved');
  await until(async () => cdp.evaluate(`(() => {
    const panel = Array.from(document.querySelectorAll('[data-testid=user-attention-inbox]'))
      .find((node) => node.getClientRects().length > 0);
    return Boolean(panel) &&
      panel.textContent.includes('Tasks awaiting your decision and unread team chats will appear here.') &&
      panel.getBoundingClientRect().height < 110 &&
      panel.querySelector('[data-testid=attention-counts]') === null &&
      panel.querySelectorAll('button[aria-label^="Open task"]').length === 0;
  })()`), 'compact explanatory empty state after all items resolved', 30_000);
  await cdp.screenshot(path.join(artifactRoot, 'attention-empty.png'));
  evidence.checks.push('compact empty state and live resolution of all requests');
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
  await checkBudgetDesktop({ cdp, first, artifactRoot, until, evidence });
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
