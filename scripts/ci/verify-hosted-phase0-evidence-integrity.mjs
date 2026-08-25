#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_INDEX_PATH =
  'docs/research/hosted-web/phase-0/freeze/current-canonical/evidence-index.json';

const FROZEN_W2_COMMIT = '6d54e7c60d29812de5b96e471761486fbbc0842c';

export const FROZEN_W2_CANONICAL_FILES = Object.freeze([
  Object.freeze({
    evidenceId: 'P0.W2.ENVIRONMENT_PROVENANCE',
    path: 'docs/research/hosted-web/phase-0/provider-runtime/environment-provenance.json',
    sha256: '302cc6081598a182df58478f6d50288228e037db5f14c33df72c512fcc5b3d81',
  }),
  Object.freeze({
    evidenceId: 'P0.W2.CREDENTIAL_EXPOSURE_MATRIX',
    path: 'docs/research/hosted-web/phase-0/provider-runtime/credential-exposure-matrix.json',
    sha256: '5f039a47a65ced6556f5c096e4135d18aeea3377db1f21fb347025c1af5b36e1',
  }),
  Object.freeze({
    evidenceId: 'P0.W2.RUNTIME_SCANNER',
    path: 'scripts/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.ts',
    sha256: '92a28a82c279467f844a48743c3c87ef4bea89c991bb3d0e06424052a3738f7c',
  }),
  Object.freeze({
    evidenceId: null,
    path: 'test/architecture/hosted-web/phase-0/provider-runtime/fixtures/environment-semantics.json',
    sha256: '3f952a58400fd40188c900673b4a4399b7144ebb9faba6018254073f5a9ad430',
  }),
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRegularFile(root, relativePath, errors) {
  const absolutePath = resolve(root, relativePath);
  try {
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) {
      errors.push(`${relativePath}: expected a regular file`);
      return null;
    }
    return readFileSync(absolutePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`${relativePath}: missing or unreadable (${detail})`);
    return null;
  }
}

function readCanonicalIndex(root, errors) {
  const bytes = readRegularFile(root, CANONICAL_INDEX_PATH, errors);
  if (bytes === null) return null;

  let index;
  try {
    index = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`${CANONICAL_INDEX_PATH}: invalid JSON (${detail})`);
    return null;
  }

  if (!isRecord(index) || !Array.isArray(index.evidence)) {
    errors.push(`${CANONICAL_INDEX_PATH}: expected an object with an evidence array`);
    return null;
  }
  return index;
}

function verifyIndexedRecord(index, expected, errors) {
  const candidates = index.evidence.filter(
    (row) => isRecord(row) && (row.evidenceId === expected.evidenceId || row.path === expected.path)
  );

  if (candidates.length === 0) {
    errors.push(`${CANONICAL_INDEX_PATH}: missing ${expected.evidenceId} at ${expected.path}`);
    return;
  }
  if (candidates.length !== 1) {
    errors.push(
      `${CANONICAL_INDEX_PATH}: duplicate ${expected.evidenceId}/${expected.path} records (${candidates.length})`
    );
    return;
  }

  const [record] = candidates;
  const exactFields = [
    ['evidenceId', expected.evidenceId],
    ['laneId', 'w2'],
    ['path', expected.path],
    ['sha256', expected.sha256],
    ['integratedAtCommit', FROZEN_W2_COMMIT],
  ];
  for (const [field, expectedValue] of exactFields) {
    if (record[field] !== expectedValue) {
      errors.push(
        `${CANONICAL_INDEX_PATH}: ${expected.evidenceId} ${field} mismatch (expected ${expectedValue}, received ${String(record[field])})`
      );
    }
  }
}

export function verifyHostedPhase0EvidenceIntegrity(root) {
  const repositoryRoot = resolve(root);
  const errors = [];
  const index = readCanonicalIndex(repositoryRoot, errors);

  if (index !== null) {
    for (const expected of FROZEN_W2_CANONICAL_FILES) {
      if (expected.evidenceId !== null) verifyIndexedRecord(index, expected, errors);
    }
  }

  for (const expected of FROZEN_W2_CANONICAL_FILES) {
    const bytes = readRegularFile(repositoryRoot, expected.path, errors);
    if (bytes === null) continue;
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expected.sha256) {
      errors.push(
        `${expected.path}: sha256 mismatch (expected ${expected.sha256}, received ${actualHash})`
      );
    }
  }

  return errors;
}

function parseRoot(args) {
  if (args.length === 0) return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (args.length === 2 && args[0] === '--root' && args[1]) return resolve(args[1]);
  throw new Error('usage: verify-hosted-phase0-evidence-integrity.mjs [--root <repository-root>]');
}

function main() {
  let root;
  try {
    root = parseRoot(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const errors = verifyHostedPhase0EvidenceIntegrity(root);
  if (errors.length > 0) {
    console.error('Hosted Phase 0 evidence integrity verification failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Hosted Phase 0 evidence integrity verified (${FROZEN_W2_CANONICAL_FILES.length} canonical files).`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
