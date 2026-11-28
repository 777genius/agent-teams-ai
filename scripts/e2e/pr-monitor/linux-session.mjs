#!/usr/bin/env node
/** Run under dbus-run-session; every display, keyring and process is disposable. */
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const deviceFlow = process.argv.includes('--device-flow');
if (process.platform !== 'linux') throw new Error('This harness requires Linux.');
if (deviceFlow && !process.env.DBUS_SESSION_BUS_ADDRESS)
  throw new Error('Start this harness with dbus-run-session.');
const root = await mkdtemp(path.join(os.tmpdir(), 'pr-monitor-native-TEST-'));
const env = {
  ...process.env,
  XDG_RUNTIME_DIR: path.join(root, 'runtime'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_CURRENT_DESKTOP: 'GNOME',
};
await Promise.all(
  [env.XDG_RUNTIME_DIR, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME].map(async (directory) => {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  })
);
const children = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function start(command, args, extra = {}) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  children.push(child);
  child.on('error', (error) => process.stderr.write(`${command}: ${error.message}\n`));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}
function stop() {
  for (const child of children.toReversed()) if (child.exitCode === null) child.kill('SIGTERM');
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

try {
  const xvfb = start(
    process.env.PR_MONITOR_E2E_XVFB ?? 'Xvfb',
    ['-displayfd', '3', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }
  );
  let display = '';
  xvfb.stdio[3].on('data', (data) => {
    display += data.toString();
  });
  for (let attempt = 0; attempt < 100 && !display.includes('\n'); attempt++) {
    if (xvfb.exitCode !== null) throw new Error('Private Xvfb exited before readiness.');
    await pause(100);
  }
  if (!/^\d+\s*$/.test(display)) throw new Error('Private Xvfb did not expose a display.');
  env.DISPLAY = `:${display.trim()}`;
  if (deviceFlow) {
    const keyring = start(
      process.env.PR_MONITOR_E2E_KEYRING ?? 'gnome-keyring-daemon',
      [
        '--foreground',
        '--unlock',
        '--components=secrets',
        '--control-directory',
        env.XDG_RUNTIME_DIR,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    keyring.stdin.end(randomBytes(32).toString('hex'));
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (keyring.exitCode !== null) throw new Error('Private system keyring exited.');
      ready = await exec(
        'gdbus',
        [
          'call',
          '--session',
          '--dest',
          'org.freedesktop.secrets',
          '--object-path',
          '/org/freedesktop/secrets',
          '--method',
          'org.freedesktop.DBus.Peer.Ping',
        ],
        { env, timeout: 1000 }
      ).then(
        () => true,
        () => false
      );
      if (!ready) await pause(100);
    }
    if (!ready) throw new Error('Private system keyring was not ready.');
  }
  const harness = start(process.execPath, [
    fileURLToPath(new URL('../pr-monitor-desktop.mjs', import.meta.url)),
    ...(deviceFlow ? ['--device-flow'] : []),
  ]);
  harness.stdout.pipe(process.stdout);
  const exitCode = await new Promise((resolve) => {
    harness.once('error', () => resolve(1));
    harness.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  stop();
  await rm(root, { recursive: true, force: true });
}
