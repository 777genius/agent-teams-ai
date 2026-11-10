// Real Linux process/environment boundary regression; no production census in its oracle.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Identity {
  pid: number;
  birth: string;
  environmentBytes: number;
}

interface Ownership {
  environment: Record<string, string>;
  begin(pid?: number): unknown;
  sample(): { pid: number }[];
  signal(signal: 'SIGTERM' | 'SIGKILL'): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
  finish(): { remaining: unknown[]; signals: { pid: number }[] };
}

const fixture = fileURLToPath(import.meta.url);
const sandbox = process.env.PACKAGED_SMOKE_FIXTURE_ROOT!;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nativeBirth(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw
      .slice(raw.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return /^[ZX]/.test(fields[0]) ? null : fields[19];
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

const same = (identity: Identity) => nativeBirth(identity.pid) === identity.birth;

async function cleanup(identity: Identity): Promise<void> {
  if (!same(identity)) return;
  process.kill(identity.pid, 'SIGKILL');
  for (let i = 0; i < 100 && same(identity); i++) await pause(20);
  assert.equal(same(identity), false, 'Exact fixture process must retire');
}

function startChild(large: boolean, environment: NodeJS.ProcessEnv = {}): Promise<Identity> {
  const env = { ...process.env, ...environment };
  if (large) {
    for (let i = 0; i < 20; i++) env[`BASELINE_TEST_PADDING_${i}`] = 'x'.repeat(60_000);
  }
  const child = spawn(process.execPath, [fixture, '--child'], {
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Fixture exited before native ready receipt')));
    child.once('message', (value) => {
      child.unref();
      resolve(value as Identity);
    });
  });
}

async function worker(mode: string, predecessor?: Identity): Promise<void> {
  const require = createRequire(import.meta.url);
  const scriptDir =
    process.env.PACKAGED_SMOKE_SCRIPT_DIR ??
    path.resolve(import.meta.dirname, '../../../../scripts/electron-builder');
  const { createPackagedSmokeOwnership } = require(
    path.join(scriptDir, 'packagedSmokeOwnedProcesses.ts')
  ) as {
    createPackagedSmokeOwnership(): Ownership;
  };
  const children: Identity[] = [];
  const receipts: string[] = [];
  const signaled: number[] = [];
  const originalLog = console.log;
  const originalKill = process.kill;
  console.log = (line: string) => {
    receipts.push(line);
  };
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal !== 0) signaled.push(pid);
    return originalKill(pid, signal);
  }) as typeof process.kill;
  let result: Record<string, unknown> | undefined;
  try {
    if (mode === 'young') {
      predecessor = await startChild(true);
      children.push(predecessor);
      assert.ok(BigInt(predecessor.birth) >= BigInt(nativeBirth(process.pid)!));
    }
    if (mode === 'preexisting' || mode === 'leader') {
      assert.ok(predecessor && same(predecessor));
      assert.ok(
        BigInt(predecessor.birth) < BigInt(nativeBirth(process.pid)!),
        'Predecessor must be strictly older than the fresh scope worker'
      );
    }
    const ownership = createPackagedSmokeOwnership();
    if (mode === 'late') {
      predecessor = await startChild(true, ownership.environment);
      children.push(predecessor);
    }
    assert.ok(predecessor && predecessor.environmentBytes > 1024 * 1024);
    if (mode === 'preexisting') {
      const owned = await startChild(false, ownership.environment);
      children.push(owned);
      ownership.begin(owned.pid);
      assert.deepEqual(
        ownership.sample().map((value) => value.pid),
        [owned.pid]
      );
      ownership.signal('SIGKILL');
      assert.equal(await ownership.waitForExit(1_000), true);
      const final = ownership.finish();
      assert.deepEqual(final.remaining, []);
      assert.deepEqual(
        final.signals.map((signal) => signal.pid),
        [owned.pid]
      );
      assert.equal(same(owned), false);
      assert.deepEqual(signaled, [owned.pid]);
    } else {
      const inspect = () =>
        mode === 'leader' ? ownership.begin(predecessor!.pid) : ownership.sample();
      assert.throws(inspect, /Unable to inspect packaged smoke ownership/);
      assert.throws(
        () => ownership.signal('SIGKILL'),
        /Unable to inspect packaged smoke ownership/
      );
      assert.throws(() => ownership.finish(), /Unable to inspect packaged smoke ownership/);
      assert.equal(
        receipts.some((line) => line.includes('"phase":"final"')),
        false
      );
      assert.deepEqual(signaled, [], 'Unverifiable ownership must never authorize a signal');
    }
    assert.equal(same(predecessor), true, 'The unrelated or unverifiable process must survive');
    assert.equal(fs.existsSync(path.join(sandbox, `signal-${predecessor.pid}`)), false);
    const logged = receipts.join('\n');
    assert.equal(logged.includes(ownership.environment.AGENT_TEAMS_PACKAGED_SMOKE_RUN_ID), false);
    assert.equal(logged.includes('x'.repeat(128)), false);
    result = {
      mode,
      nativeBirthBoundary: true,
      predecessorUntouched: true,
      lateOrYoungRejected: mode !== 'preexisting',
      ownedDrained: mode === 'preexisting',
    };
  } finally {
    process.kill = originalKill;
    console.log = originalLog;
    for (const child of children) await cleanup(child);
  }
  console.log(JSON.stringify(result));
}

async function driver(mode: string): Promise<void> {
  let predecessor: Identity | undefined;
  try {
    if (mode === 'preexisting' || mode === 'leader') {
      predecessor = await startChild(true);
      // Advance beyond a starttime tick, then assert the actual native ordering in the worker.
      await pause(50);
    }
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [fixture, '--worker', mode, JSON.stringify(predecessor ?? null)],
        { env: process.env, encoding: 'utf8', timeout: 8_000 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          else resolve(stdout);
        }
      );
    });
    if (predecessor) assert.equal(same(predecessor), true);
    process.stdout.write(output);
  } finally {
    if (predecessor) await cleanup(predecessor);
    fs.writeFileSync(
      path.join(sandbox, 'baseline-cleanup.json'),
      JSON.stringify({
        remaining: predecessor && same(predecessor) ? [predecessor.pid] : [],
      })
    );
  }
}

assert.equal(process.platform, 'linux');
if (process.argv[2] === '--child') {
  setTimeout(() => process.exit(90), 15_000);
  process.on('SIGTERM', () => {
    fs.writeFileSync(path.join(sandbox, `signal-${process.pid}`), 'SIGTERM');
  });
  const receipt: Identity = {
    pid: process.pid,
    birth: nativeBirth(process.pid)!,
    environmentBytes: fs.readFileSync(`/proc/${process.pid}/environ`).length,
  };
  process.send?.(receipt);
  process.disconnect?.();
} else if (process.argv[2] === '--worker') {
  await worker(process.argv[3], JSON.parse(process.argv[4]));
} else {
  await driver(process.argv[2]);
}
