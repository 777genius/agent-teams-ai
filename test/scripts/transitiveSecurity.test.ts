// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// Existing audit helper is JavaScript; its external-report contract is tested here.
// @ts-expect-error Existing untyped Node helper.
import { assessAuditReport } from '../../scripts/ci/audit-dependencies.mjs';
import {
  applyBackport,
  BACKPORTS,
  installedBackportPackages,
  verifyBackport,
} from '../../scripts/ci/transitive-security';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function copyPackage(name: string): string {
  const installed = installedBackportPackages(name, process.cwd(), { npm: false })[0];
  expect(installed).toBeTruthy();
  const directory = mkdtempSync(join(tmpdir(), 'TEST-transitive-security-'));
  temporary.push(directory);
  const root = join(directory, name);
  cpSync(installed, root, { recursive: true });
  // Read-only dependency resolution for the copied braces package; never install into it.
  symlinkSync(
    dirname(installed),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return root;
}

describe('verified transitive security backports', () => {
  for (const spec of BACKPORTS) {
    it(`${spec.name} rejects the registry source, repairs it, and preserves idempotence`, () => {
      const root = copyPackage(spec.name);
      verifyBackport(spec.name, root);
      expect(applyBackport(spec.name, root)).toBe(false);
      // Reverse the shipped diff with an independent patch engine to restore genuine
      // registry bytes. The original hashes then bind the reproduction to that release.
      const reverse = spawnSync('git', ['apply', '--reverse', resolve(spec.patch)], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(reverse.status, reverse.stderr).toBe(0);
      expect(() => verifyBackport(spec.name, root)).toThrow(/Missing or unexpected/);
      const probe = spawnSync(
        process.execPath,
        [resolve('scripts/ci/transitive-security.ts'), '--probe', spec.name, root],
        { encoding: 'utf8', timeout: 10000 }
      );
      expect(probe.status).not.toBe(0);
      expect(applyBackport(spec.name, root)).toBe(true);
      verifyBackport(spec.name, root);
    });
    it(`${spec.name} fails closed for a changed version or any changed runtime file`, () => {
      const root = copyPackage(spec.name);
      const metadataFile = join(root, 'package.json');
      const metadata = readFileSync(metadataFile, 'utf8');
      writeFileSync(metadataFile, metadata.replace(`"${spec.version}"`, '"99.0.0"'));
      expect(() => verifyBackport(spec.name, root)).toThrow(/Unsupported/);
      expect(() => applyBackport(spec.name, root)).toThrow(/Unsupported/);
      writeFileSync(metadataFile, metadata);
      for (const file of spec.files) {
        const target = join(root, file.path);
        const original = readFileSync(target);
        writeFileSync(target, Buffer.concat([original, Buffer.from('\n// changed\n')]));
        expect(() => verifyBackport(spec.name, root)).toThrow(/Missing or unexpected/);
        expect(() => applyBackport(spec.name, root)).toThrow(/Unexpected/);
        writeFileSync(target, original);
      }
    });
  }
  it('discovers and verifies every nested npm copy, including paths only in the audit report', () => {
    const root = copyPackage('braces');
    const directory = mkdtempSync(join(tmpdir(), 'TEST-npm-security-'));
    temporary.push(directory);
    for (const path of ['node_modules/braces', 'node_modules/parent/node_modules/braces'])
      cpSync(root, join(directory, path), { recursive: true });
    writeFileSync(
      join(directory, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/braces': {} } })
    );
    const copies = installedBackportPackages('braces', directory, {
      npm: true,
      nodes: ['node_modules/parent/node_modules/braces'],
    });
    expect(copies).toHaveLength(2);
    for (const copy of copies) verifyBackport('braces', copy);
    writeFileSync(join(copies[1], 'lib/parse.js'), 'throw new Error("tampered");');
    expect(() => {
      for (const copy of copies) verifyBackport('braces', copy);
    }).toThrow(/Missing or unexpected/);
    expect(() =>
      installedBackportPackages('braces', directory, {
        npm: true,
        nodes: ['../node_modules/braces'],
      })
    ).toThrow(/Unsafe/);
  });
});

describe('audit backport exceptions stay bounded', () => {
  const pnpmReport = (name: string, advisory: string, version: string) => ({
    advisories: {
      '1': {
        severity: 'high',
        module_name: name,
        url: `https://github.com/advisories/${advisory}`,
        findings: [{ version }],
      },
    },
    metadata: { vulnerabilities: { high: 1, critical: 0 } },
  });
  for (const spec of BACKPORTS)
    it(`requires exact ${spec.name} advisory, version and verification`, () => {
      const options = { backported: [spec.name] };
      const report = pnpmReport(spec.name, spec.advisory, spec.version);
      expect(assessAuditReport(report).blocked).toEqual(['1']);
      expect(assessAuditReport(report, options).blocked).toEqual([]);
      for (const changed of [
        pnpmReport('other', spec.advisory, spec.version),
        pnpmReport(spec.name, 'GHSA-aaaa-bbbb-cccc', spec.version),
        pnpmReport(spec.name, spec.advisory, '99.0.0'),
      ])
        expect(assessAuditReport(changed, options).blocked).toEqual(['1']);
    });
  it('does not hide an unrelated HIGH leaf in an npm metavulnerability or cycle', () => {
    const leaf = (name: string, advisory: string) => ({
      name,
      dependency: name,
      severity: 'high',
      url: `https://github.com/advisories/${advisory}`,
    });
    const report = {
      auditReportVersion: 2,
      vulnerabilities: {
        braces: { name: 'braces', severity: 'high', via: [leaf('braces', BACKPORTS[0].advisory)] },
        parent: {
          name: 'parent',
          severity: 'high',
          via: ['braces', 'parent', leaf('other', 'GHSA-aaaa-bbbb-cccc')],
        },
      },
      metadata: { vulnerabilities: { high: 2, critical: 0 } },
    };
    expect(assessAuditReport(report, { npm: true, backported: ['braces'] })).toEqual({
      blocked: ['parent'],
      excepted: ['braces'],
    });
  });
});
