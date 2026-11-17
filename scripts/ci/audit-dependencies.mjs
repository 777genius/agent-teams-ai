import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKPORTS, installedBackportPackages, verifyBackport } from './transitive-security.ts';

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

const ACCEPTED_RISKS_FILE = new URL('./audit-accepted-risks.json', import.meta.url);
// Time-boxed acceptances for advisories that have no patched release yet. Each entry names the
// exact advisory, package, audit mode (pnpm or npm) and installed versions, so a new advisory, a
// new package or a new version still fails the audit; an expired entry stops applying and the
// audit fails again.
export function loadAcceptedRisks({ now = new Date(), file = ACCEPTED_RISKS_FILE } = {}) {
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  assert(Array.isArray(entries), 'accepted risks must be a list');
  const active = [];
  for (const entry of entries) {
    assert(object(entry), 'malformed accepted risk');
    assert(/^GHSA(-[a-z0-9]{4}){3}$/.test(entry.advisory), 'accepted risk needs a GHSA id');
    assert(typeof entry.package === 'string' && entry.package, 'accepted risk needs a package');
    assert(['pnpm', 'npm'].includes(entry.mode), 'accepted risk needs a pnpm or npm mode');
    assert(
      Array.isArray(entry.versions) &&
        entry.versions.length > 0 &&
        entry.versions.every((version) => typeof version === 'string' && /^\d/.test(version)),
      'accepted risk needs exact versions'
    );
    assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.expires), 'accepted risk needs an expires date');
    assert(
      typeof entry.reason === 'string' && entry.reason.length > 20,
      'accepted risk needs a reason'
    );
    const end = Date.parse(`${entry.expires}T23:59:59Z`);
    assert(Number.isFinite(end), 'accepted risk has an invalid expires date');
    if (now.getTime() <= end) active.push(entry);
    else console.error(`Accepted risk ${entry.advisory} expired on ${entry.expires}`);
  }
  return active;
}

// npm reports list install paths but not versions; read them from the lockfile of the audited tree.
function npmLockVersions(cwd) {
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  assert(object(lock?.packages), 'missing npm lockfile packages');
  return Object.fromEntries(
    Object.entries(lock.packages).map(([path, entry]) => [path, object(entry) && entry.version])
  );
}

// Exceptions require exact advisories/packages AND independently verified installed code,
// or an unexpired accepted risk that names the advisory, package, mode and every installed version.
export function assessAuditReport(
  report,
  { npm = false, backported = [], accepted = [], lockVersions = {} } = {}
) {
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
        for (const via of entries[key].via) {
          if (typeof via === 'string') visit(via);
          else concrete.push(via);
        }
      };
      visit(name);
    } else concrete.push(entry);
    const high = concrete.filter((item) => severe(item.severity));
    const allowed =
      high.length > 0 &&
      high.every((item) => {
        const risk = accepted.find(
          (candidate) =>
            candidate.advisory === advisoryId(item) && candidate.mode === (npm ? 'npm' : 'pnpm')
        );
        if (
          risk &&
          !npm &&
          item.module_name === risk.package &&
          Array.isArray(item.findings) &&
          item.findings.length > 0 &&
          item.findings.every((finding) => risk.versions.includes(finding.version))
        )
          return true;
        // npm lists every installed copy of the vulnerable package as `nodes`; each one must be a
        // listed version according to the lockfile, otherwise the risk does not apply.
        if (
          risk &&
          npm &&
          item.name === risk.package &&
          item.dependency === risk.package &&
          Array.isArray(entries[risk.package]?.nodes) &&
          entries[risk.package].nodes.length > 0 &&
          entries[risk.package].nodes.every((node) => risk.versions.includes(lockVersions[node]))
        )
          return true;
        const spec = BACKPORTS.find((candidate) => candidate.advisory === advisoryId(item));
        if (!spec || !backported.includes(spec.name)) return false;
        if (npm) return item.name === spec.name && item.dependency === spec.name;
        return (
          item.module_name === spec.name &&
          Array.isArray(item.findings) &&
          item.findings.length > 0 &&
          item.findings.every((finding) => finding.version === spec.version)
        );
      });
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
  const backported = [];
  for (const spec of BACKPORTS) {
    const reported = npm
      ? report.vulnerabilities[spec.name]?.via?.some(
          (item) => object(item) && advisoryId(item) === spec.advisory
        )
      : Object.values(report.advisories).some((item) => advisoryId(item) === spec.advisory);
    if (!reported) continue;
    const nodes = npm ? report.vulnerabilities[spec.name].nodes : [];
    assert(
      Array.isArray(nodes) &&
        nodes.every(
          (node) => typeof node === 'string' && node.endsWith(`node_modules/${spec.name}`)
        ),
      'invalid backport install paths'
    );
    const targets = installedBackportPackages(spec.name, cwd, { npm, nodes });
    if (targets.length === 0) throw new Error(`No installed ${spec.name} package found in ${cwd}`);
    for (const target of targets) verifyBackport(spec.name, target);
    backported.push(spec.name);
  }
  const accepted = loadAcceptedRisks();
  const lockVersions = npm ? npmLockVersions(cwd) : {};
  const assessed = assessAuditReport(report, { npm, backported, accepted, lockVersions });
  // Retain the full raw report so advisories below the chosen threshold remain visible.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (assessed.excepted.length) {
    const advisories = BACKPORTS.filter((spec) => backported.includes(spec.name)).map(
      (spec) => spec.advisory
    );
    if (advisories.length)
      console.log(
        `Verified local security backports: ${advisories.join(', ')} (${assessed.excepted.join(', ')})`
      );
    for (const risk of accepted.filter((candidate) => candidate.mode === (npm ? 'npm' : 'pnpm')))
      console.log(
        `Accepted risk until ${risk.expires}: ${risk.advisory} (${risk.package} ${risk.versions.join(', ')})`
      );
  }
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
