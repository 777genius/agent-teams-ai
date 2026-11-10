// A separate real-process driver keeps fixture cleanup independent of the smoke implementation.
import assert from 'node:assert/strict';
import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

interface Identity {
  pid: number;
  birth: string;
  parent: number;
  group: number;
  state: string;
}

interface Ownership {
  environment: Record<string, string>;
  sample(): Identity[];
  signal(signal: 'SIGTERM' | 'SIGKILL'): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
  finish(): Receipt;
}

interface Receipt {
  phase: string;
  owned?: Identity[];
  remaining?: Identity[];
  signals?: { pid: number; birth: string; signal: string; outcome: string }[];
}

const fixturePath = fileURLToPath(import.meta.url);
const root = process.env.PACKAGED_SMOKE_FIXTURE_ROOT!;
const mode = process.env.PACKAGED_SMOKE_FIXTURE_MODE!;
const markerKey = 'AGENT_TEAMS_PACKAGED_SMOKE_RUN_ID';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// This oracle does not import the production census or its liveness predicate.
function identity(pid: number): Identity | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      if (['Z', 'X'].includes(fields[0]!)) return null;
      return {
        pid,
        birth: fields[19]!,
        state: fields[0]!,
        parent: Number(fields[1]),
        group: Number(fields[2]),
      };
    }
    const fields = execFileSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'ppid=', '-o', 'pgid='],
      { encoding: 'utf8', timeout: 1_000 }
    )
      .trim()
      .split(/\s+/);
    const group = Number(fields.pop());
    const parent = Number(fields.pop());
    const state = fields.pop()!;
    if (!state || /^[ZX]/.test(state)) return null;
    return { pid, birth: fields.join(' '), state, parent, group };
  } catch {
    return null;
  }
}

function stillSame(expected: Identity): boolean {
  return identity(expected.pid)?.birth === expected.birth;
}

async function cleanupExact(expected: Identity | null): Promise<void> {
  if (!expected || !stillSame(expected)) return;
  try {
    process.kill(expected.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  for (let tries = 0; tries < 100 && stillSame(expected); tries++) await pause(20);
  assert.equal(stillSame(expected), false, `Fixture cleanup failed for exact PID ${expected.pid}`);
}

function childReady(child: ChildProcess): Promise<Identity> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Fixture child exited before ready')));
    child.once('message', (value) => resolve(value as Identity));
  });
}

function startRole(role: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [fixturePath, role], {
    detached: true,
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

async function removeMarkerWithExecve(directory: string, expected: Identity): Promise<void> {
  fs.writeFileSync(path.join(directory, 'exec-unmarked'), 'exec');
  for (
    let tries = 0;
    tries < 100 && !fs.existsSync(path.join(directory, 'unmarked-ready.json'));
    tries++
  ) {
    await pause(5);
  }
  const unmarked = JSON.parse(
    fs.readFileSync(path.join(directory, 'unmarked-ready.json'), 'utf8')
  ) as Identity;
  assert.equal(unmarked.pid, expected.pid);
  assert.equal(
    unmarked.birth,
    expected.birth,
    'execve must preserve the same native process birth'
  );
  assert.equal(stillSame(expected), true, 'The unmarked process must still be live before waiting');
}

async function roleMain(role: string): Promise<void> {
  // Every fixture process has its own deadline even if the test driver is interrupted.
  setTimeout(() => process.exit(90), 20_000);
  if (role === '--unmarked-retiring' || role === '--unmarked-persistent') {
    process.on('SIGTERM', () => {});
    const ready = path.join(root, 'unmarked-ready.json');
    fs.writeFileSync(`${ready}.tmp`, JSON.stringify(identity(process.pid)));
    fs.renameSync(`${ready}.tmp`, ready);
    if (role === '--unmarked-retiring') {
      const poll = setInterval(() => {
        if (!fs.existsSync(path.join(root, 'retire-unmarked'))) return;
        clearInterval(poll);
        setTimeout(() => process.exit(0), 75);
      }, 5);
    }
    return;
  }
  if (role === '--escaped' || role === '--sentinel') {
    process.on('SIGTERM', () => {
      fs.appendFileSync(path.join(root, `${role.slice(2)}-signals`), 'SIGTERM\n');
    });
    const own = identity(process.pid);
    assert.ok(own, 'The fixture requires native PID and process-birth visibility');
    fs.writeFileSync(path.join(root, `${role.slice(2)}.json`), JSON.stringify(own));
    if (role === '--escaped') {
      fs.writeFileSync(path.join(root, 'private-marker'), process.env[markerKey] ?? '');
    }
    process.send?.(own);
    process.disconnect?.();
    if (role === '--escaped' && mode.startsWith('ownership-')) {
      const command = path.join(root, 'exec-unmarked');
      const poll = setInterval(() => {
        if (!fs.existsSync(command)) return;
        clearInterval(poll);
        const cleanEnv = { ...process.env };
        delete cleanEnv[markerKey];
        // The pinned Node 26 runtime exposes execve; the repo's Node 24 types
        // omit it. Keep this capability check local to the native fixture.
        const execve = Reflect.get(process, 'execve') as
          | ((file: string, args: string[], environment: NodeJS.ProcessEnv) => never)
          | undefined;
        assert.ok(
          typeof execve === 'function',
          'Native Linux ownership regression requires process.execve'
        );
        execve(
          process.execPath,
          [
            process.execPath,
            fixturePath,
            mode === 'ownership-retiring' ? '--unmarked-retiring' : '--unmarked-persistent',
          ],
          cleanEnv
        );
      }, 5);
    }
    return;
  }

  const escaped = startRole('--escaped', process.env);
  await childReady(escaped);
  escaped.unref();
  const leaderIdentity = identity(process.pid);
  assert.ok(leaderIdentity, 'The fixture requires a verifiable leader identity');
  fs.writeFileSync(path.join(root, 'leader.json'), JSON.stringify(leaderIdentity));
  if (role === '--exiting-owner') {
    process.exit(0);
  }
  if (mode.startsWith('app-')) {
    const userDataDir = process.env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR!;
    fs.mkdirSync(path.join(userDataDir, 'storage'));
    fs.writeFileSync(path.join(userDataDir, 'storage/app.db'), Buffer.from('SQLite format 3\0'));
    console.log(
      mode.endsWith('failure') ? 'Error: Cannot find module fixture' : 'renderer did-finish-load'
    );
  } else {
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line) as { id?: number; method: string };
      if (message.id === undefined) return;
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2024-11-05' }
          : { tools: mode.endsWith('failure') ? [] : [{ name: 'fixture-tool' }] };
      console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  }
}

function runHarness(
  script: string,
  bundle: string
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, bundle, process.platform],
      {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: root,
          PACKAGED_SMOKE_TIMEOUT_MS: '2000',
          PACKAGED_SMOKE_STABLE_MS: '0',
          PACKAGED_SMOKE_SHUTDOWN_TIMEOUT_MS: '250',
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: string | number } | null)?.code;
        resolve({ status: error ? (typeof code === 'number' ? code : -1) : 0, stdout, stderr });
      }
    );
  });
}

async function driver(): Promise<void> {
  const repository = path.resolve(path.dirname(fixturePath), '../../../..');
  const bundle = path.join(root, process.platform === 'darwin' ? 'fixture.app' : 'bundle');
  const executableDir =
    process.platform === 'darwin' ? path.join(bundle, 'Contents/MacOS') : bundle;
  const resources =
    process.platform === 'darwin'
      ? path.join(bundle, 'Contents/Resources')
      : path.join(bundle, 'resources');
  fs.mkdirSync(executableDir, { recursive: true });
  fs.mkdirSync(path.join(resources, 'mcp-server'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'mcp-server/index.js'), '// fixture entrypoint');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(
    path.join(executableDir, 'agent-teams-ai'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixturePath)} --package "$@"\n`,
    { mode: 0o755 }
  );

  let sentinel: Identity | null = null;
  let escaped: Identity | null = null;
  let owner: Identity | null = null;
  const additionalTargets: Identity[] = [];
  try {
    const sentinelEnv = { ...process.env, [markerKey]: 'unrelated-sentinel-marker' };
    const sentinelChild = startRole('--sentinel', sentinelEnv);
    sentinel = await childReady(sentinelChild);
    sentinelChild.unref();
    const scriptDir =
      process.env.PACKAGED_SMOKE_FIXTURE_SCRIPT_DIR ??
      path.join(repository, 'scripts/electron-builder');
    if (mode.startsWith('ownership-')) {
      const require = createRequire(import.meta.url);
      const { createPackagedSmokeOwnership } = require(
        path.join(scriptDir, 'packagedSmokeOwnedProcesses.ts')
      ) as {
        createPackagedSmokeOwnership(): Ownership;
      };
      const ownership = createPackagedSmokeOwnership();
      const leader = spawn(process.execPath, [fixturePath, '--exiting-owner'], {
        env: { ...process.env, ...ownership.environment },
        detached: true,
        stdio: 'ignore',
      });
      await new Promise<void>((resolve, reject) => {
        leader.once('error', reject);
        leader.once('close', () => resolve());
      });
      escaped = JSON.parse(fs.readFileSync(path.join(root, 'escaped.json'), 'utf8')) as Identity;
      owner = JSON.parse(fs.readFileSync(path.join(root, 'leader.json'), 'utf8')) as Identity;
      assert.ok(ownership.sample().some((entry) => entry.pid === escaped!.pid));
      await removeMarkerWithExecve(root, escaped);
      let debtTarget = escaped;
      if (mode === 'ownership-newly-observed') {
        const secondRoot = path.join(root, 'second-process-TEST');
        fs.mkdirSync(secondRoot);
        const secondChild = startRole('--escaped', {
          ...process.env,
          ...ownership.environment,
          PACKAGED_SMOKE_FIXTURE_ROOT: secondRoot,
          PACKAGED_SMOKE_FIXTURE_MODE: 'ownership-persistent',
        });
        const second = await childReady(secondChild);
        secondChild.unref();
        additionalTargets.push(second);
        // A strict census must reject A's existing debt, while retaining the
        // freshly proved ownership of B for all future cleanup observations.
        assert.throws(() => ownership.sample(), /ownership/i);
        await removeMarkerWithExecve(secondRoot, second);
        await cleanupExact(escaped);
        debtTarget = second;
      }
      const originalKill = process.kill;
      const originalLog = console.log;
      const targetSignals: unknown[] = [];
      const lines: string[] = [];
      process.kill = ((pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
        if (pid === escaped!.pid || additionalTargets.some((target) => target.pid === pid))
          targetSignals.push(signal);
        return originalKill(pid, signal);
      }) as typeof process.kill;
      console.log = (line: string) => {
        lines.push(line);
      };
      try {
        if (mode === 'ownership-retiring') {
          // The first synchronous census sees the live unmarked process. Only
          // after that call starts may the fixture begin its delayed retirement.
          const waiting = ownership.waitForExit(1_000);
          fs.writeFileSync(path.join(root, 'retire-unmarked'), 'retire');
          assert.equal(await waiting, true);
          assert.equal(
            stillSame(escaped),
            false,
            'A live unmarked process must never count as settled'
          );
          assert.deepEqual(ownership.finish().remaining, []);
        } else {
          assert.equal(await ownership.waitForExit(150), false);
          assert.equal(stillSame(debtTarget), true);
          assert.throws(() => ownership.signal('SIGKILL'), /ownership/i);
          assert.throws(() => ownership.finish(), /ownership/i);
          assert.equal(
            lines.some((line) => line.includes('"phase":"final"')),
            false
          );
        }
        assert.deepEqual(
          targetSignals,
          [],
          'A process without current marker proof must not be signaled'
        );
      } finally {
        process.kill = originalKill;
        console.log = originalLog;
      }
      assert.equal(stillSame(sentinel), true);
      assert.equal(fs.existsSync(path.join(root, 'sentinel-signals')), false);
      console.log(
        JSON.stringify({
          mode,
          samePidAndBirth: true,
          settledOnlyAfterExit: mode === 'ownership-retiring',
          persistentDebtRejected: mode !== 'ownership-retiring',
          freshDebtRetained: mode === 'ownership-newly-observed',
          unverifiedSignals: 0,
          sentinelUntouched: true,
        })
      );
      return;
    }
    let result: { status: number; stdout: string; stderr: string };
    if (mode === 'owner-exited' || mode === 'delayed-kill') {
      const require = createRequire(import.meta.url);
      const { createPackagedSmokeOwnership } = require(
        path.join(scriptDir, 'packagedSmokeOwnedProcesses.ts')
      ) as {
        createPackagedSmokeOwnership(): Ownership;
      };
      const {
        _internal: { terminateChild },
      } = require(path.join(scriptDir, 'smokePackagedApp.cjs')) as {
        _internal: {
          terminateChild(
            child: ChildProcess,
            closed: Promise<unknown>,
            platform: string,
            timeoutMs: number,
            ownership: Ownership
          ): Promise<void>;
        };
      };
      const ownership = createPackagedSmokeOwnership();
      const leader = spawn(process.execPath, [fixturePath, '--exiting-owner'], {
        env: { ...process.env, ...ownership.environment },
        detached: true,
        stdio: 'ignore',
      });
      await new Promise<void>((resolve, reject) => {
        leader.once('error', reject);
        leader.once('close', () => resolve());
      });
      escaped = JSON.parse(fs.readFileSync(path.join(root, 'escaped.json'), 'utf8')) as Identity;
      owner = JSON.parse(fs.readFileSync(path.join(root, 'leader.json'), 'utf8')) as Identity;
      assert.equal(
        stillSame(owner),
        false,
        'Leader must be gone before the first ownership census'
      );
      const current = identity(escaped.pid)!;
      assert.ok(
        current && current.parent !== owner.pid,
        'Escaped process must already be reparented'
      );
      assert.ok(
        ownership.sample().some((entry) => entry.pid === escaped!.pid),
        'The first census must find an already reparented child without an ancestry cache'
      );
      const lines: string[] = [];
      const originalLog = console.log;
      const originalKill = process.kill;
      let delayedKillDelivered = false;
      console.log = (line: string) => {
        lines.push(line);
      };
      if (mode === 'delayed-kill') {
        process.kill = ((pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
          if (pid === escaped!.pid && signal === 'SIGKILL') {
            setTimeout(() => {
              if (stillSame(escaped!)) originalKill(pid, signal);
              delayedKillDelivered = true;
            }, 75);
            return true;
          }
          return originalKill(pid, signal);
        }) as typeof process.kill;
      }
      try {
        // Keep the forced-kill path, but allow real process inventories to finish on loaded hosts.
        await terminateChild(leader, Promise.resolve(), process.platform, 1_500, ownership);
      } finally {
        console.log = originalLog;
        process.kill = originalKill;
      }
      if (mode === 'delayed-kill') assert.equal(delayedKillDelivered, true);
      result = { status: 0, stdout: lines.join('\n'), stderr: '' };
    } else {
      const script = path.join(
        scriptDir,
        mode.startsWith('mcp-') ? 'smokePackagedMcp.cjs' : 'smokePackagedApp.cjs'
      );
      result = await runHarness(script, bundle);
    }
    escaped = JSON.parse(fs.readFileSync(path.join(root, 'escaped.json'), 'utf8')) as Identity;
    owner = JSON.parse(fs.readFileSync(path.join(root, 'leader.json'), 'utf8')) as Identity;
    assert.notEqual(escaped.group, owner.group, 'Fixture must escape the leader process group');
    assert.equal(stillSame(sentinel), true, 'An unrelated same-executable sentinel must survive');
    assert.equal(
      stillSame(escaped),
      false,
      `Harness left detached TERM-resistant child alive: status=${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`
    );
    assert.equal(result.status, mode.endsWith('failure') ? 1 : 0, result.stderr);
    const ok = mode.startsWith('mcp-') ? '[smokePackagedMcp] OK' : '[smokePackagedApp] OK';
    const directCleanup = ['owner-exited', 'delayed-kill'].includes(mode);
    assert.equal(result.stdout.includes(ok), !directCleanup && !mode.endsWith('failure'));
    const prefix = '[packagedSmokeOwnership] ';
    const receipts = result.stdout
      .split('\n')
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)) as Receipt);
    const begin = receipts.find((receipt) => receipt.phase === 'begin');
    const final = receipts.find((receipt) => receipt.phase === 'final');
    assert.ok(begin, 'Teardown must announce its beginning');
    assert.ok(final, 'Teardown must report a final census');
    assert.deepEqual(final.remaining, []);
    assert.ok(
      final.owned?.some((entry) => entry.pid === escaped!.pid && entry.birth),
      'The census receipt must identify the escaped process that was drained'
    );
    for (const receipt of receipts) {
      for (const key of Object.keys(receipt)) {
        assert.ok(
          ['phase', 'at', 'leaderPid', 'owned', 'remaining', 'signals'].includes(key),
          `Unexpected potentially sensitive receipt field: ${key}`
        );
      }
    }
    const signals = final.signals!.filter((signal) => signal.pid === escaped!.pid);
    assert.deepEqual(
      signals.map((signal) => signal.signal),
      ['SIGTERM', 'SIGKILL']
    );
    assert.ok(signals.every((signal) => signal.outcome === 'sent'));
    assert.equal(fs.readFileSync(path.join(root, 'escaped-signals'), 'utf8'), 'SIGTERM\n');
    assert.equal(fs.existsSync(path.join(root, 'sentinel-signals')), false);
    if (!directCleanup && !mode.endsWith('failure')) {
      assert.ok(result.stdout.indexOf('"phase":"final"') < result.stdout.indexOf(ok));
    }
    const marker = fs.readFileSync(path.join(root, 'private-marker'), 'utf8');
    assert.ok(marker, 'The actual packaged child must inherit an ownership marker');
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(marker),
      false,
      'Receipts must redact ownership tokens'
    );
    assert.equal(`${result.stdout}${result.stderr}`.includes('unrelated-sentinel-marker'), false);
    console.log(
      JSON.stringify({
        mode,
        status: result.status,
        escapedGone: true,
        sentinelUntouched: true,
        detached: true,
        receiptPhases: receipts.map((receipt) => receipt.phase),
        signals: ['SIGTERM', 'SIGKILL'],
      })
    );
  } finally {
    if (!escaped && fs.existsSync(path.join(root, 'escaped.json'))) {
      escaped = JSON.parse(fs.readFileSync(path.join(root, 'escaped.json'), 'utf8')) as Identity;
    }
    if (!owner && fs.existsSync(path.join(root, 'leader.json'))) {
      owner = JSON.parse(fs.readFileSync(path.join(root, 'leader.json'), 'utf8')) as Identity;
    }
    await cleanupExact(escaped);
    await cleanupExact(owner);
    await cleanupExact(sentinel);
    for (const target of additionalTargets) await cleanupExact(target);
    fs.writeFileSync(
      path.join(root, 'fixture-cleanup.json'),
      JSON.stringify({
        mode,
        targets: [escaped, owner, sentinel, ...additionalTargets].filter((entry) => entry !== null),
        remaining: [escaped, owner, sentinel, ...additionalTargets].filter(
          (entry) => entry && stillSame(entry)
        ),
      })
    );
  }
}

const role = process.argv[2];
if (role?.startsWith('--')) {
  await roleMain(role);
} else {
  await driver();
}
