import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ADMISSION_VALIDATOR_PATH,
  CONTRACT_VALIDATOR_PATH,
  materializeP1S0PreStartAdmission,
  P1_S0_OWNED_PATHS,
} from '../../../../scripts/hosted-web/orchestration/materialize-p1-s0-worker-start.mjs';
import { validateWorkerAdmission } from '../../../../scripts/hosted-web/orchestration/orchestration-state.mjs';
import { validateWorkerStartContract } from '../../../../scripts/hosted-web/orchestration/validate-worker-start.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const phaseStartSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();

function plannedInput(overrides = {}) {
  const jobRoot = path.join(tmpdir(), 'hosted-web-planned-p1-s0-job');
  return {
    jobId: 'agent-teams-hosted-web-refactor-p1-s0',
    workerId: 'agent-teams-hosted-web-refactor-p1-s0',
    jobRoot,
    workspaceRoot: repoRoot,
    promptPath: path.join(jobRoot, 'prompt.md'),
    expectedPhaseStartSha: phaseStartSha,
    ...overrides,
  };
}

test('purely emits deterministic runtime preStartAdmission for exact P1.S0', () => {
  const input = plannedInput();
  assert.equal(existsSync(input.jobRoot), false);

  const first = materializeP1S0PreStartAdmission(input);
  const second = materializeP1S0PreStartAdmission(input);

  assert.deepEqual(first, second);
  assert.equal(existsSync(input.jobRoot), false);
  assert.equal(first.contractValidatorPath, CONTRACT_VALIDATOR_PATH);
  assert.equal(first.admissionValidatorPath, ADMISSION_VALIDATOR_PATH);
  assert.equal(path.isAbsolute(first.contractValidatorPath), false);
  assert.equal(path.isAbsolute(first.admissionValidatorPath), false);
  assert.equal(first.contract.phaseId, 'phase-01');
  assert.equal(first.contract.laneId, 'p1-s0');
  assert.equal(first.contract.packetRevision, 'phase-01-s0-bootstrap-r1');
  assert.equal(first.contract.phaseStartSha, phaseStartSha);
  assert.deepEqual(first.contract.ownedPaths, P1_S0_OWNED_PATHS);
  assert.equal(first.state.records.length, 1);
  assert.equal(first.state.records[0].status, 'queued');
  assert.equal(first.state.records[0].workKey, first.contract.workKey);
  assert.match(
    first.contract.requiredChecks[0].command,
    /pre-start-admission\/contract\.json.*pre-start-admission\/state\.json/
  );
  assert.deepEqual(validateWorkerStartContract(first.contract, { checkFilesystem: false }), {
    ok: true,
    issues: [],
  });
  assert.deepEqual(
    validateWorkerAdmission(first.contract, first.state, { checkFilesystem: false }),
    { ok: true, issues: [] }
  );
});

test('fails closed on stale expected workspace HEAD without creating job material', () => {
  const input = plannedInput({ expectedPhaseStartSha: '0'.repeat(40) });
  assert.throws(
    () => materializeP1S0PreStartAdmission(input),
    /materializerInput:workspace_head_expected:/
  );
  assert.equal(existsSync(input.jobRoot), false);
});

test('fails closed when planned prompt is outside the runtime job root', () => {
  const input = plannedInput({ promptPath: path.join(tmpdir(), 'outside-prompt.md') });
  assert.throws(
    () => materializeP1S0PreStartAdmission(input),
    /materializerInput:prompt_outside_jobRoot/
  );
  assert.equal(existsSync(input.jobRoot), false);
});

test('fails closed on overlapping runtime and workspace roots', () => {
  const jobRoot = path.join(repoRoot, '.runtime-job');
  const input = plannedInput({ jobRoot, promptPath: path.join(jobRoot, 'prompt.md') });
  assert.throws(
    () => materializeP1S0PreStartAdmission(input),
    /materializerInput:jobRoot_workspaceRoot_overlap/
  );
});

test('rejects untrusted input extensions', () => {
  const input = plannedInput({ registryPath: '/tmp/raw-registry.json' });
  assert.throws(
    () => materializeP1S0PreStartAdmission(input),
    /materializerInput:unexpected_field:registryPath/
  );
  assert.equal(existsSync(input.jobRoot), false);
});
