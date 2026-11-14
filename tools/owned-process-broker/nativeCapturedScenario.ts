import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CapturedProcess } from '../../packages/legacy-agent-host/dist/adapters/providers/CapturedProcess.js';
import { capturedWitness, timeout, waitFor } from './nativeGateContext';
import { createFixtureOutputCollector } from './nativeGateOutput';

import type { ChildProcess } from 'node:child_process';
import type { CapturedProcessProfile } from '../../packages/legacy-agent-host/dist/adapters/providers/CapturedProcess.js';
import type { GateContext } from './nativeGateContext';

/** Exercise the product custody path with genuine Windows argv/env and original Job cleanup. */
export async function nativeCapturedScenario(context: GateContext,
  provider: 'claude' | 'codex' | 'opencode', rootFirst: boolean, sentinel: ChildProcess): Promise<void> {
  const { marker, events, phase, fixture, track } = context;
  const start = marker();
  const directory = join(dirname(start.path), `TEST ${provider} Я ${rootFirst ? 'tree' : 'stdio'}`);
  mkdirSync(directory);
  const cwd = realpathSync(directory), executable = join(cwd, 'TEST provider.exe');
  copyFileSync(fixture, executable);
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const broker = realpathSync(context.broker);
  const profile: CapturedProcessProfile = { provider, cwd,
    executable: { path: realpathSync(executable), sha256: digest(executable) },
    environment: { HOME: cwd, PATH: cwd, CODEX_HOME: cwd, CLAUDE_CONFIG_DIR: cwd,
      TEST_CAPTURED_CWD: cwd, TEST_CAPTURED_VALUE: 'space quote " slash\\ end\\ Я日' },
    windowsBroker: { path: broker, sha256: digest(broker),
      arch: process.arch === 'arm64' ? 'arm64' : 'x64', protocol: 1 } };
  const previous = process.env.TEST_UNCAPTURED_PARENT;
  process.env.TEST_UNCAPTURED_PARENT = 'TEST ambient value must not reach target';
  const custody = new CapturedProcess(profile);
  try {
    phase('prepare');
    const child = custody.launch({ command: profile.executable.path, cwd,
      args: [rootFirst ? 'root-first-gated' : 'selection', start.path, start.nonce,
        ...(rootFirst ? [] : ['', 'space quote " slash\\ end\\', 'Я日'])] });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve); child.once('error', reject);
    });
    void closed.catch(() => undefined);
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(custody.isRunning(), true, 'Pending native allocation is still owned and running');
    if (rootFirst) {
      const output = createFixtureOutputCollector();
      child.stdout.on('data', events.guard(output.push));
      phase('child-lines');
      await waitFor(() => output.children.length === 4 && output.root !== undefined, 10000, events);
      assert.equal(output.root!.pid, child.pid, 'SDK PID belongs to the target, not its broker');
      phase('capture-descendants');
      const witnesses = await events.wait(Promise.all([output.root!, ...output.children].map(value =>
        capturedWitness(fixture, value.pid, value.birth, track, events))));
      child.stdin.write('1'); // Release fixture root only after its original HANDLE witness exists.
      phase('root-exit');
      assert.equal(await timeout(events.wait(exited)), 0);
      assert.equal(custody.observeStopped(), false, 'Exited root leaves its descendant Job owned');
      assert.ok(output.hasFinal());
      phase('stop');
      assert.deepEqual(await events.wait(Promise.all([custody.confirmStopped(), custody.confirmStopped()])), [true, true]);
      phase('witness-exits');
      assert.deepEqual(await timeout(events.wait(Promise.all(witnesses.map(value => value.exit)))), [0, 0, 0, 0, 0]);
      assert.equal(await timeout(events.wait(closed)), 0);
    } else {
      const output: Buffer[] = [], errors: Buffer[] = [];
      child.stdout.on('data', events.guard((chunk: Buffer) => {
        assert.ok(output.reduce((size, value) => size + value.length, chunk.length) <= 256);
        output.push(chunk);
      }));
      child.stderr.on('data', events.guard((chunk: Buffer) => {
        assert.ok(errors.reduce((size, value) => size + value.length, chunk.length) <= 128);
        errors.push(chunk);
      }));
      child.stdin.end('TEST private binary\0input');
      phase('root-exit');
      assert.equal(await timeout(events.wait(closed)), 7, 'Native argv/env/cwd assertions and private stdin complete');
      assert.equal(Buffer.concat(output).toString(), 'TEST private binary\0inputTEST native stdout tail\n');
      assert.equal(Buffer.concat(errors).toString(), 'TEST native stderr tail\n');
      assert.equal(custody.observeStopped(), false, 'SDK exit is never cleanup proof');
      phase('stop');
      assert.equal(await events.wait(custody.confirmStopped()), true);
    }
    assert.equal(custody.observeStopped(), true, 'Only original native receipt and release settle custody');
    assert.equal(custody.isRunning(), false);
    assert.equal(sentinel.exitCode, null, 'Unrelated process survives provider Job cleanup');
    assert.throws(() => custody.launch({ command: profile.executable.path, cwd, args: [] }), /unavailable/);
  } finally {
    if (previous === undefined) delete process.env.TEST_UNCAPTURED_PARENT;
    else process.env.TEST_UNCAPTURED_PARENT = previous;
    assert.equal(await custody.confirmStopped(), true, 'Fixture custody must settle before returning');
  }
}
