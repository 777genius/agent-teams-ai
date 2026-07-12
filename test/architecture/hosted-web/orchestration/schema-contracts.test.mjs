import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeWorkKey } from '../../../../scripts/hosted-web/orchestration/contract-lib.mjs';
import { generateEvidenceCatalog } from '../../../../scripts/hosted-web/orchestration/evidence-catalog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const localRequire = createRequire(import.meta.url);
const requireFromFastify = createRequire(localRequire.resolve('fastify/package.json'));
const requireFromAjvCompiler = createRequire(
  requireFromFastify.resolve('@fastify/ajv-compiler/package.json')
);
const Ajv2020 = requireFromAjvCompiler('ajv/dist/2020').default;
const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateWorkerSchema = ajv.compile(
  readJson('docs/hosted-web-phases/worker-start-contract.schema.json')
);
const validateCatalogSchema = ajv.compile(
  readJson('docs/hosted-web-phases/evidence-catalog.schema.json')
);
const driftCases = readJson(
  'test/architecture/hosted-web/orchestration/fixtures/schema-drift-cases.json'
);

function validWorkerContract() {
  const raw = readFileSync(
    path.join(
      repoRoot,
      'test/architecture/hosted-web/orchestration/fixtures/valid-worker-start.template.json'
    ),
    'utf8'
  )
    .replaceAll('$JOB_ROOT', '/tmp/hosted-web-schema-fixture')
    .replaceAll('$WORKSPACE_ROOT', '/tmp/hosted-web-schema-workspace')
    .replaceAll('$PHASE_START_SHA', 'a32f509e6d9bd31ba2135940e336729bf90c3d93');
  const contract = JSON.parse(raw);
  contract.workKey = computeWorkKey(contract);
  return contract;
}

function mutateWorker(contract, mutation) {
  if (mutation === 'duplicate-required-check') {
    contract.requiredChecks.push(clone(contract.requiredChecks[0]));
  } else if (mutation === 'whitespace-command') {
    contract.requiredChecks[0].command = ' node --test check.mjs ';
  } else if (mutation === 'invalid-revision') {
    contract.revision = 1;
  } else if (mutation === 'unsafe-path') {
    contract.ownedPaths = ['../real-project'];
  } else if (mutation === 'lane-packet-mismatch') {
    contract.lanePacket = 'docs/hosted-web-phases/phase-00/lanes/w2-provider-runtime.md';
  } else {
    throw new Error(`unknown worker schema mutation: ${mutation}`);
  }
}

function validCatalog() {
  const source = readJson(
    'test/architecture/hosted-web/orchestration/fixtures/catalog-source.json'
  );
  const result = generateEvidenceCatalog(source, repoRoot);
  assert.equal(result.ok, true, result.issues?.join('\n'));
  return result.catalog;
}

function mutateCatalog(catalog, mutation) {
  if (mutation === 'duplicate-entry') {
    catalog.entries.push(clone(catalog.entries[0]));
  } else if (mutation === 'missing-generated-command') {
    catalog.entries[0].authority = 'generated';
    catalog.entries[0].reviewDisposition = 'pending';
    catalog.entries[0].regenerationCommand = null;
  } else if (mutation === 'unsafe-path') {
    catalog.entries[0].path = '../outside';
  } else if (mutation === 'broken-supersession') {
    const superseded = catalog.entries.find((entry) => entry.authority === 'superseded');
    superseded.supersession.supersededBy = null;
  } else if (mutation === 'raw-supersession-successor') {
    const successor = catalog.entries.find((entry) => entry.supersession.supersedes.length > 0);
    successor.authority = 'raw';
    successor.reviewDisposition = 'not-required';
  } else if (mutation === 'rejected-supersession-successor') {
    const successor = catalog.entries.find((entry) => entry.supersession.supersedes.length > 0);
    successor.authority = 'rejected';
    successor.reviewDisposition = 'rejected';
  } else if (mutation === 'generated-approved-supersession-successor') {
    const successor = catalog.entries.find((entry) => entry.supersession.supersedes.length > 0);
    successor.authority = 'generated';
    successor.reviewDisposition = 'approved';
    successor.regenerationCommand = 'node regenerate-current.mjs';
  } else {
    throw new Error(`unknown evidence schema mutation: ${mutation}`);
  }
}

test('Draft 2020-12 worker-start schema accepts the positive fixture', () => {
  assert.equal(
    validateWorkerSchema(validWorkerContract()),
    true,
    JSON.stringify(validateWorkerSchema.errors)
  );
});

test('Draft 2020-12 worker-start schema requires an absolute workspace root', () => {
  const missing = validWorkerContract();
  delete missing.workspaceRoot;
  assert.equal(validateWorkerSchema(missing), false);

  const relative = validWorkerContract();
  relative.workspaceRoot = 'relative/workspace';
  assert.equal(validateWorkerSchema(relative), false);
});

test('Draft 2020-12 worker-start schema rejects every declared drift fixture', () => {
  for (const fixture of driftCases.workerStart) {
    const contract = validWorkerContract();
    mutateWorker(contract, fixture.mutation);
    assert.equal(validateWorkerSchema(contract), false, fixture.name);
  }
});

test('Draft 2020-12 evidence-catalog schema accepts the positive fixture', () => {
  assert.equal(
    validateCatalogSchema(validCatalog()),
    true,
    JSON.stringify(validateCatalogSchema.errors)
  );
});

test('Draft 2020-12 evidence-catalog schema rejects every declared drift fixture', () => {
  for (const fixture of driftCases.evidenceCatalog) {
    const catalog = validCatalog();
    mutateCatalog(catalog, fixture.mutation);
    assert.equal(validateCatalogSchema(catalog), false, fixture.name);
  }
});
