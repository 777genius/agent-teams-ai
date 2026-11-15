#!/usr/bin/env node
// Real Windows Electron/teammate lifecycle. Only the model HTTP boundary is synthetic.
// No credentials, paid inference, user projects or production profiles are used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpClient } from './comment-notification/cdp.mjs';
import { prepareNativeDesktopEnvironment } from './opencode-native-desktop-environment.ts';
import { startGroupChatModelServer } from './group-chat-model-server.ts';
import { getExpectedRuntimeCliVersion, matchesRuntimeCliVersion } from '../lib/runtime-cli-version.mjs';

assert.equal(process.platform, 'win32', 'This proof requires a Windows GUI runner');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimePath = path.join(repoRoot, 'resources/runtime/claude-multimodel.exe');
assert((await stat(runtimePath)).isFile(), 'Stage the pinned Windows runtime first');
const lock = JSON.parse(await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
const version = spawnSync(runtimePath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
assert.equal(version.status, 0, 'Pinned runtime did not execute');
assert(matchesRuntimeCliVersion(version.stdout, getExpectedRuntimeCliVersion(lock)),
  'Staged executable CLI version differs from runtime.lock.json cliVersion');

const fixture = await prepareNativeDesktopEnvironment();
const { root, projectPath, teamName, env } = fixture;
const receiptDir = process.env.WINDOWS_PRODUCT_CONSOLE_EVIDENCE ||
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'windows-product-console-' + randomUUID());
await mkdir(receiptDir, { recursive: true });
const receiptPath = path.join(receiptDir, 'windows-product-console.json');
const modelPath = path.join(receiptDir, 'model-requests.ndjson');
const screenshot = path.join(receiptDir, 'windows-product-console.png');
const proofs = new Map();
const expected = new Map();
let app;
let appBirth;
let mainBirth;
let client;
let mainInspector;
let model;
let launched = false;
let stopped = false;
let originalMember;
let log = '';
let phase = 'setup';
let protocolFailure = null;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const literal = (value) => JSON.stringify(value);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  if (!isRecord(value)) return '';
  return typeof value.text === 'string' ? value.text : contentText(value.content);
}

function modelToolDecision(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const requestText = messages.filter(m => m?.role === 'user').map(m => contentText(m.content)).join('\n');
  const directive = [...requestText.matchAll(/WIN_NATIVE_TOOL:(cmd|git|powershell):([0-9a-f-]{36})/g)].at(-1);
  if (!directive) return undefined;
  const kind = directive[1], token = directive[2], key = kind + ':' + token;
  if (!expected.has(key)) return { id: 'unowned-request-' + token, text: 'No owned test action' };
  const toolId = 'toolu_' + token.replaceAll('-', '') + '_' + kind;
  const result = messages.flatMap(m => {
    if (m?.role === 'tool' && m.tool_call_id === toolId) return [contentText(m.content)];
    if (!Array.isArray(m?.content)) return [];
    return m.content.filter(part => part?.type === 'tool_result' && part.tool_use_id === toolId)
      .map(part => contentText(part.content));
  }).at(-1);
  if (result !== undefined) {
    if (!result.includes(expected.get(key))) {
      protocolFailure = 'Actual ' + kind + ' tool result omitted its OS execution marker';
      return { id: 'failed_' + token.replaceAll('-', ''), text: 'Tool result did not qualify.' };
    }
    proofs.set(key, { kind, token, marker: expected.get(key), toolId, realToolResultSeen: true });
    return { id: 'done_' + token.replaceAll('-', ''), text: 'Native tool completed.' };
  }
  const names = (Array.isArray(body.tools) ? body.tools : [])
    .map(t => t?.function?.name ?? t?.name).filter(n => typeof n === 'string');
  const bash = names.find(n => /^(?:Bash|bash|shell|functions\.shell)$/.test(n));
  assert(bash, 'Native runtime did not expose a Bash/shell tool to teammate');
  const marker = expected.get(key);
  // Git Bash/MSYS translates native /c into a drive path; //c reaches cmd.exe as /c.
  const command = kind === 'cmd'
    ? 'cmd.exe //d //c echo ' + marker
    : kind === 'git'
      ? 'git.exe --version && echo ' + marker
      : 'powershell.exe -NoProfile -NonInteractive -Command "Write-Output ' +
        marker + '; Start-Sleep -Milliseconds 600"';
  return { id: toolId, name: bash, input: { command, description: 'Disposable Windows E2E native tool probe' } };
}

async function wait(label, read, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (protocolFailure) throw new Error(protocolFailure);
    if (app && (app.exitCode !== null || app.signalCode !== null))
      throw new Error('Owned desktop exited during ' + label + ': ' + log.slice(-3000));
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (!/execution context was destroyed|cannot find.*execution context/i.test(String(error))) throw error;
      last = error;
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for ' + label + (last ? ': ' + String(last) : ''));
}

async function getProcess(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Process lookup requires a positive PID');
  const script = "$ErrorActionPreference='Stop';" +
    "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "' -ErrorAction Stop;" +
    "if(-not $p){Write-Output 'null';exit 0};" +
    "@{pid=[int]$p.ProcessId;creation=[string]$p.CreationDate;" +
    "command=[string]$p.CommandLine;parent=[int]$p.ParentProcessId}|ConvertTo-Json -Compress";
  const found = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  if (found.status !== 0 || found.error) throw new Error('Win32 original process lookup failed');
  return JSON.parse(found.stdout.trim());
}

async function ownedStillAlive(before) {
  if (!before) return false;
  const now = await getProcess(before.pid);
  if (!now) return false;
  if (now.creation !== before.creation) throw new Error('Original process PID was reused');
  return true;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

async function api(expression) {
  assert(client);
  return client.evaluate('(async()=>await (' + expression + '))()');
}

async function run() {
  model = await startGroupChatModelServer(modelPath, modelToolDecision);
  Object.assign(env, {
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtimePath,
    ANTHROPIC_BASE_URL: model.baseUrl,
    ANTHROPIC_API_KEY: 'synthetic-owned-key',
    ANTHROPIC_AUTH_TOKEN: '',
    NODE_BINARY: process.execPath,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    pnpm_config_verify_deps_before_run: 'false',
    CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS: '180000',
    CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS: '180000',
  });
  // Only OS/display plumbing comes from the runner. Never inherit provider credentials.
  for (const key of ['CI', 'GITHUB_ACTIONS', 'RUNNER_TEMP', 'SystemRoot', 'WINDIR',
    'ComSpec', 'PATHEXT', 'Path', 'PATH', 'LANG', 'TMP', 'TEMP']) {
    if (process.env[key] && !env[key]) env[key] = process.env[key];
  }
  await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'synthetic-owned-key' } }));
  await writeFile(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT, 'agent-teams-config.json'),
    JSON.stringify({ general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark',
      defaultTab: 'teams', multimodelEnabled: true } }));
  await mkdir(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT, 'projects'), { recursive: true });
  phase = 'electron-startup';
  const port = await freePort();
  const inspectorPort = await freePort();
  app = spawn(process.execPath, [
    path.join(repoRoot, 'scripts/dev-with-runtime.mjs'),
    '--remoteDebuggingPort', String(port), '--inspect=' + inspectorPort,
  ], { cwd: repoRoot, env, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [app.stdout, app.stderr]) stream.on('data', b => {
    log = (log + b.toString()).slice(-30_000);
  });
  await wait('original desktop launcher PID', async () => {
    if (!app.pid) return false;
    const p = await getProcess(app.pid);
    if (!p || !p.command.includes('dev-with-runtime.mjs') || !p.command.includes(String(port))) return false;
    appBirth = p;
    return true;
  }, 30_000);
  const renderer = await wait('owned Electron renderer', async () => {
    if (!log.includes('DevTools listening on ws://127.0.0.1:' + port + '/')) return false;
    const targets = await fetch('http://127.0.0.1:' + port + '/json/list')
      .then(r => r.json()).catch(() => []);
    const target = targets.find(x => x.type === 'page' &&
      typeof x.url === 'string' && x.url.startsWith('http://localhost:'));
    return target?.webSocketDebuggerUrl || false;
  });
  client = await CdpClient.connect(renderer);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await wait('real Electron preload ready', () =>
    api('window.electronAPI?.startup?.getStatus().then(s=>s.ready)').catch(() => false));
  const inspectorUrl = await wait('owned Electron Main inspector', async () => {
    const match = new RegExp('Debugger listening on (ws://127\\.0\\.0\\.1:' +
      inspectorPort + '/[a-z0-9-]+)', 'i').exec(log);
    return match?.[1] || false;
  }, 30_000);
  mainInspector = await CdpClient.connect(inspectorUrl);
  await mainInspector.send('Runtime.enable');
  await mainInspector.evaluate(`(() => {
    const req = typeof require === 'function' ? require : process.mainModule?.require?.bind(process.mainModule);
    const {BrowserWindow} = req('electron');
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://localhost:'));
    if (!win) throw Error('Owned Electron window missing');
    globalThis.__winProductFocus = { pid: process.pid, before: win.isFocused(), blur: 0 };
    win.on('blur', () => { globalThis.__winProductFocus.blur++; });
    return true;
  })()`);
  const actualMainPid = await mainInspector.evaluate('globalThis.__winProductFocus.pid');
  mainBirth = await getProcess(actualMainPid);
  assert(mainBirth?.command?.toLowerCase().includes('electron.exe'),
    'Owned Electron Main Windows process birth/identity unavailable');
  phase = 'real-product-team-create';
  const request = {
    teamName, cwd: projectPath, providerId: 'anthropic', model: 'claude-sonnet-4-6',
    skipPermissions: true, syncModelsWithLead: false,
    prompt: 'Disposable Windows product E2E. Do not use tools or access files unless an explicit WIN_NATIVE_TOOL directive arrives.',
    members: [{ name: 'alice', providerId: 'anthropic', model: 'claude-sonnet-4-6',
      role: 'Disposable Windows E2E teammate' }],
  };
  await api(`(() => {
    window.__winProductLaunch = {done:false};
    window.electronAPI.teams.createTeam(${literal(request)}).then(
      value => {window.__winProductLaunch={done:true,value};},
      error => {window.__winProductLaunch={done:true,error:String(error)};}
    ); return true;
  })()`);
  const launch = await wait('product createTeam IPC result',
    () => client.evaluate('window.__winProductLaunch?.done ? window.__winProductLaunch : null'));
  if (launch.error) throw new Error('Product team launch failed: ' + launch.error);
  launched = true;
  const runtime = await wait('real teammate process observed through native IPC', async () => {
    const snap = await api(`window.electronAPI.teams.getTeamAgentRuntime(${literal(teamName)})`);
    const member = snap?.members?.alice, pid = member?.runtimePid ?? member?.pid;
    if (!member?.alive || !Number.isSafeInteger(pid) || pid <= 0) return false;
    const observed = await getProcess(pid);
    if (!observed?.command?.includes(teamName)) return false;
    originalMember = observed;
    return snap;
  }, 180_000);
  await client.screenshot(screenshot);
  phase = 'native-tool-invocations';
  for (const kind of ['cmd', 'git', 'powershell']) {
    const token = randomUUID(), key = kind + ':' + token;
    expected.set(key, 'WIN_TOOL_' + kind.toUpperCase() + '_' + token);
    await api(`window.electronAPI.teams.sendMessage(${literal(teamName)},
      ${literal({ member: 'alice', from: 'user', text: 'WIN_NATIVE_TOOL:' + key })})`);
    await wait('original ' + kind + ' tool result in live teammate runtime',
      () => proofs.get(key) || false, 150_000);
  }
  assert.equal(proofs.size, 3);
  assert.equal(model.errors.length, 0, 'Synthetic model protocol produced errors');
  phase = 'product-stop';
  await api(`window.electronAPI.teams.stop(${literal(teamName)})`);
  stopped = true;
  await wait('original teammate PID retired after product Stop', async () =>
    !(await ownedStillAlive(originalMember)), 30_000);
  const focus = await mainInspector.evaluate('globalThis.__winProductFocus');
  assert(focus.pid > 0 && Number.isSafeInteger(focus.blur));
  const evidence = {
    schemaVersion: 1, success: true, platform: process.platform,
    modelBoundary: 'loopback synthetic HTTP; no paid model inference',
    realElectronMainHosted: true, realProductTeammateLaunch: true,
    realProductStopConfirmed: true, nativeOsPidBound: true,
    originalTeammatePid: originalMember.pid, originalTeammateBirth: originalMember.creation,
    toolResults: [...proofs.values()], electronFocus: focus,
    actualConsoleWindowsEnumerated: false, forceAppExitDescendantsVerified: false,
    screenshot: path.basename(screenshot), runtimeVersion: lock.version,
  };
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ receiptPath, ...evidence }));
}

try {
  await run();
} catch (error) {
  await writeFile(receiptPath, JSON.stringify({
    schemaVersion: 1, success: false, phase, error: String(error),
    realProductTeammateLaunch: Boolean(originalMember),
    toolResults: [...proofs.values()], modelErrors: model?.errors ?? [],
    logTail: log.slice(-3500),
  }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  if (launched && !stopped && client) {
    await api(`window.electronAPI.teams.stop(${literal(teamName)})`).catch(() => undefined);
  }
  await mainInspector?.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  let cleanupOk = true;
  // The dev launcher can exit before Electron or a native teammate does.
  // Verify each original process birth and command before touching its PID;
  // never kill unknown/recycled PIDs or discard a still-in-use test profile.
  for (const { identity, marker } of [
    { identity: appBirth, marker: 'dev-with-runtime.mjs' },
    { identity: mainBirth, marker: 'electron.exe' },
    { identity: originalMember, marker: teamName },
  ]) {
    if (!identity) continue;
    try {
      const live = await getProcess(identity.pid);
      if (!live) continue;
      if (live.creation !== identity.creation ||
          !live.command.toLowerCase().includes(marker.toLowerCase()))
        throw new Error('Original Windows process identity changed');
      const killed = spawnSync('taskkill.exe', ['/PID', String(identity.pid), '/T', '/F'], {
        windowsHide: true, timeout: 15_000, encoding: 'utf8',
      });
      if (killed.error || killed.status !== 0) {
        if (await ownedStillAlive(identity))
          throw new Error('Original Windows process tree termination failed');
      }
      if (await ownedStillAlive(identity))
        throw new Error('Original Windows PID survived verified termination');
    } catch (error) {
      cleanupOk = false;
      process.stderr.write('Owned Windows E2E cleanup failed: ' + String(error) + '\n');
    }
  }
  await model?.close().catch(() => { cleanupOk = false; });
  if (cleanupOk && process.env.WINDOWS_PRODUCT_CONSOLE_KEEP !== '1') {
    await rm(root, { recursive: true, force: true }).catch(() => { cleanupOk = false; });
  }
  if (!cleanupOk) {
    process.exitCode = 1;
    try {
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      await writeFile(receiptPath, JSON.stringify({
        ...receipt, success: false, cleanupConfirmed: false,
      }, null, 2) + '\n');
    } catch { /* The original failure and process evidence stay in CI logs. */ }
  }
}
