// Proof-only scenario handoff. Nothing here grants access or signaling rights.
import assert from 'node:assert/strict';
import { windowsProofDrainSnapshot } from './platform.mjs';

export const SCENARIO_RECEIPT_LIMIT = 1024 * 1024;
const LIMIT = 500;
const runs = ['cold', 'warm-1', 'warm-2'];

function preciseBirth(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value.slice(0, 23) + 'Z'
  );
}

function identity(row) {
  assert(
    Number.isSafeInteger(row?.pid) &&
      row.pid > 0 &&
      Number.isSafeInteger(row.parent) &&
      row.parent >= 0 &&
      row.parent !== row.pid &&
      preciseBirth(row.birth) &&
      (row.executable == null ||
        (typeof row.executable === 'string' &&
          row.executable.length > 0 &&
          row.executable.length <= 4096)),
    'Invalid scenario proof identity'
  );
  return { pid: row.pid, parent: row.parent, birth: row.birth, executable: row.executable ?? null };
}

const key = (row) => `${row.pid}/${row.birth}`;
const samePath = (left, right) =>
  left == null || right == null || left.toLowerCase() === right.toLowerCase();

export function scenarioProofIdentities(...groups) {
  const result = new Map();
  for (const group of groups) {
    assert(
      Array.isArray(group) && group.length <= LIMIT,
      'Missing/oversized scenario proof history'
    );
    for (const value of group) {
      const row = identity(value);
      const previous = result.get(key(row));
      if (previous) {
        assert(
          samePath(previous.executable, row.executable),
          'Conflicting scenario proof executable'
        );
        // PID + exact birth survives reparenting and null -> known path enrichment.
        if (previous.executable === null) previous.executable = row.executable;
      } else result.set(key(row), row);
      assert(result.size <= LIMIT, 'Scenario proof union bound exceeded');
    }
  }
  return [...result.values()];
}

export function scenarioProofBinding(root, run, launcher) {
  assert(
    typeof root === 'string' && root.length > 0 && root.length <= 4096,
    'Invalid scenario proof root'
  );
  assert(run === null || runs.includes(run), 'Invalid scenario proof run');
  // The producer also serves the separate attachment fixture (run:null).
  assert(
    Number.isSafeInteger(launcher?.pid) && launcher.pid > 0 && typeof launcher.birth === 'string',
    'Missing proof launcher'
  );
  return { root, run, launcher: { pid: launcher.pid, birth: launcher.birth } };
}

export function parseScenarioReceipt(text) {
  assert(
    typeof text === 'string' && Buffer.byteLength(text) <= SCENARIO_RECEIPT_LIMIT,
    'Missing/oversized scenario receipt'
  );
  return JSON.parse(text);
}

function contains(ledger, row) {
  const previous = ledger.find((value) => key(value) === key(row));
  assert(
    previous && samePath(previous.executable, row.executable),
    'Post-stop identity is not in proven ledger'
  );
}

function lineage(rows, launcher) {
  const reached = new Set([key(launcher)]);
  for (let pass = 0; pass < rows.length; pass++) {
    let changed = false;
    for (const row of rows) {
      if (reached.has(key(row))) continue;
      if (
        rows.some(
          (parent) =>
            reached.has(key(parent)) && row.parent === parent.pid && row.birth >= parent.birth
        )
      ) {
        reached.add(key(row));
        changed = true;
      }
    }
    if (!changed) break;
  }
  return reached;
}

function rootRetirement(receipt, launcher, notBefore, notAfter) {
  assert(
    receipt?.observationOnly === true &&
      Number.isSafeInteger(receipt.startedAt) &&
      receipt.startedAt >= notBefore &&
      Number.isSafeInteger(receipt.at) &&
      receipt.at <= notAfter &&
      Number.isSafeInteger(receipt.census?.startedAt) &&
      receipt.census.startedAt >= receipt.startedAt &&
      Number.isSafeInteger(receipt.census.completedAt) &&
      receipt.census.completedAt >= receipt.census.startedAt &&
      receipt.census.completedAt <= receipt.at,
    'Incomplete launcher retirement observation'
  );
  assert.deepEqual(
    receipt.expected,
    { pid: launcher.pid, birth: launcher.birth },
    'Foreign launcher retirement'
  );
  assert.deepEqual(receipt.census.ports, [9222], 'Launcher retirement listener selection changed');
  const state = windowsProofDrainSnapshot([launcher], receipt.census).rows[0].state;
  assert(
    ['absent', 'different-birth'].includes(state) && receipt.state === state,
    'Launcher retirement is UNKNOWN or still present'
  );
}

export function validateScenarioProof({ context, prestop, proof, graceful, signal, stoppedAt }) {
  assert(
    runs.includes(context?.run) &&
      Number.isSafeInteger(context.requestedAt) &&
      Number.isSafeInteger(stoppedAt) &&
      stoppedAt >= context.requestedAt,
    'Invalid scenario stop window'
  );
  const launcher = identity(context.launcher);
  const binding = scenarioProofBinding(context.root, context.run, launcher);
  const prior = scenarioProofIdentities(prestop);
  assert(prior.length > 0, 'Empty pre-stop proof history');
  contains(prior, launcher);
  for (const receipt of [proof, graceful]) {
    assert(
      receipt?.schemaVersion === 1 && receipt.observationOnly === true,
      'Missing bound post-stop receipt'
    );
    assert.deepEqual(receipt.binding, binding, 'Stale/foreign scenario proof binding');
    assert(
      Number.isSafeInteger(receipt.startedAt) &&
        receipt.startedAt >= context.requestedAt &&
        Number.isSafeInteger(receipt.completedAt) &&
        receipt.completedAt >= receipt.startedAt &&
        receipt.completedAt <= stoppedAt,
      'Stale/invalid post-stop receipt time'
    );
  }
  assert(
    proof.complete === true &&
      !graceful.historyUnavailable &&
      proof.startedAt === graceful.startedAt &&
      proof.completedAt >= graceful.completedAt,
    'Incomplete post-stop proof history'
  );
  const ledger = scenarioProofIdentities(proof.identities);
  assert(
    ledger.length > 0 && ledger.length === proof.identities.length,
    'Empty/duplicate post-stop proof ledger'
  );
  for (const row of prior) contains(ledger, row);
  const rooted = lineage(ledger, launcher);
  for (const row of ledger)
    assert(
      prior.some((previous) => key(previous) === key(row)) || rooted.has(key(row)),
      'Unproven new post-stop lineage'
    );
  let lastAt = graceful.startedAt;
  for (const point of ['beforeClose', 'afterClose']) {
    const observation = graceful[point];
    assert(
      observation?.observationOnly === true &&
        !observation.collectionFailed &&
        Number.isSafeInteger(observation.startedAt) &&
        observation.startedAt >= lastAt &&
        Number.isSafeInteger(observation.at) &&
        observation.at >= observation.startedAt &&
        observation.at <= graceful.completedAt &&
        Array.isArray(observation.known) &&
        observation.known.length <= LIMIT,
      'Incomplete shutdown history observation'
    );
    lastAt = observation.at;
    const known = scenarioProofIdentities(observation.known.map((record) => record.expected));
    assert(known.length === observation.known.length, 'Duplicate known shutdown identity');
    const descendants = scenarioProofIdentities(observation.descendants);
    if (!descendants.some((row) => key(row) === key(launcher))) {
      assert(descendants.length === 0, 'A retired launcher grants no new ancestry');
      rootRetirement(observation.rootRetirement, launcher, observation.startedAt, observation.at);
    }
    for (const row of [...known, ...descendants]) contains(ledger, row);
    const observedLineage = lineage(scenarioProofIdentities([launcher], descendants), launcher);
    assert(
      descendants.every((row) => observedLineage.has(key(row))),
      'Unproven shutdown descendant lineage'
    );
  }
  let rootObservationAt = graceful.afterClose.at;
  for (const point of ['lateRootRetirement', 'finalRootRetirement']) {
    if (graceful[point]) {
      rootRetirement(graceful[point], launcher, rootObservationAt, graceful.completedAt);
      rootObservationAt = graceful[point].at;
    }
  }
  // Read and verify the separate signal receipt, but never promote proof rows to it.
  for (const row of scenarioProofIdentities(signal)) contains(ledger, row);
  return {
    identities: scenarioProofIdentities(prior, ledger),
    notBefore: stoppedAt,
    binding,
    observationOnly: true,
    signalAuthorityExpanded: false,
  };
}

export function scenarioProofDrain(handoff, census, now) {
  assert(
    Number.isSafeInteger(census?.startedAt) &&
      census.startedAt >= handoff.notBefore &&
      Number.isSafeInteger(census.completedAt) &&
      census.completedAt >= census.startedAt &&
      Number.isSafeInteger(now) &&
      census.completedAt <= now,
    'Stale/incomplete final scenario census'
  );
  assert.deepEqual(census.ports, [9222], 'Scenario proof listener selection changed');
  const drain = windowsProofDrainSnapshot(handoff.identities, census);
  return {
    ...drain,
    listenerPids: [...new Set(drain.listeners.map((row) => row.pid))],
    remaining: drain.rows.filter((row) => !['absent', 'different-birth'].includes(row.state)),
  };
}

export function scenarioFinalHistory(drain, completedAt) {
  return {
    at: completedAt,
    records: drain.rows.map((row) => ({
      ...row,
      state:
        row.state === 'absent'
          ? 'absent-from-census'
          : row.state === 'different-birth'
            ? 'pid-reused'
            : row.state,
    })),
  };
}

export function carryScenarioProof(manifest, handoff) {
  assert(!manifest.proofHistoryUnavailable, 'Manifest proof history unavailable after stop');
  assert.deepEqual(
    scenarioProofBinding(manifest.root, manifest.run, manifest.launcher),
    handoff.binding,
    'Post-stop manifest changed scenario binding'
  );
  const current = scenarioProofIdentities(manifest.proofObservedProcesses);
  for (const row of current) contains(handoff.identities, row);
  // Preserve even a short-lived late child that disappeared before the final
  // manifest observation. This array remains proof-only across warm restarts.
  return scenarioProofIdentities(current, handoff.identities);
}
