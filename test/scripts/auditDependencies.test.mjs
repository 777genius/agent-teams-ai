import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAuditReport } from '../../scripts/ci/audit-dependencies.mjs';
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
