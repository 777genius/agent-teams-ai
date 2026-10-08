import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { artifactDownloadTimeout, planCommand } from './windows-plan-command.mts';

const execute = promisify(execFile);
void test('archive budget validates authenticated sizes and bounds only large archive time', () => {
  for (const size of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => artifactDownloadTimeout(size), /Authenticated artifact size/);
  assert.equal(artifactDownloadTimeout(1), 300_000);
  assert.equal(artifactDownloadTimeout(256 * 1_048_576), 300_000);
  assert(artifactDownloadTimeout(256 * 1_048_576 + 1) > 300_000);
  assert.equal(artifactDownloadTimeout(874_797_415), 955_000);
  // Actual ZIP was still advancing at 879067136 bytes when the 900008ms limit expired.
  assert.equal(artifactDownloadTimeout(1_001_742_940), 1_076_000);
  assert(artifactDownloadTimeout(1_001_742_940) > (1_001_742_940 / 879_067_136) * 900_008);
  assert.equal(artifactDownloadTimeout(Number.MAX_SAFE_INTEGER), 1_200_000);
});

void test('unsupported transfer budgets fail before launching a child', async () => {
  for (const timeout of [0, -1, 1.5, 1_200_001])
    await assert.rejects(planCommand('must-not-launch', [], 'unused', timeout), assert.AssertionError);
});

void test('successful tiny transfer preserves exact bytes and reports bounded phase telemetry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-plan-command-'));
  try {
    const output = path.join(root, 'tiny.bin');
    const module = new URL('./windows-plan-command.mts', import.meta.url).href;
    const { stderr } = await execute(process.execPath, [
      '--input-type=module',
      '-e',
      `const {planCommand}=await import(${JSON.stringify(module)}); await planCommand(process.execPath,['-e',"process.stdout.write(Buffer.from([0,255,10,13]));"],${JSON.stringify(output)},1200000);`,
    ]);
    assert.deepEqual(await readFile(output), Buffer.from([0, 255, 10, 13]));
    const events = stderr
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            phase: string;
            event: string;
            elapsedMs: number;
            bytes: number;
            timeoutMs: number;
            code?: number;
          }
      );
    assert.deepEqual(
      events.map(({ event }) => event),
      ['start', 'closed']
    );
    assert(events.every(({ phase }) => phase.endsWith(':tiny.bin')));
    assert.equal(events[0]?.bytes, 0);
    assert.equal(events[1]?.bytes, 4);
    assert.equal(events[1]?.code, 0);
    assert.equal(events[1]?.timeoutMs, 1_200_000);
    assert(Number.isFinite(events[1]?.elapsedMs));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('nonzero child retains its outcome and stderr instead of accepting transferred bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-plan-command-'));
  try {
    await assert.rejects(
      planCommand(
        process.execPath,
        [
          '-e',
          "process.stdout.write('partial'); process.stderr.write('TEST failure detail'); process.exit(7);",
        ],
        path.join(root, 'failed.bin')
      ),
      /code 7.*TEST failure detail/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('timeout closes its own tiny child and retains abort and stderr evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-plan-command-'));
  try {
    let failure: AggregateError | undefined;
    await assert.rejects(
      planCommand(
        process.execPath,
        [
          '-e',
          "process.stderr.write('TEST_PID:'+process.pid+' TEST timeout detail'); process.on('SIGTERM',()=>{}); setInterval(()=>{},10);",
        ],
        path.join(root, 'timeout.bin'),
        500
      ),
      (error: unknown) => {
        assert(error instanceof AggregateError);
        failure = error;
        assert.match(error.message, /timedOut true.*TEST timeout detail/);
        assert(
          error.errors.some((item: unknown) => item instanceof Error && item.name === 'AbortError')
        );
        return true;
      }
    );
    const pid = Number(failure?.message.match(/TEST_PID:(\d+)/u)?.[1]);
    assert(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('destination collision never overwrites custody and retains the stream error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-plan-command-'));
  try {
    const output = path.join(root, 'retained.bin');
    await writeFile(output, 'TEST retained original');
    await assert.rejects(
      planCommand(
        process.execPath,
        ['-e', "process.stdout.write('replacement'); setInterval(()=>{},10);"],
        output
      ),
      (error: unknown) => {
        assert(error instanceof AggregateError);
        assert(
          error.errors.some(
            (item: unknown) => item instanceof Error && 'code' in item && item.code === 'EEXIST'
          )
        );
        return true;
      }
    );
    assert.equal(await readFile(output, 'utf8'), 'TEST retained original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('deadline never accepts exit zero while its owned inherited pipe closes late', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-plan-command-'));
  try {
    await assert.rejects(
      planCommand(
        process.execPath,
        [
          '-e',
          "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1000)'],{stdio:['ignore',1,2]}); process.exit(0);",
        ],
        path.join(root, 'late-pipe.bin'),
        500
      ),
      /code 0.*timedOut true/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
