#!/usr/bin/env node
// Disposable Electron profile and CLI only. No agent/team launch commands.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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

function processBirth(pid) {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  }).trim();
}

async function ownedProcessIds() {
  const launcher = Number(await readFile(path.join(root, 'launcher.pid'), 'utf8'));
  const expectedBirth = (await readFile(path.join(root, 'launcher.birth'), 'utf8')).trim();
  assert(
    expectedBirth && processBirth(launcher) === expectedBirth,
    'Launcher PID was reused; refusing access'
  );
  const lines = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
    .trim()
    .split('\n');
  const processes = lines
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), parent: Number(match[2]), command: match[3] } : null;
    })
    .filter(Boolean);
  assert(
    processes.find((entry) => entry.pid === launcher)?.command.includes('pnpm dev:mcp'),
    'Launcher identity changed; refusing cleanup'
  );
  const owned = [launcher];
  for (let index = 0; index < owned.length; index++)
    for (const entry of processes) if (entry.parent === owned[index]) owned.push(entry.pid);
  return owned;
}

async function assertOwnedDebugEndpoint() {
  const owned = await ownedProcessIds();
  const listeners = execFileSync('lsof', ['-nP', '-t', '-iTCP:9222', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map(Number);
  assert(
    listeners.length && listeners.every((pid) => owned.includes(pid)),
    'CDP listener is not owned by this sandbox; refusing access'
  );
}

if (mode === 'seed') {
  assert(
    process.platform !== 'win32',
    'This shell fixture runner supports Unix; Windows requires native shim fixtures'
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-'));
  const data = {
    root: dir,
    home: path.join(dir, 'home'),
    userData: path.join(dir, 'user-data'),
    bin: path.join(dir, 'bin'),
  };
  for (const value of [data.home, data.userData, data.bin]) await mkdir(value, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(data));
  await writeFile(path.join(dir, 'scenario'), 'version-exit');
  const fixture = `#!${process.execPath}
const fs = require('node:fs');
const root = ${JSON.stringify(dir)};
const scenario = fs.readFileSync(root + '/scenario', 'utf8').trim();
const args = process.argv.slice(2);
fs.appendFileSync(root + '/calls.ndjson', JSON.stringify({binary: process.argv[1], args})+'\\n');
if (process.argv[1].endsWith('/opencode')) {
  if (scenario === 'version-timeout') { process.stderr.write('waiting for fixture\\n'); setTimeout(()=>{}, 60000); }
  else if (scenario === 'version-exit') { process.stderr.write('fixture failed api_key=DO_NOT_COPY_THIS_SECRET\\n'); process.exitCode=9; }
  else console.log('1.14.24');
} else if (args.includes('--version')) console.log('2.1.114 (Claude Code)');
else if (args[0] === 'auth') console.log(JSON.stringify({loggedIn:true,authMethod:'oauth'}));
else if (args[0] === 'runtime' && args[1] === 'status') console.log(JSON.stringify({providers:Object.fromEntries(['anthropic','codex','gemini','opencode'].map(providerId=>[providerId,{providerId,supported:true,authenticated:true,verificationState:'verified',statusCheckOutcome:'authoritative',statusMessage:'Sandbox fixture',models:[],capabilities:{teamLaunch:false,oneShot:false}}]))}));
else if (args[0] === 'runtime' && args[1] === 'providers') console.log(JSON.stringify({runtimeId:'opencode',ok:false,error:{code:'runtime-unhealthy',message:'Sandbox provider settings unavailable',recoverable:true}}));
else console.log('{}');
`;
  for (const name of ['opencode', 'fixture-runtime'])
    await writeFile(path.join(data.bin, name), fixture, { mode: 0o755 });
  console.log(dir);
} else if (mode === 'stop') {
  await manifest();
  const owned = await ownedProcessIds();
  for (const pid of owned.reverse()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  console.log('Stopped owned test process tree');
} else if (mode === 'start') {
  const data = await manifest();
  // Refuse to attach to a pre-existing app or replace its CDP endpoint.
  let occupied = false;
  try {
    occupied = (await fetch('http://127.0.0.1:9222/json/version')).ok;
  } catch {
    /* vacant */
  }
  assert(!occupied, 'Port 9222 belongs to another process');
  const child = spawn('pnpm', ['dev:mcp', '--noSandbox'], {
    cwd: repo,
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: data.home,
      USERPROFILE: data.home,
      PATH: `${data.bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/sh',
      AGENT_TEAMS_ELECTRON_USER_DATA_DIR: data.userData,
      AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: path.join(data.home, '.claude'),
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: path.join(data.bin, 'fixture-runtime'),
      CLAUDE_CLI_PATH: path.join(data.bin, 'fixture-runtime'),
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
      NODE_BINARY: process.execPath,
      XDG_CONFIG_HOME: path.join(data.home, '.config'),
      XDG_DATA_HOME: path.join(data.home, '.local/share'),
    },
  });
  await writeFile(path.join(root, 'launcher.pid'), String(child.pid));
  await writeFile(path.join(root, 'launcher.birth'), processBirth(child.pid));
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
} else if (mode === 'inspect' || mode === 'verify') {
  await manifest();
  await assertOwnedDebugEndpoint();
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const target = targets.find(
    (entry) => entry.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):/.test(entry.url)
  );
  assert(target, 'No dev renderer');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
    const screenshot = await send('Page.captureScreenshot');
    await writeFile(path.join(root, `${mode}.png`), Buffer.from(screenshot.data, 'base64'));
  } finally {
    ws.close();
  }
} else throw new Error('Usage: seed | start <sandbox> | inspect <sandbox> | verify <sandbox>');
