import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assessAuditReport, loadAcceptedRisks } from '../../scripts/ci/audit-dependencies.mjs';
import { BACKPORTS } from '../../scripts/ci/transitive-security.ts';

const [spec] = BACKPORTS;
const backported = [spec.name];
const advisory = {
  name: spec.name,
  dependency: spec.name,
  module_name: spec.name,
  severity: 'high',
  url: `https://github.com/advisories/${spec.advisory}`,
  findings: [{ version: spec.version }],
};
const unrelated = (severity = 'high') => ({
  ...advisory,
  severity,
  url: 'https://github.com/advisories/GHSA-abcd-efgh-ijkl',
});
const pnpmReport = (entries) => ({
  advisories: entries,
  metadata: {
    vulnerabilities: {
      high: Object.values(entries).filter((entry) => entry.severity === 'high').length,
      critical: Object.values(entries).filter((entry) => entry.severity === 'critical').length,
    },
  },
});
const npmReport = () => ({
  auditReportVersion: 2,
  vulnerabilities: {
    [spec.name]: { name: spec.name, severity: 'high', via: [{ ...advisory }] },
    micromatch: { name: 'micromatch', severity: 'high', via: [spec.name] },
    nuxt: { name: 'nuxt', severity: 'high', via: ['micromatch', 'builder'] },
    builder: { name: 'builder', severity: 'high', via: ['nuxt'] },
  },
  metadata: { vulnerabilities: { high: 4, critical: 0 } },
});

// Regression: a verified backport must never hide another HIGH/CRITICAL advisory in the same report.
test('a verified backport exception does not hide unrelated HIGH or CRITICAL advisories', () => {
  const report = pnpmReport({ 1: advisory });
  assert.deepEqual(assessAuditReport(report).blocked, ['1']);
  assert.deepEqual(assessAuditReport(report, { backported }), { blocked: [], excepted: ['1'] });
  for (const level of ['high', 'critical']) {
    assert.deepEqual(
      assessAuditReport(pnpmReport({ 1: advisory, 2: unrelated(level) }), { backported }).blocked,
      ['2']
    );
  }
});

test('npm follows metavulnerability paths and cycles without hiding unrelated HIGH', () => {
  const report = npmReport();
  assert.equal(assessAuditReport(report, { npm: true, backported }).excepted.length, 4);
  assert.equal(assessAuditReport(report, { npm: true }).blocked.length, 4);
  report.vulnerabilities.micromatch.via.push({
    ...unrelated(),
    name: 'micromatch',
    dependency: 'micromatch',
  });
  assert.deepEqual(assessAuditReport(report, { npm: true, backported }).blocked, [
    'micromatch',
    'nuxt',
    'builder',
  ]);
});

test('empty reports pass, errors and malformed reports fail closed', () => {
  assert.deepEqual(assessAuditReport(pnpmReport({})), { blocked: [], excepted: [] });
  for (const report of [
    null,
    {},
    { error: { code: 'ENETUNREACH' } },
    { ...pnpmReport({}), error: { code: 'EAUDIT' } },
    { ...pnpmReport({}), metadata: { vulnerabilities: { high: 1, critical: 0 } } },
    pnpmReport({ 1: { ...advisory, severity: 'unknown' } }),
    pnpmReport({ 1: { ...advisory, url: undefined } }),
  ]) {
    assert.throws(() => assessAuditReport(report, { backported }), /Invalid audit report/);
  }
  const missing = npmReport();
  missing.vulnerabilities.micromatch.via = ['missing'];
  assert.throws(() => assessAuditReport(missing, { npm: true, backported }), /missing dependency/);
  const cycle = npmReport();
  cycle.vulnerabilities.nuxt.via = ['builder'];
  assert.deepEqual(assessAuditReport(cycle, { npm: true, backported }).blocked, [
    'nuxt',
    'builder',
  ]);
});

const risk = {
  advisory: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  mode: 'pnpm',
  versions: ['2.3.2', '4.0.4'],
  expires: '2026-12-15',
  reason: 'No patched release yet; reachable only through trusted build tooling globs.',
};
const riskAdvisory = (versions = ['2.3.2', '4.0.4']) => ({
  module_name: 'picomatch',
  severity: 'high',
  url: `https://github.com/advisories/${risk.advisory}`,
  findings: versions.map((version) => ({ version })),
});

test('an accepted risk covers only its advisory, package and listed versions', () => {
  const accepted = [risk];
  assert.deepEqual(assessAuditReport(pnpmReport({ 1: riskAdvisory() })).blocked, ['1']);
  assert.deepEqual(assessAuditReport(pnpmReport({ 1: riskAdvisory() }), { accepted }), {
    blocked: [],
    excepted: ['1'],
  });
  // A newly installed, unlisted version is not covered.
  assert.deepEqual(
    assessAuditReport(pnpmReport({ 1: riskAdvisory(['2.3.2', '4.0.7']) }), { accepted }).blocked,
    ['1']
  );
  // Another package under the same advisory id, or another advisory, is not covered.
  assert.deepEqual(
    assessAuditReport(pnpmReport({ 1: { ...riskAdvisory(), module_name: 'other' } }), { accepted })
      .blocked,
    ['1']
  );
  assert.deepEqual(
    assessAuditReport(pnpmReport({ 1: riskAdvisory(), 2: unrelated() }), { accepted }).blocked,
    ['2']
  );
  // A pnpm risk never applies to an npm report.
  assert.deepEqual(assessAuditReport(npmReport(), { npm: true, accepted }).excepted, []);
});

const npmRisk = { ...risk, mode: 'npm', versions: ['2.3.2', '4.0.7'] };
const npmNodes = {
  'node_modules/picomatch': '4.0.7',
  'node_modules/micromatch/node_modules/picomatch': '2.3.2',
};
const riskLeaf = {
  name: 'picomatch',
  dependency: 'picomatch',
  severity: 'high',
  url: `https://github.com/advisories/${risk.advisory}`,
};
// npm reports have no versions: the install paths are resolved through the lockfile.
const landingReport = () => ({
  auditReportVersion: 2,
  vulnerabilities: {
    picomatch: {
      name: 'picomatch',
      severity: 'high',
      via: [riskLeaf],
      nodes: Object.keys(npmNodes),
    },
    micromatch: { name: 'micromatch', severity: 'high', via: ['picomatch'] },
    nuxt: { name: 'nuxt', severity: 'high', via: ['micromatch', 'builder'] },
    builder: { name: 'builder', severity: 'high', via: ['nuxt'] },
  },
  metadata: { vulnerabilities: { high: 4, critical: 0 } },
});
const npmOptions = { npm: true, accepted: [npmRisk], lockVersions: npmNodes };

test('an accepted npm risk covers only its advisory, package and lockfile versions', () => {
  assert.equal(assessAuditReport(landingReport(), { npm: true }).blocked.length, 4);
  assert.deepEqual(assessAuditReport(landingReport(), npmOptions), {
    blocked: [],
    excepted: ['picomatch', 'micromatch', 'nuxt', 'builder'],
  });
  // The pnpm entry does not apply to an npm report, and the npm entry not to a pnpm report.
  assert.equal(
    assessAuditReport(landingReport(), { ...npmOptions, accepted: [risk] }).blocked.length,
    4
  );
  assert.deepEqual(
    assessAuditReport(pnpmReport({ 1: riskAdvisory(['2.3.2', '4.0.7']) }), { accepted: [npmRisk] })
      .blocked,
    ['1']
  );
  // An unlisted version, an unknown install path or a missing lockfile entry is not covered.
  for (const lockVersions of [
    { ...npmNodes, 'node_modules/picomatch': '4.0.8' },
    { ...npmNodes, 'node_modules/picomatch': undefined },
    { 'node_modules/picomatch': '4.0.7' },
    {},
  ]) {
    assert.equal(
      assessAuditReport(landingReport(), { ...npmOptions, lockVersions }).blocked.length,
      4
    );
  }
  // A package without install paths cannot be verified.
  const noNodes = landingReport();
  delete noNodes.vulnerabilities.picomatch.nodes;
  assert.equal(assessAuditReport(noNodes, npmOptions).blocked.length, 4);
  // Another package or advisory with the same shape is not covered.
  for (const leaf of [
    { ...riskLeaf, name: 'other', dependency: 'other' },
    { ...riskLeaf, url: 'https://github.com/advisories/GHSA-abcd-efgh-ijkl' },
  ]) {
    const other = landingReport();
    other.vulnerabilities.picomatch.via = [leaf];
    assert.equal(assessAuditReport(other, npmOptions).blocked.length, 4);
  }
  // Any other HIGH leaf in the tree still blocks its own chain.
  const extra = landingReport();
  extra.vulnerabilities.micromatch.via.push({
    ...riskLeaf,
    name: 'micromatch',
    dependency: 'micromatch',
    url: 'https://github.com/advisories/GHSA-abcd-efgh-ijkl',
  });
  assert.deepEqual(assessAuditReport(extra, npmOptions).blocked, ['micromatch', 'nuxt', 'builder']);
});

test('accepted risks expire and are validated', () => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-accepted-risks-'));
  try {
    const file = join(directory, 'risks.json');
    const write = (value) => writeFileSync(file, JSON.stringify(value));
    write([risk]);
    assert.equal(loadAcceptedRisks({ file, now: new Date('2026-12-15T12:00:00Z') }).length, 1);
    assert.equal(loadAcceptedRisks({ file, now: new Date('2026-12-16T00:00:00Z') }).length, 0);
    for (const broken of [
      { ...risk, advisory: 'CVE-2026-1' },
      { ...risk, versions: [] },
      { ...risk, versions: ['^4.0.0'] },
      { ...risk, expires: 'soon' },
      { ...risk, reason: 'x' },
      { ...risk, package: undefined },
      { ...risk, mode: undefined },
      { ...risk, mode: 'yarn' },
    ]) {
      write([broken]);
      assert.throws(() => loadAcceptedRisks({ file }), /Invalid audit report/);
    }
    write({});
    assert.throws(() => loadAcceptedRisks({ file }), /Invalid audit report/);
    // The committed file must itself be well formed.
    assert.ok(Array.isArray(loadAcceptedRisks({ now: new Date('2026-11-18T00:00:00Z') })));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
