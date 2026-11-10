import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  acquireProfileWriterLease,
  ProfileWriterUnavailable,
} from '../src/adapters/profile/ProfileWriterLease.ts';

test(
  'one captured writer per store; crash permits store recovery without adopting providers',
  { timeout: 10000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-writer-')));
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-other-writer-')));
    const moduleUrl = new URL('../dist/adapters/profile/ProfileWriterLease.js', import.meta.url);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { acquireProfileWriterLease } from ${JSON.stringify(moduleUrl.href)};
      const lease = acquireProfileWriterLease(process.argv[1]);
      process.stdout.write('owned\\n');
      process.stdin.resume();
      process.once('SIGTERM', () => { lease.release(); process.exit(0); });
    `,
        root,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const childExit = once(child, 'exit');
    let other: ReturnType<typeof acquireProfileWriterLease> | undefined;
    try {
      const readiness = await Promise.race([
        once(child.stdout, 'data').then(([data]) => String(data)),
        childExit.then(() => {
          throw new Error('Writer exited before readiness');
        }),
      ]);
      assert.equal(readiness, 'owned\n');
      assert.throws(() => acquireProfileWriterLease(root), ProfileWriterUnavailable);
      other = acquireProfileWriterLease(otherRoot);
      other.assertCurrent();
      child.kill('SIGKILL');
      const [, signal] = await childExit;
      assert.equal(signal, 'SIGKILL');
      const recovered = acquireProfileWriterLease(root);
      recovered.assertCurrent();
      other.assertCurrent();
      recovered.release();
      recovered.release();
      assert.throws(() => recovered.assertCurrent(), ProfileWriterUnavailable);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await childExit;
      other?.release();
      rmSync(root, { recursive: true, force: true });
      rmSync(otherRoot, { recursive: true, force: true });
    }
  }
);

test('store aliases cannot create a second writer and malformed lock is held', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-writer-alias-')));
  const alias = `${root}-alias`;
  let lease: ReturnType<typeof acquireProfileWriterLease> | undefined;
  try {
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    lease = acquireProfileWriterLease(root);
    assert.throws(() => acquireProfileWriterLease(alias), ProfileWriterUnavailable);
    assert.throws(() => acquireProfileWriterLease(`${root}/..`), ProfileWriterUnavailable);
    lease.assertCurrent();
    lease.release();
    writeFileSync(join(root, '.legacy-agent-host-writer.lock'), 'incomplete-unknown-owner');
    assert.throws(() => acquireProfileWriterLease(root), ProfileWriterUnavailable);
  } finally {
    lease?.release();
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
