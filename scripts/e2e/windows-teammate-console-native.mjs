#!/usr/bin/env node
// Real Windows process smoke, intentionally NOT a substitute for interactive Electron GUI proof.
// It executes no agent binaries, models, SDKs or user projects.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withCliProcessDefaults } from '../../src/main/utils/cliProcessDefaults.ts';

const file = fileURLToPath(import.meta.url);
const CALL_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 90_000;
const expected = ['cmd', 'git', 'powershell'];

function terminateOwnedTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  // Only the still-live child created by this fixture. Never scan for or kill unrelated PIDs.
  const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 8_000,
    stdio: 'ignore',
  });
  if (result.error) child.kill();
}

async function invokeTool(name, command, args) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let output = '';
    let settled = false;
    const child = spawn(command, args, {
      detached: false,
      // Intentionally omit windowsHide: reproduce default tool-child behavior.
      // Forcing it true would hide the very Windows popup regression under test.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (error, receipt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(receipt);
    };
    const timer = setTimeout(() => {
      terminateOwnedTree(child);
      finish(new Error(name + ' exceeded native timeout'));
    }, CALL_TIMEOUT_MS);
    child.stdout?.on('data', (b) => { output = (output + b.toString()).slice(-4000); });
    child.stderr?.on('data', (b) => { output = (output + b.toString()).slice(-4000); });
    child.once('error', (err) => finish(err));
    child.once('close', (code, signal) => {
      if (code !== 0) return finish(new Error(name + ' failed: ' + (signal || code) + ' ' + output));
      let consoleState;
      if (name === 'powershell') {
        const noConsole = output.includes('NO-CONSOLE-ATTACHED');
        const hiddenConsole = output.includes('HIDDEN-CONSOLE-VERIFIED');
        if (noConsole === hiddenConsole) {
          return finish(new Error('Native PowerShell console visibility was not proved: ' + output));
        }
        consoleState = noConsole ? 'none' : 'hidden';
      }
      finish(null, {
        name, pid: child.pid, exitCode: code, durationMs: Date.now() - started,
        ...(name === 'powershell' ? { consoleState, consoleWindowVisible: false } : {}),
      });
    });
  });
}

async function runTeammateFixture() {
  // A parent must explicitly stop this disposable process. No real agent is launched.
  process.on('message', (msg) => {
    if (msg?.type === 'stop') process.exit(0);
  });
  const consoleVisibilityProbe = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; ' +
      'public static class NativeConsole { ' +
      '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); ' +
      '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }\'',
    '$hwnd = [NativeConsole]::GetConsoleWindow()',
    // GetConsoleWindow returns NULL when no console is attached (also safe).
    // A non-NULL handle must be hidden. A visible window still fails closed.
    "if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NO-CONSOLE-ATTACHED' } " +
      "elseif ([NativeConsole]::IsWindowVisible($hwnd)) { throw 'Unexpected visible console window' } " +
      "else { Write-Output 'HIDDEN-CONSOLE-VERIFIED' }",
  ].join('; ');
  const calls = [
    ['cmd', 'cmd.exe', ['/d', '/s', '/c', 'echo windows-native-fixture']],
    ['git', 'git.exe', ['--version']],
    ['powershell', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      consoleVisibilityProbe]],
  ];
  for (const [name, command, args] of calls) {
    const receipt = await invokeTool(name, command, args);
    process.send?.({ type: 'tool', ...receipt });
  }
  process.send?.({ type: 'ready', pid: process.pid });
  // Fail closed if the parent fails to send Stop; no independent background process.
  setTimeout(() => process.exit(2), 10_000).unref();
}

async function runParent() {
  assert.equal(process.platform, 'win32', 'Windows real-process proof requires win32');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-console-native-'));
  let child;
  try {
    const options = withCliProcessDefaults({
      cwd: scratch,
      env: { ...process.env },
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    assert.equal(options.detached, false);
    assert.equal(options.windowsHide, true);
    const started = Date.now();
    const tools = [];
    let ready = false;
    let stderr = '';
    child = spawn(process.execPath, [file, '--teammate-fixture'], options);
    child.stderr?.on('data', (b) => { stderr = (stderr + b.toString()).slice(-4000); });
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        terminateOwnedTree(child);
        finish(new Error('teammate fixture timed out: ' + stderr));
      }, RUN_TIMEOUT_MS);
      child.on('message', (msg) => {
        if (msg?.type === 'tool') tools.push(msg);
        if (msg?.type === 'ready') {
          if (msg.pid !== child.pid) {
            terminateOwnedTree(child);
            finish(new Error('teammate fixture identity mismatch'));
            return;
          }
          ready = true;
          child.send({ type: 'stop' });
        }
      });
      child.once('error', (err) => finish(err));
      child.once('close', (code, signal) => {
        if (!ready || code !== 0) return finish(new Error(
          'teammate failed: ' + (signal || code) + ' ' + stderr));
        finish(null);
      });
    });
    assert.deepEqual(tools.map((x) => x.name), expected);
    assert.ok(tools.every((x) => Number.isSafeInteger(x.pid) && x.pid > 0 && x.exitCode === 0));
    const powershell = tools.find((x) => x.name === 'powershell');
    assert.ok(powershell?.consoleWindowVisible === false &&
      (powershell.consoleState === 'none' || powershell.consoleState === 'hidden'),
    'Native child PowerShell console must not be visible');
    const evidence = {
      schemaVersion: 1,
      platform: process.platform,
      architecture: process.arch,
      teammatePid: child.pid,
      teammateExitCode: child.exitCode,
      teammateDetached: options.detached,
      teammateWindowsHide: options.windowsHide,
      toolSpawnWindowsHideForced: false,
      powershellConsoleNotVisibleVerified: true,
      powershellConsoleState: powershell.consoleState,
      calls: tools,
      durationMs: Date.now() - started,
      originalCliInvocations: 0,
      guiWindowAndFocusObserved: false,
      descendantForceKillVerified: false,
      scope: 'native fixture process mechanics; NOT interactive Electron GUI or provider proof',
      success: true,
    };
    const report = path.join(process.env.RUNNER_TEMP || os.tmpdir(),
      'windows-console-native-' + randomUUID() + '.json');
    await fs.writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ report, ...evidence }) + '\n');
  } finally {
    terminateOwnedTree(child);
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

// A separate fixture mimics forced termination of the owning app process.
// The test is never described as an Electron GUI / real provider proof.
function originalProcessAlive(pid, marker) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.match(marker, /^native-custody-[0-9a-f-]{36}$/);
  // CIM errors must fail closed, never be mistaken for confirmed process absence.
  const script = "$ErrorActionPreference = 'Stop'; try { " +
    "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid +
    "' -ErrorAction Stop; if ($p -and $p.CommandLine -like '*" + marker +
    "*') { 'alive' } else { 'gone' } " +
    "} catch { [Console]::Error.WriteLine('CIM lookup failed'); exit 1 }";
  const found = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16_384,
  });
  if (found.error || found.status !== 0) {
    throw new Error('Native Windows process identity lookup failed: ' +
      String(found.error || found.stderr).slice(0,500));
  }
  const result = found.stdout.trim();
  assert.ok(result === 'alive' || result === 'gone', 'Unexpected native process lookup output');
  return result === 'alive';
}

function killVerifiedOriginal(pid, marker) {
  if (!Number.isSafeInteger(pid) || !marker) return;
  if (!originalProcessAlive(pid, marker)) return;
  const killed = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true, encoding: 'utf8', timeout: 10_000,
  });
  if (killed.error || killed.status !== 0) {
    throw new Error('Could not clean up original fixture PID ' + pid);
  }
}

async function runCustodyTeammate() {
  const marker = process.argv.at(-1);
  const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], {
    windowsHide: true, detached: false, stdio: 'ignore',
  });
  assert.ok(tool.pid);
  process.send?.({ type: 'custody-ready', teammatePid: process.pid, toolPid: tool.pid, marker });
  setInterval(() => {}, 1000);
}

async function runCustodyApp() {
  const marker = process.argv.at(-1);
  const child = spawn(process.execPath, [file, '--custody-teammate', marker],
    withCliProcessDefaults({ detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  assert.ok(child.pid);
  child.on('message', (msg) => {
    if (msg?.type === 'custody-ready') {
      process.send?.({ ...msg, appPid: process.pid });
    }
  });
  setInterval(() => {}, 1000);
}

async function runCustodyProbe() {
  assert.equal(process.platform, 'win32');
  const marker = 'native-custody-' + randomUUID();
  const app = spawn(process.execPath, [file, '--custody-app', marker],
    withCliProcessDefaults({ detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  let matePid;
  let toolPid;
  try {
    const ready = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(() => finish(new Error('Custody fixture startup timeout')), 30_000);
      app.once('error', (err) => finish(err));
      app.once('close', (code) => finish(new Error('App fixture exited before custody readiness: ' + code)));
      app.on('message', (msg) => {
        if (msg?.type !== 'custody-ready') return;
        if (msg.appPid !== app.pid || msg.marker !== marker ||
            !Number.isSafeInteger(msg.teammatePid) || !Number.isSafeInteger(msg.toolPid)) {
          finish(new Error('Custody fixture returned an unbound identity'));
          return;
        }
        finish(null, msg);
      });
    });
    matePid = ready.teammatePid;
    toolPid = ready.toolPid;
    assert.equal(originalProcessAlive(matePid, marker), true, 'teammate must be live before kill');
    assert.equal(originalProcessAlive(toolPid, marker), true, 'tool must be live before kill');

    // Terminate the original *app-like* owner, not the teammate or tool.
    app.kill('SIGKILL');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('App force-kill did not settle')), 10_000);
      app.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const teammateStillAlive = originalProcessAlive(matePid, marker);
    const toolStillAlive = originalProcessAlive(toolPid, marker);
    const report = {
      schemaVersion: 1, platform: process.platform, kind: 'simulated-app-crash',
      marker, appPid: app.pid, teammatePid: matePid, toolPid,
      teammateStillAliveAfterAppForceKill: teammateStillAlive,
      toolStillAliveAfterAppForceKill: toolStillAlive,
      realElectronGuiObserved: false, realProviderExecuted: false,
      status: 'observed',
    };
    const reportPath = path.join(process.env.RUNNER_TEMP || os.tmpdir(),
      'windows-console-native-custody-' + randomUUID() + '.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ reportPath, ...report }) + '\n');
    assert.equal(teammateStillAlive, false,
      'Non-detached direct teammate survived app force-kill in native Windows process fixture');
    assert.equal(toolStillAlive, false,
      'Original tool descendant survived app force-kill in native Windows process fixture');
  } finally {
    terminateOwnedTree(app);
    // Cleanup must attempt *both* original PIDs even if the first lookup/kill fails.
    const cleanupErrors = [];
    for (const pid of [matePid, toolPid]) {
      if (!pid) continue;
      try {
        killVerifiedOriginal(pid, marker);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, 'Original Windows fixture process cleanup failed');
    }
  }
}

if (process.argv.includes('--custody-teammate')) {
  await runCustodyTeammate();
} else if (process.argv.includes('--custody-app')) {
  await runCustodyApp();
} else if (process.argv.includes('--custody-probe')) {
  await runCustodyProbe();
} else if (process.argv.includes('--teammate-fixture')) {
  await runTeammateFixture();
} else {
  await runParent();
}
