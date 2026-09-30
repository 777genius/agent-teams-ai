import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

const [mode, markerPath, sandboxPath] = process.argv.slice(2);
const ownerMarker = sandboxPath && path.join(sandboxPath, '.process-anchor-test-owner');

if (
  !mode ||
  !markerPath ||
  !sandboxPath ||
  !path.isAbsolute(markerPath) ||
  !path.isAbsolute(sandboxPath) ||
  path.dirname(markerPath) !== sandboxPath ||
  !ownerMarker ||
  !existsSync(ownerMarker)
) {
  process.exit(64);
}

const fixturePath = new URL(import.meta.url).pathname;

function descriptorSnapshot() {
  const descriptors = [];
  for (let descriptor = 0; descriptor < 3; descriptor += 1) {
    try {
      descriptors.push({ descriptor, target: readlinkSync(`/proc/self/fd/${descriptor}`) });
    } catch {
      descriptors.push({ descriptor, target: 'unavailable' });
    }
  }
  return descriptors;
}

function record(event, detail = {}) {
  appendFileSync(
    markerPath,
    `${JSON.stringify({
      event,
      role: mode,
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      environmentNames: Object.keys(process.env).sort(),
      descriptors: descriptorSnapshot(),
      ...detail,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}

function spawnFixture(childMode, detached = false) {
  const child = spawn(process.execPath, [fixturePath, childMode, markerPath, sandboxPath], {
    cwd: process.cwd(),
    env: { ...process.env },
    detached,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

function stayAlive({ ignoreTerm = false, lifetimeMs } = {}) {
  record('started');
  process.on('SIGTERM', () => {
    record('term');
    if (!ignoreTerm) process.exit(0);
  });
  process.on('SIGINT', () => {
    record('interrupt');
    if (!ignoreTerm) process.exit(0);
  });
  if (lifetimeMs !== undefined) {
    setTimeout(() => {
      record('bounded-exit');
      process.exit(0);
    }, lifetimeMs);
  }
  setTimeout(() => {
    record('safety-timeout');
    process.exit(70);
  }, 15_000);
}

switch (mode) {
  case 'normal':
  case 'unrelated':
  case 'double-grandchild':
  case 'crash-survivor':
    stayAlive();
    break;
  case 'ignore-term':
    stayAlive({ ignoreTerm: true });
    break;
  case 'double-fork':
    record('started');
    spawnFixture('double-middle');
    stayAlive();
    break;
  case 'double-middle':
    record('started');
    spawnFixture('double-grandchild');
    setTimeout(() => process.exit(0), 25);
    break;
  case 'escape':
    record('started');
    spawnFixture('escape-middle');
    stayAlive();
    break;
  case 'escape-middle':
    record('started');
    spawnFixture('escape-grandchild', true);
    setTimeout(() => process.exit(0), 25);
    break;
  case 'escape-grandchild':
    stayAlive({ ignoreTerm: true, lifetimeMs: 600 });
    break;
  case 'main-crash':
    record('started');
    spawnFixture('crash-survivor');
    setTimeout(() => {
      record('main-crash');
      process.exit(42);
    }, 75);
    break;
  default:
    process.exit(64);
}
