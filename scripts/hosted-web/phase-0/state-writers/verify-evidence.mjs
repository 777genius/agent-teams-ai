#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../../..');
const evidenceDir = join(repoRoot, 'docs/research/hosted-web/phase-0/state-writers');
const expectedSha = 'a32f509e6d9bd31ba2135940e336729bf90c3d93';
const evidenceFiles = [
  'state-family-catalog.json',
  'writer-coordination.json',
  'schema-unknown-fields.json',
  'backup-behavior.json',
  'sqlite-online-backup-results.json',
  'estimate-input.json',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function verifySourceRefs(refs, context) {
  invariant(Array.isArray(refs) && refs.length > 0, `${context}: sourceRefs must be non-empty`);
  for (const ref of refs) {
    invariant(
      nonEmptyString(ref) && !ref.startsWith('/'),
      `${context}: sourceRef must be repository-relative`
    );
    const topLevel = ref.split('/')[0];
    invariant(
      ['src', 'test', 'scripts', 'docs'].includes(topLevel),
      `${context}: unsupported sourceRef ${ref}`
    );
    await access(join(repoRoot, ref));
  }
}

export async function validateStateFamilyCatalog(catalog) {
  invariant(catalog.evidenceId === 'P0.W3.STATE_FAMILY_CATALOG', 'catalog: wrong evidenceId');
  invariant(
    Array.isArray(catalog.families) && catalog.families.length > 0,
    'catalog: families missing'
  );
  const ids = new Set();
  const required = [
    'pathPattern',
    'implementationStatus',
    'authority',
    'writers',
    'unresolvedWriters',
    'schemaVersion',
    'maxBytes',
    'lockingModel',
    'atomicity',
    'unknownFieldPolicy',
    'corruptionPolicy',
    'backupRole',
    'secretClass',
  ];
  for (const family of catalog.families) {
    invariant(
      nonEmptyString(family.id) && !ids.has(family.id),
      `catalog: duplicate/empty family id ${family.id}`
    );
    ids.add(family.id);
    for (const key of required) {
      invariant(family[key] !== undefined, `${family.id}: missing ${key}`);
    }
    invariant(
      Array.isArray(family.writers) && family.writers.length > 0,
      `${family.id}: writers missing`
    );
    invariant(
      Array.isArray(family.unresolvedWriters),
      `${family.id}: unresolvedWriters must be an array`
    );
    await verifySourceRefs(family.sourceRefs, family.id);
  }
  const unresolvedCount = catalog.families.filter(
    (family) => family.unresolvedWriters.length > 0
  ).length;
  invariant(catalog.counts.total === catalog.families.length, 'catalog: counts.total drift');
  invariant(
    catalog.counts.withUnresolvedWriterIdentity === unresolvedCount,
    'catalog: unresolved count drift'
  );
  return ids;
}

async function validateCommon(record, fileName) {
  invariant(record?.schemaVersion === 1, `${fileName}: schemaVersion must be 1`);
  invariant(
    nonEmptyString(record?.evidenceId) && record.evidenceId.startsWith('P0.W3.'),
    `${fileName}: invalid evidenceId`
  );
  invariant(record.phaseStartSha === expectedSha, `${fileName}: wrong phaseStartSha`);
  invariant(nonEmptyString(record.proofLevel), `${fileName}: proofLevel missing`);
}

export async function verifyEvidence({ overrideCatalog } = {}) {
  const records = new Map();
  for (const fileName of evidenceFiles) {
    const parsed =
      fileName === 'state-family-catalog.json' && overrideCatalog
        ? overrideCatalog
        : JSON.parse(await readFile(join(evidenceDir, fileName), 'utf8'));
    await validateCommon(parsed, fileName);
    records.set(fileName, parsed);
  }

  const familyIds = await validateStateFamilyCatalog(records.get('state-family-catalog.json'));
  const coordination = records.get('writer-coordination.json');
  const allowedClasses = new Set(coordination.classes);
  invariant(
    coordination.operations.length >= 10,
    'coordination: required mutation coverage too small'
  );
  for (const operation of coordination.operations) {
    invariant(familyIds.has(operation.familyId), `${operation.id}: unknown familyId`);
    invariant(
      allowedClasses.has(operation.coordinationClass),
      `${operation.id}: invalid coordinationClass`
    );
    invariant(
      ['app_exclusive', 'cooperative_external', 'uncoordinated_external'].includes(
        operation.adr29Class
      ),
      `${operation.id}: invalid ADR-29 class`
    );
    for (const key of ['activeWriterEvidence', 'currentProof', 'hostedDisposition']) {
      invariant(nonEmptyString(operation[key]), `${operation.id}: missing ${key}`);
    }
    await verifySourceRefs(operation.sourceRefs, operation.id);
  }

  const unknowns = records.get('schema-unknown-fields.json');
  for (const policy of unknowns.policies) {
    invariant(familyIds.has(policy.familyId), `unknown fields: unknown family ${policy.familyId}`);
    await verifySourceRefs(policy.sourceRefs, `unknown-fields:${policy.familyId}`);
  }

  const backup = records.get('backup-behavior.json');
  invariant(
    backup.currentService.classification === 'legacy_unverified safety copy',
    'backup: unsafe current-service classification'
  );
  invariant(
    backup.proofLevel === 'fixture_characterized',
    'backup: production service fixture proof missing'
  );
  invariant(
    backup.fixture?.kind === 'marker-owned production-service fault characterization',
    'backup: fixture ownership missing'
  );
  invariant(
    backup.fixture?.userStateAccessed === false,
    'backup: fixture must not access user state'
  );
  invariant(
    backup.fixture?.sourceUnderTest === 'src/main/services/team/TeamBackupService.ts',
    'backup: wrong production source under test'
  );
  invariant(
    backup.fixture?.result?.tests === 7 && backup.fixture?.result?.cases === 12,
    'backup: fixture result count drift'
  );
  invariant(
    backup.fixture?.result?.passed === 7 && backup.fixture?.result?.failed === 0,
    'backup: fixture is not fully passing'
  );
  invariant(
    Array.isArray(backup.faultMatrix) && backup.faultMatrix.length === 12,
    'backup: fault matrix must contain 12 cases'
  );
  const backupCaseIds = backup.faultMatrix.map((entry) => entry.caseId);
  invariant(
    new Set(backupCaseIds).size === backupCaseIds.length,
    'backup: duplicate fault case ID'
  );
  invariant(
    backupCaseIds.every((caseId, index) => caseId === `TB-${String(index + 1).padStart(2, '0')}`),
    'backup: fault case IDs must be contiguous TB-01 through TB-12'
  );
  invariant(
    backup.faultMatrix.every((entry) => entry.asserted === true),
    'backup: unasserted fixture result'
  );
  invariant(
    backup.faultMatrix.every((entry) => entry.recoveryPointSafe === false),
    'backup: legacy fault incorrectly marked safe'
  );
  await access(join(repoRoot, backup.fixture.path));
  await verifySourceRefs(backup.currentService.sourceRefs, 'backup current service');

  const sqlite = records.get('sqlite-online-backup-results.json');
  invariant(
    sqlite.results.some((entry) => entry.case.includes('wal-active')),
    'sqlite: WAL case missing'
  );
  invariant(
    sqlite.results.some((entry) => entry.case.includes('BUSY')),
    'sqlite: BUSY case missing'
  );
  invariant(
    sqlite.results.some((entry) => entry.case.includes('corruption')),
    'sqlite: corruption case missing'
  );

  const estimate = records.get('estimate-input.json');
  const min = estimate.buckets.reduce(
    (sum, bucket) => sum + bucket.productionLines.min + bucket.testLines.min,
    0
  );
  const max = estimate.buckets.reduce(
    (sum, bucket) => sum + bucket.productionLines.max + bucket.testLines.max,
    0
  );
  invariant(
    estimate.totals.changedLines.min === min && estimate.totals.changedLines.max === max,
    'estimate: changed-line total drift'
  );
  invariant(min >= 4_500 && max <= 7_500, 'estimate: outside parent EST-RECOVERY-STATE range');
  invariant(
    estimate.buckets.every((bucket) => bucket.excludedGeneratedVendorLines === true),
    'estimate: generated/vendor exclusion missing'
  );

  const spikeSource = await readFile(
    join(repoRoot, 'scripts/hosted-web/phase-0/state-writers/sqlite-online-backup-spike.mjs'),
    'utf8'
  );
  invariant(
    !/copyFile|wal_checkpoint|VACUUM\s+INTO/i.test(spikeSource),
    'sqlite spike: forbidden fallback/checkpoint detected'
  );

  return {
    evidenceFiles: evidenceFiles.length,
    stateFamilies: familyIds.size,
    operations: coordination.operations.length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyEvidence()
    .then((result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
