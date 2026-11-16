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
const hwndReady = path.join(receiptDir, 'hwnd-ready.txt');
const hwndStop = path.join(receiptDir, 'hwnd-stop.txt');
const hwndProof = path.join(receiptDir, 'window-observation.json');
const usageCcusageMarker = path.join(receiptDir, 'usage-ccusage-process.json');
const usageTokscaleMarker = path.join(receiptDir, 'usage-tokscale-process.json');
const usageProcessScript = [
  "const fs = require('node:fs')",
  "fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,source:process.argv[2]}))",
  "process.stdout.write('[]')",
  "setTimeout(() => process.exit(0), 700)",
].join(';');
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
let initialMember;
let appManagedRosterAttachConfirmed = false;
let teamAliveBeforeAttach = null;
let addMemberIpcReceipt = null;
let forceExitMember;
let hwndObserver;
let hwndObserverLog = '';
let hwndEvidence;
let usageImporterProcesses = [];
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
    if (m?.role === 'tool' && m.tool_call_id === toolId)
      return [{ text: contentText(m.content), isError: m.is_error === true }];
    if (!Array.isArray(m?.content)) return [];
    return m.content.filter(part => part?.type === 'tool_result' && part.tool_use_id === toolId)
      .map(part => ({ text: contentText(part.content), isError: part.is_error === true }));
  }).at(-1);
  if (result !== undefined) {
    if (result.isError) {
      protocolFailure = 'Real ' + kind + ' Bash tool returned an error';
      return { id: 'failed_' + token.replaceAll('-', ''), text: 'Tool failed.' };
    }
    // Require the actual native Git version alongside the marker, not just echo.
    if (kind === 'git' && !/git version\s+[0-9]/i.test(result.text)) {
      protocolFailure = 'Native git.exe did not produce its actual version text';
      return { id: 'failed_' + token.replaceAll('-', ''), text: 'Tool result did not qualify.' };
    }
    if (!result.text.includes(expected.get(key))) {
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
    // Exercise actual Electron token-usage importers with owned native
    // Windows console-subsystem processes (no installed vendor CLI, no billing).
    AGENT_TEAMS_TOKEN_USAGE_CCUSAGE_COMMAND: process.execPath,
    AGENT_TEAMS_TOKEN_USAGE_CCUSAGE_ARGS: JSON.stringify([
      '-e', usageProcessScript, usageCcusageMarker, 'ccusage',
    ]),
    AGENT_TEAMS_TOKEN_USAGE_TOKSCALE_COMMAND: process.execPath,
    AGENT_TEAMS_TOKEN_USAGE_TOKSCALE_ARGS: JSON.stringify([
      '-e', usageProcessScript, usageTokscaleMarker, 'tokscale',
    ]),
    AGENT_TEAMS_TOKEN_USAGE_COMMAND_REFRESH_MS: '1',
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

  // Initial provisioning uses deterministic spawn. The changed Windows-only
  // spawn option belongs to app-managed live-roster attachment as well as
  // manual restart. Attach a NEW teammate through ordinary product IPC: a
  // restarted existing member would be refused while its PID is unverified.
  // Never downgrade the production PID safety guard to pass this test.
  // Establish and pin a focused Electron foreground baseline immediately
  // before app-managed roster attachment; watch the member spawn, tool calls,
  // and token-usage importers in the same native HWND/focus interval.
  const focusReady = await mainInspector.evaluate(`(() => {
    const req = typeof require === 'function' ? require : process.mainModule?.require?.bind(process.mainModule);
    const win = req('electron').BrowserWindow.getAllWindows()
      .find(w => w.webContents.getURL().startsWith('http://localhost:'));
    if (!win) return false;
    if (!win.isFocused()) win.focus();
    globalThis.__winProductFocus.before = win.isFocused();
    globalThis.__winProductFocus.blur = 0;
    return win.isFocused();
  })()`);
  assert(focusReady, 'Could not establish focused owned Electron window before tool E2E');
  phase = 'native-window-observer';
  hwndObserver = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(repoRoot, 'scripts/e2e/windows-product-console-hwnd.ps1'),
    '-ReadyPath', hwndReady, '-StopPath', hwndStop,
    '-EvidencePath', hwndProof, '-MainPid', String(mainBirth.pid),
  ], { windowsHide: true, cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [hwndObserver.stdout, hwndObserver.stderr]) stream.on('data', chunk => {
    hwndObserverLog = (hwndObserverLog + chunk.toString()).slice(-4000);
  });
  await wait('owned native HWND observer ready', async () => {
    if (hwndObserver.exitCode !== null)
      throw new Error('Native HWND observer failed: ' + hwndObserverLog);
    return (await readFile(hwndReady, 'utf8').catch(() => '')) === 'ready';
  }, 45_000);
  phase = 'app-managed-teammate-attach';
  initialMember = originalMember;
  // The product IPC treats an inactive team as a config-only add. Verify the
  // same runtime liveness gate before expecting a genuine member spawn event.
  teamAliveBeforeAttach = await api(`window.electronAPI.teams.processAlive(${literal(teamName)})`);
  assert.equal(teamAliveBeforeAttach, true,
    'Product runtime became inactive before app-managed member attachment');
  const attachedName = 'bob';
  const attachedSpec = {
    name: attachedName, providerId: 'anthropic', model: 'claude-sonnet-4-6',
    role: 'Disposable Windows app-managed teammate',
  };
  await api(`(() => {
    window.__winProductAttach={done:false};
    window.electronAPI.teams.addMember(${literal(teamName)}, ${literal(attachedSpec)}).then(
      value => window.__winProductAttach={done:true,value},
      error => window.__winProductAttach={done:true,error:String(error)}
    ); return true;
  })()`);
  const attachResult = await wait('original app-managed member attachment IPC', () =>
    client.evaluate('window.__winProductAttach?.done ? window.__winProductAttach : null'),
    180_000);
  // Electron preload unwraps IpcResult and resolves addMember as void;
  // a rejected IPC is surfaced by the error callback, not by a success field.
  addMemberIpcReceipt = { done: attachResult.done === true, error: attachResult.error ?? null };
  if (attachResult.error) throw new Error('Product member attachment failed: ' + attachResult.error);
  // The original process_spawned event proves the exact app-managed launch
  // path. Runtime liveness projections can lag this original event on Windows;
  // neither a cached alive flag nor a numeric PID alone qualifies the launch.
  const attachedEvent = await wait('original app-managed direct-process attachment event', async () => {
    const filePath = path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT,
      'teams', teamName, 'runtime', attachedName + '.runtime.jsonl');
    const contents = await readFile(filePath, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    const events = contents.split('\n').filter(Boolean).map(line => JSON.parse(line));
    return events.find(event =>
      event.type === 'process_spawned' &&
      event.source === 'TeamProvisioningService.direct_process_member_added' &&
      event.teamName === teamName && event.agentName === attachedName &&
      Number.isSafeInteger(event.pid) && event.pid > 0) || false;
  }, 180_000);
  assert(attachedEvent.pid !== initialMember.pid,
    'App-managed teammate must use a distinct original PID');
  originalMember = await wait('real app-managed added teammate original Windows process', async () => {
    const observed = await getProcess(attachedEvent.pid);
    return observed?.command?.includes(teamName) &&
      observed.command.includes('--agent-name') &&
      observed.command.includes(attachedName) ? observed : false;
  }, 30_000);
  assert.equal(originalMember.pid, attachedEvent.pid,
    'Observed original Windows process must match the app-managed spawn event');
  appManagedRosterAttachConfirmed = true;
  await client.screenshot(screenshot);
  phase = 'native-tool-invocations';
  for (const kind of ['cmd', 'git', 'powershell']) {
    const token = randomUUID(), key = kind + ':' + token;
    expected.set(key, 'WIN_TOOL_' + kind.toUpperCase() + '_' + token);
    await api(`window.electronAPI.teams.sendMessage(${literal(teamName)},
      ${literal({ member: attachedName, from: 'user', text: 'WIN_NATIVE_TOOL:' + key })})`);
    await wait('original ' + kind + ' tool result in live teammate runtime',
      () => proofs.get(key) || false, 150_000);
  }
  assert.equal(proofs.size, 3);
  assert.equal(model.errors.length, 0, 'Synthetic model protocol produced errors');
  // Keep the same real Win32 HWND/focus observer running while the actual
  // production token-usage IPC executes both CLI importers in Electron Main.
  // Marker files are written by the child processes, not by test fixtures.
  phase = 'product-token-usage-importers';
  for (const marker of [usageCcusageMarker, usageTokscaleMarker]) {
    await rm(marker, { force: true });
  }
  const usageRefresh = await api('window.electronAPI.tokenUsage.refreshSnapshot()');
  assert(usageRefresh && typeof usageRefresh === 'object' &&
    usageRefresh.success !== false && !usageRefresh.error,
    'Product token-usage importer refresh IPC failed');
  usageImporterProcesses = [];
  for (const [source, marker] of [
    ['ccusage', usageCcusageMarker],
    ['tokscale', usageTokscaleMarker],
  ]) {
    const entry = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(entry?.source, source, 'Real CLI importer marker source mismatch');
    assert(Number.isSafeInteger(entry.pid) && entry.pid > 0,
      'CLI importer did not report its real native child PID');
    usageImporterProcesses.push({ source, pid: entry.pid });
  }
  assert.equal(usageImporterProcesses.length, 2);
  for (const ownedChild of usageImporterProcesses) {
    await wait('owned ' + ownedChild.source + ' importer process retired', async () =>
      (await getProcess(ownedChild.pid)) === null, 20_000);
  }
  await writeFile(hwndStop, 'stop');
  hwndEvidence = await wait('owned native HWND observer evidence', async () => {
    try { return JSON.parse(await readFile(hwndProof, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }, 30_000);
  assert(hwndEvidence.completedByOwnedStop && hwndEvidence.actualNativeHwndEnumerated,
    'Native observer did not complete real HWND enumeration');
  assert(hwndEvidence.sampleCount >= 5, 'Native HWND observer did not sample the tool interval');
  assert(hwndEvidence.foregroundInitiallyMain, 'Actual Electron Main was not foreground');
  assert.equal(hwndEvidence.foregroundOtherPidSamples, 0,
    'Another process took the foreground during real tool calls');
  assert.deepEqual(hwndEvidence.unexpectedNewConsoleWindows, [],
    'Visible native Windows console window was observed during real product tool calls');
  phase = 'product-stop';
  await api(`window.electronAPI.teams.stop(${literal(teamName)})`);
  stopped = true;
  await wait('both original teammate PIDs retired after product Stop', async () =>
    !(await ownedStillAlive(originalMember)) &&
      !(await ownedStillAlive(initialMember)), 30_000);
  const focus = await mainInspector.evaluate('globalThis.__winProductFocus');
  assert(focus.pid > 0 && Number.isSafeInteger(focus.blur));
  assert.equal(focus.before, true, 'Electron window did not own focus before tools');
  assert.equal(focus.blur, 0, 'Electron window blurred during real tool calls');
  phase = 'forced-actual-electron-main-exit';
  const forcedTeamName = teamName + '-force';
  const forcedRequest = { ...request, teamName: forcedTeamName };
  await api(`(() => {
    window.__forceExitLaunch = {done:false};
    window.electronAPI.teams.createTeam(${literal(forcedRequest)}).then(
      value => window.__forceExitLaunch={done:true,value},
      error => window.__forceExitLaunch={done:true,error:String(error)}
    ); return true;
  })()`);
  const forceLaunch = await wait('actual second product team launch',
    () => client.evaluate('window.__forceExitLaunch?.done ? window.__forceExitLaunch : null'));
  if (forceLaunch.error) throw new Error('Forced-exit team launch failed: ' + forceLaunch.error);
  forceExitMember = await wait('actual second team member process', async () => {
    const snap = await api(`window.electronAPI.teams.getTeamAgentRuntime(${literal(forcedTeamName)})`);
    const member = snap?.members?.alice, pid = member?.runtimePid ?? member?.pid;
    if (!member?.alive || !Number.isSafeInteger(pid) || pid <= 0) return false;
    const observed = await getProcess(pid);
    return observed?.command?.includes(forcedTeamName) ? observed : false;
  }, 150_000);
  assert(forceExitMember.pid !== originalMember.pid,
    'Forced-exit product member must be a new process, not a recycled stopped member');
  assert(await ownedStillAlive(forceExitMember),
    'Forced-exit teammate had already retired before Electron Main was killed');
  const liveMain = await getProcess(mainBirth.pid);
  assert(liveMain?.creation === mainBirth.creation &&
    liveMain.command.toLowerCase().includes('electron.exe'),
    'Original Electron Main identity changed; refusing to force-exit a different process');
  const killedMain = spawnSync('taskkill.exe', ['/PID', String(mainBirth.pid), '/F'], {
    windowsHide: true, timeout: 15_000, encoding: 'utf8',
  });
  assert.equal(killedMain.status, 0, 'Actual Electron Main force-exit failed');
  let forceExitMemberRetired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await ownedStillAlive(forceExitMember))) {
      forceExitMemberRetired = true;
      break;
    }
    await delay(300);
  }
  assert(forceExitMemberRetired,
    'Original product teammate survived forced Electron Main exit without tree-kill');
  const evidence = {
    schemaVersion: 1, success: true, platform: process.platform,
    modelBoundary: 'loopback synthetic HTTP; no paid model inference',
    realElectronMainHosted: true, realProductTeammateLaunch: true,
    realProductStopConfirmed: true, nativeOsPidBound: true,
    appManagedRosterAttachConfirmed, provisionedTeammatePid: initialMember.pid,
    appManagedAddedTeammatePid: originalMember.pid,
    originalTeammatePid: originalMember.pid, originalTeammateBirth: originalMember.creation,
    toolResults: [...proofs.values()], usageImporterProcesses, electronFocus: focus,
    actualConsoleWindowsEnumerated: true,
    visibleConsoleWindowsObserved: hwndEvidence.unexpectedNewConsoleWindows.length,
    foregroundOtherPidSamples: hwndEvidence.foregroundOtherPidSamples,
    nativeHwndSamples: hwndEvidence.sampleCount,
    forceAppExitDescendantsVerified: true,
    forcedElectronMainPid: mainBirth.pid,
    forceExitTeammatePid: forceExitMember.pid,
    screenshot: path.basename(screenshot), runtimeVersion: lock.version,
  };
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ receiptPath, ...evidence }));
}

try {
  await run();
} catch (error) {
  // Preserve read-only original PID facts when product Stop refuses confirmation.
  // A live original is never silently reclassified as stopped; identity changes
  // are recorded, and lookup errors are not treated as proof of disappearance.
  const stopFailurePidEvidence = phase === 'product-stop'
    ? await Promise.all([
        ['alice', initialMember],
        ['bob', originalMember],
      ].filter(([, identity]) => Boolean(identity)).map(async ([member, identity]) => {
        try {
          const observed = await getProcess(identity.pid);
          return {
            member, pid: identity.pid, observedAlive: observed !== null,
            originalBirthMatches: observed ? observed.creation === identity.creation : null,
            originalTeamAttributed: observed ? observed.command.includes(teamName) : null,
          };
        } catch {
          return { member, pid: identity.pid, processLookupFailed: true };
        }
      }))
    : [];
  await writeFile(receiptPath, JSON.stringify({
    schemaVersion: 1, success: false, phase, error: String(error),
    realProductTeammateLaunch: Boolean(originalMember),
    appManagedRosterAttachConfirmed,
    teamAliveBeforeAttach,
    addMemberIpcReceipt,
    toolResults: [...proofs.values()], usageImporterProcesses,
    stopFailurePidEvidence,
    modelErrors: model?.errors ?? [],
    logTail: log.slice(-3500),
  }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  if (launched && !stopped && client) {
    await api(`window.electronAPI.teams.stop(${literal(teamName)})`).catch(() => undefined);
  }
  if (hwndObserver && hwndObserver.exitCode === null) {
    await writeFile(hwndStop, 'stop').catch(() => undefined);
    await delay(450);
    if (hwndObserver.exitCode === null) hwndObserver.kill();
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
    { identity: initialMember, marker: teamName },
    { identity: originalMember, marker: teamName },
    { identity: forceExitMember, marker: teamName + '-force' },
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
