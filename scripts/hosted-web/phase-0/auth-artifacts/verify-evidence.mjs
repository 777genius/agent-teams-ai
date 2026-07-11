#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evaluateHostedArtifactContract,
  evaluateV1TerminalAbsence,
  repoRoot,
  runAbiSmokeProbe,
  scanStandalone,
  validateStandaloneCharacterizationProjection,
} from './auth-artifacts-spike.mjs';
import {
  controllerArtifactContractSha256,
  loadControllerArtifactContract,
  validateControllerArtifactProjection,
} from '../w4-w6-contract/controller-artifact-contract.mjs';

const localRequire = createRequire(import.meta.url);
const requireFromFastify = createRequire(localRequire.resolve('fastify/package.json'));
const Ajv = requireFromFastify('ajv');
const evidenceDir = resolve(repoRoot, 'docs/research/hosted-web/phase-0/auth-artifacts');
const readJson = (path) => JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));

const schema = readJson('docs/research/hosted-web/phase-0/auth-artifacts/evidence.schema.json');
const validateEvidence = new Ajv({ allErrors: true, jsonPointers: true }).compile(schema);
for (const file of [
  'evidence.json',
  'estimate-input.json',
  'observed-artifact-scan.json',
  'proposed-hosted-artifact-manifest.json',
  'finding-resolution.json',
]) {
  const value = JSON.parse(readFileSync(resolve(evidenceDir, file), 'utf8'));
  if (!validateEvidence(value)) {
    throw new Error(`${file}: ${JSON.stringify(validateEvidence.errors)}`);
  }
}

const controllerSchema = readJson(
  'docs/research/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.schema.json'
);
const validateController = new Ajv({ allErrors: true }).compile(controllerSchema);
const controller = loadControllerArtifactContract();
if (!validateController(controller)) {
  throw new Error(`controller artifact contract: ${JSON.stringify(validateController.errors)}`);
}

const evidence = readJson('docs/research/hosted-web/phase-0/auth-artifacts/evidence.json');
const expectedIds = [
  'P0.W6.AUTH_TRANSITIONS',
  'P0.W6.PROXY_ORIGIN_THREAT_MATRIX',
  'P0.W6.COOKIE_VERSION_EVIDENCE',
  'P0.W6.ARTIFACT_INVENTORY',
  'P0.W6.ABI_STUB_REPORT',
  'P0.W6.TERMINAL_ABSENCE_REPORT',
  'P0.W6.ESTIMATE',
].sort();
if (JSON.stringify(evidence.evidence.map(({ id }) => id).sort()) !== JSON.stringify(expectedIds)) {
  throw new Error('W6 evidence IDs differ');
}
if (evidence.packetRevision !== 'phase-00-r3') throw new Error('W6 evidence is not r3');
for (const row of evidence.evidence) {
  if (
    row.owner !== 'w6' ||
    !row.requirementIds?.length ||
    !row.assertions?.length ||
    !row.reproduction?.length
  ) {
    throw new Error(`${row.id}: incomplete evidence shape`);
  }
}

const w4Projection = readJson(
  'docs/research/hosted-web/phase-0/host-primitives/native-artifact-contract.json'
);
const w6Projection = readJson(
  'docs/research/hosted-web/phase-0/auth-artifacts/proposed-hosted-artifact-manifest.json'
);
const controllerHash = controllerArtifactContractSha256();
for (const [lane, projection] of [
  ['w4', w4Projection],
  ['w6', w6Projection],
]) {
  const result = validateControllerArtifactProjection(controller, projection);
  if (!result.ok) throw new Error(`${lane} projection drift: ${result.violations.join(',')}`);
}
if (JSON.stringify(w4Projection.artifacts) !== JSON.stringify(w6Projection.artifacts)) {
  throw new Error('W4/W6 artifact projections are not equal');
}
const artifactGate = evaluateHostedArtifactContract(w6Projection);
if (!artifactGate.contractPasses || artifactGate.releasePasses || artifactGate.hostedV1Admitted) {
  throw new Error(`r3 artifact disposition mismatch: ${JSON.stringify(artifactGate)}`);
}

const committedScan = readJson(
  'docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json'
);
const sourceScan = scanStandalone(repoRoot);
if (JSON.stringify(committedScan.source) !== JSON.stringify(sourceScan.source)) {
  throw new Error('standalone source characterization is stale');
}
if (sourceScan.emitted.observed || sourceScan.emitted.files.length !== 0) {
  throw new Error('source characterization consulted mutable ambient standalone output');
}
const standaloneProjection = validateStandaloneCharacterizationProjection(
  committedScan,
  w6Projection.currentStandalone
);
if (!standaloneProjection.ok) {
  throw new Error(
    `standalone characterization drift: ${standaloneProjection.violations.join(',')}`
  );
}
const inventoryEvidence = evidence.evidence.find(({ id }) => id === 'P0.W6.ARTIFACT_INVENTORY');
if (
  JSON.stringify(inventoryEvidence?.facts?.characterizationAuthority) !==
  JSON.stringify(standaloneProjection.expected)
) {
  throw new Error('W6 artifact evidence disagrees with standalone characterization authority');
}
if (
  committedScan.emitted.observed !== true ||
  committedScan.emitted.files.length === 0 ||
  committedScan.emitted.internalStorageWorkerPresent !== false ||
  committedScan.emitted.electronEmptyStubPresent !== true ||
  committedScan.emitted.terminalServiceMarkerPresent !== true
) {
  throw new Error('committed targeted standalone-build characterization is incomplete');
}
if (evaluateV1TerminalAbsence(committedScan).passes) {
  throw new Error('current standalone unexpectedly satisfies the terminal-absence rule');
}

const abiProbe = runAbiSmokeProbe();
if (
  abiProbe.runtime.nodeModuleAbi !== 137 ||
  abiProbe.runtime.electronModuleAbi !== 143 ||
  abiProbe.sqlite.some(({ packageName, reopenedValue }) => packageName !== reopenedValue)
) {
  throw new Error(`ABI characterization mismatch: ${JSON.stringify(abiProbe)}`);
}

const handoff = readJson('.codex-handoff/phase-00-w6.json');
if (
  handoff.schemaVersion !== 2 ||
  handoff.taskId !== 'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v7' ||
  handoff.jobId !== handoff.taskId ||
  handoff.packetRevision !== 'phase-00-r3' ||
  handoff.baseSha !== 'f7d98790eb868714e536f77bd796072ea706911a' ||
  handoff.canonicalBaseSha !== 'f7d98790eb868714e536f77bd796072ea706911a' ||
  handoff.sourceWorktree !==
    '/var/data/agent-teams-hosted-web-refactor/worktrees/phase-00-remediation-w4-w6-v7' ||
  handoff.remediationProvenance?.approvedV6ReviewSha256 !==
    '5c4c0ed2792df575dfd74c3a197ff00af6ed2abcc001dd815c39e70a87f7ed7a' ||
  handoff.remediationProvenance?.supersedingReviewRecordSha256 !==
    'b68ad9f064e622edc64e96194bd00bea42b5c31467a0503b58b8e826911eaa8b' ||
  handoff.remediationProvenance?.rejectedIntegrationArchiveSha256 !==
    '1b49a4f0745b5e67fe8d56c97174ae55af4d9c5edb006112440b467bc9cea1dc' ||
  handoff.remediationProvenance?.v6PreservedPatchSha256 !==
    '479f78a3a89a7e132899ede39a7606c59ce9b201ebe04d97df281e3a4825f690' ||
  handoff.salvage?.sourceTaskId !==
    'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v5' ||
  handoff.salvage?.preservedPatch !==
    '/var/data/agent-teams-hosted-web-refactor/worker-jobs/jobs/agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v5/agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v5.preserved.patch' ||
  handoff.salvage?.preservedPatchSha256 !==
    '183069adf05cb254c846cbd37a7c39ac930b2cb5dd6994f6b5b96dc5d4304d79' ||
  handoff.salvage?.independentlyVerified !== true ||
  handoff.headVerifiedBeforeEdits !== true ||
  handoff.status !== 'characterized'
) {
  throw new Error('W6 handoff provenance/status is stale');
}
if (
  Object.values(handoff.scope).some((value) => value !== false && typeof value === 'boolean') ||
  handoff.scope.disposition !== 'standalone_artifact_rejected_for_hosted_v1'
) {
  throw new Error('W6 handoff overstates r3 admission');
}

const checkedPaths = [
  '.codex-handoff/phase-00-w6.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/estimate-input.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/evidence.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/evidence.schema.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/finding-resolution.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/proposed-hosted-artifact-manifest.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/report.md',
  'docs/research/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.json',
  'docs/research/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.schema.json',
  'scripts/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.mjs',
  'scripts/hosted-web/phase-0/auth-artifacts/verify-evidence.mjs',
  'scripts/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.mjs',
  'test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts',
  'test/architecture/hosted-web/phase-0/w4-w6-contract/artifact-contract.test.ts',
];
const serialized = checkedPaths
  .map((path) => readFileSync(resolve(repoRoot, path), 'utf8'))
  .join('\n');
for (const pattern of [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~-]+/,
  /\b(?:sk|ghp)_[A-Za-z0-9]{12,}/,
  /\/(?:Users|home)\/[A-Za-z0-9._-]+\//,
]) {
  if (pattern.test(serialized)) throw new Error(`sensitive-looking value matched ${pattern}`);
}

process.stdout.write(
  `W6 r3 evidence, exact W4 DTO/artifact consumption, reset admission, current standalone rejection, terminal rule, ABI characterization and provenance passed (controller ${controllerHash})\n`
);
