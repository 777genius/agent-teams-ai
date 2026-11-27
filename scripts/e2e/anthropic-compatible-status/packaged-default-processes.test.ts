import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultProcessLedger, type ProcessIdentity } from './packaged-default-processes.ts';

const root = { pid: 42, parent: 1, birth: '2026-09-10T01:00:00.0000000Z' };
const child = { pid: 43, parent: 42, birth: '2026-09-10T01:00:01.0000000Z' };
const other = { pid: 44, parent: 1, birth: '2026-09-10T01:00:02.0000000Z' };

function fixture() {
  let rows: ProcessIdentity[] = [root, other];
  const signals: number[] = [];
  const ledger = new DefaultProcessLedger(
    (required = []) => {
      if (required.includes(child.pid)) throw new Error('missing birth');
      return rows;
    },
    (pid) => {
      signals.push(pid);
      rows = rows.filter((row) => row.pid !== pid);
      return true;
    }
  );
  ledger.roots.push(root, other);
  for (const identity of [root, child, other]) {
    ledger.observed.set(`${identity.pid}:${identity.birth}`, identity);
  }
  return { ledger, signals };
}

test('failed census still cleans verified roots and never signals the uncertain child', async () => {
  const { ledger, signals } = fixture();
  await assert.rejects(ledger.stop(), /Process inventory failed: Error: missing birth/);
  assert.deepEqual(signals, [root.pid, other.pid]);
});

test('qualification does not fall back to permissive census or signal processes', async () => {
  const { ledger, signals } = fixture();
  await assert.rejects(ledger.stop({ requireQuiet: true }), /missing birth/);
  assert.deepEqual(signals, []);
});

test('a PID reused between sampling and signaling does not prevent cleanup of another root', async () => {
  let rows: ProcessIdentity[] = [root, other];
  const signals: number[] = [];
  const ledger = new DefaultProcessLedger(
    (required = []) => {
      if (required.length === 1 && required[0] === root.pid) {
        rows = rows.map((row) =>
          row.pid === root.pid ? { ...row, birth: child.birth } : row
        );
      }
      return rows;
    },
    (pid) => {
      signals.push(pid);
      rows = rows.filter((row) => row.pid !== pid);
      return true;
    }
  );
  ledger.roots.push(root, other);
  for (const identity of [root, other]) {
    ledger.observed.set(`${identity.pid}:${identity.birth}`, identity);
  }
  await assert.rejects(ledger.stop(), /PID reused/);
  assert.deepEqual(signals, [other.pid]);
});
