import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVISORY, installedForgePackages, verifyForgePackage } from './node-forge-security.mjs';

const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const severe = (severity) => severity === 'high' || severity === 'critical';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function assert(condition, message) {
  if (!condition) throw new Error(`Invalid audit report: ${message}`);
}
function severity(value) {
  assert(severities.includes(value), 'unknown severity');
  return value;
}
function advisoryId(value) {
  const fromUrl =
    typeof value.url === 'string' &&
    /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(value.url)?.[1];
  assert(typeof fromUrl === 'string', 'missing advisory URL');
  assert(
    !value.github_advisory_id || value.github_advisory_id === fromUrl,
    'conflicting advisory ID'
  );
  return fromUrl;
}

// The only exception requires the exact advisory AND independently verified installed code.
export function assessAuditReport(report, { npm = false, patched = false } = {}) {
  assert(object(report) && !report.error && !report.errors, 'error or missing report');
  const entries = npm ? report.vulnerabilities : report.advisories;
  assert(object(entries), 'missing vulnerability map');
  if (npm) assert(report.auditReportVersion === 2, 'unsupported npm report version');
  const counts = report.metadata?.vulnerabilities;
  assert(object(counts), 'missing vulnerability counts');
  const items = Object.entries(entries);
  for (const [name, entry] of items) {
    assert(object(entry), `malformed ${name}`);
    severity(entry.severity);
    if (npm) {
      assert(
        entry.name === name && Array.isArray(entry.via) && entry.via.length > 0,
        `malformed npm entry ${name}`
      );
      for (const via of entry.via) {
        if (typeof via === 'string')
          assert(Object.hasOwn(entries, via), `missing dependency ${via}`);
        else {
          assert(object(via), 'malformed advisory');
          severity(via.severity);
          advisoryId(via);
        }
      }
    } else advisoryId(entry);
  }
  for (const level of ['high', 'critical']) {
    assert(
      Number.isInteger(counts[level]) &&
        counts[level] >= 0 &&
        counts[level] === items.filter(([, entry]) => entry.severity === level).length,
      `inconsistent ${level} count`
    );
  }
  const blocked = [],
    excepted = [];
  for (const [name, entry] of items) {
    if (!severe(entry.severity)) continue;
    const concrete = [];
    if (npm) {
      // npm emits cyclic metavulnerability links (Nuxt -> builder -> Nuxt).
      // Traverse once per package and assess actual advisory leaves, never grant a cycle an exception.
      const seen = new Set();
      const visit = (key) => {
        if (seen.has(key)) return;
        seen.add(key);
        for (const via of entries[key].via)
          typeof via === 'string' ? visit(via) : concrete.push(via);
      };
      visit(name);
    } else concrete.push(entry);
    const high = concrete.filter((item) => severe(item.severity));
    const allowed =
      patched &&
      high.length > 0 &&
      high.every(
        (item) =>
          advisoryId(item) === ADVISORY &&
          (npm
            ? item.name === 'node-forge' && item.dependency === 'node-forge'
            : item.module_name === 'node-forge')
      );
    (allowed ? excepted : blocked).push(name);
  }
  return { blocked, excepted };
}

export function auditDependencies({ npm = false, cwd = process.cwd() } = {}) {
  const command = npm ? 'npm' : 'pnpm';
  const args = npm
    ? ['audit', '--audit-level', 'high', '--json']
    : ['dlx', 'pnpm@11.4.0', '--pm-on-fail=ignore', 'audit', '--audit-level', 'high', '--json'];
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180000,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error(
      `Audit command failed: ${result.error?.message ?? result.signal ?? result.status}`
    );
  const report = JSON.parse(result.stdout);
  // First validate the report without an exception; malformed/infrastructure errors fail closed.
  const original = assessAuditReport(report, { npm });
  if (result.status === 1 && original.blocked.length === 0)
    throw new Error('Audit failed without a reported HIGH/CRITICAL vulnerability');
  if (result.status === 0 && original.blocked.length > 0)
    throw new Error('Audit exit status disagrees with vulnerability report');
  let patched = false;
  if (original.blocked.length > 0) {
    const targets = installedForgePackages(cwd, { npm });
    for (const target of targets) verifyForgePackage(target);
    // npm may report nested copies beyond the hoisted package.
    if (npm) {
      const nodes = report.vulnerabilities['node-forge']?.nodes;
      if (nodes) {
        assert(
          Array.isArray(nodes) &&
            nodes.length > 0 &&
            nodes.every(
              (node) => typeof node === 'string' && node.endsWith('node_modules/node-forge')
            ),
          'invalid node-forge install paths'
        );
        for (const node of nodes) verifyForgePackage(resolve(cwd, node));
      }
    }
    patched = true;
  }
  const assessed = assessAuditReport(report, { npm, patched });
  // Retain the full raw report so advisories below the chosen threshold remain visible.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (assessed.excepted.length)
    console.log(`Verified local security backport: ${ADVISORY} (${assessed.excepted.join(', ')})`);
  if (assessed.blocked.length)
    throw new Error(`Unresolved HIGH/CRITICAL vulnerabilities: ${assessed.blocked.join(', ')}`);
  return assessed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--npm'))
      throw new Error('Usage: node audit-dependencies.mjs [--npm]');
    auditDependencies({ npm: process.argv[2] === '--npm' });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
