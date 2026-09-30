import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_INDEX_PATH,
  FROZEN_W2_CANONICAL_FILES,
  verifyHostedPhase0EvidenceIntegrity,
} from '../../../../../scripts/ci/verify-hosted-phase0-evidence-integrity.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

function copyCanonicalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hosted-phase0-integrity-'));
  temporaryRoots.push(root);
  for (const relativePath of [
    CANONICAL_INDEX_PATH,
    ...FROZEN_W2_CANONICAL_FILES.map((entry) => entry.path),
  ]) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, relativePath), destination);
  }
  return root;
}

function mutateIndex(root, mutate) {
  const path = join(root, CANONICAL_INDEX_PATH);
  const index = JSON.parse(readFileSync(path, 'utf8'));
  mutate(index);
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
}

test('accepts the exact frozen W2 files and their current-canonical index records', () => {
  assert.deepEqual(verifyHostedPhase0EvidenceIntegrity(REPOSITORY_ROOT), []);
});

test('fails closed when a canonical file is missing', () => {
  const root = copyCanonicalFixture();
  const missing = FROZEN_W2_CANONICAL_FILES[3].path;
  unlinkSync(join(root, missing));

  assert.match(verifyHostedPhase0EvidenceIntegrity(root).join('\n'), new RegExp(missing));
});

test('fails closed when a relevant current-canonical index record is missing', () => {
  const root = copyCanonicalFixture();
  const expected = FROZEN_W2_CANONICAL_FILES[0];
  mutateIndex(root, (index) => {
    index.evidence = index.evidence.filter((row) => row.evidenceId !== expected.evidenceId);
  });

  assert.match(
    verifyHostedPhase0EvidenceIntegrity(root).join('\n'),
    /missing P0\.W2\.ENVIRONMENT_PROVENANCE/
  );
});

test('fails closed on a duplicate relevant index record', () => {
  const root = copyCanonicalFixture();
  const expected = FROZEN_W2_CANONICAL_FILES[1];
  mutateIndex(root, (index) => {
    const record = index.evidence.find((row) => row.evidenceId === expected.evidenceId);
    index.evidence.push({ ...record });
  });

  assert.match(
    verifyHostedPhase0EvidenceIntegrity(root).join('\n'),
    /duplicate P0\.W2\.CREDENTIAL_EXPOSURE_MATRIX/
  );
});

test('fails closed when an indexed hash changes even if the file bytes do not', () => {
  const root = copyCanonicalFixture();
  const expected = FROZEN_W2_CANONICAL_FILES[2];
  mutateIndex(root, (index) => {
    const record = index.evidence.find((row) => row.evidenceId === expected.evidenceId);
    record.sha256 = '0'.repeat(64);
  });

  assert.match(
    verifyHostedPhase0EvidenceIntegrity(root).join('\n'),
    /P0\.W2\.RUNTIME_SCANNER sha256 mismatch/
  );
});

test('fails closed when canonical file bytes change', () => {
  const root = copyCanonicalFixture();
  const expected = FROZEN_W2_CANONICAL_FILES[3];
  writeFileSync(join(root, expected.path), '{}\n');

  assert.match(
    verifyHostedPhase0EvidenceIntegrity(root).join('\n'),
    /environment-semantics\.json: sha256 mismatch/
  );
});

test('does not broaden verification to unrelated pre-existing stale index records', () => {
  const root = copyCanonicalFixture();
  mutateIndex(root, (index) => {
    index.evidence.push({
      evidenceId: 'P0.UNRELATED.STALE',
      laneId: 'unrelated',
      path: 'docs/research/hosted-web/phase-0/unrelated-stale.json',
      sha256: 'not-a-current-hash',
    });
  });

  assert.deepEqual(verifyHostedPhase0EvidenceIntegrity(root), []);
});
