#!/usr/bin/env node
// Disposable Electron profile and CLI only. No agent/team launch commands.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { catalogScenarios, verifyCatalog } from './opencode-diagnostics/catalog.mjs';
import {
  processes,
  sameIdentity,
  ownedTree,
  listeners,
  assertListenerOwnership,
  assertPortAvailable,
  fixtureShim,
  launchCommand,
  isolatedEnvironment,
  assertNoInstalledOpenCode,
  assertLauncherCommand,
} from './opencode-diagnostics/platform.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2];
const root = process.argv[3];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function manifest() {
  assert(
    root && path.basename(root).startsWith('opencode-diagnostics-e2e-'),
    'Owned sandbox required'
  );
  const data = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(data.root, path.resolve(root));
  return data;
}

async function ownedProcesses() {
  const data = await manifest();
  assert(data.launcher, 'No manifest-owned launcher');
  const owned = ownedTree(processes(), data.launcher);
  assertLauncherCommand(data.launcher);
  return owned;
}

async function assertOwnedDebugEndpoint() {
  // Retain the existing bounded recheck, without assuming the cause of snapshot differences.
  // Missing/reused launcher or foreign listeners still fail closed.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Read listeners first so children born during lsof are in the later ancestry snapshot.
    const ids = listeners();
    const owned = await ownedProcesses();
    try {
      assertListenerOwnership(ids, owned);
    } catch (error) {
      // Diagnostic only: a later snapshot never authorizes this failed access.
      try {
        await writeFile(
          path.join(root, 'ownership-failure.json'),
          JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              attempt,
              launcher: (await manifest()).launcher,
              ownedBefore: owned,
              listenerPids: ids,
              processesAfter: processes(),
            },
            null,
            2
          )
        );
      } catch {
        /* Preserve ownership error. */
      }
      throw error;
    }
    const current = processes();
    sameIdentity(
      owned[0],
      current.find((p) => p.pid === owned[0].pid)
    );
    const listenerProcesses = owned.filter((p) => ids.includes(p.pid));
    if (listenerProcesses.some((p) => !current.some((now) => now.pid === p.pid))) continue;
    for (const entry of listenerProcesses)
      sameIdentity(
        entry,
        current.find((p) => p.pid === entry.pid)
      );
    return;
  }
  throw new Error('CDP listener ownership did not stabilize; refusing access');
}

if (mode === 'seed') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-'));
  const data = {
    root: dir,
    home: path.join(dir, 'home'),
    userData: path.join(dir, 'user-data'),
    bin: path.join(dir, 'bin'),
    temp: path.join(dir, 'tmp'),
    node: process.execPath,
    fixture: path.join(dir, 'fixture.cjs'),
    platform: process.platform,
  };
  for (const value of [data.home, data.userData, data.bin, data.temp])
    await mkdir(value, { recursive: true });
  await writeFile(path.join(dir, 'scenario'), 'version-exit');
  await writeFile(
    data.fixture,
    await readFile(new URL('./opencode-diagnostics/fixture.cjs', import.meta.url))
  );
  for (const [role, name] of [
    ['opencode', 'opencode'],
    ['orchestrator', 'fixture-runtime'],
  ]) {
    data[role] = path.join(data.bin, name + (process.platform === 'win32' ? '.cmd' : ''));
    await writeFile(data[role], fixtureShim(data.node, data.fixture, role), { mode: 0o755 });
  }
  // PATH .cmd candidates are intentionally rejected by the production native-runtime
  // resolver. Seed its existing app-managed fixture contract instead of changing it.
  data.openCodeManifest = path.join(data.userData, 'data/runtimes/opencode/current.json');
  await mkdir(path.dirname(data.openCodeManifest), { recursive: true });
  await writeFile(
    data.openCodeManifest,
    JSON.stringify({
      schemaVersion: 1,
      version: '1.14.24',
      platformPackage: 'diagnostics-fixture',
      binaryPath: data.opencode,
      integrity: 'disposable-fixture',
      installedAt: new Date().toISOString(),
    })
  );
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(data, null, 2));
  console.log(dir);
} else if (mode === 'stop') {
  const owned = await ownedProcesses();
  // Capture identities before cleanup; never use taskkill /T or a process-group signal.
  for (const entry of owned.reverse()) {
    const current = processes().find((p) => p.pid === entry.pid);
    if (!current) continue;
    sameIdentity(entry, current);
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  console.log('Stopped owned test process tree');
} else if (mode === 'start') {
  const data = await manifest();
  assert(!data.launcher, 'Sandbox already started; seed a new sandbox');
  assertNoInstalledOpenCode(data);
  await assertPortAvailable();
  const launch = launchCommand();
  const child = spawn(launch.command, launch.args, {
    cwd: repo,
    stdio: 'inherit',
    shell: false,
    env: isolatedEnvironment(data),
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  data.launcher = processes().find((p) => p.pid === child.pid);
  assert(data.launcher?.birth, 'Could not establish launcher birth identity');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(data, null, 2));
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} else if (mode === 'inspect' || mode === 'verify') {
  await manifest();
  await assertOwnedDebugEndpoint();
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const target = targets.find(
    (entry) => entry.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):/.test(entry.url)
  );
  assert(target, 'No dev renderer');
  const endpoint = new URL(target.webSocketDebuggerUrl);
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) &&
      endpoint.port === '9222' &&
      endpoint.protocol === 'ws:',
    'Unexpected CDP endpoint'
  );
  await assertOwnedDebugEndpoint();
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const response = JSON.parse(String(raw));
    if (response.method === 'Log.entryAdded' || response.method === 'Runtime.exceptionThrown')
      console.log(JSON.stringify(response.params));
    const item = pending.get(response.id);
    if (item) {
      pending.delete(response.id);
      clearTimeout(item.timer);
      response.error
        ? item.reject(new Error(response.error.message))
        : item.resolve(response.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`CDP timeout: ${method} ${params.expression?.slice(0, 80) ?? ''}`));
      }, 15000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  try {
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.bringToFront');
    if (mode === 'verify')
      await send('Browser.grantPermissions', {
        origin: new URL(target.url).origin,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
    if (mode === 'inspect') {
      console.log(await evaluate('document.body.innerText'));
      console.log(
        await evaluate(
          'JSON.stringify({ready:document.readyState,resources:performance.getEntriesByType("resource").slice(-6).map(r=>({name:r.name,duration:r.duration})),scripts:[...document.scripts].map(s=>s.src)})'
        )
      );
    } else {
      const scenario = (await readFile(path.join(root, 'scenario'), 'utf8')).trim();
      if (catalogScenarios.includes(scenario)) {
        await verifyCatalog({ root, scenario, evaluate, send });
      } else {
        let found;
        for (let attempt = 0; attempt < 90; attempt++) {
          if (attempt === 0) {
            const refresh = await evaluate(
              `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh status' && !b.disabled); if (!button) return null; button.scrollIntoView({block:'center'}); const r = button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
            );
            if (refresh) {
              await send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                button: 'left',
                clickCount: 1,
                ...refresh,
              });
              await send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                button: 'left',
                clickCount: 1,
                ...refresh,
              });
            }
          }
          found = await evaluate(
            `document.querySelector('[data-testid="opencode-version-diagnostics"]')?.innerText`
          );
          if (
            scenario === 'ready'
              ? !found && attempt >= 5
              : found && (scenario !== 'version-timeout' || found.includes('timed out'))
          )
            break;
          await delay(1000);
        }
        if (scenario === 'ready') {
          assert(!found, 'Successful retry retained stale diagnostics');
          console.log(JSON.stringify({ passed: true, scenario, platform: process.platform }));
          const screenshot = await send('Page.captureScreenshot');
          await writeFile(path.join(root, 'ready.png'), Buffer.from(screenshot.data, 'base64'));
          ws.close();
          process.exit(0);
        }
        assert(found, 'Version diagnostic alert not visible');
        assert.match(found, /version_probe/);
        await evaluate(
          `document.querySelector('[data-testid="opencode-version-diagnostics"] button').scrollIntoView({block:'center'})`
        );
        const point = await evaluate(
          `(() => { const r = document.querySelector('[data-testid="opencode-version-diagnostics"] button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
        );
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          ...point,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          ...point,
        });
        for (let attempt = 0; attempt < 30; attempt++) {
          if (
            (
              await evaluate(
                `document.querySelector('[data-testid="opencode-version-diagnostics"] button').innerText`
              )
            ).includes('Copied')
          )
            break;
          await delay(100);
        }
        const copied = await evaluate('navigator.clipboard.readText()');
        assert.match(copied, /version_probe/);
        assert.match(copied, /reportId: oc-[a-f0-9]{32}/);
        assert.match(copied, /timeoutMs: 30000/);
        assert.match(copied, scenario === 'version-timeout' ? /timedOut: true/ : /Exit code: 9/);
        assert(!copied.includes('DO_NOT_COPY_THIS_SECRET'));
        const logs = await readFile(path.join(root, 'user-data/logs/app-errors.ndjson'), 'utf8');
        assert(!logs.includes('DO_NOT_COPY_THIS_SECRET'));
        const reportId = copied.match(/reportId: (oc-[a-f0-9]{32})/)[1];
        assert(logs.includes(reportId), 'Log lost the report correlation ID');
        await writeFile(path.join(root, `copied-report-${scenario}.txt`), copied);
        await writeFile(path.join(root, 'copied-report.txt'), copied);
        console.log(
          JSON.stringify({
            passed: true,
            platform: process.platform,
            reportPath: path.join(root, 'copied-report.txt'),
          })
        );
      }
    }
    const screenshot = await send('Page.captureScreenshot');
    await writeFile(path.join(root, `${mode}.png`), Buffer.from(screenshot.data, 'base64'));
  } finally {
    ws.close();
  }
} else
  throw new Error(
    'Usage: seed | start <sandbox> | inspect <sandbox> | verify <sandbox> | stop <sandbox>'
  );
