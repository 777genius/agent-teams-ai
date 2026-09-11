#!/usr/bin/env node
// Disposable Electron profile and CLI only. No agent/team launch commands.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  packagedArguments,
  packagedArtifact,
  preparePackagedProfile,
  packagedTarget,
  packagedStopOrder,
} from './opencode-diagnostics/packaged.mjs';
import { verifyPackaged } from './opencode-diagnostics/packaged-verify.mjs';
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

import {
  cleanupScenario,
  seedStartupCleanup,
  verifyStartupCleanup,
} from './opencode-diagnostics/startup-cleanup.mjs';

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
  if (data.packaged) {
    // Retain previously proven descendants if they are later reparented. A PID
    // with a different birth never inherits cleanup authority.
    const snapshot = processes();
    for (const prior of data.observedProcesses ?? []) {
      if (
        !owned.some((entry) => entry.pid === prior.pid) &&
        snapshot.some((entry) => entry.pid === prior.pid && entry.birth === prior.birth)
      )
        owned.push(prior);
    }
    data.observedProcesses = owned;
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(data, null, 2));
  }
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
      const currentSnapshot = processes();
      const missing = ids.filter((pid) => !owned.some((p) => p.pid === pid));
      if (
        ids.some((pid) => owned.some((p) => p.pid === pid)) &&
        missing.length &&
        missing.every((pid) => !currentSnapshot.some((p) => p.pid === pid)) &&
        attempt < 2
      ) {
        await delay(50);
        continue; // Restart all ownership reads; never authorize an unverified listener.
      }
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
    const data = await manifest();
    if (data.packaged) {
      const descendants = ownedTree(current, data.launcher);
      for (const entry of listenerProcesses) {
        assert(
          descendants.some((p) => p.pid === entry.pid && p.birth === entry.birth),
          'CDP owner is no longer an owned descendant'
        );
        assert.equal(
          entry.executable?.toLowerCase(),
          data.artifact.app.path.toLowerCase(),
          'CDP owner is not the selected packaged executable'
        );
      }
    }
    return;
  }
  throw new Error('CDP listener ownership did not stabilize; refusing access');
}

if (mode === 'seed-packaged') {
  const options = packagedArguments(process.argv.slice(3));
  const artifact = await packagedArtifact(options.executable);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-'));
  const data = {
    root: dir,
    home: path.join(dir, 'home'),
    userData: path.join(dir, 'user-data'),
    temp: path.join(dir, 'tmp'),
    platform: process.platform,
    packaged: true,
    artifact,
    runtimeSetup: options.runtimeSetup,
  };
  await preparePackagedProfile(data);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(data, null, 2));
  console.log(dir);
} else if (mode === 'seed') {
  const seededScenario = root || 'version-exit';
  assert(['version-exit', cleanupScenario].includes(seededScenario), 'Unsupported seed scenario');
  if (seededScenario === cleanupScenario) assert.equal(process.platform, 'win32');
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
  await writeFile(path.join(dir, 'scenario'), seededScenario);
  if (seededScenario === cleanupScenario) await seedStartupCleanup(dir);
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
  const data = await manifest();
  if (data.packaged)
    await writeFile(path.join(root, 'cleanup-identities.json'), JSON.stringify(owned, null, 2));
  // Capture identities before cleanup; never use taskkill /T or a process-group signal.
  const ordered = data.packaged
    ? packagedStopOrder(owned, data.artifact.app.path)
    : [...owned].reverse();
  const signals = [];
  try {
    for (const entry of ordered) {
      const record = { expected: entry, at: new Date().toISOString(), outcome: 'checking' };
      signals.push(record);
      const current = processes().find((p) => p.pid === entry.pid);
      record.current = current ?? null;
      if (!current) { record.outcome = 'missing-from-identity-snapshot'; continue; }
      sameIdentity(entry, current);
      try {
        process.kill(entry.pid, 'SIGTERM');
        record.outcome = 'signal-returned';
      } catch (error) {
        record.outcome = error.code ?? String(error);
        if (error.code !== 'ESRCH') throw error;
      }
    }
  } finally {
    if (data.packaged)
      await writeFile(path.join(root, 'cleanup-signals.json'), JSON.stringify(signals, null, 2));
  }
  console.log('Stopped owned test process tree');
} else if (mode === 'start') {
  const data = await manifest();
  assert(!data.launcher, 'Sandbox already started; seed a new sandbox');
  const env = data.packaged ? await preparePackagedProfile(data) : isolatedEnvironment(data);
  if (data.packaged) {
    assert.equal(process.platform, 'win32');
    assert.deepEqual(
      await packagedArtifact(data.artifact.app.path),
      data.artifact,
      'App artifact changed'
    );
  } else assertNoInstalledOpenCode(data);
  await assertPortAvailable();
  const launch = data.packaged
    ? {
        command: data.artifact.app.path,
        args: [
          '--remote-debugging-port=9222',
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${data.userData}`,
        ],
      }
    : launchCommand();
  if (data.packaged) {
    // The foreground harness is the ancestor; the Electron main process owns CDP.
    data.launcher = processes().find((p) => p.pid === process.pid);
    assert(data.launcher?.birth, 'Could not establish launcher birth identity');
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(data, null, 2));
  }
  if (data.packaged) setInterval(() => {}, 1000); // Keep ownership root live until explicit stop.
  if (!data.packaged && (await readFile(path.join(root, 'scenario'), 'utf8')).trim() === cleanupScenario) {
    assert.equal(process.platform, 'win32');
    data.cleanupLaunchStartedAt = Date.now();
  }
  const child = spawn(launch.command, launch.args, {
    cwd: data.packaged ? data.root : repo,
    stdio: 'inherit',
    shell: false,
    env,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  if (!data.packaged) data.launcher = processes().find((p) => p.pid === child.pid);
  assert(data.launcher?.birth, 'Could not establish launcher birth identity');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(data, null, 2));
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} else if (mode === 'inspect' || mode === 'verify') {
  const data = await manifest();
  await assertOwnedDebugEndpoint();
  const targets = await (
    await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(10000) })
  ).json();
  const target = data.packaged
    ? packagedTarget(targets, data.artifact.renderer, true, path.win32)
    : targets.find(
        (entry) => entry.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):/.test(entry.url)
      );
  assert(target, data.packaged ? 'No packaged renderer' : 'No dev renderer');
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
  const preloadScripts = [];
  const scriptMetadata = [];
  ws.on('message', (raw) => {
    const response = JSON.parse(String(raw));
    if (
      data.packaged &&
      response.method === 'Debugger.scriptParsed' &&
      (response.params.url === '' || /[\\/]preload[\\/]index\.js$/.test(response.params.url))
    )
      preloadScripts.push(response.params);
    if (
      data.packaged &&
      response.method === 'Debugger.scriptParsed' &&
      scriptMetadata.length < 200
    ) {
      const { scriptId, executionContextId, url } = response.params;
      // Local disposable test paths only; never retain source or opaque URL payloads.
      const label =
        typeof url === 'string' && !/^(data|https?):/i.test(url)
          ? url.split(/[?#]/, 1)[0].slice(0, 512)
          : '[opaque URL omitted]';
      scriptMetadata.push({ scriptId, executionContextId, url: label });
    }
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(await evaluate('window.innerWidth'), 1440, 'Unexpected test viewport width');
    if (data.packaged)
      assert.equal(await evaluate('window.innerHeight'), 1000, 'Unexpected test viewport height');
    if (mode === 'verify')
      await send('Browser.grantPermissions', {
        ...(data.packaged ? {} : { origin: new URL(target.url).origin }),
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
    if (mode === 'inspect') {
      console.log(await evaluate('document.body.innerText'));
      console.log(
        await evaluate(
          'JSON.stringify({ready:document.readyState,resources:performance.getEntriesByType("resource").slice(-6).map(r=>({name:r.name,duration:r.duration})),scripts:[...document.scripts].map(s=>s.src)})'
        )
      );
    } else if (data.packaged) {
      await verifyPackaged({ root, data, evaluate, send, preloadScripts, scriptMetadata });
    } else {
      const scenario = (await readFile(path.join(root, 'scenario'), 'utf8')).trim();
      if (scenario === cleanupScenario) {
        await verifyStartupCleanup({ root, evaluate, send });
      } else if (catalogScenarios.includes(scenario)) {
        await verifyCatalog({ root, scenario, evaluate, send });
      } else {
        let found;
        let refreshClicked = false;
        let recovered = false;
        const verifyStarted = Date.now();
        for (let attempt = 0; attempt < 90; attempt++) {
          if (attempt === 0) {
            const refresh = await evaluate(
              `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh status' && !b.disabled); if (!button) return null; button.scrollIntoView({block:'center'}); const r = button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
            );
            if (refresh) {
              refreshClicked = true;
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
          if (scenario === 'ready' && refreshClicked && !found) {
            const events = (await readFile(path.join(root, 'calls.ndjson'), 'utf8'))
              .trim()
              .split('\n')
              .map(JSON.parse);
            recovered =
              events.some(
                (e) =>
                  e.scenario === 'ready' && e.event === 'version-success' && e.at >= verifyStarted
              ) && /OpenCode: Connected/.test(await evaluate('document.body.innerText'));
          }
          if (
            scenario === 'ready'
              ? recovered
              : found && (scenario !== 'version-timeout' || found.includes('timed out'))
          )
            break;
          await delay(1000);
        }
        if (scenario === 'ready') {
          assert(
            refreshClicked && recovered && !found,
            'Retry did not complete a fresh successful version probe'
          );
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
        const previousClipboard = await evaluate('navigator.clipboard.readText()');
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
        assert(
          (
            await evaluate(
              `document.querySelector('[data-testid="opencode-version-diagnostics"] button').innerText`
            )
          ).includes('Copied'),
          'Copy did not complete'
        );
        const copied = await evaluate('navigator.clipboard.readText()');
        assert.notEqual(copied, previousClipboard, 'Clipboard retained a previous report');
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
  } catch (error) {
    if (data.packaged && ['cold', 'warm-1', 'warm-2'].includes(data.run)) {
      try {
        const screenshot = await send('Page.captureScreenshot');
        await writeFile(
          path.join(root, data.run, 'failure.png'),
          Buffer.from(screenshot.data, 'base64')
        );
      } catch {
        /* Preserve the failure; never connect to a different target for evidence. */
      }
    }
    throw error;
  } finally {
    ws.close();
  }
} else
  throw new Error(
    'Usage: seed [startup-cleanup] | seed-packaged --packaged-executable <exe> [--runtime-setup app-install] | start <sandbox> | inspect <sandbox> | verify <sandbox> | stop <sandbox>'
  );
