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
  if (!child?.pid || child.exitCode !== null) return;
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
      windowsHide: true,
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
      finish(null, { name, pid: child.pid, exitCode: code, durationMs: Date.now() - started });
    });
  });
}

async function runTeammateFixture() {
  // A parent must explicitly stop this disposable process. No real agent is launched.
  process.on('message', (msg) => {
    if (msg?.type === 'stop') process.exit(0);
  });
  const calls = [
    ['cmd', 'cmd.exe', ['/d', '/s', '/c', 'echo windows-native-fixture']],
    ['git', 'git.exe', ['--version']],
    ['powershell', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Write-Output 'windows-native-fixture'"]],
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
    const evidence = {
      schemaVersion: 1,
      platform: process.platform,
      architecture: process.arch,
      teammatePid: child.pid,
      teammateExitCode: child.exitCode,
      teammateDetached: options.detached,
      teammateWindowsHide: options.windowsHide,
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

if (process.argv.includes('--teammate-fixture')) {
  await runTeammateFixture();
} else {
  await runParent();
}
