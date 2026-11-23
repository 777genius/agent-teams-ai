#!/usr/bin/env node
/**
 * Disposable, real Electron renderer → preload → main → persistent settings →
 * Thinwrap transport E2E. Test credentials only; vendor fetch is intercepted
 * inside the main process, before the real adapter calls it.
 *
 * Run on a Linux desktop / xvfb:
 *   node scripts/e2e/notification-channels-desktop.mjs
 * Never launches agent runtimes or touches user projects.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpClient } from './comment-notification/cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.platform, 'linux', 'This harness uses the disposable Linux desktop');
const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-channels-E2E-'));
const home = path.join(root, 'home');
const claude = path.join(home, '.claude');
const userData = path.join(root, 'user-data');
const fakeFetchAudit = path.join(root, 'vendor-fetch.ndjson');
const evidence = {
  suite: 'notification-channels-desktop',
  root,
  checks: [],
  passed: false,
};
const TOKEN = '123456789:abcdefghijklmnopqrstuvwxyz_0123456789';
const safeDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
let cdp;
let log = '';

async function until(predicate, label, limitMs = 45_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await safeDelay(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function readAudit() {
  const data = await readFile(fakeFetchAudit, 'utf8');
  return data.trim() ? data.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

async function evaluate(expression) {
  assert(cdp, 'Renderer not connected');
  return cdp.evaluate(expression);
}

async function rendererCall(expression) {
  return evaluate('(async () => (' + expression + '))()');
}

function button(name) {
  return "Array.from(document.querySelectorAll('section[aria-label=\"Delivery channels\"] button')).find(x => x.textContent?.trim() === " + JSON.stringify(name) + ')';
}

async function click(expression) {
  await until(async () => await evaluate('Boolean(' + expression + ')'), 'button: ' + expression);
  await evaluate(expression + '.click()');
}

async function setInput(selector, value) {
  await evaluate("(() => { const input=document.querySelector(" + JSON.stringify(selector) +
    "); if (!input) throw new Error('Missing input');" +
    "const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;" +
    "set.call(input," + JSON.stringify(value) + ");" +
    "input.dispatchEvent(new Event('input',{bubbles:true})); })()");
}

async function launch() {
  const config = path.join(root, 'electron.delivery.e2e.config.ts');
  // No real API calls can reach Telegram. The actual Thinwrap HTTP requests
  // are intercepted at the final main-process fetch boundary.
  const fixture = [
    "if (process.type === 'browser') {",
    "const orig = globalThis.fetch;",
    "globalThis.fetch = async (url, options) => {",
    "  const target = new URL(String(url));",
    "  if (target.hostname === 'api.telegram.org') {",
    "    require('node:fs').appendFileSync(" + JSON.stringify(fakeFetchAudit) +
       ", JSON.stringify({host:target.hostname,method:options?.method," +
       "redirect:options?.redirect,body:JSON.parse(String(options?.body ?? '{}'))})+'\\n');",
    "    return new Response(JSON.stringify({ok:true,result:{message_id:17}})," +
       "{status:200,headers:{'content-type':'application/json'}});",
    "  }",
    "  return orig(url, options);",
    "};",
    "}",
  ].join('\n');
  await writeFile(config, [
    "import base from " + JSON.stringify(path.join(repo, 'electron.vite.config.ts')) + ';',
    'const output = base.main.build.rollupOptions.output;',
    'export default {...base, main: {...base.main, build: {...base.main.build,',
    'rollupOptions: {...base.main.build.rollupOptions,',
    'output: {...output, banner: (output.banner ?? "") + "\\n" + ' + JSON.stringify(fixture) + ' }}}}};',
  ].join('\n'));
  const runtime = path.join(root, 'deny-agent-runtime.cjs');
  const lock = JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8'));
  await writeFile(runtime, '#!' + process.execPath + '\n' +
    'if(process.argv.slice(2).join(" ")==="--version") console.log(' +
    JSON.stringify(lock.version) + '); else process.exitCode=77;\n');
  await chmod(runtime, 0o755);

  const env = {
    ...Object.fromEntries(
      ['PATH', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'TZ'].flatMap(
        (key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]
      )
    ),
    HOME: home,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    CLAUDE_CONFIG_DIR: claude,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtime,
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
  };
  if (process.getuid?.() === 0) env.NO_SANDBOX = '1';
  app = spawn('pnpm', ['dev:mcp', '--config', config], {
    cwd: repo,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.on('error', (error) => { log += '\n' + error.message; });
  for (const stream of [app.stdout, app.stderr]) {
    stream.on('data', (data) => { log += data.toString(); });
  }
  let port;
  await until(() => {
    if (app.exitCode !== null) throw new Error('Electron exited:\n' + log.slice(-4000));
    const match = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (!match) return false;
    port = Number(match[1]);
    return true;
  }, 'owned Electron CDP', 180_000);
  let target;
  await until(async () => {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = list.find((item) => item.type === 'page' &&
        item.url.startsWith('http://localhost:'));
      return Boolean(target);
    } catch {
      return false;
    }
  }, 'owned Electron renderer', 60_000);
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.waitFor('window.electronAPI?.notificationChannels && window.__agentTeamsDevStore',
    'real preload and app store', 60_000);
}

async function run() {
  await Promise.all([home, claude, userData].map((p) => mkdir(p, { recursive: true })));
  await mkdir(path.join(claude, 'projects'), { recursive: true });
  await writeFile(fakeFetchAudit, '');
  await writeFile(path.join(claude, 'agent-teams-config.json'), JSON.stringify({
    general: { appLocale: 'en', theme: 'dark', defaultTab: 'dashboard' },
    notifications: { enabled: true, notifyOnUserInbox: true, soundEnabled: false },
  }));
  await launch();

  // Real renderer / preload, no stubbing of the UI or of credential persistence.
  await evaluate("window.__agentTeamsDevStore.getState().openTab({type:'settings',label:'Settings'})");
  await cdp.waitFor("document.querySelector('[data-testid=\"settings-nav-notifications\"]')",
    'settings navigation');
  await click("document.querySelector('[data-testid=\"settings-nav-notifications\"]')");
  await cdp.waitFor("document.querySelector('section[aria-label=\"Delivery channels\"]')",
    'real React delivery settings');
  await cdp.screenshot(path.join(root, 'delivery-channels-before.png'));
  evidence.checks.push('Settings page and notification section render');

  await click(button('Add channel'));
  await cdp.waitFor('document.querySelector("input[placeholder=\\"My Telegram\\"]")',
    'channel editor');
  await setInput('input[placeholder="My Telegram"]', 'TEST Telegram');
  const fields = await evaluate("Array.from(document.querySelectorAll('section[aria-label=\"Delivery channels\"] input')).map(x=>({type:x.type,placeholder:x.placeholder}))");
  const chatSelector = 'section[aria-label="Delivery channels"] input[autocomplete="off"]:not([placeholder])';
  assert(fields.some((item) => item.type === 'password'), 'Secret field must be masked');
  await setInput(chatSelector, '123456');
  await setInput('section[aria-label="Delivery channels"] input[type="password"]', TOKEN);
  await until(async () => evaluate('Boolean(' + button('Save channel') + ' && !' +
    button('Save channel') + '.disabled)'), 'valid form');
  await click(button('Save channel'));
  await until(async () => {
    const list = await rendererCall('window.electronAPI.notificationChannels.list()');
    return list.length === 1;
  }, 'saved real IPC channel');
  const channels = await rendererCall('window.electronAPI.notificationChannels.list()');
  assert.equal(channels[0].enabled, false, 'Outbound delivery must be opt-in');
  assert.equal(channels[0].name, 'TEST Telegram');
  assert.equal(channels[0].hasCredential, true);
  assert(!JSON.stringify(channels).includes(TOKEN));
  const metadataPath = path.join(userData, 'data', 'notification-channels.json');
  const metadata = await readFile(metadataPath, 'utf8');
  assert(!metadata.includes(TOKEN), 'Credential leaked into settings JSON');
  const vaultPath = path.join(claude, 'api-keys.json');
  const vaultOnDisk = await readFile(vaultPath, 'utf8');
  assert(!vaultOnDisk.includes(TOKEN), 'Credential must be encrypted at rest');
  assert.equal((await stat(vaultPath)).mode & 0o077, 0, 'Secret file must be owner-only');
  assert.equal((await stat(metadataPath)).mode & 0o077, 0, 'Metadata file must be owner-only');
  evidence.checks.push('React form → IPC → encrypted credential + owner-only metadata');

  await click(button('Test'));
  await until(async () => (await readAudit()).length === 1, 'real Thinwrap test POST');
  let audit = await readAudit();
  assert.equal(audit[0].host, 'api.telegram.org');
  assert.equal(audit[0].method, 'POST');
  assert.equal(audit[0].redirect, 'error');
  assert.match(audit[0].body.text, /Test notification/);
  assert(!JSON.stringify(audit).includes(TOKEN));
  evidence.checks.push('User Test → Thinwrap → guarded vendor fetch → observed success');

  // Enable via actual Radix checkbox. The synthetic team event must not be
  // source-suppressed: NotificationManager deliberately excludes hidden events.
  await click("document.querySelector('section[aria-label=\"Delivery channels\"] [aria-label=\"Enable TEST Telegram\"]')");
  await until(async () => {
    const list = await rendererCall('window.electronAPI.notificationChannels.list()');
    return list[0]?.enabled === true;
  }, 'opt-in enabled');

  const secretPayload = {
    teamName: 'TEST-notification-channels',
    teamDisplayName: 'TEST private workspace',
    from: 'test-agent',
    body: 'private password and internal agent prompt',
    summary: 'private summary',
    teamEventType: 'user_inbox',
    dedupeKey: 'delivery-e2e-' + randomUUID(),
    suppressToast: false,
  };
  await rendererCall('window.electronAPI.teams.showMessageNotification(' +
    JSON.stringify(secretPayload) + ')');
  await until(async () => (await readAudit()).length === 2, 'committed notification dispatch');
  audit = await readAudit();
  assert.equal(audit[1].body.text, 'Agent Teams: Message for you.');
  assert(!JSON.stringify(audit).includes('password'));
  assert(!JSON.stringify(audit).includes('private'));
  evidence.checks.push('Real team notification → sanitized outbound event, no private content');

  await click("document.querySelector('section[aria-label=\"Delivery channels\"] [aria-label=\"Enable TEST Telegram\"]')");
  await until(async () => {
    const list = await rendererCall('window.electronAPI.notificationChannels.list()');
    return list[0]?.enabled === false;
  }, 'channel disabled');
  await rendererCall('window.electronAPI.teams.showMessageNotification(' +
    JSON.stringify({ ...secretPayload, dedupeKey: 'delivery-off-' + randomUUID() }) + ')');
  await safeDelay(1200);
  assert.equal((await readAudit()).length, 2, 'Disabled channel must not deliver');
  evidence.checks.push('Disabled destination suppresses external delivery');

  await cdp.screenshot(path.join(root, 'delivery-channels-after.png'));
  await click(button('Delete'));
  await click(button('Confirm delete'));
  await until(async () => (await rendererCall(
    'window.electronAPI.notificationChannels.list()')).length === 0, 'deleted channel');
  const metadataAfter = await readFile(metadataPath, 'utf8');
  assert(!metadataAfter.includes(TOKEN));
  evidence.checks.push('Delete removes destination and does not expose credential');
  evidence.passed = true;
}

try {
  await run();
} catch (error) {
  evidence.error = String(error);
  evidence.rendererLogTail = log.slice(-2500).replaceAll(TOKEN, '[redacted]');
  process.exitCode = 1;
} finally {
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify(evidence, null, 2));
  if (cdp) await cdp.close().catch(() => undefined);
  if (app?.pid) {
    // Only stop our detached test process group. Never terminate shared hosts.
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await safeDelay(1000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
  }
  console.log(JSON.stringify(evidence, null, 2));
}
