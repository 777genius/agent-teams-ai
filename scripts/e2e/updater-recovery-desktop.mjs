#!/usr/bin/env node
// Built Electron main/preload/renderer integration. Test controls exist only in
// the disposable launcher, never in production source or real project state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { connectCdp } from './announcements/cdp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
if (args.includes('--help')) {
  console.log('Build first, then: node scripts/e2e/updater-recovery-desktop.mjs [--output DIR] [--renderer-platform MacIntel|Linux] [--no-sandbox]');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const mainEntry = path.join(repoRoot, 'dist-electron/main/index.cjs');
const root = await mkdtemp(path.join(os.tmpdir(), 'updater-recovery-desktop-e2e-'));
const output = path.resolve(option('--output', path.join(root, 'evidence')));
const rendererPlatform = option('--renderer-platform', 'MacIntel');
const token = randomBytes(24).toString('hex');
const config = {
  root,
  mainEntry,
  token,
  userData: path.join(root, 'user-data'),
  home: path.join(root, 'home'),
  claudeRoot: path.join(root, 'home/.claude'),
  ready: path.join(root, 'main-ready.json'),
};
const evidence = {
  startedAt: new Date().toISOString(),
  root,
  rendererPlatformFixture: rendererPlatform,
  hostPlatform: process.platform,
  productionMain: mainEntry,
  checks: [],
  passed: false,
};
let app;
let cdp;
let controller;
let launchError;
let liveLog;
let log = '';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// This function is serialized into a throwaway CJS launcher so all controls run
// in Electron main. Production shell IPC and preload are left intact.
function mainFixture(config) {
  const fs = require('node:fs');
  const http = require('node:http');
  const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
  app.setPath('home', config.home);
  app.setPath('userData', config.userData);
  app.setAppLogsPath(require('node:path').join(config.root, 'logs'));
  const state = { sent: [], external: [], checks: 0, downloads: 0, installs: 0 };
  const pending = [];
  shell.openExternal = async (url) => { state.external.push(url); };
  const send = (status) => {
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    if (windows.length !== 1) throw new Error('Expected exactly one sandbox app window');
    state.sent.push(status);
    windows[0].webContents.send('updater:status', status);
  };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    if (channel === 'updater:check' || channel === 'updater:download') {
      originalHandle(channel, async () => {
        state[channel === 'updater:check' ? 'checks' : 'downloads']++;
        return new Promise((resolve) => pending.push(resolve));
      });
    } else if (channel === 'updater:install') {
      // A regression must fail the assertion instead of quitting/installing.
      originalHandle(channel, async () => { state.installs++; });
    } else originalHandle(channel, handler);
  };
  // Only renderer file assets are needed. Do not contact providers, telemetry,
  // announcements, or updater networks while running this deterministic test.
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true })
    );
  });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${config.token}`) {
        res.writeHead(403); res.end(); return;
      }
      if (req.method === 'GET' && req.url === '/state') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...state, pid: process.pid, userData: app.getPath('userData'), home: app.getPath('home') }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/command') {
        res.writeHead(404); res.end(); return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) throw new Error('Oversized test command');
      }
      const command = JSON.parse(body);
      if (command.type === 'status') send(command.status);
      else if (command.type === 'release') {
        if (command.status) send(command.status);
        while (pending.length) pending.shift()();
      } else if (command.type === 'stop') {
        res.end('{}'); app.exit(0); return;
      } else throw new Error('Unknown test command');
      res.end('{}');
    } catch (error) {
      res.writeHead(500); res.end(String(error));
    }
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(config.ready, JSON.stringify({ port: server.address().port, pid: process.pid }));
  });
  server.unref();
  require(config.mainEntry);
}

async function waitFor(fn, label, timeout = 60000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    if (launchError) throw launchError;
    if (app?.signalCode) throw new Error(`Electron exited (${app.signalCode}) while waiting for ${label}`);
    if (app?.exitCode !== null && app?.exitCode !== undefined) {
      throw new Error(`Electron exited (${app.exitCode}) while waiting for ${label}`);
    }
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? `: ${lastError}` : ''}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function mainRequest(route, body) {
  const response = await fetch(`http://127.0.0.1:${controller.port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Main test controller returned ${response.status}: ${await response.text()}`);
  return response.json();
}
const inspect = (expression) => cdp.inspect(expression);
const waitUi = (expression, label) => waitFor(() => inspect(expression), label);
const dialog = 'document.querySelector("[data-testid=update-dialog]")';
const visible = (selector) => `(() => {
  if (document.getElementById('splash')) return false;
  const e=document.querySelector(${JSON.stringify(selector)});
  const r=e?.getBoundingClientRect();
  if (!r?.width || !r?.height || e.disabled) return false;
  const style=getComputedStyle(e);
  if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) return false;
  const top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
  return Boolean(top && e.contains(top));
})()`;

async function send(status) {
  const receivedBefore = await inspect('window.__updaterE2EReceived.length');
  await mainRequest('/command', { type: 'status', status });
  await waitUi(
    `window.__updaterE2EReceived?.length > ${receivedBefore} && JSON.stringify(window.__updaterE2EReceived.at(-1)) === ${JSON.stringify(JSON.stringify(status))}`,
    `preload delivered ${status.type}`
  );
}
async function screenshot(name) {
  if (name !== 'failure') {
    assert.equal(await inspect('Boolean(document.getElementById("splash"))'), false, `${name}: startup splash obscures screenshot`);
    if (await inspect('Boolean(document.querySelector("[data-testid=update-error]"))')) {
      await waitUi(visible('[data-testid=update-manual-download]'), `${name}: recovery is unobscured before screenshot`);
    }
    // Wait for two painted frames after the asserted state, not a fixed delay.
    await inspect('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
}
async function snapshot(name) {
  const ui = await inspect(`({ text: (${dialog})?.innerText ?? '', body: document.body.innerText, received: window.__updaterE2EReceived, splashPresent: Boolean(document.getElementById('splash')), overflow: document.documentElement.scrollWidth > innerWidth, dialogs: document.querySelectorAll('[role=dialog]').length })`);
  assert.equal(ui.splashPresent, false, `${name}: startup splash remains over rendered UI`);
  assert.equal(ui.overflow, false, `${name}: horizontal viewport overflow`);
  evidence.checks.push({ name, ui, main: await mainRequest('/state') });
  await screenshot(name);
}
async function freshRenderer() {
  await cdp.send('Page.reload');
  await waitUi('Boolean(window.electronAPI?.updater?.onStatus && document.body && document.querySelector("#root")?.childElementCount)', 'real preload and rendered app');
  const startup = await waitUi('window.electronAPI.startup.getStatus().then(s => (s.ready || s.error || s.phase === "failed") && s)', 'app startup');
  assert(startup.ready && !startup.error, `Sandbox startup failed: ${JSON.stringify(startup)}`);
  // Main readiness precedes App.tsx's animated splash dismissal. DOM content
  // behind that overlay does not prove the recovery is visible to the user.
  await waitUi('!document.getElementById("splash")', 'frontend startup splash removed');
  await waitUi(visible('[aria-label="More actions"]'), 'frontend app frame rendered and unobscured');
  await inspect(`(() => { window.__updaterE2EReceived=[]; window.electronAPI.updater.onStatus((_event,status)=>window.__updaterE2EReceived.push(status)); })()`);
  await waitUi('!document.querySelector("[data-testid=update-manual-download]")', 'fresh update state');
}
async function recovery(error, name, retry) {
  await send({ type: 'error', error });
  await waitUi(visible('[data-testid=update-manual-download]'), `${name}: manual download button`);
  await cdp.click('[data-testid=update-error] summary');
  await waitUi('document.querySelector("[data-testid=update-error] details")?.open', `${name}: expanded original error details`);
  const text = await inspect(`(${dialog})?.innerText ?? ''`);
  assert(text.includes('Update could not be completed'), `${name}: recovery heading absent`);
  assert(text.includes(error), `${name}: original error details absent`);
  assert(text.includes('Keep your app data and project folders'), `${name}: data preservation guidance absent`);
  assert.equal(await inspect('Boolean(document.querySelector("[data-testid=update-retry]"))'), retry, `${name}: retry classification`);
  assert.equal(await inspect('Array.from(document.querySelectorAll("button")).some(b => /^Restart (now|to update)$/i.test(b.textContent.trim()))'), false, `${name}: stale restart action still rendered`);
  await snapshot(name);
  const before = (await mainRequest('/state')).external.length;
  await cdp.click('[data-testid=update-manual-download]');
  const external = await waitFor(async () => {
    const state = await mainRequest('/state');
    return state.external.length > before && state.external;
  }, `${name}: shell.openExternal`);
  assert.equal(external.length, before + 1, `${name}: one external navigation per click`);
  assert.equal(external.at(-1), 'https://agentteams.live/#download', `${name}: fixed public download URL`);
}

try {
  await access(mainEntry);
  await access(path.join(repoRoot, 'dist-electron/preload/index.js'));
  await mkdir(output, { recursive: true });
  for (const dir of [config.userData, config.home, config.claudeRoot, path.join(root, 'logs')]) {
    await mkdir(dir, { recursive: true });
  }
  const launcher = path.join(root, 'launcher.cjs');
  await writeFile(launcher, `(${mainFixture.toString()})(${JSON.stringify(config)});\n`);
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOME: config.home,
    USERPROFILE: config.home,
    XDG_CONFIG_HOME: path.join(config.home, '.config'),
    XDG_DATA_HOME: path.join(config.home, '.local/share'),
    XDG_CACHE_HOME: path.join(config.home, '.cache'),
    CLAUDE_CONFIG_DIR: config.claudeRoot,
    CODEX_HOME: path.join(config.home, '.codex'),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: config.userData,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: config.claudeRoot,
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    NODE_BINARY: process.execPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  liveLog = createWriteStream(path.join(output, 'desktop.log'));
  app = spawn(require('electron'), [launcher, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--lang=en-US', ...(process.getuid?.() === 0 || args.includes('--no-sandbox') ? ['--no-sandbox'] : [])], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.on('error', (error) => { launchError = error; log += `\nLaunch error: ${error.stack}`; });
  console.log(`Updater sandbox Electron PID ${app.pid ?? 'unavailable'}; live log: ${path.join(output, 'desktop.log')}`);
  for (const stream of [app.stdout, app.stderr]) stream.on('data', (chunk) => {
    log = (log + chunk.toString()).slice(-200000);
    liveLog.write(chunk);
  });
  controller = await waitFor(async () => JSON.parse(await readFile(config.ready, 'utf8')), 'owned main controller');
  assert.equal(controller.pid, app.pid);
  const provenance = await mainRequest('/state');
  assert.equal(provenance.userData, config.userData);
  assert.equal(provenance.home, config.home);
  evidence.provenance = provenance;
  const target = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
    const pages = targets.filter((t) => t.type === 'page' && t.url.startsWith('file:'));
    assert(pages.length <= 1, 'Ambiguous Electron renderer targets');
    return pages[0];
  }, 'owned built Electron renderer');
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(navigator,'platform',{get:()=>${JSON.stringify(rendererPlatform)}}); Object.defineProperty(navigator,'language',{get:()=> 'en-US'}); Object.defineProperty(navigator,'languages',{get:()=> ['en-US']});`,
  });
  await freshRenderer();
  // Unknown version must still expose a usable recovery path and exact details.
  const generic = 'Updater fixture: could not read release metadata <unsafe-marker>';
  await recovery(generic, 'unknown-version-generic', false);
  assert.equal(await inspect(`(${dialog}).innerText.includes('v999.0.0')`), false);
  assert.equal(await inspect('Boolean(document.querySelector("unsafe-marker"))'), false, 'Error text interpreted as markup');
  await send({ type: 'checking' });
  await send({ type: 'not-available' });
  await waitUi(visible('[data-testid=update-manual-download]'), 'periodic checking/no-update retains unresolved recovery');
  await snapshot('unknown-version-periodic-recovery-retained');

  await freshRenderer();
  await send({ type: 'downloaded', version: '999.0.0' });
  await waitUi('Array.from(document.querySelectorAll("button")).some(b => /^Restart (now|to update)$/i.test(b.textContent.trim()))', 'downloaded fixture has restart action before failure');
  const signature = 'Code signature did not pass validation: code failed to satisfy specified code requirement(s)';
  await recovery(signature, 'signature-after-downloaded', false);
  if (rendererPlatform.includes('Mac')) {
    const text = await inspect(`(${dialog}).innerText`);
    assert(text.includes('DMG') && text.includes('Applications') && text.includes('Replace the existing app'), 'Mac replacement instructions missing');
    assert(text.includes('could not verify the app signature'), 'Signature-specific manual recovery explanation missing');
  }
  await send({ type: 'checking' });
  await send({ type: 'available', version: '999.0.0', releaseNotes: 'Updater sandbox release notes.' });
  await waitUi(visible('[data-testid=update-manual-download]'), 'periodic checking/same-version retains signature recovery');
  assert.equal(await inspect('Array.from(document.querySelectorAll("button")).some(b => /^Restart (now|to update)$/i.test(b.textContent.trim()))'), false, 'Periodic status resurrected stale restart');
  await snapshot('signature-periodic-recovery-retained');
  assert.equal((await mainRequest('/state')).installs, 0, 'Failure initiated an install');

  await freshRenderer();
  const network = 'net::ERR_CONNECTION_RESET updater fixture';
  await recovery(network, 'network-check-error', true);
  const checksBefore = (await mainRequest('/state')).checks;
  await cdp.click('[data-testid=update-retry]');
  await waitFor(async () => (await mainRequest('/state')).checks === checksBefore + 1, 'retry check crossed preload and main IPC');
  await waitUi('!document.querySelector("[data-testid=update-error]")', 'retry clears old error immediately');
  await mainRequest('/command', { type: 'release', status: { type: 'not-available' } });
  await waitUi('!document.querySelector("[data-testid=update-manual-download]")', 'successful retry clears recovery');
  await snapshot('network-check-recovered');

  await freshRenderer();
  await send({ type: 'available', version: '999.0.0', releaseNotes: 'Updater sandbox release notes.' });
  await send({ type: 'downloading', progress: { percent: 77, transferred: 77, total: 100 } });
  await waitUi('Array.from(document.querySelectorAll("button")).some(b => b.textContent.trim() === "77%")', 'download fixture exposes nonzero progress');
  await recovery('ETIMEDOUT updater fixture download', 'network-download-error', true);
  const downloadsBefore = (await mainRequest('/state')).downloads;
  await cdp.click('[data-testid=update-retry]');
  await waitFor(async () => (await mainRequest('/state')).downloads === downloadsBefore + 1, 'retry download crossed preload and main IPC');
  await waitUi('!document.querySelector("[data-testid=update-error]")', 'download retry clears stale error');
  await waitUi('Array.from(document.querySelectorAll("button")).some(b => b.textContent.trim() === "0%")', 'download retry resets old progress before main response');
  await mainRequest('/command', { type: 'release', status: { type: 'downloading', progress: { percent: 0, transferred: 0, total: 100 } } });
  await snapshot('network-download-retried');
  evidence.finalMain = await mainRequest('/state');
  assert.equal(evidence.finalMain.installs, 0);
  assert.deepEqual(evidence.finalMain.external, Array(4).fill('https://agentteams.live/#download'));
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error.stack ?? error);
  process.exitCode = 1;
  if (cdp) {
    evidence.failureUi = await inspect('document.body?.innerText').catch(String);
    await screenshot('failure').catch(() => {});
  }
} finally {
  if (controller) await mainRequest('/command', { type: 'stop' }).catch(() => {});
  cdp?.close();
  if (app && app.exitCode === null) {
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), pause(5000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
  }
  await mkdir(output, { recursive: true });
  if (liveLog) await new Promise((resolve) => liveLog.end(resolve));
  await writeFile(path.join(output, 'desktop.log'), log);
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Updater desktop E2E ${evidence.passed ? 'passed' : 'failed'}: ${output}`);
  if (evidence.error) console.error(evidence.error);
}
