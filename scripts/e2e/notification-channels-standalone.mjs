#!/usr/bin/env node
/**
 * Real standalone Node entrypoint smoke: HTTP -> service -> persisted metadata
 * and private encrypted credential vault, with no network sends to vendors.
 *
 * Build first:
 *   pnpm exec vite build --config docker/vite.standalone.config.ts
 * Then:
 *   node scripts/e2e/notification-channels-standalone.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = path.join(repoRoot, 'dist-standalone', 'index.cjs');
const evidenceDir = process.env.NOTIFICATION_CHANNELS_E2E_OUTPUT_DIR;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
const root = evidenceDir
  ? await mkdtemp(path.join(evidenceDir, 'standalone-'))
  : await mkdtemp(path.join(os.tmpdir(), 'notification-standalone-E2E-'));
const claudeRoot = path.join(root, 'claude');
const appData = path.join(root, 'app-data');
const home = path.join(root, 'home');
const TEST_TOKEN = '123456789:abcdefghijklmnopqrstuvwxyz_0123456789';
let processOwner;
let logs = '';
let passed = false;
const assertions = [];

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Missing server address');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startHost(port) {
  assert(existsSync(entry), 'Build the standalone entrypoint before running this test');
  await Promise.all([claudeRoot, appData, home].map((dir) => mkdir(dir, { recursive: true })));
  await mkdir(path.join(claudeRoot, 'projects'), { recursive: true });
  await writeFile(path.join(claudeRoot, 'agent-teams-config.json'), JSON.stringify({
    general: { appLocale: 'en', theme: 'dark' },
    notifications: { enabled: false, soundEnabled: false },
  }));
  const env = Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL', 'TZ'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]]
    )
  );
  Object.assign(env, {
    HOME: home,
    CLAUDE_ROOT: claudeRoot,
    APP_DATA_DIR: appData,
    PORT: String(port),
    HOST: '127.0.0.1',
    CORS_ORIGIN: 'http://127.0.0.1:' + port,
    AGENT_TEAMS_MCP_HTTP: '0',
    NODE_ENV: 'test',
  });
  processOwner = spawn(process.execPath, [entry], {
    cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  processOwner.on('error', (error) => { logs += '\n' + error.message; });
  for (const stream of [processOwner.stdout, processOwner.stderr]) {
    stream.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-8000); });
  }
}

async function waitUntilReady(baseUrl) {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    if (processOwner.exitCode !== null || processOwner.signalCode !== null) {
      throw new Error('Standalone exited early:\n' + logs.slice(-2500));
    }
    try {
      const res = await fetch(baseUrl + '/api/notification-channels', {
        headers: { Origin: baseUrl },
        signal: AbortSignal.timeout(1500),
      });
      if (res.status === 200 && Array.isArray(await res.json())) return;
      if (res.status >= 500) throw new Error('Standalone failed startup with HTTP ' + res.status);
    } catch {
      // Server is still starting; respect the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Standalone API did not start:\n' + logs.slice(-2500));
}

async function request(baseUrl, method, suffix, payload, origin = baseUrl) {
  const res = await fetch(baseUrl + '/api/notification-channels' + suffix, {
    method,
    headers: { Origin: origin, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  return { status: res.status, body: text, json: text ? JSON.parse(text) : null };
}

async function run() {
  const port = await allocatePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  await startHost(port);
  await waitUntilReady(baseUrl);
  assertions.push('Standalone server booted against isolated HOME, CLAUDE_ROOT and APP_DATA_DIR');
  // The ConfigManager singleton must read the overridden CLAUDE_ROOT profile.
  // If it is imported before the override, it falls back to HOME/.claude.
  const profile = await fetch(baseUrl + '/api/config', {
    headers: { Origin: baseUrl },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(profile.status, 200);
  const configResponse = await profile.json();
  assert.equal(configResponse.success, true);
  assert.equal(configResponse.data.notifications.enabled, false,
    'ConfigManager must read the overridden CLAUDE_ROOT profile');
  assertions.push('Standalone ConfigManager resolves CLAUDE_ROOT after overrides');

  const invalidOrigin = await request(baseUrl, 'POST', '', {}, 'https://evil.example');
  assert.equal(invalidOrigin.status, 403, 'Untrusted origins must not write settings');
  const readWithWrongOrigin = await request(baseUrl, 'GET', '', undefined, 'https://evil.example');
  assert.equal(readWithWrongOrigin.status, 403, 'Untrusted origins must not read metadata');
  assertions.push('Cross-origin credential administration denied');

  const initial = await request(baseUrl, 'GET', '');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json, []);

  const saved = await request(baseUrl, 'POST', '', {
    name: 'Standalone Telegram test',
    provider: 'telegram',
    enabled: false,
    events: ['user_inbox'],
    chatId: '123456',
    secret: TEST_TOKEN,
  });
  assert.equal(saved.status, 200, saved.body.slice(0, 120));
  assert.equal(saved.json.enabled, false, 'External delivery must default to off');
  assert.equal(saved.json.hasCredential, true);
  assert(!saved.body.includes(TEST_TOKEN), 'Secret leaked in save response');
  const id = saved.json.id;

  const metaPath = path.join(appData, 'data', 'notification-channels.json');
  const vaultPath = path.join(appData, 'data', 'notification-channel-credentials', 'api-keys.json');
  const meta = await readFile(metaPath, 'utf8');
  const vault = await readFile(vaultPath, 'utf8');
  assert(!meta.includes(TEST_TOKEN), 'Credential leaked into metadata');
  assert(!vault.includes(TEST_TOKEN), 'Credential not encrypted at rest');
  if (process.platform !== 'win32') {
    assert.equal((await stat(vaultPath)).mode & 0o077, 0, 'Vault file must be owner-only');
    assert.equal((await stat(metaPath)).mode & 0o077, 0, 'Metadata file must be owner-only');
  }
  assertions.push('HTTP save → owner-only metadata + encrypted isolated vault');

  const read = await request(baseUrl, 'GET', '');
  assert.equal(read.status, 200);
  assert.equal(read.json.length, 1);
  assert.equal(read.json[0].id, id);
  assert.equal(read.json[0].hasCredential, true);
  assert(!read.body.includes(TEST_TOKEN), 'Secret leaked in list');

  const updated = await request(baseUrl, 'POST', '', {
    id, name: 'Standalone Telegram updated', provider: 'telegram',
    enabled: false, events: ['task_blocked'], chatId: '123456',
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.events, ['task_blocked']);
  assertions.push('Update retains secret reference without exposing token');

  const deleted = await request(baseUrl, 'DELETE', '/' + encodeURIComponent(id));
  assert.equal(deleted.status, 200);
  assert.deepEqual((await request(baseUrl, 'GET', '')).json, []);
  assert.deepEqual(JSON.parse(await readFile(vaultPath, 'utf8')), []);
  assertions.push('Deleting destination removes encrypted credential');

  // Never call POST /:id/test: this smoke must not contact real vendor endpoints.
  passed = true;
}

try {
  await run();
} catch (error) {
  process.exitCode = 1;
  // Only bounded diagnostics; test token must never be logged.
  console.error(String(error).replaceAll(TEST_TOKEN, '[redacted]'));
} finally {
  if (processOwner && processOwner.exitCode === null) {
    processOwner.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (processOwner.exitCode === null && processOwner.signalCode === null) processOwner.kill('SIGKILL');
  }
  const receipt = { suite: 'notification-channels-standalone', passed, assertions };
  await writeFile(path.join(root, 'receipt-standalone.json'), JSON.stringify(receipt, null, 2));
  if (!evidenceDir) await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(receipt));
}
