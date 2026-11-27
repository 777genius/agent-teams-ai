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

for (const lateRead of ['fallback', 'signal'] as const) {
  test('failure cleanup stops after a late ' + lateRead + ' census and retains the first error', async (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const inventoryError = new Error('missing captured birth');
    const reads: number[][] = [];
    const signals: number[] = [];
    const ledger = new DefaultProcessLedger(
      (required = []) => {
        reads.push([...required]);
        if (required.includes(child.pid)) throw inventoryError;
        if (
          (lateRead === 'fallback' && required.length === 0) ||
          (lateRead === 'signal' && required.length === 1)
        ) {
          now += 30_000;
          if (lateRead === 'signal') throw new Error('later census failure');
        }
        return [root, other];
      },
      (pid) => {
        signals.push(pid);
        return true;
      }
    );
    ledger.roots.push(root, other);
    for (const identity of [root, child, other]) {
      ledger.observed.set(String(identity.pid) + ':' + identity.birth, identity);
    }
    await assert.rejects(ledger.stop(), (error) => error === inventoryError);
    assert.deepEqual(signals, []);
    assert.deepEqual(
      reads,
      lateRead === 'fallback'
        ? [[root.pid, child.pid, other.pid], []]
        : [[root.pid, child.pid, other.pid], [], [root.pid]]
    );
  });
}

test('failure cleanup shares its deadline across progress and does not signal after a late read', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const inventoryError = new Error('missing captured birth');
  const last = { ...other, pid: 45 };
  let rows: ProcessIdentity[] = [root, other, last];
  const reads: number[][] = [];
  const signals: number[] = [];
  const ledger = new DefaultProcessLedger(
    (required = []) => {
      reads.push([...required]);
      if (required.includes(child.pid)) throw inventoryError;
      if (required.length === 1) now += 6000;
      return rows;
    },
    (pid) => {
      signals.push(pid);
      rows = rows.filter((row) => row.pid !== pid);
      return true;
    }
  );
  ledger.roots.push(root, other, last);
  for (const identity of [root, child, other, last]) {
    ledger.observed.set(String(identity.pid) + ':' + identity.birth, identity);
  }
  await assert.rejects(ledger.stop(), (error) => error === inventoryError);
  assert.deepEqual(signals, [root.pid]);
  assert.deepEqual(reads, [[root.pid, child.pid, other.pid, last.pid], [], [root.pid], [other.pid]]);
});

test('healthy cleanup does not activate the failure deadline', async (t) => {
  let clockReads = 0;
  t.mock.method(Date, 'now', () => {
    clockReads++;
    return 0;
  });
  let rows: ProcessIdentity[] = [root];
  const signals: number[] = [];
  const ledger = new DefaultProcessLedger(
    () => rows,
    (pid) => {
      signals.push(pid);
      rows = rows.filter((row) => row.pid !== pid);
      return true;
    }
  );
  ledger.roots.push(root);
  ledger.observed.set(String(root.pid) + ':' + root.birth, root);
  const result = await ledger.stop();
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(signals, [root.pid]);
  assert.equal(clockReads, 0);
});
