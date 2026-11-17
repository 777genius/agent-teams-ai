import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAuditReport } from '../../scripts/ci/audit-dependencies.mjs';
import { BACKPORTS } from '../../scripts/ci/transitive-security.ts';
import {
  UNPATCHED_EXCEPTIONS,
  npmLockfileInstalls,
} from '../../scripts/ci/unpatched-advisories.mjs';

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
  assert.deepEqual(assessAuditReport(report, { backported }), {
    blocked: [],
    excepted: ['1'],
    temporary: [],
    expired: [],
  });
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
  assert.deepEqual(assessAuditReport(pnpmReport({})), {
    blocked: [],
    excepted: [],
    temporary: [],
    expired: [],
  });
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

// Temporary exception for an advisory without any published fix (unpatched-advisories.mjs).
const [exception] = UNPATCHED_EXCEPTIONS;
const unpatched = UNPATCHED_EXCEPTIONS;
const GHSA = 'GHSA-fc5q-39xc-vjpf';
const OTHER = 'GHSA-abcd-efgh-ijkl';
const beforeExpiry = Date.parse('2026-12-15T23:59:59Z');
const afterExpiry = Date.parse('2026-12-16T00:00:00Z');
const url = (id) => `https://github.com/advisories/${id}`;

// The exception is a reviewed owner decision; any change to it must be deliberate.
test('the picomatch exception pins its advisory, versions per report, roots and expiry', () => {
  assert.equal(UNPATCHED_EXCEPTIONS.length, 1);
  assert.equal(exception.advisory, GHSA);
  assert.equal(exception.name, 'picomatch');
  assert.equal(exception.validThrough, '2026-12-15');
  assert.deepEqual(exception.pnpm.versions, ['2.3.2', '4.0.4']);
  assert.deepEqual(exception.npm.versions, ['2.3.2', '4.0.7']);
  assert.match(exception.reason, /first_patched_version null/);
  assert.match(exception.reason, /Remove this exception when a patched picomatch version exists/);
  for (const root of exception.pnpm.roots) assert.match(root, /^(\.|landing)>[^>]+$/);
  assert.equal(new Set(exception.pnpm.roots).size, exception.pnpm.roots.length);
  assert.equal(new Set(exception.npm.roots).size, exception.npm.roots.length);
});

const pnpmEntry = ({ id = GHSA, name = 'picomatch', findings } = {}) => ({
  module_name: name,
  severity: 'high',
  url: url(id),
  findings: findings ?? [
    { version: '2.3.2', paths: ['.>tailwindcss>micromatch>picomatch'] },
    { version: '4.0.4', paths: ['.>vite>picomatch', 'landing>nuxt>unplugin>picomatch'] },
  ],
});
const pnpm = (report, now = beforeExpiry) => assessAuditReport(report, { unpatched, now });

test('pnpm: only the exact advisory, versions and dev/build roots pass before expiry', () => {
  assert.deepEqual(pnpm(pnpmReport({ 1: pnpmEntry() })), {
    blocked: [],
    excepted: [],
    temporary: ['1'],
    expired: [],
  });
  // The exception is opt-in: without it the advisory blocks, as the exit-status check expects.
  assert.deepEqual(assessAuditReport(pnpmReport({ 1: pnpmEntry() })).blocked, ['1']);
  const blocked = (entry) => pnpm(pnpmReport({ 1: entry })).blocked;
  // 4.0.7 is only the landing npm lockfile version, never allowed in the pnpm report.
  for (const version of ['4.0.7', '4.0.3', '2.3.1'])
    assert.deepEqual(
      blocked(pnpmEntry({ findings: [{ version, paths: ['.>vite>picomatch'] }] })),
      ['1'],
      version
    );
  assert.deepEqual(blocked(pnpmEntry({ id: OTHER })), ['1']);
  assert.deepEqual(blocked(pnpmEntry({ name: 'micromatch' })), ['1']);
  for (const path of [
    '.>electron>picomatch',
    '.>@sentry/electron>glob>picomatch',
    'agent-teams-controller>vite>picomatch',
    'landing>vuetify>picomatch',
    '.>vite',
    'picomatch',
  ])
    assert.deepEqual(
      blocked(
        pnpmEntry({
          findings: [{ version: '4.0.4', paths: ['.>vite>picomatch', path] }],
        })
      ),
      ['1'],
      path
    );
  assert.deepEqual(blocked(pnpmEntry({ findings: [] })), ['1']);
  assert.deepEqual(blocked(pnpmEntry({ findings: [{ version: '4.0.4', paths: [] }] })), ['1']);
});

test('pnpm: the exception expires hard and says why', () => {
  const result = pnpm(pnpmReport({ 1: pnpmEntry() }), afterExpiry);
  assert.deepEqual(result.blocked, ['1']);
  assert.deepEqual(result.temporary, []);
  assert.equal(result.expired.length, 1);
  assert.match(result.expired[0], /GHSA-fc5q-39xc-vjpf \(picomatch\) expired after 2026-12-15/);
  assert.match(result.expired[0], /patched picomatch release/);
});

test('pnpm: other HIGH or CRITICAL advisories still block next to the exception', () => {
  for (const level of ['high', 'critical']) {
    const other = { ...pnpmEntry({ id: OTHER, name: 'braces' }), severity: level };
    const result = pnpm(pnpmReport({ 1: pnpmEntry(), 2: other }));
    assert.deepEqual(result.blocked, ['2'], level);
    assert.deepEqual(result.temporary, ['1'], level);
  }
  // A second advisory for picomatch itself is not covered.
  assert.deepEqual(pnpm(pnpmReport({ 1: pnpmEntry(), 2: pnpmEntry({ id: OTHER }) })).blocked, [
    '2',
  ]);
  // Moderate findings never block and the exception does not change that.
  const moderate = { ...pnpmEntry({ id: OTHER }), severity: 'moderate' };
  assert.deepEqual(pnpm(pnpmReport({ 1: pnpmEntry(), 2: moderate })).blocked, []);
});

// Landing npm report: picomatch leaf plus metavulnerabilities that only point at it.
const picomatchNpmReport = ({ id = GHSA, extra } = {}) => {
  const vulnerabilities = {
    picomatch: {
      name: 'picomatch',
      severity: 'high',
      via: [{ name: 'picomatch', dependency: 'picomatch', severity: 'high', url: url(id) }],
      nodes: ['node_modules/picomatch', 'node_modules/micromatch/node_modules/picomatch'],
    },
    micromatch: { name: 'micromatch', severity: 'high', via: ['picomatch'] },
    nuxt: { name: 'nuxt', severity: 'high', via: ['micromatch'] },
    ...extra,
  };
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        high: Object.values(vulnerabilities).filter((entry) => entry.severity === 'high').length,
        critical: 0,
      },
    },
  };
};
const installs = (overrides = {}) =>
  new Map([
    ['node_modules/picomatch', { version: '4.0.7', roots: ['nuxt', 'vite'] }],
    ['node_modules/micromatch/node_modules/picomatch', { version: '2.3.2', roots: ['nuxt'] }],
    ...Object.entries(overrides),
  ]);
const npm = (report, npmInstalls = installs(), now = beforeExpiry) =>
  assessAuditReport(report, { npm: true, unpatched, now, npmInstalls });

test('npm: exact advisory, lockfile versions and dev/build roots pass before expiry', () => {
  assert.deepEqual(npm(picomatchNpmReport()), {
    blocked: [],
    excepted: [],
    temporary: ['picomatch', 'micromatch', 'nuxt'],
    expired: [],
  });
  assert.deepEqual(assessAuditReport(picomatchNpmReport(), { npm: true }).blocked, [
    'picomatch',
    'micromatch',
    'nuxt',
  ]);
  const all = ['picomatch', 'micromatch', 'nuxt'];
  // 4.0.4 is only the pnpm version; the landing lockfile must carry 4.0.7 or 2.3.2.
  for (const version of ['4.0.4', '4.0.6'])
    assert.deepEqual(
      npm(
        picomatchNpmReport(),
        installs({ 'node_modules/picomatch': { version, roots: ['nuxt'] } })
      ).blocked,
      all,
      version
    );
  assert.deepEqual(npm(picomatchNpmReport({ id: OTHER })).blocked, all);
  for (const roots of [['nuxt', 'vuetify'], ['some-runtime-lib'], []])
    assert.deepEqual(
      npm(picomatchNpmReport(), installs({ 'node_modules/picomatch': { version: '4.0.7', roots } }))
        .blocked,
      all,
      roots.join(',')
    );
  // An affected install missing from the lockfile fails closed.
  const missing = installs();
  missing.delete('node_modules/micromatch/node_modules/picomatch');
  assert.deepEqual(npm(picomatchNpmReport(), missing).blocked, all);
});

test('npm: the exception expires hard and other HIGH advisories still block', () => {
  const expired = npm(picomatchNpmReport(), installs(), afterExpiry);
  assert.deepEqual(expired.blocked, ['picomatch', 'micromatch', 'nuxt']);
  assert.match(expired.expired[0], /expired after 2026-12-15/);
  const other = picomatchNpmReport({
    extra: {
      braces: {
        name: 'braces',
        severity: 'high',
        via: [{ name: 'braces', dependency: 'braces', severity: 'high', url: url(OTHER) }],
      },
      nuxt: { name: 'nuxt', severity: 'high', via: ['micromatch', 'braces'] },
    },
  });
  const result = npm(other);
  assert.deepEqual(result.blocked, ['nuxt', 'braces']);
  assert.deepEqual(result.temporary, ['picomatch', 'micromatch']);
});

test('lockfile reachability follows Node resolution and skips optional peers', () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { app: '1' }, devDependencies: { tool: '1' } },
      'node_modules/app': {
        version: '1.0.0',
        peerDependencies: { tool: '1', ui: '1' },
        peerDependenciesMeta: { tool: { optional: true } },
      },
      'node_modules/ui': { version: '1.0.0' },
      'node_modules/tool': { version: '1.0.0', dependencies: { glob: '1' } },
      'node_modules/glob': { version: '1.0.0', dependencies: { picomatch: '2' } },
      'node_modules/glob/node_modules/picomatch': { version: '2.3.2' },
      'node_modules/picomatch': { version: '4.0.7' },
    },
  };
  const result = npmLockfileInstalls(lockfile);
  assert.deepEqual(result.get('node_modules/glob/node_modules/picomatch'), {
    version: '2.3.2',
    roots: ['tool'],
  });
  assert.deepEqual(result.get('node_modules/ui').roots, ['app']);
  // Not reachable from any direct dependency: no roots, so the exception fails closed.
  assert.equal(result.get('node_modules/picomatch'), undefined);
  // A required peer is an edge.
  lockfile.packages['node_modules/app'].peerDependenciesMeta = {};
  assert.deepEqual(
    npmLockfileInstalls(lockfile).get('node_modules/glob/node_modules/picomatch').roots,
    ['app', 'tool']
  );
  assert.throws(
    () => npmLockfileInstalls({ lockfileVersion: 2, packages: {} }),
    /lockfileVersion 3/
  );
});
