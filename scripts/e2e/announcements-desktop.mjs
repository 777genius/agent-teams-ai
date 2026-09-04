#!/usr/bin/env node
// Never launches Electron; parent owns the dev:mcp process and its cleanup.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { publishFixture } from './announcements/fixtures.mjs';
import { connectCdp } from './announcements/cdp.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const mode = args.find((arg) => ['--seed', '--serve', '--verify'].includes(arg));
const scenario = option('--scenario', mode === '--verify' ? 'initial' : 'ten');
const json = (file) => readFile(file, 'utf8').then(JSON.parse);
async function manifestFor(root) {
  const canonical = await realpath(root);
  assert(
    path.basename(canonical).startsWith('announcements-desktop-e2e-'),
    'Expected owned sandbox prefix'
  );
  assert.equal(
    path.dirname(canonical),
    await realpath(os.tmpdir()),
    'Sandbox must be a direct tmpdir child'
  );
  const manifest = await json(path.join(canonical, 'fixture.json'));
  assert.equal(manifest.root, canonical);
  assert.equal(manifest.userDataRoot, path.join(canonical, 'user-data'));
  assert.equal(manifest.claudeRoot, path.join(canonical, 'claude'));
  return manifest;
}

if (mode === '--seed') {
  const root = option('--root')
    ? (await manifestFor(option('--root'))).root
    : await realpath(await mkdtemp(path.join(os.tmpdir(), 'announcements-desktop-e2e-')));
  const manifest = {
    schemaVersion: 1,
    root,
    userDataRoot: path.join(root, 'user-data'),
    claudeRoot: path.join(root, 'claude'),
    createdAt: new Date().toISOString(),
  };
  await mkdir(manifest.userDataRoot, { recursive: true });
  await mkdir(manifest.claudeRoot, { recursive: true });
  const processes = execFileSync('ps', ['eww', '-ax', '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(
    !processes
      .split('\n')
      .some(
        (line) =>
          line.includes(`AGENT_TEAMS_ELECTRON_USER_DATA_DIR=${manifest.userDataRoot}`) &&
          /Electron/.test(line)
      ),
    'Stop sandbox Electron before reseeding state'
  );
  if (option('--usage-ms') !== undefined) {
    const accumulatedOpenMs = Number(option('--usage-ms'));
    assert(Number.isSafeInteger(accumulatedOpenMs) && accumulatedOpenMs >= 0);
    const directory = path.join(manifest.userDataRoot, 'data/announcements');
    await mkdir(directory, { recursive: true });
    const statePath = path.join(directory, 'state.json');
    let state;
    try {
      state = await json(statePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = {
        schemaVersion: 1,
        origin: 'fresh',
        firstAppOpenedAt: new Date().toISOString(),
        trackingStartedAt: new Date().toISOString(),
        autoSuppressedThrough: null,
        handledIds: [],
        dismissedIds: [],
      };
    }
    await writeFile(statePath, JSON.stringify({ ...state, accumulatedOpenMs }));
  }
  await writeFile(path.join(root, 'fixture.json'), JSON.stringify(manifest, null, 2));
  await publishFixture(root, scenario);
  console.log(JSON.stringify(manifest, null, 2));
} else if (mode === '--serve') {
  const manifest = await manifestFor(option('--root'));
  const port = Number(option('--port', '9477'));
  let offline = false;
  let tail = Promise.resolve();
  const mime = {
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png',
    '.gif': 'image/gif',
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'POST' && url.pathname === '/__fixture') {
        const next = url.searchParams.get('scenario');
        assert(
          ['ten', 'new', 'edited', 'expired', 'cohort', 'empty', 'offline', 'online'].includes(next)
        );
        tail = tail
          .catch(() => {})
          .then(async () => {
            if (next === 'offline' || next === 'online') offline = next === 'offline';
            else {
              await publishFixture(manifest.root, next);
              offline = false;
            }
        });
        await tail;
        res.writeHead(204, { 'X-Content-Type-Options': 'nosniff' });
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (offline) {
        res.writeHead(503);
        res.end('Fixture offline');
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const publicRoot = path.join(manifest.root, 'public');
      const file = path.resolve(publicRoot, relative);
      assert(file.startsWith(publicRoot + path.sep));
      assert((await stat(file)).size <= 2 * 1024 * 1024);
      res.writeHead(200, {
        'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1', () =>
    console.log(
      JSON.stringify({
        root: manifest.root,
        feedUrl: `http://127.0.0.1:${port}/announcements/feed.v1.json`,
        pid: process.pid,
      })
    )
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.close();
      server.closeAllConnections();
    });
} else if (mode === '--verify') {
  const manifest = await manifestFor(option('--root'));
  const pid = Number(option('--app-pid'));
  assert(Number.isSafeInteger(pid) && pid > 1, 'Provide the owned Electron main PID');
  const command = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  for (const [key, value] of Object.entries({
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: manifest.userDataRoot,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: manifest.claudeRoot,
  }))
    assert(command.includes(`${key}=${value}`), `Process lacks sandbox evidence: ${key}`);
  const port = Number(option('--cdp-port', '9222'));
  assert(
    command.includes(`--remote-debugging-port=${port}`),
    'PID must own intended Electron CDP endpoint'
  );
  assert(
    command.includes('AGENT_TEAMS_ANNOUNCEMENTS_FEED_URL=http://127.0.0.1:'),
    'Missing loopback fixture feed evidence'
  );
  const tabs = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json());
  const pages = tabs.filter(
    (tab) =>
      tab.type === 'page' &&
      (/^http:\/\/(localhost|127\.0\.0\.1):/.test(tab.url) || tab.url.startsWith('file:'))
  );
  assert.equal(pages.length, 1, 'Expected one dev:mcp renderer');
  const client = await connectCdp(pages[0].webSocketDebuggerUrl);
  try {
    const state = await client.inspect(
      `(() => ({ text: document.body.innerText, unsafe: window.__announcementUnsafeExecuted === true, badLinks: [...document.querySelectorAll('[role="dialog"] article a')].map(a=>a.getAttribute('href')).filter(h=>h && /^(javascript|file|command|task|team|vscode|data):/i.test(h)), dialogs: [...document.querySelectorAll('[role="dialog"]')].map(e=>e.textContent), images: [...document.images].map(e=>({alt:e.alt,loaded:e.complete && e.naturalWidth>0})), overflow: document.documentElement.scrollWidth > innerWidth }))()`
    );
    assert.equal(state.unsafe, false);
    assert.equal(state.badLinks.length, 0);
    if (scenario === 'initial' || scenario === 'empty')
      assert(
        !state.dialogs.some((text) => text.includes('Fixture')),
        'Unexpected automatic fixture modal'
      );
    if (scenario === 'empty')
      assert(!state.text.includes('Fixture '), 'Empty feed still shows fixture history');
    if (scenario === 'rich') {
      assert(state.text.includes('End of rich fixture.'), 'Rich body not open');
      assert.equal(state.overflow, false, 'Viewport has horizontal overflow');
      for (const alt of [
        'Blue violet banner',
        'Pipeline diagram: three blue stages connected in sequence',
        'Tiny GIF',
      ])
        assert(
          state.images.some((image) => image.alt === alt && image.loaded),
          `Image did not load: ${alt}`
        );
    }
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      path.join(manifest.root, `verify-${scenario}.png`),
      Buffer.from(screenshot.data, 'base64')
    );
    await writeFile(
      path.join(manifest.root, `verify-${scenario}.json`),
      JSON.stringify({ scenario, checkedAt: new Date().toISOString(), state }, null, 2)
    );
    console.log(`Verified ${scenario}: ${manifest.root}`);
  } finally {
    client.close();
  }
} else {
  console.log(
    'Usage: --seed [--scenario ten|empty] | --serve --root PATH [--port 9477] | --verify --root PATH --app-pid PID [--cdp-port 9222] [--scenario initial|rich|empty]'
  );
  process.exitCode = 1;
}
