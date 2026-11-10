#!/usr/bin/env node
// Real runtime + OpenCode, disposable data, no team launch or model inference.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectCdp } from './announcements/cdp.mjs';
import {
  assertListenerOwnership,
  assertPortAvailable,
  isolatedEnvironment,
  listeners,
  ownedTree,
  processes,
  sameIdentity,
} from './opencode-diagnostics/platform.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert(process.argv[index]?.startsWith('--') && process.argv[index + 1], 'Expected --key value');
  options.set(process.argv[index], process.argv[index + 1]);
}
for (const key of options.keys()) {
  assert(['--runtime', '--opencode', '--cursor-assets', '--expect', '--reuse-root'].includes(key), `Unknown ${key}`);
}
const runtime = await realpath(options.get('--runtime') || '');
const opencode = await realpath(options.get('--opencode') || '');
const cursorAssets = await realpath(options.get('--cursor-assets') || '');
const expected = options.get('--expect') || 'ready';
assert(['ready', 'cursor-error'].includes(expected));
assert.equal(process.platform, 'darwin', 'Managed Cursor assets are macOS-only');
await assertPortAvailable();
const root = options.has('--reuse-root')
  ? await realpath(options.get('--reuse-root'))
  : await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-without-cursor-e2e-')));
if (options.has('--reuse-root')) {
  assert(path.basename(root).startsWith('opencode-without-cursor-e2e-'), 'Expected disposable E2E root');
  assert(root.startsWith(await realpath(os.tmpdir()) + path.sep), 'Reusable root must be under tmp');
  const previous = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(previous.root, root, 'Reusable root manifest mismatch');
  assert.equal(previous.project, path.join(root, 'sandbox'), 'Reusable project mismatch');
}
// A failed rerun must never leave a previous PASS beside its new failure logs.
await rm(path.join(root, 'result.json'), { force: true });
const data = {
  root, home: path.join(root, 'home'), userData: path.join(root, 'user-data'),
  bin: path.join(root, 'bin'), temp: path.join(root, 'tmp'), node: process.execPath,
  orchestrator: runtime, opencode, project: path.join(root, 'sandbox'),
};
async function ensureSandboxDirectory(directory) {
  await mkdir(directory, { recursive: true });
  assert.equal(await realpath(directory), directory, 'Sandbox directory escaped through a symlink');
}
for (const target of [data.home, data.userData, data.bin, data.temp, data.project]) {
  await ensureSandboxDirectory(target);
}
const claudeRoot = path.join(data.home, '.claude');
await ensureSandboxDirectory(claudeRoot);
await writeFile(path.join(data.project, 'README.md'), '# Issue 765 disposable sandbox\n');
await writeFile(path.join(claudeRoot, 'agent-teams-config.json'), JSON.stringify({
  general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'dashboard' },
}));
const projectDir = path.join(claudeRoot, 'projects', data.project.replace(/[/\\]/g, '-'));
await ensureSandboxDirectory(projectDir);
await writeFile(path.join(projectDir, 'issue765.jsonl'), JSON.stringify({
  type: 'user', cwd: data.project, sessionId: 'issue765-sandbox',
  timestamp: new Date().toISOString(), isMeta: false,
  message: { role: 'user', content: 'Issue 765 test fixture' },
}) + '\n');
const manifestPath = path.join(data.userData, 'data/runtimes/opencode/current.json');
await ensureSandboxDirectory(path.dirname(manifestPath));
await writeFile(manifestPath, JSON.stringify({
  schemaVersion: 1, version: '1.14.24', platformPackage: 'issue765-sandbox',
  binaryPath: opencode, integrity: 'test-only', installedAt: new Date().toISOString(),
}));
const env = {
  ...isolatedEnvironment(data),
  CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
  CODEX_HOME: path.join(root, 'codex-home'),
  CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'multimodel-data'),
  CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'multimodel-cache'),
  CURSOR_AGENT_EXECUTABLE: path.join(root, 'missing-cursor-agent'),
  AGENT_TEAMS_CURSOR_MANAGED_ASSETS: cursorAssets,
  AGENT_TEAMS_CURSOR_SUPERVISOR_NODE: await realpath(process.execPath),
  AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
};
// The app resolves native providers before invoking the runtime. Restore the
// fixture's absence and data roots at the process boundary for every command.
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const launcherPath = path.join(data.bin, 'sandbox-runtime');
const pinnedEnv = Object.entries(env).filter(([key]) => /^(HOME|USERPROFILE|CURSOR_AGENT_EXECUTABLE|CODEX_HOME|CLAUDE_CONFIG_DIR|CLAUDE_MULTIMODEL_|XDG_|AGENT_TEAMS_CURSOR_|OPENCODE_BIN_PATH)/.test(key));
await writeFile(launcherPath, '#!/bin/sh\n' + pinnedEnv.map(([key, value]) => `export ${key}=${quote(value)}`).join('\n') + `\ncd ${quote(data.project)}\nexec ${quote(runtime)} "$@"\n`, { mode: 0o700 });
env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = launcherPath;
env.CLAUDE_CLI_PATH = launcherPath;
await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ...data, cursorAssets, expected }, null, 2));
console.log(`Sandbox artifacts: ${root}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// CDP evaluates JavaScript source, so escape characters that could terminate
// an embedded literal before interpolating a selector or model ID.
const jsLiteral = (value) => JSON.stringify(value)
  .replaceAll('<', '\\u003C')
  .replaceAll('>', '\\u003E')
  .replaceAll('/', '\\u002F')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');
const app = spawn('pnpm', ['dev:mcp'], {
  cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [app.stdout, app.stderr]) stream.on('data', (chunk) => { logs += chunk; });
let cdp;
let launcher;
let knownOwned = [];
let failure;
let successResult;
let successMessage;
async function save(name, content) { await writeFile(path.join(root, name), content); }
async function waitFor(expression, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`Desktop exited: ${app.exitCode ?? app.signalCode}`);
    }
    try {
      if (await cdp.inspect(expression)) return;
    } catch (error) {
      // OpenCode inventory can briefly occupy the dev renderer while it starts.
      // A single CDP evaluation timeout is not a failed UI assertion.
      if (!String(error).includes('Runtime.evaluate timed out')) throw error;
    }
    await pause(300);
  }
  throw new Error(`Timed out: ${description}`);
}
async function click(selector) {
  await waitFor(`Boolean(document.querySelector(${jsLiteral(selector)})) && !document.querySelector(${jsLiteral(selector)}).disabled`, selector);
  await cdp.inspect(`document.querySelector(${jsLiteral(selector)}).scrollIntoView({block:'center'})`);
  await pause(200);
  // Electron's Retina screenshot pixels and CDP input coordinates disagree in
  // this dev window. The repository's existing desktop E2E uses DOM activation.
  await cdp.inspect(`document.querySelector(${jsLiteral(selector)}).click()`);
}
async function cleanupSandboxHosts() {
  const input = path.join(root, 'cleanup-hosts.json');
  await save('cleanup-hosts.json', JSON.stringify({
    schemaVersion: 1,
    requestId: randomUUID(),
    command: 'opencode.cleanupHosts',
    cwd: data.project,
    startedAt: new Date().toISOString(),
    timeoutMs: 60_000,
    body: { mode: 'force', reason: 'issue-765-e2e-cleanup', projectPath: data.project },
  }));
  const { stdout } = await execFileAsync(launcherPath, [
    'runtime', 'opencode-command', '--json', '--input', input,
  ], { cwd: data.project, env, timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  await save('cleanup-hosts-result.json', JSON.stringify(result, null, 2));
  assert.equal(result.ok, true, `Scoped OpenCode cleanup failed: ${JSON.stringify(result.error)}`);
  assert.equal(result.data.remaining, 0, 'Sandbox OpenCode hosts remain after cleanup');
  assert(!result.data.hosts.some((host) => host.action === 'failed'), 'Sandbox host cleanup failed');
}
async function screenshot(name) {
  const result = await cdp.send('Page.captureScreenshot');
  await save(name, Buffer.from(result.data, 'base64'));
}
function survivingOwnedProcesses() {
  const snapshot = processes();
  return knownOwned.filter((item) => {
    const current = snapshot.find((candidate) => candidate.pid === item.pid);
    if (!current) return false;
    try { sameIdentity(item, current); return true; }
    catch { return false; }
  });
}
async function waitForOwnedExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let survivors = survivingOwnedProcesses();
  while (survivors.length && Date.now() < deadline) {
    await pause(100);
    survivors = survivingOwnedProcesses();
  }
  return survivors;
}
try {
  launcher = processes().find((item) => item.pid === app.pid);
  assert(launcher, 'Launcher identity missing');
  await save('launcher.json', JSON.stringify(launcher));
  const deadline = Date.now() + 120_000;
  let target;
  while (Date.now() < deadline) {
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`Desktop startup exited: ${app.exitCode ?? app.signalCode}`);
    }
    try {
      const ids = listeners();
      if (ids.length) {
        knownOwned = ownedTree(processes(), launcher);
        assertListenerOwnership(ids, knownOwned);
        const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
        target = targets.find((item) => item.type === 'page' && /^http:\/\/localhost:/.test(item.url));
        if (target?.webSocketDebuggerUrl) break;
      }
    } catch (error) {
      if (/refusing|not a launcher descendant/.test(String(error))) throw error;
    }
    await pause(500);
  }
  assert(target?.webSocketDebuggerUrl, 'Owned dev:mcp renderer unavailable');
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await save('stage.txt', 'waiting for dashboard');
  await waitFor('Boolean(document.querySelector("[data-testid=runtime-manage-opencode]"))', 'dashboard OpenCode control');
  await save('stage.txt', 'opening provider settings');
  await click('[data-testid="runtime-manage-opencode"]');
  await save('stage.txt', 'waiting for provider settings');
  await waitFor('Boolean(document.querySelector("[role=dialog]"))', 'Provider Settings dialog', 180_000);
  await save('stage.txt', 'waiting for provider directory');
  await waitFor('Boolean(document.querySelector("[data-testid=runtime-provider-search]")) || document.body.innerText.includes("Managed Cursor requires an absolute native executable")', 'provider directory');
  if (expected === 'cursor-error') {
    await waitFor('document.body.innerText.includes("Managed Cursor requires an absolute native executable")', 'original Cursor error');
    await screenshot('cursor-error.png');
    await save('ui.txt', await cdp.inspect('document.body.innerText'));
    successResult = { expected, reproduced: true, root };
    successMessage = 'PASS: original Cursor error reproduced through dev:mcp';
  } else {
    await waitFor('Boolean(document.querySelector("[data-testid=runtime-provider-directory-row-openrouter]"))', 'OpenRouter provider');
    await screenshot('directory.png');
    assert(!(await cdp.inspect('document.body.innerText.includes("Managed Cursor requires an absolute native executable")')));
    // A provider without credentials can have no selectable models. This
    // regression checks that its directory remains usable without Cursor.
    await waitFor('Boolean(document.querySelector("[data-testid=runtime-provider-directory-row-opencode-header]"))', 'OpenCode Zen provider');
    await click('[data-testid="runtime-provider-directory-row-opencode-header"]');
    await waitFor('Boolean(document.querySelector("[data-testid=runtime-provider-directory-row-opencode-content]"))', 'OpenCode Zen details');
    assert(!(await cdp.inspect('document.body.innerText.includes("Managed Cursor requires an absolute native executable")')));
    await save('ui.txt', await cdp.inspect('document.body.innerText'));
    successResult = { expected, providers: ['openrouter', 'opencode'], root };
    successMessage = 'PASS: OpenCode provider directory and details without Cursor';
  }
} catch (error) {
  failure = error;
  if (cdp) {
    await screenshot('failure.png').catch(() => {});
    await save('failure-ui.txt', await cdp.inspect('document.body.innerText').catch(() => ''));
  }
} finally {
  cdp?.close();
  await save('desktop.log', logs);
  if (launcher) {
    const snapshot = processes();
    if (snapshot.some((item) => item.pid === launcher.pid && item.birth === launcher.birth)) {
      knownOwned = ownedTree(snapshot, launcher);
    }
    const signals = [];
    for (const item of [...knownOwned].reverse()) {
      const current = processes().find((candidate) => candidate.pid === item.pid);
      if (!current) continue;
      try { sameIdentity(item, current); }
      catch (error) { failure ??= error; continue; }
      try { process.kill(item.pid, 'SIGTERM'); signals.push(item); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
    }
    let survivors = await waitForOwnedExit(5_000);
    const forced = [];
    for (const item of survivors) {
      const current = processes().find((candidate) => candidate.pid === item.pid);
      if (!current) continue;
      try { sameIdentity(item, current); }
      catch { continue; }
      try { process.kill(item.pid, 'SIGKILL'); forced.push(item); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
    }
    survivors = await waitForOwnedExit(10_000);
    await save('cleanup.json', JSON.stringify({ term: signals, kill: forced, surviving: survivors }));
    if (survivors.length) {
      failure ??= new Error(`Desktop descendants remained alive after cleanup: ${survivors.map((item) => item.pid).join(', ')}`);
    }
  }
  // Persistent OpenCode hosts detach from their short-lived runtime CLI parent.
  // Once the app has stopped, ask the runtime to terminate only hosts for this
  // disposable project, using its process-identity checks and registry lock.
  const exitDeadline = Date.now() + 15_000;
  while (app.exitCode === null && app.signalCode === null && Date.now() < exitDeadline) {
    await pause(100);
  }
  if (app.exitCode === null && app.signalCode === null) {
    failure ??= new Error('Desktop launcher remained alive after cleanup');
  }
  try { await cleanupSandboxHosts(); }
  catch (error) { failure ??= error; }
  if (!failure) {
    await save('result.json', JSON.stringify(successResult, null, 2));
    console.log(successMessage);
    console.log(`Evidence retained: ${root}`);
  }
}
if (failure) throw failure;
