import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter, once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createTestChildProcessTrace, installTestChildProcessTrace, traceTestUnixProcessTableResult,
} from '../../src/main/utils/testChildProcessTrace.ts';

const prefix = '[TEST_MAIN_CHILD_PROCESS] ';
const parse = (lines: string[]): Record<string, unknown>[] => lines.map(line => {
  assert.ok(line.startsWith(prefix) && line.endsWith('\n'));
  assert.ok(Buffer.byteLength(line) < 1024);
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
});

test('ordinary Node imports and synchronous observations remain inert', () => {
  const events = channel('child_process'), subscribed = events.hasSubscribers;
  assert.equal(installTestChildProcessTrace(), false);
  const result = Object.freeze({ pid: 123, status: 0, signal: null });
  traceTestUnixProcessTableResult(result);
  assert.deepEqual(result, { pid: 123, status: 0, signal: null });
  assert.equal(events.hasSubscribers, subscribed);
});

test('constructor subscription observes the original async child after pid assignment', async () => {
  const lines: string[] = [];
  const trace = createTestChildProcessTrace({ mainPid: process.pid, write: line => { lines.push(line); } });
  const events = channel('child_process');
  events.subscribe(trace.observe);
  try {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("TEST_CHILD_ONLY")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const originalPid = child.pid;
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += String(bytes); });
    child.stderr.on('data', bytes => { stderr += String(bytes); });
    const closed = await once(child, 'close');
    assert.deepEqual(closed, [0, null]);
    assert.equal(stdout, 'TEST_CHILD_ONLY');
    assert.equal(stderr, '');
    trace.finish();
    const rows = parse(lines);
    const opened = rows.find(row => row.event === 'async-spawn');
    assert.equal(opened?.pid, originalPid);
    assert.equal(opened?.versionOnly, false);
    assert.equal(rows.find(row => row.event === 'async-exit')?.pid, originalPid);
    assert.equal(rows.find(row => row.event === 'async-exit')?.status, 0);
    assert.equal(rows.at(-1)?.observationFailures, 0);
  } finally { events.unsubscribe(trace.observe); trace.finish(); }
});

test('the observer preserves an actual unhandled child-process error', () => {
  const helper = new URL('../../src/main/utils/testChildProcessTrace.ts', import.meta.url).href;
  const missing = join(process.cwd(), 'TEST-no-such-child-' + randomUUID());
  const launch = 'import {spawn} from "node:child_process";spawn(' + JSON.stringify(missing) + ');';
  const observe = [
    'import {channel} from "node:diagnostics_channel";',
    'import {createTestChildProcessTrace} from ' + JSON.stringify(helper) + ';',
    'const trace=createTestChildProcessTrace({mainPid:process.pid,write:line=>process.stderr.write(line)});',
    'channel("child_process").subscribe(trace.observe);',
  ].join('');
  const baseline = spawnSync(process.execPath, ['--input-type=module', '-e', launch], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
  });
  const observed = spawnSync(process.execPath, ['--input-type=module', '-e', observe + launch], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
  });
  assert.equal(baseline.error, undefined);
  assert.equal(observed.error, undefined);
  assert.equal(baseline.status, 1);
  assert.equal(observed.status, baseline.status);
  for (const result of [baseline, observed]) {
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Unhandled 'error' event/u);
    assert.match(result.stderr, /ENOENT/u);
    assert.equal(result.stdout, '');
  }
  const rows = parse(observed.stderr.split('\n').filter(line => line.startsWith(prefix)).map(line => line + '\n'));
  assert.equal(rows.find(row => row.event === 'async-error')?.code, 'ENOENT');
});

test('failed reads, writes and unknown child fields cannot change the original operation', () => {
  const lines: string[] = [];
  let writes = 0;
  const trace = createTestChildProcessTrace({
    mainPid: process.pid,
    write(line) { if (++writes === 1) throw new Error('PRIVATE_WRITE'); lines.push(line); },
    readBirth() { throw new Error('PRIVATE_PROC'); },
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 123, spawnfile: '/TEST/PRIVATE_PATH/unknown-command',
    spawnargs: ['PRIVATE_PATH', 'PRIVATE_PROMPT', '--key=PRIVATE_KEY'],
  });
  assert.doesNotThrow(() => trace.observe({ process: child }));
  assert.doesNotThrow(() => child.emit('spawn'));
  assert.doesNotThrow(() => child.emit('exit', 7, null));
  const originalError = Object.assign(new Error('PRIVATE_ERROR'), { code: 'PRIVATE_CODE' });
  assert.equal(child.listenerCount('error'), 0);
  assert.throws(() => child.emit('error', originalError), error => error === originalError);
  const result = Object.freeze({ pid: 456, status: 0, signal: null });
  assert.doesNotThrow(() => trace.sync(result));
  assert.deepEqual(result, { pid: 456, status: 0, signal: null });
  trace.finish();
  const rows = parse(lines);
  assert.equal(rows.find(row => row.event === 'async-spawn')?.observedBirth, null);
  assert.equal(rows.find(row => row.event === 'async-error')?.code, 'other');
  assert.equal(rows.find(row => row.event === 'sync-result')?.pid, 456);
  assert.equal(rows.find(row => row.event === 'sync-result')?.observedBirth, null);
  assert.equal(rows.at(-1)?.observationFailures, 2);
  assert.equal(lines.join('').includes('PRIVATE'), false);
});

test('event and pending-child bounds explicitly preserve incomplete coverage', () => {
  const lines: string[] = [];
  const trace = createTestChildProcessTrace({ mainPid: process.pid, limit: 3,
    write: line => { lines.push(line); }, readBirth: () => null });
  const children = Array.from({ length: 65 }, () => Object.assign(new EventEmitter(), {
    pid: 123, spawnfile: 'node', spawnargs: ['node', '--version'],
  }));
  for (const child of children) trace.observe({ process: child });
  assert.equal(children.at(-1)!.listenerCount('spawn'), 0);
  for (const child of children.slice(0, 64)) { child.emit('spawn'); child.emit('exit', 0, null); }
  trace.finish();
  const count = lines.length;
  trace.finish();
  trace.sync({ pid: 123, status: 0, signal: null });
  assert.equal(lines.length, count);
  const rows = parse(lines);
  assert.ok(rows.length <= 3 + 4);
  assert.equal(rows.filter(row => row.event === 'trace-limit').length, 1);
  assert.equal(rows.at(-1)?.observedChildren, 64);
  assert.equal(rows.at(-1)?.unobservedChildren, 1);
  assert.equal(rows.at(-1)?.limited, true);
  assert.equal(rows.at(-1)?.droppedObservations, 125);
});
