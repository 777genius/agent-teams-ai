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
const root = process.env.NOTIFICATION_CHANNELS_E2E_OUTPUT_DIR ??
  await mkdtemp(path.join(os.tmpdir(), 'delivery-channels-E2E-'));
const home = path.join(root, 'home');
const claude = path.join(home, '.claude');
const userData = path.join(root, 'user-data');
const fakeFetchAudit = path.join(root, 'vendor-fetch.ndjson');
const customWebhookAudit = path.join(root, 'custom-webhook.ndjson');
const CUSTOM_WEBHOOK = 'https://hooks.agentteams-e2e.org/notify?sig=e2e-secret';
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

async function readCustomWebhookAudit() {
  const data = await readFile(customWebhookAudit, 'utf8');
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
  // React can render a row before its preceding save/refresh has cleared "busy".
  // Clicking a disabled native/Radix button silently does nothing and would
  // turn a real integration test into a misleading timeout.
  await until(async () => await evaluate(
    '(() => { const element = ' + expression + '; return Boolean(element && !element.disabled); })()'
  ), 'enabled control: ' + expression);
  await evaluate('(() => { const element = ' + expression +
    '; if (!element || element.disabled) throw new Error("Control unavailable before click");' +
    'element.click(); return true; })()');
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
    "const webhookDns = require('node:dns/promises');",
    "const originalLookup = webhookDns.lookup;",
    "webhookDns.lookup = async (name, options) => name === 'hooks.agentteams-e2e.org' ? [{address:'8.8.8.8',family:4}] : originalLookup(name,options);",
    "const https = require('node:https');",
    "const originalHttpsRequest = https.request;",
    "const Emitter = require('node:events').EventEmitter;",
    "https.request = (url, options, callback) => {",
    "  if (new URL(String(url)).hostname !== 'hooks.agentteams-e2e.org') return originalHttpsRequest(url,options,callback);",
    "  const req = new Emitter();",
    "  req.end = (body) => {",
    "    options.lookup('hooks.agentteams-e2e.org',{all:true},(err, addresses) => {",
    "      if (err) { req.emit('error',err); return; }",
    "      require('node:fs').appendFileSync(" + JSON.stringify(customWebhookAudit) +
        ", JSON.stringify({host:'hooks.agentteams-e2e.org',addresses,body:JSON.parse(String(body))})+'\\n');",
    "      queueMicrotask(() => { callback({statusCode:202,destroy(){}}); req.emit('close'); });",
    "    });",
    "  };",
    "  req.destroy = (error) => { if (error) req.emit('error',error); req.emit('close'); };",
    "  return req;",
    "};",
    "require('node:module').syncBuiltinESMExports();",
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
    JSON.stringify(lock.cliVersion ?? lock.version) + '); else process.exitCode=77;\n');
  await chmod(runtime, 0o755);

  const env = {
    ...Object.fromEntries(
      // Keep pnpm's installed store location when HOME is isolated. Otherwise
      // pnpm 11 tries to reinstall the workspace before the dev script starts.
      ['PATH', 'PNPM_HOME', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'TZ'].flatMap(
        (key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]
      )
    ),
    HOME: home,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    CLAUDE_CONFIG_DIR: claude,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtime,
    // This E2E only exercises settings and notifications, never terminal agents.
    // Keep the launcher from downloading a real terminal daemon in CI.
    CLAUDE_TERMINAL_DAEMON_BINARY: runtime,
    AGENT_TEAMS_MCP_HTTP: '0',
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
  await writeFile(customWebhookAudit, '');
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
  assert.deepEqual(channels[0].events, [], 'New provider must not subscribe silently');
  assert.equal(channels[0].name, 'TEST Telegram');
  assert.equal(channels[0].hasCredential, true);
  assert(!JSON.stringify(channels).includes(TOKEN));
  const metadataPath = path.join(userData, 'data', 'notification-channels.json');
  const metadata = await readFile(metadataPath, 'utf8');
  assert(!metadata.includes(TOKEN), 'Credential leaked into settings JSON');
  const vaultPath = path.join(userData, 'data', 'notification-channel-credentials', 'api-keys.json');
  const vaultOnDisk = await readFile(vaultPath, 'utf8');
  assert(!vaultOnDisk.includes(TOKEN), 'Credential must be encrypted at rest');
  assert.equal((await stat(vaultPath)).mode & 0o077, 0, 'Secret file must be owner-only');
  const privateKeyName = JSON.parse(vaultOnDisk)[0]?.envVarName;
  assert(privateKeyName, 'Private credential reference missing');
  const genericKeys = await rendererCall('window.electronAPI.apiKeys.list()');
  // The preload unwraps IpcResult<T> and rejects on IPC errors.
  assert(Array.isArray(genericKeys), 'Generic key listing must return an array');
  assert(!JSON.stringify(genericKeys).includes(privateKeyName),
    'Private notification key leaked through generic key listing');
  const genericLookup = await rendererCall('window.electronAPI.apiKeys.lookup(' +
    JSON.stringify([privateKeyName]) + ')');
  assert(Array.isArray(genericLookup), 'Generic credential lookup must return an array');
  assert.equal(genericLookup.length, 0,
    'Private notification key leaked through generic key lookup');
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

  // User-centric route editor: select a provider beside the existing event switch.
  const routeButton = "document.querySelector('button[data-delivery-events=user_inbox]')";
  await cdp.waitFor(routeButton, 'destination picker');
  assert.match(await evaluate(routeButton + '.textContent'), /Desktop/,
    'Existing desktop route must remain selected by default');
  await click(routeButton);
  await cdp.waitFor("document.querySelector('[aria-label=\"Deliver Message for you to TEST Telegram\"]')",
    'provider in destination picker');
  await click("document.querySelector('[aria-label=\"Deliver Message for you to TEST Telegram\"]')");
  await until(async () => {
    const list = await rendererCall('window.electronAPI.notificationChannels.list()');
    return list[0]?.events.includes('user_inbox');
  }, 'selected provider subscription persisted');
  const metadataRouted = await readFile(metadataPath, 'utf8');
  assert(metadataRouted.includes('user_inbox'));
  assert(!metadataRouted.includes(TOKEN), 'Routing must not write provider secrets in metadata');

  // External-only: uncheck Desktop without disabling the event or the provider.
  await click("document.querySelector('[aria-label=\"Desktop for Message for you\"]')");
  await until(async () => {
    const config = await rendererCall('window.electronAPI.config.get()');
    return config.notifications.desktopDisabledEvents?.includes('user_inbox');
  }, 'desktop exclusion persisted');
  evidence.checks.push('Settings event route → channel.events + native Desktop exclusion');

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

  // Source-hidden notifications remain in local history but never leave the app.
  const hidden = { ...secretPayload, dedupeKey: 'delivery-hidden-' + randomUUID(),
    suppressToast: true };
  await rendererCall('window.electronAPI.teams.showMessageNotification(' +
    JSON.stringify(hidden) + ')');
  await until(async () => {
    const history = await rendererCall('window.electronAPI.notifications.get({limit:100})');
    return history.notifications.some((item) => item.dedupeKey === hidden.dedupeKey);
  }, 'source-hidden notification committed to history');
  await safeDelay(250);
  assert.equal((await readAudit()).length, 2, 'Source-suppressed event leaked externally');

  // The duplicate must not create a second persisted event or an outbound POST.
  const beforeDuplicate = await rendererCall('window.electronAPI.notifications.get({limit:100})');
  await rendererCall('window.electronAPI.teams.showMessageNotification(' +
    JSON.stringify(secretPayload) + ')');
  await safeDelay(600);
  const afterDuplicate = await rendererCall('window.electronAPI.notifications.get({limit:100})');
  assert.equal(afterDuplicate.total, beforeDuplicate.total, 'Duplicate persisted twice');
  assert.equal((await readAudit()).length, 2, 'Duplicate event delivered twice');
  evidence.checks.push('Source suppression and persisted event dedupe prevent external delivery');

  await click("document.querySelector('section[aria-label=\"Delivery channels\"] [aria-label=\"Enable TEST Telegram\"]')");
  await until(async () => {
    const list = await rendererCall('window.electronAPI.notificationChannels.list()');
    return list[0]?.enabled === false;
  }, 'channel disabled');
  const disabledEvent = { ...secretPayload, dedupeKey: 'delivery-off-' + randomUUID() };
  await rendererCall('window.electronAPI.teams.showMessageNotification(' +
    JSON.stringify(disabledEvent) + ')');
  await until(async () => {
    const history = await rendererCall('window.electronAPI.notifications.get({limit:100})');
    return history.notifications.some((item) => item.dedupeKey === disabledEvent.dedupeKey);
  }, 'disabled-channel notification committed to history');
  await safeDelay(250);
  assert.equal((await readAudit()).length, 2, 'Disabled channel must not deliver');
  evidence.checks.push('Disabled destination suppresses external delivery');

  await cdp.screenshot(path.join(root, 'delivery-channels-after.png'));
  await click(button('Delete'));
  await click(button('Confirm delete'));
  await until(async () => (await rendererCall(
    'window.electronAPI.notificationChannels.list()')).length === 0, 'deleted channel');
  const metadataAfter = await readFile(metadataPath, 'utf8');
  assert(!metadataAfter.includes(TOKEN));
  assert.equal(JSON.parse(await readFile(vaultPath, 'utf8')).length, 0,
    'Deleted channel must remove its encrypted secret');
  evidence.checks.push('Delete removes destination and does not expose credential');

  // Same real Electron renderer -> IPC -> encrypted vault -> pinned HTTPS adapter.
  // Patch only the mock public hostname in the main process; no vendor request.
  await click(button('Add channel'));
  await setInput('input[placeholder="My Telegram"]', 'TEST Custom Webhook');
  await click("document.querySelector('section[aria-label=\\\"Delivery channels\\\"] [aria-label=\\\"Delivery provider\\\"]')");
  await cdp.waitFor(
    "Array.from(document.querySelectorAll('[role=option]')).find(x=>x.textContent?.includes('Custom Webhook'))",
    'custom webhook provider option'
  );
  await click("Array.from(document.querySelectorAll('[role=option]')).find(x=>x.textContent?.includes('Custom Webhook'))");
  await setInput('section[aria-label="Delivery channels"] input[type="password"]', CUSTOM_WEBHOOK);
  await click(button('Save channel'));
  await until(async () => {
    const items = await rendererCall('window.electronAPI.notificationChannels.list()');
    return items.length === 1 && items[0].provider === 'webhook';
  }, 'custom webhook saved');
  const webhookChannels = await rendererCall('window.electronAPI.notificationChannels.list()');
  assert(!JSON.stringify(webhookChannels).includes('e2e-secret'));
  assert(!(await readFile(metadataPath, 'utf8')).includes('e2e-secret'));
  assert(!(await readFile(vaultPath, 'utf8')).includes('e2e-secret'));

  await click(button('Test'));
  await until(async () => (await readCustomWebhookAudit()).length === 1,
    'custom HTTPS adapter Test request');
  const webhookTest = (await readCustomWebhookAudit())[0];
  assert.deepEqual(webhookTest.addresses, [{address:'8.8.8.8',family:4}]);
  assert.equal(webhookTest.body.source, 'agent-teams');
  assert.equal(webhookTest.body.event, 'test');
  assert.match(webhookTest.body.message, /Test notification/);
  assert(!JSON.stringify(webhookTest).includes('e2e-secret'));
  await until(async () => {
    const items = await rendererCall('window.electronAPI.notificationChannels.list()');
    return items[0]?.lastTest?.success === true;
  }, 'webhook test persisted');
  evidence.checks.push('Custom HTTPS Test → guarded DNS + pinned request → accepted response');

  await click("document.querySelector('section[aria-label=\\\"Delivery channels\\\"] [aria-label=\\\"Enable TEST Custom Webhook\\\"]')");
  await until(async () => (await rendererCall(
    'window.electronAPI.notificationChannels.list()'))[0]?.enabled === true,
    'webhook enabled');
  await click(routeButton);
  await cdp.waitFor(
    "document.querySelector('[aria-label=\\\"Deliver Message for you to TEST Custom Webhook\\\"]')",
    'webhook in event destinations'
  );
  await click("document.querySelector('[aria-label=\\\"Deliver Message for you to TEST Custom Webhook\\\"]')");
  await until(async () => (await rendererCall(
    'window.electronAPI.notificationChannels.list()'))[0]?.events.includes('user_inbox'),
    'webhook subscribed');
  await rendererCall('window.electronAPI.teams.showMessageNotification(' +
    JSON.stringify({...secretPayload, dedupeKey:'webhook-' + randomUUID()}) + ')');
  await until(async () => (await readCustomWebhookAudit()).length === 2,
    'automatic custom HTTPS delivery');
  const webhookAutomatic = (await readCustomWebhookAudit())[1];
  assert.equal(webhookAutomatic.body.event, 'user_inbox');
  assert.equal(webhookAutomatic.body.message, 'Agent Teams: Message for you.');
  assert(!JSON.stringify(webhookAutomatic).includes('password'));
  await until(async () => (await rendererCall(
    'window.electronAPI.notificationChannels.list()'))[0]?.lastDelivery?.success === true,
    'automatic delivery status');
  await click(button('Refresh status'));
  await until(async () => Boolean(await evaluate(
    'document.querySelector(\'section[aria-label="Delivery channels"]\')?.textContent?.includes("Automatic: Accepted by endpoint")'
  )), 'visible automatic diagnostic');
  evidence.checks.push('Automatic webhook event → fixed safe JSON + session status');

  await click(button('Delete'));
  await click(button('Confirm delete'));
  await until(async () => (await rendererCall(
    'window.electronAPI.notificationChannels.list()')).length === 0, 'webhook deleted');
  assert.deepEqual(JSON.parse(await readFile(vaultPath, 'utf8')), []);
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
