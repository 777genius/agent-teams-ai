#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const goldenPath = resolve(
  root,
  'test/fixtures/hosted-approval-runtime-admission-v1.release-golden.json'
);
const runtimeLockPath = resolve(root, 'runtime.lock.json');
const [admissionInput] = process.argv.slice(2);
const golden = JSON.parse(await readFile(goldenPath, 'utf8'));
const runtimeLock = JSON.parse(await readFile(runtimeLockPath, 'utf8'));

const exactKeys = (value, expected) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

function invalid(reason) {
  throw new Error(`hosted-approval-runtime-release-golden-invalid:${reason}`);
}

function verifyReleaseGolden() {
  if (!exactKeys(golden, ['schemaVersion', 'source', 'release', 'canonicalJson', 'sha256'])) {
    invalid('schema');
  }
  if (
    golden.schemaVersion !== 2 ||
    golden.source !== 'agent-teams-orchestrator/hosted-approval-runtime-admission.v1'
  ) {
    invalid('identity');
  }
  if (
    !exactKeys(golden.release, [
      'sourceRepository',
      'releaseRepository',
      'releaseTag',
      'sourceCommit',
      'manifestAttestation',
    ]) ||
    golden.release.sourceRepository !== '777genius/agent_teams_orchestrator' ||
    golden.release.releaseRepository !== '777genius/agent_teams_orchestrator_binaries' ||
    golden.release.releaseTag !== runtimeLock.releaseTag ||
    golden.release.sourceCommit !== '1f9a7ffc00715e2434eb7549ac2c53880d9f6f83' ||
    !COMMIT.test(golden.release.sourceCommit)
  ) {
    invalid('release-pin');
  }
  const attestation = golden.release.manifestAttestation;
  if (
    !exactKeys(attestation, ['kind', 'releaseId', 'assetId', 'assetName', 'assetSha256']) ||
    attestation.kind !== 'github-release-asset-digest/v1' ||
    attestation.releaseId !== 363595793 ||
    attestation.assetId !== 498146437 ||
    attestation.assetName !== `agent-teams-runtime-manifest-${runtimeLock.sourceRef}.json` ||
    attestation.assetSha256 !==
      '0b1036e1f110eefeed5b12c9637a7efa3bf35d6b09a8eb20519909e86bed2bcb' ||
    !SHA256.test(attestation.assetSha256)
  ) {
    invalid('manifest-attestation-pin');
  }
  if (
    typeof golden.canonicalJson !== 'string' ||
    golden.sha256 !== `sha256:${sha256(golden.canonicalJson)}`
  ) {
    invalid('canonical-digest');
  }
  const snapshot = JSON.parse(golden.canonicalJson);
  if (
    !exactKeys(snapshot, ['schemaVersion', 'approvalGeneration', 'authorities']) ||
    snapshot.schemaVersion !== 1 ||
    snapshot.approvalGeneration !== 1 ||
    !Array.isArray(snapshot.authorities) ||
    snapshot.authorities.length === 0
  ) {
    invalid('authority-snapshot');
  }
}

verifyReleaseGolden();
if (admissionInput === '--verify-golden') {
  process.stdout.write(`${JSON.stringify({ verified: true, releaseGolden: goldenPath })}\n`);
  process.exit(0);
}
if (!admissionInput) {
  throw new Error('usage: verify-hosted-approval-runtime-admission-authority <admission-json>');
}

const admissionPath = resolve(admissionInput);
const admissionBytes = await readFile(admissionPath);
const admission = JSON.parse(admissionBytes.toString('utf8'));
const match = /^approval-admission-generation_([1-9][0-9]*)_owner_[1-9][0-9]*$/u.exec(
  admission.admissionGeneration ?? ''
);
if (!match || !Array.isArray(admission.routes)) invalid('admission-shape');
const snapshot = {
  schemaVersion: 1,
  approvalGeneration: Number(match[1]),
  authorities: [...admission.routes]
    .toSorted((left, right) => left.routeId.localeCompare(right.routeId))
    .map((route) => route.authority),
};
const canonicalJson = JSON.stringify(snapshot);
if (canonicalJson !== golden.canonicalJson) invalid('cross-repository-authority-mismatch');

process.stdout.write(
  `${JSON.stringify({
    verified: true,
    sourceRepository: golden.release.sourceRepository,
    releaseRepository: golden.release.releaseRepository,
    releaseTag: golden.release.releaseTag,
    sourceCommit: golden.release.sourceCommit,
    manifestAttestationSha256: golden.release.manifestAttestation.assetSha256,
    admissionSha256: sha256(admissionBytes),
    approvalGeneration: snapshot.approvalGeneration,
  })}\n`
);
