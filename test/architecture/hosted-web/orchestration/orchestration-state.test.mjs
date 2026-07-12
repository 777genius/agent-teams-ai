import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANONICAL_SHA,
  computeWorkKey,
} from '../../../../scripts/hosted-web/orchestration/contract-lib.mjs';
import {
  admitInitialWork,
  applyAtomicRefill,
  createInitialState,
  validateOrchestrationState,
  validateWorkerAdmission,
} from '../../../../scripts/hosted-web/orchestration/orchestration-state.mjs';

const request = {
  jobId: 'hosted-web-contract-test',
  workerId: 'worker-1',
  phaseId: 'phase-00',
  laneId: 'w1',
  baseSha: CANONICAL_SHA,
  phaseStartSha: CANONICAL_SHA,
  packetRevision: 'phase-00-r2',
  controllerPacket: 'docs/hosted-web-phase-0-execution-packet.md',
  lanePacket: 'docs/hosted-web-phases/phase-00/lanes/w1-parity-renderer.md',
  inputPatchHash: 'b'.repeat(64),
  reviewKind: 'implementation',
};

function admitted(maxRetries = 2) {
  return admitInitialWork(createInitialState(maxRetries), request);
}

function withStatus(state, status) {
  return { ...state, records: state.records.map((record) => ({ ...record, status })) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function workerContract(state = admitted()) {
  const record = state.records.at(-1);
  return {
    schemaVersion: 1,
    jobId: record.jobId,
    workerId: record.workerId,
    canonicalSha: CANONICAL_SHA,
    baseSha: record.baseSha,
    phaseStartSha: record.phaseStartSha,
    packetRevision: record.packetRevision,
    controllerPacket: record.controllerPacket,
    lanePacket: record.lanePacket,
    phaseId: record.phaseId,
    laneId: record.laneId,
    inputPatchHash: record.inputPatchHash,
    reviewKind: record.reviewKind,
    revision: record.revision,
    retryCount: record.retryCount,
    workKey: record.workKey,
    supersedes: record.supersedes,
    registryStatus: 'queued',
    jobRoot: '/tmp/hosted-web-contract-test',
    workspaceRoot: '/tmp/hosted-web-workspace-test',
    promptPath: '/tmp/hosted-web-contract-test/prompt.md',
    ownedPaths: ['docs/hosted-web-phases/START_HERE.md'],
    mandatoryDocs: [
      'AGENTS.md',
      'CLAUDE.md',
      'AGENT_CRITICAL_GUARDRAILS.md',
      'docs/hosted-web-phases/START_HERE.md',
      'docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md',
      'docs/hosted-web-phases/README.md',
      'docs/hosted-web-phases/EXECUTION_INDEX.json',
      'docs/hosted-web-phases/ORCHESTRATION_GUARDS.md',
      record.controllerPacket,
      record.lanePacket,
    ],
    mandatoryScripts: ['scripts/hosted-web/orchestration/validate-worker-admission.mjs'],
    mandatoryFixtures: ['test/architecture/hosted-web/orchestration/fixtures/input-fixture.json'],
    requiredChecks: [{ id: 'focused', cwd: 'test', command: 'node --test focused.mjs' }],
    executionPolicy: {
      mode: 'sandbox-only',
      sandboxRoot: '/tmp/hosted-web-workspace-test/sandbox',
      forbiddenRealProjects: ['~/dev/projects/ai/claude-runtime'],
    },
  };
}

test('workKey deterministically includes every identity component', () => {
  const work = { ...request, revision: 0 };
  assert.equal(computeWorkKey(work), computeWorkKey({ ...work }));
  for (const [field, value] of [
    ['phaseId', 'phase-02'],
    ['laneId', 'review'],
    ['baseSha', '0'.repeat(40)],
    ['phaseStartSha', '1'.repeat(40)],
    ['packetRevision', 'phase-00-r3'],
    ['inputPatchHash', 'c'.repeat(64)],
    ['reviewKind', 'review'],
    ['revision', 1],
  ]) {
    assert.notEqual(computeWorkKey(work), computeWorkKey({ ...work, [field]: value }), field);
  }
});

test('rejects duplicate in-flight and terminal work keys', () => {
  for (const status of ['running', 'verified']) {
    const state = admitted();
    const duplicate = { ...state.records[0], status };
    state.records.push(duplicate);
    const result = validateOrchestrationState(state);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((issue) => issue.startsWith('duplicate_workKey:')),
      status
    );
  }
});

test('initial admission rejects an already admitted deterministic key', () => {
  const state = admitted();
  assert.throws(() => admitInitialWork(state, request), /duplicate workKey rejected/);
});

test('atomic refill preserves identity, increments retry/revision, and leaves input unchanged', () => {
  const terminal = withStatus(admitted(), 'failed');
  const snapshot = clone(terminal);
  const refilled = applyAtomicRefill(terminal, terminal.records[0].workKey);
  assert.deepEqual(terminal, snapshot);
  assert.equal(refilled.records.length, 2);
  const [predecessor, successor] = refilled.records;
  assert.equal(predecessor.status, 'superseded');
  assert.equal(predecessor.supersededBy, successor.workKey);
  assert.equal(successor.supersedes, predecessor.workKey);
  assert.equal(successor.revision, 1);
  assert.equal(successor.retryCount, 1);
  assert.deepEqual(validateOrchestrationState(refilled), { ok: true, issues: [] });
});

test('refill rejects non-terminal, successful, and already-superseded predecessors', () => {
  const running = withStatus(admitted(), 'running');
  assert.throws(
    () => applyAtomicRefill(running, running.records[0].workKey),
    /not failed or blocked/
  );
  const verified = withStatus(admitted(), 'verified');
  assert.throws(
    () => applyAtomicRefill(verified, verified.records[0].workKey),
    /not failed or blocked/
  );

  const failed = withStatus(admitted(), 'failed');
  const refilled = applyAtomicRefill(failed, failed.records[0].workKey);
  assert.throws(
    () => applyAtomicRefill(refilled, failed.records[0].workKey),
    /not failed or blocked/
  );
});

test('max retry policy rejects another refill at the limit', () => {
  const failed = withStatus(admitted(1), 'failed');
  const once = applyAtomicRefill(failed, failed.records[0].workKey);
  const successorKey = once.records[1].workKey;
  const terminalAgain = {
    ...once,
    records: once.records.map((record) =>
      record.workKey === successorKey ? { ...record, status: 'blocked' } : record
    ),
  };
  assert.throws(() => applyAtomicRefill(terminalAgain, successorKey), /max retries reached: 1\/1/);
});

test('atomic refill rejects launch when another worker consumes the configured capacity', () => {
  let state = admitInitialWork(createInitialState(2, 2), request);
  state = admitInitialWork(state, {
    ...request,
    jobId: 'other-job',
    workerId: 'worker-2',
    laneId: 'w2',
    lanePacket: 'docs/hosted-web-phases/phase-00/lanes/w2-provider-runtime.md',
  });
  const predecessorKey = state.records[0].workKey;
  state = {
    ...state,
    maxInFlight: 1,
    records: state.records.map((record, index) => ({
      ...record,
      status: index === 0 ? 'failed' : 'running',
    })),
  };
  assert.deepEqual(validateOrchestrationState(state), { ok: true, issues: [] });
  assert.throws(() => applyAtomicRefill(state, predecessorKey), /refill capacity exhausted: 1\/1/);
});

test('combined admission accepts the exact Phase 0 and P1.S0 authorities', () => {
  const requests = [
    request,
    {
      ...request,
      jobId: 'hosted-web-p1-s0-test',
      phaseId: 'phase-01',
      laneId: 'p1-s0',
      packetRevision: 'phase-01-s0-bootstrap-r1',
      controllerPacket: 'docs/hosted-web-phases/phase-01/controller-packet.md',
      lanePacket: 'docs/hosted-web-phases/phase-01/lanes/p1-s0-serial-bootstrap.md',
    },
  ];

  for (const admissionRequest of requests) {
    const state = admitInitialWork(createInitialState(), admissionRequest);
    const contract = workerContract(state);
    assert.deepEqual(validateWorkerAdmission(contract, state, { checkFilesystem: false }), {
      ok: true,
      issues: [],
    });
  }
});

test('combined admission requires exactly one queued record with exact worker identity', () => {
  const state = admitted();
  const contract = workerContract(state);

  const empty = createInitialState();
  const missing = validateWorkerAdmission(contract, empty, { checkFilesystem: false });
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.includes('admission:workKey_match_count_expected_1:actual:0'));

  const wrongIdentity = { ...contract, workerId: 'different-worker' };
  const mismatched = validateWorkerAdmission(wrongIdentity, state, { checkFilesystem: false });
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.issues.includes('admission:identity_mismatch:workerId'));

  const terminalState = withStatus(state, 'verified');
  const terminal = validateWorkerAdmission(contract, terminalState, { checkFilesystem: false });
  assert.equal(terminal.ok, false);
  assert.ok(terminal.issues.some((issue) => issue.startsWith('admission:status_not_launchable:')));
});

test('rejects non-reciprocal, identity-changing supersession chains', () => {
  const failed = withStatus(admitted(), 'failed');
  const refilled = applyAtomicRefill(failed, failed.records[0].workKey);
  const successor = refilled.records[1];
  successor.laneId = 'different-lane';
  successor.workKey = computeWorkKey(successor);
  const result = validateOrchestrationState(refilled);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.startsWith('supersession:')));
});
