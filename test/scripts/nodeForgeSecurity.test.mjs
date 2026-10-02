import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  ADVISORY,
  applyForgePatch,
  installedForgePackages,
  verifyForgePackage,
  verifyRsaBehavior,
} from '../../scripts/ci/node-forge-security.mjs';
import { assessAuditReport } from '../../scripts/ci/audit-dependencies.mjs';

const advisory = {
  name: 'node-forge',
  dependency: 'node-forge',
  module_name: 'node-forge',
  severity: 'high',
  url: `https://github.com/advisories/${ADVISORY}`,
};
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
    'node-forge': { name: 'node-forge', severity: 'high', via: [{ ...advisory }] },
    listhen: { name: 'listhen', severity: 'high', via: ['node-forge'] },
    nuxt: { name: 'nuxt', severity: 'high', via: ['listhen', 'builder'] },
    builder: { name: 'builder', severity: 'high', via: ['nuxt'] },
  },
  metadata: { vulnerabilities: { high: 4, critical: 0 } },
});

// Regression: a future broad ignore or accidentally trusted unpatched package turns these red.
test('only the exact advisory is excepted after package validation', () => {
  const report = pnpmReport({ 1: advisory });
  assert.deepEqual(assessAuditReport(report).blocked, ['1']);
  assert.deepEqual(assessAuditReport(report, { patched: true }), { blocked: [], excepted: ['1'] });
  for (const level of ['high', 'critical']) {
    const other = {
      ...advisory,
      severity: level,
      url: 'https://github.com/advisories/GHSA-abcd-efgh-ijkl',
    };
    assert.deepEqual(
      assessAuditReport(pnpmReport({ 1: advisory, 2: other }), { patched: true }).blocked,
      ['2']
    );
  }
  assert.deepEqual(
    assessAuditReport(pnpmReport({ 1: { ...advisory, module_name: 'other' } }), { patched: true })
      .blocked,
    ['1']
  );
});

test('npm follows metavulnerability paths and cycles without hiding unrelated HIGH', () => {
  const report = npmReport();
  assert.equal(assessAuditReport(report, { npm: true, patched: true }).excepted.length, 4);
  assert.equal(assessAuditReport(report, { npm: true }).blocked.length, 4);
  report.vulnerabilities.listhen.via.push({
    ...advisory,
    name: 'listhen',
    dependency: 'listhen',
    url: 'https://github.com/advisories/GHSA-abcd-efgh-ijkl',
  });
  assert.deepEqual(assessAuditReport(report, { npm: true, patched: true }).blocked, [
    'listhen',
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
    assert.throws(() => assessAuditReport(report, { patched: true }), /Invalid audit report/);
  }
  const missing = npmReport();
  missing.vulnerabilities.listhen.via = ['missing'];
  assert.throws(
    () => assessAuditReport(missing, { npm: true, patched: true }),
    /missing dependency/
  );
  const cycle = npmReport();
  cycle.vulnerabilities.nuxt.via = ['builder'];
  assert.deepEqual(assessAuditReport(cycle, { npm: true, patched: true }).blocked, [
    'nuxt',
    'builder',
  ]);
});

test('missing additional npm or pnpm instance cannot be silently ignored', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'node-forge-discovery-'));
  try {
    const installed = join(sandbox, 'node_modules/node-forge');
    mkdirSync(installed, { recursive: true });
    assert.deepEqual(installedForgePackages(sandbox), [realpathSync(installed)]);
    writeFileSync(
      join(sandbox, 'package-lock.json'),
      JSON.stringify({
        packages: {
          'node_modules/node-forge': { version: '1.4.0' },
          'node_modules/other/node_modules/node-forge': { version: '1.4.0' },
        },
      })
    );
    assert.throws(() => installedForgePackages(sandbox), /Missing installed node-forge package/);
    rmSync(join(sandbox, 'package-lock.json'));
    mkdirSync(join(sandbox, 'node_modules/.pnpm/node-forge@1.3.1'), { recursive: true });
    assert.throws(() => installedForgePackages(sandbox), /Missing installed node-forge package/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

let packageRoot = process.env.NODE_FORGE_TEST_PACKAGE;
if (!packageRoot) {
  try {
    [packageRoot] = installedForgePackages(resolve('.'));
  } catch {
    /* No dependencies in a source-only checkout. */
  }
}

// Runs against the real npm package in a disposable copy, never modifies the installed store.
// CI installs node-forge; source-only checkouts can supply NODE_FORGE_TEST_PACKAGE.
test(
  'real RSA regression: baseline accepts forgery, backport rejects it and accepts valid signatures',
  {
    skip:
      !packageRoot &&
      !process.env.CI &&
      'Install dependencies or set NODE_FORGE_TEST_PACKAGE to the node-forge 1.4.0 package',
  },
  () => {
    assert.ok(packageRoot, 'CI must install node-forge or provide NODE_FORGE_TEST_PACKAGE');
    const sandbox = mkdtempSync(join(tmpdir(), 'node-forge-security-'));
    const target = join(sandbox, 'node_modules/node-forge');
    try {
      cpSync(packageRoot, target, { recursive: true });
      const rsa = join(target, 'lib/rsa.js');
      const source = readFileSync(rsa, 'utf8');
      // Reconstruct the exact published baseline if CI installed the backport already.
      writeFileSync(
        rsa,
        source
          .replace(
            '          // validate DigestInfo structure and element counts (outer DigestInfo\n' +
              '          // and nested DigestAlgorithm). asn1.validate ignores extra children,\n' +
              '          // so length must be checked explicitly at each nesting level to\n' +
              '          // prevent low-exponent PKCS#1 v1.5 signature forgery (CVE-2026-85393).\n',
            '          // validate DigestInfo structure and element count\n'
          )
          .replace(
            "obj.value.length !== 2 ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)) {",
            'obj.value.length !== 2) {'
          )
      );
      assert.throws(() => verifyRsaBehavior(target), /accepted the forged/);
      assert.throws(() => verifyForgePackage(target), /Missing or unexpected/);
      assert.equal(applyForgePatch(target), true);
      verifyForgePackage(target);
      assert.equal(applyForgePatch(target), false);
      writeFileSync(rsa, readFileSync(rsa, 'utf8') + '\n// unexpected source mutation\n');
      assert.throws(() => applyForgePatch(target), /Unexpected node-forge source/);
      assert.throws(() => verifyForgePackage(target), /Missing or unexpected/);
      const manifest = join(target, 'package.json');
      const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
      writeFileSync(manifest, JSON.stringify({ ...metadata, version: '1.3.1' }));
      assert.throws(() => applyForgePatch(target), /Unsupported node-forge package/);
      assert.throws(() => verifyForgePackage(target), /Unsupported node-forge package/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
);
