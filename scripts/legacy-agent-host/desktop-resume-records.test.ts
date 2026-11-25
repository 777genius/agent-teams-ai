import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { rows } from './desktop-resume-records.ts';

const require = createRequire(import.meta.url);
const writerPath = require.resolve('../../agent-teams-controller/src/internal/atomicFile.js');
const writer = require(writerPath) as { writeJsonFileSync(path: string, value: unknown): void };

test('published receipt reads survive the real controller writer before its atomic rename', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-resume-records-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = { commandId: 'TEST-first', phase: 'completed' };
  const second = { commandId: 'TEST-second', phase: 'completed' };
  writer.writeJsonFileSync(join(root, 'first.json'), first);
  const control = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const fs=require('node:fs'), original=fs.renameSync, control=new Int32Array(workerData.control);
    fs.renameSync=(from,to)=>{
      parentPort.postMessage({from,to});
      if(Atomics.wait(control,0,0,5000)==='timed-out')throw new Error('TEST original rename deadline');
      return original(from,to);
    };
    require(workerData.writer).writeJsonFileSync(workerData.target,workerData.value);
  `, { eval: true, workerData: { control: control.buffer, writer: writerPath,
    target: join(root, 'second.json'), value: second } });
  const exit = new Promise<number>(resolve => worker.once('exit', resolve));
  let error: Error | undefined;
  worker.once('error', value => { error = value; });
  try {
    const [stage] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) }) as
      [{ from: string; to: string }];
    assert.equal(stage.to, join(root, 'second.json'));
    assert.match(basename(stage.from), /^\.tmp\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(await rows(root), [first], 'an unrenamed file is not a published receipt');
  } finally {
    Atomics.store(control, 0, 1); Atomics.notify(control, 0);
    assert.equal(await exit, 0); assert.equal(error, undefined);
  }
  assert.deepEqual((await rows(root)).sort((left, right) => String(left.commandId).localeCompare(String(right.commandId))), [first, second]);
  assert.deepEqual((await readdir(root)).sort(), ['first.json', 'second.json']);
});

test('receipt reads reject foreign staging names, directories and symbolic links', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-resume-records-refusal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = ['unknown', 'malformed', 'directory', 'staging-link', 'receipt-link'] as const;
  for (const kind of cases) {
    const directory = join(root, kind); await mkdir(directory);
    const name = kind === 'unknown' ? 'foreign.txt' : kind === 'malformed' ? '.tmp.not-a-uuid'
      : kind === 'receipt-link' ? 'receipt.json' : '.tmp.' + randomUUID();
    const path = join(directory, name);
    if (kind === 'directory') await mkdir(path);
    else if (kind === 'staging-link' || kind === 'receipt-link') {
      const target = join(root, kind + '-target.json'); await writeFile(target, '{}');
      await symlink(target, path);
    } else await writeFile(path, '{}');
    await assert.rejects(rows(directory), assert.AssertionError, kind);
  }
});
