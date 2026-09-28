#!/usr/bin/env node
// Real runtime + OpenCode, disposable data, no team launch or model inference.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
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
async function openModelsTab() {
  const selector = '[data-testid=runtime-provider-tab-providers]';
  await waitFor(`Boolean(document.querySelector(${jsLiteral(selector)})?.previousElementSibling) && !document.querySelector(${jsLiteral(selector)}).previousElementSibling.disabled`, 'enabled Models tab');
  // Radix Tabs switches on mousedown; HTMLElement.click() emits only click.
  await cdp.inspect(`(() => { const tab = document.querySelector(${jsLiteral(selector)}).previousElementSibling; tab.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,button:0})); tab.click(); })()`);
  await waitFor('Boolean(document.querySelector("[data-testid=opencode-default-inheritance]"))', 'default model settings');
}
async function readPersistedDefault() {
  const { stdout } = await execFileAsync(launcherPath, [
    'runtime', 'providers', 'view', '--runtime', 'opencode',
    '--project-path', data.project, '--json',
  ], { cwd: data.project, env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout).view;
}
async function screenshot(name) {
  const result = await cdp.send('Page.captureScreenshot');
  await save(name, Buffer.from(result.data, 'base64'));
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
    await save('result.json', JSON.stringify({ expected, reproduced: true, root }, null, 2));
    console.log('PASS: original Cursor error reproduced through dev:mcp');
  } else {
    await waitFor('Boolean(document.querySelector("[data-testid=runtime-provider-directory-row-openrouter]"))', 'OpenRouter provider');
    await screenshot('directory.png');
    assert(!(await cdp.inspect('document.body.innerText.includes("Managed Cursor requires an absolute native executable")')));
    // OpenRouter is visible but needs an API key in this empty sandbox.
    await waitFor('Boolean(document.querySelector("[data-testid=runtime-provider-directory-row-atomic-chat-header]"))', 'Atomic Chat provider');
    await openModelsTab();
    await click('[data-testid=opencode-default-inheritance] button');
    await waitFor('Boolean(document.querySelector("[data-testid=opencode-default-target-banner]"))', 'all-projects model picker');
    // Connected OpenCode Zen models can be selected without inference.
    const selectableContent = '[data-testid="runtime-provider-directory-row-opencode-content"]';
    if (!(await cdp.inspect(`Boolean(document.querySelector(${jsLiteral(selectableContent)}))`))) {
      await click('[data-testid="runtime-provider-directory-row-opencode-header"]');
    }
    await waitFor(`Boolean(document.querySelector(${jsLiteral(selectableContent)} + ' [data-testid=runtime-provider-model-list]'))`, 'OpenCode Zen model list');
    await waitFor(`document.querySelectorAll(${jsLiteral(selectableContent)} + ' [data-testid^=runtime-provider-model-row-]').length > 0`, 'OpenCode Zen model rows');
    const modelIds = await cdp.inspect(`Array.from(document.querySelectorAll(${jsLiteral(selectableContent)} + ' [data-testid^=runtime-provider-model-row-]')).map(item => item.dataset.testid)`);
    const availableSelect = `${selectableContent} [data-testid^=runtime-provider-model-row-] button[aria-pressed="false"]:not([disabled])`;
    await waitFor(`Boolean(document.querySelector(${jsLiteral(availableSelect)}))`, 'non-Cursor selectable model');
    const selectedModelId = (await cdp.inspect(`document.querySelector(${jsLiteral(availableSelect)}).closest('[data-testid^=runtime-provider-model-row-]').dataset.testid`))
      .slice('runtime-provider-model-row-'.length);
    await click(availableSelect);
    const selectedRow = `${selectableContent} [data-testid=${JSON.stringify(`runtime-provider-model-row-${selectedModelId}`)}] button[aria-pressed="true"]`;
    await waitFor(`Boolean(document.querySelector(${jsLiteral(selectedRow)}))`, 'default model saved');
    await openModelsTab();
    await waitFor(`document.querySelector('[data-testid=opencode-default-inheritance]')?.textContent?.includes(${jsLiteral(selectedModelId)})`, 'default model displayed');
    // A separate process reads the saved preference, not the renderer's
    // optimistic state.
    const persisted = await readPersistedDefault();
    assert.equal(persisted.allProjectsDefaultModel, selectedModelId);
    assert.equal(persisted.defaultModelSource, 'all_projects');
    await screenshot('selected-model.png');
    await save('ui.txt', await cdp.inspect('document.body.innerText'));
    await save('result.json', JSON.stringify({ expected, providers: ['openrouter', 'atomic-chat'], modelIds, selectedModelId, persistedDefaultModel: persisted.allProjectsDefaultModel, root }, null, 2));
    console.log(`PASS: provider directory, ${modelIds.length} OpenCode Zen models and persisted default without Cursor`);
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
    await save('cleanup.json', JSON.stringify(signals));
  }
  if (!failure) console.log(`Evidence retained: ${root}`);
}
if (failure) throw failure;
