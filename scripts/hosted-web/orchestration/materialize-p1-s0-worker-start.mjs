#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CANONICAL_SHA,
  computeWorkKey,
  formatIssues,
  parseCliArgs,
  sha256Bytes,
} from './contract-lib.mjs';
import {
  admitInitialWork,
  createInitialState,
  validateWorkerAdmission,
} from './orchestration-state.mjs';
import { validateWorkerStartContract } from './validate-worker-start.mjs';

export const CONTRACT_VALIDATOR_PATH = 'scripts/hosted-web/orchestration/validate-worker-start.mjs';
export const ADMISSION_VALIDATOR_PATH =
  'scripts/hosted-web/orchestration/validate-worker-admission.mjs';
export const P1_S0_OWNED_PATHS = Object.freeze([
  'docs/research/hosted-web/phase-1/bootstrap/phase-start.json',
  'docs/research/hosted-web/phase-1/bootstrap/packet-revision.json',
  'docs/research/hosted-web/phase-1/bootstrap/ownership-manifest.json',
  'docs/research/hosted-web/phase-1/bootstrap/baseline-fingerprints.json',
  'docs/research/hosted-web/phase-1/bootstrap/estimate-allocation.json',
  'docs/research/hosted-web/phase-1/bootstrap/bootstrap-report.md',
]);

const CONTROLLER_PACKET = 'docs/hosted-web-phases/phase-01/controller-packet.md';
const LANE_PACKET = 'docs/hosted-web-phases/phase-01/lanes/p1-s0-serial-bootstrap.md';
const PACKET_REVISION = 'phase-01-s0-bootstrap-r1';
const EMPTY_INPUT_PATCH_HASH = sha256Bytes('');
const CONTRACT_ARTIFACT = 'pre-start-admission/contract.json';
const STATE_ARTIFACT = 'pre-start-admission/state.json';

const MANDATORY_DOCS = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'AGENT_CRITICAL_GUARDRAILS.md',
  'docs/hosted-web-phases/START_HERE.md',
  'docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md',
  'docs/hosted-web-phases/README.md',
  'docs/hosted-web-phases/EXECUTION_INDEX.json',
  'docs/hosted-web-phases/ORCHESTRATION_GUARDS.md',
  CONTROLLER_PACKET,
  LANE_PACKET,
  'docs/hosted-web-phases/phase-01/packet-inputs.md',
  'docs/hosted-web-phases/phase-01/architecture-and-contracts.md',
  'docs/hosted-web-phases/phase-01/execution-dag.md',
  'docs/hosted-web-phases/phase-01/conformance-and-tests.md',
  'docs/hosted-web-phases/phase-01/operations-and-risk.md',
  'docs/hosted-web-phases/phase-01/execution-packet-templates.md',
  'docs/research/hosted-web/phase-0/freeze/current-canonical/README.md',
]);

const MANDATORY_SCRIPTS = Object.freeze([
  CONTRACT_VALIDATOR_PATH,
  ADMISSION_VALIDATOR_PATH,
  'docs/research/hosted-web/phase-0/freeze/current-canonical/verify-indexes.mjs',
  'docs/research/hosted-web/phase-0/estimate-reconciliation/verify-ledger.mjs',
  'test/architecture/hosted-web/orchestration/worker-start-contract.test.mjs',
  'test/architecture/hosted-web/orchestration/orchestration-state.test.mjs',
]);

const MANDATORY_FIXTURES = Object.freeze([
  'docs/research/hosted-web/phase-0/freeze/current-canonical/decision-index.json',
  'docs/research/hosted-web/phase-0/freeze/current-canonical/evidence-index.json',
  'docs/research/hosted-web/phase-0/freeze/current-canonical/lane-identity-index.json',
  'docs/research/hosted-web/phase-0/freeze/current-canonical/review-disposition-index.json',
]);

const REQUIRED_INPUTS = Object.freeze([
  'jobId',
  'workerId',
  'jobRoot',
  'workspaceRoot',
  'promptPath',
  'expectedPhaseStartSha',
]);

function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function normalizeAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label}:absolute_path_required`);
  }
  return path.resolve(value);
}

function validateInputs(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('materializerInput:object_required');
  }
  for (const field of Object.keys(input)) {
    if (!REQUIRED_INPUTS.includes(field))
      throw new Error(`materializerInput:unexpected_field:${field}`);
  }
  for (const field of REQUIRED_INPUTS) {
    if (!(field in input)) throw new Error(`materializerInput:missing_field:${field}`);
  }
  for (const field of ['jobId', 'workerId']) {
    if (typeof input[field] !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(input[field])) {
      throw new Error(`materializerInput:${field}_invalid`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(input.expectedPhaseStartSha ?? '')) {
    throw new Error('materializerInput:expectedPhaseStartSha_invalid');
  }

  const jobRoot = normalizeAbsolute(input.jobRoot, 'materializerInput:jobRoot');
  const workspaceRootInput = normalizeAbsolute(
    input.workspaceRoot,
    'materializerInput:workspaceRoot'
  );
  const promptPath = normalizeAbsolute(input.promptPath, 'materializerInput:promptPath');
  const workspaceRoot = realpathSync(workspaceRootInput);
  if (!statSync(workspaceRoot).isDirectory()) {
    throw new Error('materializerInput:workspaceRoot_directory_required');
  }
  if (!containedBy(jobRoot, promptPath)) {
    throw new Error('materializerInput:prompt_outside_jobRoot');
  }
  if (containedBy(jobRoot, workspaceRoot) || containedBy(workspaceRoot, jobRoot)) {
    throw new Error('materializerInput:jobRoot_workspaceRoot_overlap');
  }

  const phaseStartSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (phaseStartSha !== input.expectedPhaseStartSha) {
    throw new Error(
      `materializerInput:workspace_head_expected:${input.expectedPhaseStartSha}:actual:${phaseStartSha}`
    );
  }
  return { jobRoot, workspaceRoot, promptPath, phaseStartSha };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function requiredChecks({ jobRoot, phaseStartSha }) {
  const cwd = 'scripts/hosted-web/orchestration';
  const contractPath = path.join(jobRoot, CONTRACT_ARTIFACT);
  const statePath = path.join(jobRoot, STATE_ARTIFACT);
  const outputs = P1_S0_OWNED_PATHS.map((item) => `../../../${item}`).join(' ');
  return [
    {
      id: 'worker-admission',
      cwd,
      command: `node validate-worker-admission.mjs --contract ${shellQuote(contractPath)} --state ${shellQuote(statePath)}`,
    },
    {
      id: 'phase-0-freeze-indexes',
      cwd,
      command:
        'node ../../../docs/research/hosted-web/phase-0/freeze/current-canonical/verify-indexes.mjs',
    },
    {
      id: 'phase-0-estimate-ledger',
      cwd,
      command:
        'node ../../../docs/research/hosted-web/phase-0/estimate-reconciliation/verify-ledger.mjs',
    },
    {
      id: 'orchestration-contract-focused',
      cwd,
      command:
        'node --test ../../../test/architecture/hosted-web/orchestration/worker-start-contract.test.mjs ../../../test/architecture/hosted-web/orchestration/orchestration-state.test.mjs',
    },
    {
      id: 'exact-prettier',
      cwd,
      command: `pnpm exec prettier --check ${outputs}`,
    },
    {
      id: 'diff-check',
      cwd,
      command: `git diff --check ${phaseStartSha} -- ${outputs}`,
    },
  ];
}

export function materializeP1S0PreStartAdmission(input) {
  const resolved = validateInputs(input);
  const request = {
    jobId: input.jobId,
    workerId: input.workerId,
    phaseId: 'phase-01',
    laneId: 'p1-s0',
    baseSha: CANONICAL_SHA,
    phaseStartSha: resolved.phaseStartSha,
    packetRevision: PACKET_REVISION,
    controllerPacket: CONTROLLER_PACKET,
    lanePacket: LANE_PACKET,
    inputPatchHash: EMPTY_INPUT_PATCH_HASH,
    reviewKind: 'implementation',
  };
  const state = admitInitialWork(createInitialState(0, 1), request);
  const record = state.records[0];
  const contract = {
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
    workKey: computeWorkKey(record),
    supersedes: record.supersedes,
    registryStatus: record.status,
    jobRoot: resolved.jobRoot,
    workspaceRoot: resolved.workspaceRoot,
    promptPath: resolved.promptPath,
    ownedPaths: [...P1_S0_OWNED_PATHS],
    mandatoryDocs: [...MANDATORY_DOCS],
    mandatoryScripts: [...MANDATORY_SCRIPTS],
    mandatoryFixtures: [...MANDATORY_FIXTURES],
    requiredChecks: requiredChecks(resolved),
    executionPolicy: {
      mode: 'sandbox-only',
      sandboxRoot: resolved.workspaceRoot,
      forbiddenRealProjects: ['~/dev/projects/ai/claude-runtime'],
    },
  };
  const startResult = validateWorkerStartContract(contract, { checkFilesystem: false });
  if (!startResult.ok) throw new Error(formatIssues('worker-start validation', startResult.issues));
  const admissionResult = validateWorkerAdmission(contract, state, { checkFilesystem: false });
  if (!admissionResult.ok) {
    throw new Error(formatIssues('worker admission', admissionResult.issues));
  }
  return {
    contractValidatorPath: CONTRACT_VALIDATOR_PATH,
    admissionValidatorPath: ADMISSION_VALIDATOR_PATH,
    contract,
    state,
  };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2), [
    'job-id',
    'worker-id',
    'job-root',
    'workspace-root',
    'prompt-path',
    'expected-phase-start-sha',
  ]);
  const result = materializeP1S0PreStartAdmission({
    jobId: args['job-id'],
    workerId: args['worker-id'],
    jobRoot: args['job-root'],
    workspaceRoot: args['workspace-root'],
    promptPath: args['prompt-path'],
    expectedPhaseStartSha: args['expected-phase-start-sha'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
