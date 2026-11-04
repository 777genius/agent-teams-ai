import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { durable, observe, requireTerminal } from './observe.mts';

test('finite synthetic child close cannot turn missing native terminal into a next-pin permission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-selection-propagation-'));
  durable(path.join(root, 'entry.json'), { entered: true });
  let nextPin = false;
  let notified!: () => void;
  const unknown = new Promise<void>((resolve) => {
    notified = resolve;
  });
  let closed = false;
  const pending = observe(
    process.execPath,
    ['-e', 'setTimeout(()=>process.exit(0), 75)'],
    root,
    {},
    10,
    () => {
      durable(path.join(root, 'UNKNOWN.json'), { targetHalted: true });
      notified();
    }
  );
  void pending.then(() => {
    closed = true;
  });
  await unknown;
  assert.equal(closed, false, 'UNKNOWN must be durable before eventual wrapper close');
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'UNKNOWN.json'), 'utf8')).targetHalted,
    true
  );
  const closure = await pending;
  assert.equal(JSON.parse(await readFile(path.join(root, 'entry.json'), 'utf8')).entered, true);
  assert.equal(closure.code, 0);
  assert.equal(closure.unknown, true);
  assert.throws(() => {
    requireTerminal(closure, { nativeClosed: true });
    nextPin = true;
  }, /target halted/);
  assert.equal(nextPin, false);
  assert.throws(() => requireTerminal({ ...closure, unknown: false }, undefined), /target halted/);
  assert.doesNotThrow(() =>
    requireTerminal({ ...closure, unknown: false }, { nativeClosed: true })
  );
});
