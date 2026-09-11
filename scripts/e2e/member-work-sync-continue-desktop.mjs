#!/usr/bin/env node
// Disposable Electron renderer E2E for member-work-sync Continue.
// Seeds an isolated team/project, launches `pnpm dev:mcp`, opens the member
// dialog, clicks Continue, and proves the renderer invoked continueManually.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const apiModuleSuffix = '/src/renderer/api/index.ts';
const expectedApiModulePaths = new Set([
  '/api/index.ts',
  apiModuleSuffix,
  `/@fs${repoRoot}${apiModuleSuffix}`,
  `/@fs/${repoRoot}${apiModuleSuffix}`,
]);
const apiNeedle = 'function getImpl() {\n  if (window.electronAPI) return window.electronAPI;';
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
  if (appLogTail.length > 200) appLogTail.splice(0, appLogTail.length - 200);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function seedFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'work-sync-continue-e2e-')));
  const runtimeLock = JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
  const fixture = {
    kind: 'member-work-sync-continue-desktop-v1',
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
    teamName: `wsync-e2e-${randomUUID()}`,
    memberName: 'team-lead',
    runtimeWrapperPath: path.join(root, 'fixture-runtime-deny.cjs'),
    runtimeLedgerPath: path.join(root, 'fixture-runtime-ledger.ndjson'),
    deliveryRuntimeVersion: runtimeLock.version,
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
      `const fs = require('node:fs');\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args.length === 1 && args[0] === '--version') {\n` +
      `  process.stdout.write(${JSON.stringify(`${runtimeLock.version}\n`)});\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `fs.appendFileSync(${JSON.stringify(fixture.runtimeLedgerPath)}, JSON.stringify({ args, at: Date.now() }) + '\\n');\n` +
      `process.stderr.write('fixture runtime denies all lifecycle and provider commands\\n');\n` +
      `process.exit(77);\n`
  );
  await chmod(fixture.runtimeWrapperPath, 0o755);
  await writeFile(fixture.runtimeLedgerPath, '');
  await writeFile(path.join(fixture.projectPath, 'README.md'), '# Disposable Continue E2E\n');
  const member = {
    name: fixture.memberName,
    agentId: `${fixture.memberName}@${fixture.teamName}`,
    agentType: 'team-lead',
    role: 'Lead',
    providerId: 'opencode',
    providerBackendId: 'opencode-cli',
    model: 'test-model',
    color: 'blue',
    cwd: fixture.projectPath,
    joinedAt: Date.now(),
    subscriptions: [],
  };
  const teamDir = path.join(fixture.claudeRoot, 'teams', fixture.teamName);
  await json(path.join(fixture.claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  await json(path.join(teamDir, 'config.json'), {
    name: fixture.teamName,
    description: 'Disposable Continue E2E fixture',
    color: 'blue',
    language: 'en',
    createdAt: Date.now(),
    leadAgentId: member.agentId,
    members: [member],
    projectPath: fixture.projectPath,
    projectPathHistory: [fixture.projectPath],
  });
  await json(path.join(teamDir, 'members.meta.json'), { version: 1, members: [member] });
  await json(path.join(teamDir, 'team.meta.json'), {
    version: 1,
    cwd: fixture.projectPath,
    providerId: 'opencode',
    model: 'test-model',
    prompt: 'Renderer fixture only. Never launch any provider.',
    createdAt: Date.now(),
  });
  await mkdir(path.join(fixture.claudeRoot, 'projects'), { recursive: true });
  await mkdir(path.join(fixture.claudeRoot, 'tasks', fixture.teamName), { recursive: true });
  await json(path.join(root, 'fixture.json'), fixture);
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
  const env = {
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
  };
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
    this.listeners = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        Promise.resolve(listener(message.params)).catch((error) => {
          process.stderr.write(`CDP listener ${message.method} failed: ${String(error)}\n`);
        });
      }
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed'));
      }
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

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
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
    let lastTransientError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return;
        lastTransientError = null;
      } catch (error) {
        if (
          !/execution context was destroyed|cannot find (?:default )?execution context/i.test(
            String(error)
          )
        ) {
          throw error;
        }
        lastTransientError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(
      `Timed out waiting for ${label}${lastTransientError ? `: ${String(lastTransientError)}` : ''}`
    );
  }

  close() {
    this.socket.close();
  }
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
      cdp.close();
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
  if (fixture?.root && process.env.MEMBER_WORK_SYNC_CONTINUE_E2E_KEEP !== '1') {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(fixture.root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 7) {
          process.stderr.write(`Fixture cleanup failed: ${String(error)}\n`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}

async function dumpRenderer(client, label) {
  if (!client) return;
  try {
    const snapshot = await client.evaluate(`(() => {
      const state = window.__agentTeamsDevStore?.getState?.();
      const fixture = window.__workSyncContinueE2E;
      return {
        label: ${JSON.stringify(label)},
        hasFixtureApi: Boolean(fixture?.createApi),
        getStatus: fixture?.getStatus ?? [],
        continue: fixture?.continue ?? [],
        paneTabs: (state?.paneLayout?.panes ?? []).flatMap((pane) =>
          (pane.tabs ?? []).map((tab) => ({ type: tab.type, teamName: tab.teamName, id: tab.id }))
        ),
        focusedPaneId: state?.paneLayout?.focusedPaneId,
        teams: (state?.teams ?? []).map((team) => team.teamName),
        selectedTeamName: state?.selectedTeamName,
        selectedMembers: (state?.selectedTeamData?.members ?? []).map((member) => member.name),
        pendingMemberProfile: state?.pendingMemberProfile,
        dialog: Boolean(document.querySelector('[role="dialog"]')),
        continueButton: Boolean(document.querySelector('[data-testid="member-work-sync-continue"]')),
        bodyText: (document.body?.innerText ?? '').slice(0, 800),
      };
    })()`);
    process.stderr.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Renderer dump failed: ${String(error)}\n`);
  }
}

const attentionStatus = (fixture) => ({
  teamName: fixture.teamName,
  memberName: fixture.memberName,
  state: 'needs_sync',
  agenda: {
    teamName: fixture.teamName,
    memberName: fixture.memberName,
    generatedAt: '2026-04-29T00:20:00.000Z',
    fingerprint: 'agenda:v1:continue-e2e',
    items: [
      {
        taskId: 'task-1',
        displayId: '11111111',
        subject: 'Recover stuck work',
        kind: 'work',
        assignee: fixture.memberName,
        priority: 'normal',
        reason: 'owned_pending_task',
        evidence: { status: 'pending', owner: fixture.memberName },
      },
    ],
    diagnostics: [],
  },
  shadow: { reconciledBy: 'queue', wouldNudge: true, fingerprintChanged: false },
  evaluatedAt: '2026-04-29T00:20:00.000Z',
  diagnostics: [],
  recoveryHealth: {
    schemaVersion: 1,
    attentionAt: '2026-04-29T00:20:00.000Z',
    episodes: [
      {
        episodeId: 'episode:task-1:team-lead:2026-04-29T00:00:00.000Z',
        workKey: `task-1:${fixture.memberName}`,
        taskId: 'task-1',
        firstObservedAt: '2026-04-29T00:00:00.000Z',
        dueAt: '2026-04-29T00:20:00.000Z',
        phase: 'attention',
        reason: 'no_progress_deadline',
      },
    ],
  },
});

function fixtureBootstrap(fixture) {
  return `(() => {
    const status = ${JSON.stringify(attentionStatus(fixture))};
    const state = {
      getStatus: [],
      continue: [],
      status,
      createApi(realApi) {
        const memberWorkSync = {
          ...realApi.memberWorkSync,
          getStatus: async (request) => {
            state.getStatus.push(request);
            return status;
          },
          continueManually: async (request) => {
            state.continue.push(request);
            return status;
          },
        };
        return new Proxy({}, {
          get(_target, property) {
            if (property === 'memberWorkSync') return memberWorkSync;
            const value = Reflect.get(realApi, property, realApi);
            return typeof value === 'function' ? value.bind(realApi) : value;
          },
        });
      },
    };
    window.__workSyncContinueE2E = state;
  })();`;
}

async function installApiInterception(client, fixture) {
  let patchCount = 0;
  let patchError = null;
  const observedScriptPaths = new Set();
  let resolveFirstPatch;
  let rejectFirstPatch;
  const firstPatch = new Promise((resolve, reject) => {
    resolveFirstPatch = resolve;
    rejectFirstPatch = reject;
  });
  client.on('Fetch.requestPaused', async (event) => {
    const url = new URL(event.request.url);
    observedScriptPaths.add(url.pathname);
    if (!expectedApiModulePaths.has(url.pathname) || !event.responseStatusCode) {
      await client.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    try {
      const bodyResult = await client.send('Fetch.getResponseBody', { requestId: event.requestId });
      const source = bodyResult.base64Encoded
        ? Buffer.from(bodyResult.body, 'base64').toString('utf8')
        : bodyResult.body;
      const occurrences = source.split(apiNeedle).length - 1;
      assert.equal(occurrences, 1, 'Expected exactly one getImpl fixture injection needle');
      const replacement = `${apiNeedle.split('\n')[0]}\n  const continueFixture = window.__workSyncContinueE2E;\n  if (window.electronAPI && continueFixture?.createApi) return continueFixture.createApi(window.electronAPI);\n  ${apiNeedle.split('\n')[1]}`;
      const patched = source.replace(apiNeedle, replacement);
      const headers = (event.responseHeaders ?? []).filter(
        (header) => !['content-length', 'content-encoding'].includes(header.name.toLowerCase())
      );
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: event.responseStatusCode,
        responsePhrase: event.responseStatusText,
        responseHeaders: headers,
        body: Buffer.from(patched).toString('base64'),
      });
      patchCount += 1;
      resolveFirstPatch();
    } catch (error) {
      patchError = error;
      rejectFirstPatch(error);
      await client
        .send('Fetch.failRequest', {
          requestId: event.requestId,
          errorReason: 'Failed',
        })
        .catch(() => undefined);
    }
  });
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api/index.ts*', resourceType: 'Script', requestStage: 'Response' }],
  });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureBootstrap(fixture) });
  await client.send('Page.reload', { ignoreCache: true });
  let timeout;
  try {
    await Promise.race([
      firstPatch,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `API module was not intercepted; observed ${JSON.stringify(
                  [...observedScriptPaths]
                    .filter((value) => /api|renderer/i.test(value))
                    .slice(-100)
                )}`
              )
            ),
          30_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (patchError) throw patchError;
  assert(patchCount >= 1, 'API module was not patched');
}

async function main() {
  const fixture = await seedFixture();
  let failure = null;
  const step = (label) => {
    process.stdout.write(`step: ${label}\n`);
  };
  try {
    const { port, renderer } = await startApp(fixture);
    process.stdout.write(`Using isolated dev:mcp CDP port ${port}\n`);
    cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    step('waiting for native API');
    await cdp.waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'native API and dev store',
      60_000
    );
    const native = await cdp.evaluate(`(async () => {
      const teams = await window.electronAPI.teams.list();
      return teams.map((team) => team.teamName);
    })()`);
    assert.deepEqual(native, [fixture.teamName]);
    step('installing API interception');
    await installApiInterception(cdp, fixture);
    step('waiting for intercepted API');
    await cdp.waitFor(
      'window.__workSyncContinueE2E?.createApi && window.__agentTeamsDevStore && window.electronAPI?.teams',
      'intercepted renderer API and dev store',
      60_000
    );
    step('waiting for hydrated team list');
    await cdp.waitFor(
      `(() => { const state = window.__agentTeamsDevStore?.getState(); return Boolean(
        state?.paneLayout?.focusedPaneId && state?.paneLayout?.panes?.length && !state?.teamsLoading &&
        state?.teams?.some((team) => team.teamName === ${JSON.stringify(fixture.teamName)})); })()`,
      'hydrated fixture team',
      60_000
    );
    step('opening teams list');
    await cdp.evaluate(`window.__agentTeamsDevStore.getState().openTeamsTab()`);
    await cdp.waitFor(
      `(() => {
        const state = window.__agentTeamsDevStore?.getState();
        const pane = state?.paneLayout?.panes?.find((candidate) =>
          candidate.id === state.paneLayout.focusedPaneId);
        return pane?.tabs?.find((tab) => tab.id === pane.activeTabId)?.type === 'teams';
      })()`,
      'active Teams tab',
      60_000
    );
    await cdp.waitFor(
      `Boolean(Array.from(document.querySelectorAll('[role="button"]')).find((element) =>
        element.querySelector('h3')?.textContent?.trim() === ${JSON.stringify(fixture.teamName)}))`,
      'fixture team card',
      60_000
    );
    step('opening team tab');
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
    step('waiting for team data');
    await cdp.waitFor(
      `(() => {
        const data = window.__agentTeamsDevStore?.getState()?.selectedTeamData;
        return data?.teamName === ${JSON.stringify(fixture.teamName)} &&
          Boolean(data?.members?.some((member) => member.name === ${JSON.stringify(
            fixture.memberName
          )}));
      })()`,
      'loaded fixture team data',
      60_000
    );
    step('opening member profile');
    const continueSelector = '[data-testid="member-work-sync-continue"]';
    const opened = Date.now() + 30_000;
    while (Date.now() < opened) {
      await cdp.evaluate(
        `window.__agentTeamsDevStore.getState().openMemberProfile(${JSON.stringify(
          fixture.memberName
        )}, ${JSON.stringify(fixture.teamName)})`
      );
      if (
        await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(continueSelector)}))`)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await cdp.waitFor(
      `Boolean(document.querySelector(${JSON.stringify(continueSelector)}))`,
      'Continue control',
      5_000
    );
    step('clicking Continue');
    await cdp.evaluate(`document.querySelector(${JSON.stringify(continueSelector)}).click()`);
    await cdp.waitFor(
      `window.__workSyncContinueE2E.continue.length > 0`,
      'Continue API invocation',
      10_000
    );
    const calls = await cdp.evaluate(
      `({ getStatus: window.__workSyncContinueE2E.getStatus, continue: window.__workSyncContinueE2E.continue })`
    );
    assert.equal(calls.continue.length, 1);
    assert.equal(calls.continue[0].teamName, fixture.teamName);
    assert.equal(calls.continue[0].memberName, fixture.memberName);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          teamName: fixture.teamName,
          memberName: fixture.memberName,
          continueCalls: calls.continue,
        },
        null,
        2
      ) + '\n'
    );
  } catch (error) {
    failure = error;
    await dumpRenderer(cdp, 'failure');
  } finally {
    await cleanup(fixture);
  }
  if (failure) throw failure;
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.stderr.write(`${appLogTail.slice(-40).join('\n')}\n`);
  process.exitCode = 1;
});
