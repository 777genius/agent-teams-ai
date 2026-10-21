import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCENARIO_RECEIPT_LIMIT,
  parseScenarioReceipt,
  scenarioProofBinding,
  scenarioProofIdentities,
  validateScenarioProof,
  scenarioProofDrain,
  scenarioFinalHistory,
  carryScenarioProof,
} from './scenario-cleanup-proof.mjs';

const birth = (offset) => `2026-10-21T20:00:00.${String(offset).padStart(7, '0')}Z`;
const identity = (pid, parent = 100, offset = pid) => ({
  pid,
  parent,
  birth: birth(offset),
  executable: `C:\\TEST\\${pid}.exe`,
});
const base = Date.parse('2026-10-21T20:00:01Z');
function fixture(count = 3) {
  const launcher = identity(100, 50, 0);
  const rows = [
    launcher,
    ...Array.from({ length: count - 1 }, (_, index) => identity(101 + index)),
  ];
  const context = {
    root: 'C:\\TEST\\opencode-diagnostics-e2e-proof',
    run: 'cold',
    launcher,
    requestedAt: base,
  };
  const binding = scenarioProofBinding(context.root, context.run, launcher);
  const observation = (at) => ({
    startedAt: at - 1,
    at,
    observationOnly: true,
    known: rows.map((expected) => ({ expected, state: 'absent-from-census', current: null })),
    descendants: [launcher],
  });
  return JSON.parse(
    JSON.stringify({
      context,
      prestop: rows,
      stoppedAt: base + 100,
      proof: {
        schemaVersion: 1,
        observationOnly: true,
        binding,
        startedAt: base + 1,
        completedAt: base + 90,
        complete: true,
        identities: rows,
      },
      graceful: {
        schemaVersion: 1,
        observationOnly: true,
        binding,
        startedAt: base + 1,
        completedAt: base + 80,
        beforeClose: observation(base + 10),
        afterClose: observation(base + 20),
      },
      signal: [launcher],
    })
  );
}
const census = (processes) => ({
  schemaVersion: 1,
  complete: true,
  ports: [9222],
  listeners: [],
  processes,
  startedAt: base + 101,
  completedAt: base + 102,
});
const clone = (value) => structuredClone(value);

test('complete history replaces the old 10/25, 17/52, 16/87 live-subset assumption', () => {
  for (const [liveCount, historyCount] of [
    [10, 25],
    [17, 52],
    [16, 87],
  ]) {
    const input = fixture(historyCount);
    const live = input.prestop.slice(0, liveCount);
    assert.equal(
      input.graceful.afterClose.known.every((record) =>
        live.some((row) => row.pid === record.expected.pid && row.birth === record.expected.birth)
      ),
      false
    );
    input.prestop = scenarioProofIdentities(live, input.prestop);
    const handoff = validateScenarioProof(input);
    assert.equal(handoff.identities.length, historyCount);
    assert.equal(handoff.signalAuthorityExpanded, false);
    assert.equal(input.signal.length, 1);
    assert.equal(scenarioProofDrain(handoff, census([]), base + 103).drained, true);
  }
});

test('post-close known identities and late descendants remain in the complete proof union', () => {
  const input = fixture();
  const late = identity(700);
  const later = identity(701, 700);
  input.proof.identities = [...input.proof.identities, late, later];
  input.graceful.afterClose.descendants = [input.context.launcher, late];
  input.graceful.afterClose.known.push({ expected: late, state: 'same-birth-present' });
  // later is observed by the producer after the immediate afterClose sample.
  const handoff = validateScenarioProof(input);
  assert(handoff.identities.some((row) => row.pid === 701));
  assert.equal(handoff.identities.length, 5);
  const remains = scenarioProofDrain(
    handoff,
    census([{ pid: 701, parent: 700, birth: later.birth }]),
    base + 103
  );
  assert.equal(remains.drained, false);
  assert.deepEqual(
    input.signal.map((row) => row.pid),
    [100]
  );
  const manifest = {
    root: input.context.root,
    run: input.context.run,
    launcher: input.context.launcher,
    proofObservedProcesses: input.prestop,
  };
  const carried = carryScenarioProof(manifest, handoff);
  assert(carried.some((row) => row.pid === later.pid));
  assert.equal(manifest.proofObservedProcesses.length, input.prestop.length);
  assert.throws(
    () =>
      carryScenarioProof(
        { ...manifest, proofObservedProcesses: [...input.prestop, identity(999)] },
        handoff
      ),
    /proven ledger/
  );
  const warm = fixture();
  warm.context.run = 'warm-1';
  warm.context.launcher = identity(200, 50, 0);
  warm.prestop = scenarioProofIdentities([warm.context.launcher], carried);
  warm.proof.identities = warm.prestop;
  warm.signal = [warm.context.launcher];
  for (const receipt of [warm.proof, warm.graceful])
    receipt.binding = scenarioProofBinding(
      warm.context.root,
      warm.context.run,
      warm.context.launcher
    );
  for (const point of ['beforeClose', 'afterClose']) {
    warm.graceful[point].known = warm.prestop.map((expected) => ({
      expected,
      state: 'absent-from-census',
    }));
    warm.graceful[point].descendants = [warm.context.launcher];
  }
  assert(validateScenarioProof(warm).identities.some((row) => row.pid === later.pid));
});

test('a stopped launcher grants no new ancestry and requires a fresh complete retirement census', () => {
  const input = fixture();
  const launcher = input.context.launcher;
  const retirement = (startedAt, at, processes = []) => ({
    startedAt,
    at,
    observationOnly: true,
    expected: { pid: launcher.pid, birth: launcher.birth },
    state: 'absent',
    census: { ...census(processes), startedAt, completedAt: at },
  });
  input.graceful.afterClose.descendants = [];
  input.graceful.afterClose.rootRetirement = retirement(base + 19, base + 20);
  input.graceful.lateRootRetirement = retirement(base + 30, base + 31);
  input.graceful.finalRootRetirement = retirement(base + 40, base + 41);
  assert.equal(validateScenarioProof(input).identities.length, 3);
  const reused = clone(input);
  reused.graceful.afterClose.rootRetirement.state = 'different-birth';
  reused.graceful.afterClose.rootRetirement.census.processes = [
    { pid: launcher.pid, parent: 4, birth: birth(1) },
  ];
  assert.equal(validateScenarioProof(reused).identities.length, 3);
  for (const change of [
    (value) => {
      const unproven = identity(999);
      value.graceful.afterClose.descendants.push(unproven);
      value.proof.identities.push(unproven);
    },
    (value) => {
      delete value.graceful.afterClose.rootRetirement;
    },
    (value) => {
      value.graceful.afterClose.rootRetirement.census.complete = false;
    },
    (value) => {
      value.graceful.afterClose.rootRetirement.census.processes = [
        { pid: launcher.pid, parent: 4, birth: null },
      ];
    },
    (value) => {
      value.graceful.afterClose.rootRetirement.census.processes = [
        { pid: launcher.pid, parent: 4, birth: launcher.birth },
      ];
    },
    (value) => {
      value.graceful.lateRootRetirement.census.startedAt = base + 1;
    },
    (value) => {
      value.graceful.finalRootRetirement.expected.pid++;
    },
  ]) {
    const bad = clone(input);
    change(bad);
    assert.throws(() => validateScenarioProof(bad));
  }
});

test('consistent null-to-known executable enrichment and reparenting retain the exact process', () => {
  const old = { ...identity(101), executable: null };
  const current = { ...identity(101), parent: 4, executable: 'c:\\test\\101.EXE' };
  const rows = scenarioProofIdentities([old], [current], [identity(101)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].executable, current.executable);
  assert.equal(rows[0].parent, old.parent);
  assert.throws(
    () => scenarioProofIdentities([current], [{ ...current, executable: 'C:\\foreign.exe' }]),
    /Conflicting/
  );
  const input = fixture();
  input.prestop = input.prestop.map((row) => (row.pid === 101 ? old : row));
  const handoff = validateScenarioProof(input);
  assert.equal(
    handoff.identities.find((row) => row.pid === 101).executable,
    identity(101).executable
  );
});

test('different exact births for the same PID are distinct required proof identities', () => {
  const first = identity(90, 100, 1),
    second = identity(90, 100, 2);
  const input = fixture();
  input.prestop = [...input.prestop, first, second];
  input.proof.identities = [...input.proof.identities, first, second];
  const handoff = validateScenarioProof(input);
  assert.equal(handoff.identities.filter((row) => row.pid === 90).length, 2);
  assert.equal(
    scenarioProofDrain(handoff, census([{ pid: 90, parent: 4, birth: birth(3) }]), base + 103)
      .drained,
    true
  );
  assert.equal(
    scenarioProofDrain(handoff, census([{ pid: 90, parent: 4, birth: first.birth }]), base + 103)
      .drained,
    false
  );
});

test('same PID with null, imprecise or unchanged birth never proves retirement', () => {
  const input = fixture(),
    handoff = validateScenarioProof(input);
  for (const value of [null, birth(101), birth(101).replace('0000101', '000010')]) {
    const drain = scenarioProofDrain(
      handoff,
      census([{ pid: 101, parent: 100, birth: value }]),
      base + 103
    );
    assert.equal(drain.drained, false);
    assert(
      ['unknown', 'same-birth-present'].includes(
        drain.rows.find((row) => row.expected.pid === 101).state
      )
    );
  }
  const changed = scenarioProofDrain(
    handoff,
    census([{ pid: 101, parent: 4, birth: birth(102) }]),
    base + 103
  );
  assert.equal(changed.drained, true);
  assert.equal(
    scenarioFinalHistory(changed, base + 102).records.find((row) => row.expected.pid === 101).state,
    'pid-reused'
  );
});

test('missing, unreadable, incomplete, stale or listener-bearing complete census fails closed', () => {
  const handoff = validateScenarioProof(fixture());
  for (const value of [
    undefined,
    { ...census([]), complete: false },
    { ...census([]), processes: null },
    { ...census([]), startedAt: base + 1 },
    { ...census([]), completedAt: base + 500 },
    { ...census([]), ports: [9223] },
  ]) {
    assert.throws(() => scenarioProofDrain(handoff, value, base + 103));
  }
  const value = { ...census([]), listeners: [{ pid: 999, port: 9222 }] };
  assert.equal(scenarioProofDrain(handoff, value, base + 103).drained, false);
});

test('missing, malformed, oversized or incomplete post-stop proof cannot qualify', () => {
  assert.throws(() => parseScenarioReceipt(undefined));
  assert.throws(() => parseScenarioReceipt('{invalid'));
  assert.throws(() => parseScenarioReceipt(' '.repeat(SCENARIO_RECEIPT_LIMIT + 1)));
  assert.throws(() => scenarioProofIdentities(undefined));
  assert.throws(() =>
    scenarioProofIdentities(Array.from({ length: 501 }, (_, index) => identity(index + 1000)))
  );
  for (const patch of [
    undefined,
    { complete: false },
    { identities: undefined },
    { schemaVersion: 0 },
  ]) {
    const input = fixture();
    input.proof = patch === undefined ? undefined : { ...input.proof, ...patch };
    assert.throws(() => validateScenarioProof(input));
  }
  const input = fixture();
  input.proof.identities = input.proof.identities.slice(0, 1);
  assert.throws(() => validateScenarioProof(input), /proven ledger/);
});

test('root, run, launcher and invocation time prevent stale or foreign handoff reuse', () => {
  for (const change of [
    (binding) => {
      binding.root = 'C:\\foreign';
    },
    (binding) => {
      binding.run = 'warm-1';
    },
    (binding) => {
      binding.launcher.pid++;
    },
    (binding) => {
      binding.launcher.birth = birth(1);
    },
  ]) {
    const input = clone(fixture());
    change(input.proof.binding);
    assert.throws(() => validateScenarioProof(input), /binding/);
  }
  for (const change of [
    (input) => {
      input.proof.startedAt = base - 1;
    },
    (input) => {
      input.proof.completedAt = base + 101;
    },
    (input) => {
      input.graceful.afterClose.at = base - 1;
    },
    (input) => {
      input.graceful.afterClose.at = base + 81;
    },
  ]) {
    const input = clone(fixture());
    change(input);
    assert.throws(() => validateScenarioProof(input));
  }
});

test('forged known rows, disconnected descendants and missing post-close history are refused', () => {
  for (const change of [
    (input) => {
      input.graceful.afterClose.known.push({ expected: identity(999) });
    },
    (input) => {
      input.graceful.afterClose.descendants = null;
    },
    (input) => {
      input.graceful.afterClose.collectionFailed = true;
    },
    (input) => {
      input.graceful.historyUnavailable = true;
    },
    (input) => {
      input.graceful.afterClose.known[1].expected.executable = 'C:\\foreign.exe';
    },
    (input) => {
      input.proof.identities.push(identity(999, 9999));
    },
    (input) => {
      input.graceful.afterClose.descendants.push(identity(101, 9999));
    },
    (input) => {
      input.signal.push(identity(999));
    },
  ]) {
    const input = clone(fixture());
    change(input);
    assert.throws(() => validateScenarioProof(input));
  }
});

test('identity unions reject imprecise expected births, conflicting paths and oversized combined history', () => {
  assert.throws(() =>
    scenarioProofIdentities([{ ...identity(101), birth: '2026-10-21T20:00:00.000Z' }])
  );
  assert.throws(() => scenarioProofIdentities([{ ...identity(101), birth: null }]));
  assert.throws(() => scenarioProofIdentities([{ ...identity(101), parent: 101 }]));
  assert.throws(() =>
    scenarioProofIdentities([identity(101)], [{ ...identity(101), executable: 'C:\\other.exe' }])
  );
  const rows = Array.from({ length: 501 }, (_, index) => identity(1000 + index));
  assert.throws(() => scenarioProofIdentities(rows.slice(0, 300), rows.slice(300)), /union bound/);
});
