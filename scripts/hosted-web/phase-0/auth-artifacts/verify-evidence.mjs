#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evaluateFinalImageTerminalAbsence,
  evaluateHostedArtifactContract,
  repoRoot,
  runAbiSmokeProbe,
  scanStandalone,
} from './auth-artifacts-spike.mjs';

const localRequire = createRequire(import.meta.url);
const requireFromFastify = createRequire(localRequire.resolve('fastify/package.json'));
const Ajv = requireFromFastify('ajv');
const evidenceDir = resolve(repoRoot, 'docs/research/hosted-web/phase-0/auth-artifacts');
const expectedChangedPaths = [
  '.codex-handoff/phase-00-w6.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/estimate-input.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/evidence.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/evidence.schema.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/finding-resolution.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/proposed-hosted-artifact-manifest.json',
  'docs/research/hosted-web/phase-0/auth-artifacts/report.md',
  'scripts/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.mjs',
  'scripts/hosted-web/phase-0/auth-artifacts/verify-evidence.mjs',
  'test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts',
].sort();
const schema = JSON.parse(readFileSync(resolve(evidenceDir, 'evidence.schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, jsonPointers: true }).compile(schema);
const files = [
  'evidence.json',
  'estimate-input.json',
  'observed-artifact-scan.json',
  'proposed-hosted-artifact-manifest.json',
  'finding-resolution.json',
];
const expectedIds = [
  'P0.W6.AUTH_TRANSITIONS',
  'P0.W6.PROXY_ORIGIN_THREAT_MATRIX',
  'P0.W6.COOKIE_VERSION_EVIDENCE',
  'P0.W6.ARTIFACT_INVENTORY',
  'P0.W6.ABI_STUB_REPORT',
  'P0.W6.TERMINAL_ABSENCE_REPORT',
  'P0.W6.ESTIMATE',
].sort();

for (const file of files) {
  const value = JSON.parse(readFileSync(resolve(evidenceDir, file), 'utf8'));
  if (!validate(value)) throw new Error(`${file}: ${JSON.stringify(validate.errors)}`);
}

const evidence = JSON.parse(readFileSync(resolve(evidenceDir, 'evidence.json'), 'utf8'));
const actualIds = evidence.evidence.map(({ id }) => id).sort();
if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
  throw new Error(`evidence IDs differ: ${JSON.stringify(actualIds)}`);
}

for (const row of evidence.evidence) {
  if (row.owner !== 'w6') throw new Error(`${row.id}: missing W6 owner`);
  if (!row.requirementIds?.length || !row.assertions?.length || !row.reproduction?.length) {
    throw new Error(`${row.id}: incomplete acceptance evidence shape`);
  }
}

const contract = JSON.parse(
  readFileSync(resolve(evidenceDir, 'proposed-hosted-artifact-manifest.json'), 'utf8')
);
const contractGate = evaluateHostedArtifactContract(contract);
if (!contractGate.contractPasses || contractGate.releasePasses) {
  throw new Error(`artifact contract gate mismatch: ${JSON.stringify(contractGate)}`);
}
const processAnchorRow = contract.artifacts.find(({ id }) => id === 'agent-teams-process-anchor');
for (const field of [
  'protocolManifestPath',
  'protocolSha256',
  'spikeSourcePath',
  'spikeSourceSha256',
  'buildRecipeId',
  'builderImageDigest',
  'compilerIdentity',
  'targetAbi',
  'uid',
  'gid',
  'mode',
  'stripped',
  'twoCleanBuildsMatch',
  'imageOrder',
  'seccompProbe',
  'abiLoadProbe',
]) {
  const omitted = structuredClone(contract);
  delete omitted.artifacts.find(({ id }) => id === 'agent-teams-process-anchor')[field];
  if (evaluateHostedArtifactContract(omitted).contractPasses) {
    throw new Error(`artifact contract accepted omitted process-anchor ${field}`);
  }
}
if (processAnchorRow.targetPath !== '/opt/agent-teams/bin/agent-teams-process-anchor') {
  throw new Error('process-anchor final path does not match the W4 contract');
}
for (const field of [
  'compilerPresent',
  'sourcePresent',
  'headersPresent',
  'objectFilesPresent',
  'buildCachePresent',
]) {
  const omitted = structuredClone(contract);
  delete omitted.finalImageEvidence[field];
  if (evaluateHostedArtifactContract(omitted).contractPasses) {
    throw new Error(`artifact contract accepted omitted final-image ${field}`);
  }
}
const oldPath = structuredClone(contract);
oldPath.artifacts.find(({ id }) => id === 'agent-teams-instance-lock').targetPath =
  '/app/bin/agent-teams-instance-lock';
if (evaluateHostedArtifactContract(oldPath).contractPasses) {
  throw new Error('artifact contract accepted the superseded W6 native path');
}
for (const id of [
  'agent-teams-instance-lock',
  'agent-teams-workspace-guard',
  'agent-teams-process-anchor',
]) {
  const row = contract.artifacts.find((artifact) => artifact.id === id);
  if (row?.producerOwner !== 'w4' || row.packagingOwner !== 'w6') {
    throw new Error(`${id}: W4/W6 ownership is not explicit`);
  }
}

const cleanImageFixture = {
  packages: ['fastify', 'better-sqlite3'],
  files: contract.artifacts.map(({ targetPath }) => targetPath),
  routes: ['/api/hosted/v1/meta'],
  migrations: ['001_coordination'],
  capabilities: ['teams.read'],
  processes: ['agent-teams-instance-lock', 'node'],
  rendererChunks: ['team-console.js'],
  ports: ['443/tcp'],
  volumes: ['/app/state'],
};
if (!evaluateFinalImageTerminalAbsence(cleanImageFixture).passes) {
  throw new Error('clean terminal-negative final-image fixture failed');
}
if (
  evaluateFinalImageTerminalAbsence({
    ...cleanImageFixture,
    routes: [...cleanImageFixture.routes, '/api/terminal/ws'],
  }).passes
) {
  throw new Error('deliberate terminal-route negative fixture passed');
}

const abiProbe = runAbiSmokeProbe();
if (
  abiProbe.runtime.nodeModuleAbi !== 137 ||
  abiProbe.runtime.electronModuleAbi !== 143 ||
  abiProbe.sqlite.some(({ packageName, reopenedValue }) => packageName !== reopenedValue)
) {
  throw new Error(`ABI/SQLite probe mismatch: ${JSON.stringify(abiProbe)}`);
}

const resolutions = JSON.parse(
  readFileSync(resolve(evidenceDir, 'finding-resolution.json'), 'utf8')
);
const expectedReviewFindings = ['R46-01', 'R46-02', 'R46-06', 'R46-07', 'R46-08'];
if (
  JSON.stringify(resolutions.reviewFindings.map(({ id }) => id).sort()) !==
  JSON.stringify(expectedReviewFindings)
) {
  throw new Error('W6 review finding resolution set is incomplete');
}
if (resolutions.requirements.length !== 8)
  throw new Error('W6 requirement resolution set is incomplete');

const handoff = JSON.parse(
  readFileSync(resolve(repoRoot, '.codex-handoff/phase-00-w6.json'), 'utf8')
);
if (
  handoff.taskId !== 'agent-teams-hosted-web-refactor-phase-00-remediation-w6-v3' ||
  handoff.baseSha !== '648bebed68f5a64c984e83b441e14dd7c587c403' ||
  handoff.headVerifiedBeforeEdits !== true ||
  handoff.status !== 'ready_for_focused_re_review'
) {
  throw new Error('W6 remediation handoff identity/status is stale');
}
if (JSON.stringify([...handoff.changedPaths].sort()) !== JSON.stringify(expectedChangedPaths)) {
  throw new Error('W6 remediation handoff changedPaths is incomplete or contains extra paths');
}

const committedScan = JSON.parse(
  readFileSync(resolve(evidenceDir, 'observed-artifact-scan.json'), 'utf8')
);
const currentScan = scanStandalone(repoRoot);
if (JSON.stringify(committedScan.source) !== JSON.stringify(currentScan.source)) {
  throw new Error('committed source scan is stale');
}
if (JSON.stringify(committedScan.emitted) !== JSON.stringify(currentScan.emitted)) {
  throw new Error(
    'committed emitted-artifact scan is stale; rebuild or explain the changed artifact'
  );
}

const serialized = expectedChangedPaths
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
  `W6 evidence schema, ownership, findings, artifact omission negatives, handoff completeness, ABI smoke, scan freshness and secret/path checks passed (Node ABI ${abiProbe.runtime.nodeModuleAbi}; Electron ABI ${abiProbe.runtime.electronModuleAbi})\n`
);
