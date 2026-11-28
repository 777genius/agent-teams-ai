import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  captureCodexCodeModeProcess,
  observeCodexCodeModeProcess,
} from './fixtures/codex-native-closure.ts';
import type { ProcessFact } from './fixtures/native-input-capture.ts';

// The old three-argument helper satisfies this type too. Missing pre-assert evidence
// must fail an assertion on the real helper, not an import or a future API lookup.
type Capture = (
  hostPid: Parameters<typeof captureCodexCodeModeProcess>[0],
  nativeInputs: Parameters<typeof captureCodexCodeModeProcess>[1],
  read: Parameters<typeof captureCodexCodeModeProcess>[2],
  observer?: (value: unknown) => void
) => ReturnType<typeof captureCodexCodeModeProcess>;
const capture: Capture = captureCodexCodeModeProcess;
const hostPid = 1100;
const birth = 'Sat Nov 28 10:00:00 2026';
const rootFailure = {
  code: 'ERR_ASSERTION',
  message: /^one selected original live Codex root(?:\n|$)/u,
  expected: 1,
};

function fact(pid: number, parentPid: number, command: string): ProcessFact {
  return { pid, parentPid, groupId: pid, birth, command };
}

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-codex-preassert-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const nativeInputs = ['codex', 'codex-code-mode-host'].map((name) => {
    const path = join(directory, name),
      bytes = Buffer.from('TEST never executed: ' + name);
    writeFileSync(path, bytes, { mode: 0o700 });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const root = fact(1200, hostPid, nativeInputs[0]!.path);
  const helper = fact(1201, root.pid, nativeInputs[1]!.path);
  return { directory, nativeInputs, root, helper, rows: [root, helper] };
}

function observation(rows: ProcessFact[]) {
  let reads = 0;
  const diagnostics: unknown[] = [];
  return {
    read: () => {
      reads++;
      return rows;
    },
    observer: (value: unknown) => {
      diagnostics.push(value);
    },
    diagnostics,
    count: () => reads,
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  const values: unknown[] = value;
  return values.map(record);
}

function diagnostic(observed: ReturnType<typeof observation>) {
  assert.equal(observed.count(), 1, 'reuse the one original process read');
  assert.equal(observed.diagnostics.length, 1, 'retain evidence before the original assertion');
  return record(observed.diagnostics[0]);
}

test('one root and helper retain the exact witness and one private pre-assert diagnostic', async (t) => {
  const f = fixture(t),
    original = structuredClone(f.rows),
    observed = observation(f.rows);
  const witness = await capture(hostPid, f.nativeInputs, observed.read, observed.observer);
  assert.deepEqual(witness, {
    status: 'captured',
    codex: f.root,
    helper: f.helper,
    nativeInputs: f.nativeInputs,
  });
  assert.notEqual(witness.codex, f.root);
  assert.notEqual(witness.helper, f.helper);
  assert.equal(witness.nativeInputs, f.nativeInputs);
  const value = diagnostic(observed);
  assert.deepEqual(value, {
    schemaVersion: 1,
    diagnosticOnly: true,
    hostPid,
    rootCount: 1,
    helperCount: 1,
    rootsTruncated: false,
    helpersTruncated: false,
    roots: [{ pid: 1200, parentPid: hostPid, groupId: 1200, birth, executableRole: 'codex' }],
    helpers: [
      { pid: 1201, parentPid: 1200, groupId: 1201, birth, executableRole: 'code-mode-host' },
    ],
  });
  assert.equal(
    JSON.stringify(value).includes(f.directory),
    false,
    'no executable path or raw command'
  );
  assert.deepEqual(f.rows, original);
});

test('two original matching roots preserve the 2/1 failure and both candidate relations', async (t) => {
  const f = fixture(t),
    second = fact(1300, hostPid, f.nativeInputs[0]!.path);
  const secondHelper = fact(1301, second.pid, f.nativeInputs[1]!.path);
  const rows = [...f.rows, second, secondHelper],
    original = structuredClone(rows);
  const observed = observation(rows);
  await assert.rejects(capture(hostPid, f.nativeInputs, observed.read, observed.observer), {
    ...rootFailure,
    actual: 2,
  });
  const value = diagnostic(observed);
  assert.equal(value.rootCount, 2);
  assert.equal(value.helperCount, 2);
  assert.equal(value.rootsTruncated, false);
  assert.equal(value.helpersTruncated, false);
  assert.deepEqual(
    records(value.roots).map((row) => [row.pid, row.parentPid, row.executableRole]),
    [
      [1200, hostPid, 'codex'],
      [1300, hostPid, 'codex'],
    ]
  );
  assert.deepEqual(
    records(value.helpers).map((row) => [row.pid, row.parentPid, row.executableRole]),
    [
      [1201, 1200, 'code-mode-host'],
      [1301, 1300, 'code-mode-host'],
    ]
  );
  assert.deepEqual(Object.keys(value).sort(), [
    'diagnosticOnly',
    'helperCount',
    'helpers',
    'helpersTruncated',
    'hostPid',
    'rootCount',
    'roots',
    'rootsTruncated',
    'schemaVersion',
  ]);
  assert.deepEqual(rows, original);
});

test('zero roots preserve the 0/1 failure and an exact empty diagnostic', async (t) => {
  const f = fixture(t),
    observed = observation([]);
  await assert.rejects(capture(hostPid, f.nativeInputs, observed.read, observed.observer), {
    ...rootFailure,
    actual: 0,
  });
  assert.deepEqual(diagnostic(observed), {
    schemaVersion: 1,
    diagnosticOnly: true,
    hostPid,
    rootCount: 0,
    helperCount: 0,
    rootsTruncated: false,
    helpersTruncated: false,
    roots: [],
    helpers: [],
  });
});

test('foreign parents and executable paths do not become original candidate roots or helpers', async (t) => {
  const f = fixture(t);
  const foreignRoot = fact(1400, hostPid + 1, f.nativeInputs[0]!.path);
  const foreign = [
    foreignRoot,
    fact(1401, foreignRoot.pid, f.nativeInputs[1]!.path),
    fact(1500, hostPid, join(f.directory, 'different-codex')),
    fact(1501, f.root.pid, join(f.directory, 'different-helper')),
  ];
  const observed = observation([...foreign, ...f.rows]);
  const witness = await capture(hostPid, f.nativeInputs, observed.read, observed.observer);
  assert.deepEqual(witness.codex, f.root);
  assert.deepEqual(witness.helper, f.helper);
  const value = diagnostic(observed);
  assert.equal(value.rootCount, 1);
  assert.equal(value.helperCount, 1);
  assert.deepEqual(
    records(value.roots).map((row) => row.pid),
    [1200]
  );
  assert.deepEqual(
    records(value.helpers).map((row) => row.pid),
    [1201]
  );
  const absent = observation(foreign);
  await assert.rejects(capture(hostPid, f.nativeInputs, absent.read, absent.observer), {
    ...rootFailure,
    actual: 0,
  });
  assert.equal(diagnostic(absent).rootCount, 0);
  assert.equal(diagnostic(absent).helperCount, 0);
});

test('missing duplicate and wrong-group helpers retain their original assertions after observation', async (t) => {
  const f = fixture(t);
  const cases = [
    {
      rows: [f.root],
      count: 0,
      expected: 1,
      actual: 0,
      message: /^actual original code-mode helper must be observed before Stop(?:\n|$)/u,
    },
    {
      rows: [...f.rows, fact(1202, f.root.pid, f.nativeInputs[1]!.path)],
      count: 2,
      expected: 1,
      actual: 2,
      message: /^actual original code-mode helper must be observed before Stop(?:\n|$)/u,
    },
    {
      rows: [f.root, { ...f.helper, groupId: f.root.groupId }],
      count: 1,
      expected: f.helper.pid,
      actual: f.root.groupId,
      message: /^pinned native helper has its own process group(?:\n|$)/u,
    },
  ];
  for (const control of cases) {
    const observed = observation(control.rows),
      original = structuredClone(control.rows);
    await assert.rejects(capture(hostPid, f.nativeInputs, observed.read, observed.observer), {
      code: 'ERR_ASSERTION',
      message: control.message,
      expected: control.expected,
      actual: control.actual,
    });
    const value = diagnostic(observed);
    assert.equal(value.rootCount, 1);
    assert.equal(value.helperCount, control.count);
    assert.deepEqual(control.rows, original);
  }
});

test('throwing or mutating diagnostic observers cannot replace original results and failures', async (t) => {
  const f = fixture(t),
    original = structuredClone(f.rows);
  let calls = 0,
    reads = 0;
  const read = () => {
    reads++;
    return f.rows;
  };
  const thrown = new Error('TEST observer failure');
  const first = await capture(hostPid, f.nativeInputs, read, () => {
    calls++;
    throw thrown;
  });
  assert.equal(calls, 1);
  assert.equal(reads, 1);
  assert.deepEqual(first.helper, f.helper);
  const second = await capture(hostPid, f.nativeInputs, read, (value) => {
    calls++;
    const view = record(value);
    for (const row of [...records(view.roots), ...records(view.helpers)]) {
      row.pid = 99;
      row.parentPid = 99;
      row.groupId = 99;
      row.birth = 'TEST changed';
    }
    view.rootCount = 0;
    view.roots = [];
    view.helpers = [];
    throw thrown;
  });
  assert.equal(calls, 2);
  assert.equal(reads, 2);
  assert.deepEqual(second, first);
  assert.deepEqual(f.rows, original);
  const two = [...f.rows, fact(1300, hostPid, f.nativeInputs[0]!.path)];
  await assert.rejects(
    capture(
      hostPid,
      f.nativeInputs,
      () => {
        reads++;
        return two;
      },
      () => {
        calls++;
        throw thrown;
      }
    ),
    { ...rootFailure, actual: 2 }
  );
  assert.equal(calls, 3);
  assert.equal(reads, 3);
  // A diagnostic projection refusal is also observational: the old truthy-birth
  // witness remains valid, but no oversized original birth is emitted.
  const unprojectable = [{ ...f.root, birth: 'x'.repeat(65) }, f.helper];
  const last = await capture(
    hostPid,
    f.nativeInputs,
    () => {
      reads++;
      return unprojectable;
    },
    () => {
      calls++;
    }
  );
  assert.equal(last.codex.birth, 'x'.repeat(65));
  assert.equal(calls, 3);
  assert.equal(reads, 4);
  assert.deepEqual(f.rows, original);
});

test('candidate overflow keeps exact totals and bounded rows without relaxing the original count', async (t) => {
  const f = fixture(t);
  const roots = Array.from({ length: 20 }, (_, index) => ({
    ...fact(2000 + index, hostPid, f.nativeInputs[0]!.path),
    birth: '\\'.repeat(64),
    privateArgv: 'TEST-PRIVATE-ARGV',
  }));
  const helpers = Array.from({ length: 40 }, (_, index) => ({
    ...fact(3000 + index, 2000 + (index % 20), f.nativeInputs[1]!.path),
    birth: '\\'.repeat(64),
    privateEnvironment: 'TEST-PRIVATE-ENV',
  }));
  const rows = [...roots, ...helpers],
    original = structuredClone(rows),
    observed = observation(rows);
  await assert.rejects(capture(hostPid, f.nativeInputs, observed.read, observed.observer), {
    ...rootFailure,
    actual: 20,
  });
  const value = diagnostic(observed),
    keptRoots = records(value.roots),
    keptHelpers = records(value.helpers);
  assert.equal(value.rootCount, 20);
  assert.equal(value.helperCount, 40);
  assert.equal(value.rootsTruncated, true);
  assert.equal(value.helpersTruncated, true);
  assert.equal(keptRoots.length, 16);
  assert.equal(keptHelpers.length, 32);
  assert.equal(keptRoots[0]!.pid, 2000);
  assert.equal(keptRoots[15]!.pid, 2015);
  assert.equal(keptHelpers[0]!.pid, 3000);
  assert.equal(keptHelpers[31]!.pid, 3031);
  assert.equal(
    keptHelpers[19]!.parentPid,
    2019,
    'helper relations include roots outside the retained prefix'
  );
  const text = JSON.stringify(value);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 16 * 1024);
  assert.equal(text.includes('TEST-PRIVATE-'), false);
  assert.equal(text.includes(f.directory), false);
  assert.deepEqual(rows, original);
});

test('physical refusals precede process reads and after-Stop checks keep the original identity', async (t) => {
  const f = fixture(t);
  const badPins = [
    [f.nativeInputs[0]!, { ...f.nativeInputs[1]!, path: join(f.directory, 'different-helper') }],
    [{ ...f.nativeInputs[0]!, sha256: '0'.repeat(64) }, f.nativeInputs[1]!],
  ];
  for (const nativeInputs of badPins) {
    const observed = observation(f.rows);
    await assert.rejects(capture(hostPid, nativeInputs, observed.read, observed.observer), {
      code: 'ERR_ASSERTION',
    });
    assert.equal(observed.count(), 0);
    assert.deepEqual(observed.diagnostics, []);
  }
  const witness = await capture(hostPid, f.nativeInputs, () => f.rows);
  assert.deepEqual(
    observeCodexCodeModeProcess(witness, () => f.rows),
    {
      state: 'same-live',
      current: f.helper,
    }
  );
  assert.deepEqual(
    observeCodexCodeModeProcess(witness, () => [f.root]),
    { state: 'absent' }
  );
  assert.deepEqual(
    observeCodexCodeModeProcess(witness, () => [{ ...f.helper, pid: 9999 }]),
    {
      state: 'absent',
    }
  );
  const reused = { ...f.helper, birth: 'Sat Nov 28 11:00:00 2026' };
  assert.equal(observeCodexCodeModeProcess(witness, () => [reused]).state, 'identity-mismatch');
  assert.deepEqual(witness.firstIdentityMismatch, reused);
  assert.notEqual(witness.firstIdentityMismatch, reused);
  for (const changed of [
    { ...f.helper, parentPid: hostPid },
    { ...f.helper, groupId: hostPid },
    { ...f.helper, command: join(f.directory, 'different-helper') },
  ]) {
    assert.equal(observeCodexCodeModeProcess(witness, () => [changed]).state, 'identity-mismatch');
    assert.deepEqual(witness.firstIdentityMismatch, reused);
  }
  assert.equal(observeCodexCodeModeProcess(witness, () => f.rows).state, 'same-live');
  assert.deepEqual(witness.firstIdentityMismatch, reused);
});
