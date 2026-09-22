import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_URL = new URL('./team-provisioning-architecture-baseline.json', import.meta.url);

export const TEAM_PROVISIONING_ARCHITECTURE_RULES = {
  facadeInheritance: {
    pattern:
      /\bclass\s+\w+(?:\s*<[\s\S]{0,300}?>)?\s+extends\s+TeamProvisioning\w*(?:Facade|FacadeDelegates)\b/g,
    guidance: 'Use explicit composition; do not add TeamProvisioning facade inheritance.',
  },
  serviceHostDeclaration: {
    pattern: /\binterface\s+TeamProvisioning\w*ServiceHost\b/g,
    guidance: 'Use small use-case-owned ports; do not add whole-service host interfaces.',
  },
  serviceHostCast: {
    pattern: /\bas\s+unknown\s+as\s+\w*ServiceHost\b/g,
    guidance: 'Inject explicit dependencies; do not cast the service to a host shape.',
  },
  protectedAbstractDependency: {
    pattern: /\bprotected\s+abstract\s+readonly\b/g,
    guidance: 'Inject dependencies through composition instead of abstract protected slots.',
  },
  createFromServiceFactory: {
    pattern: /\bcreateTeamProvisioning\w*FromService\b/g,
    guidance: 'Build focused adapters in the composition root; do not discover them from service.',
  },
};

export function normalizeRepoPath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isProvisioningProductionPath(filePath) {
  const normalizedPath = normalizeRepoPath(filePath);
  if (!normalizedPath.endsWith('.ts')) return false;
  if (/(?:^|\/)(?:__tests__|test|tests|fixtures?)(?:\/|$)/.test(normalizedPath)) return false;
  if (/\.(?:test|spec)\.ts$/.test(normalizedPath)) return false;
  return (
    normalizedPath === 'src/main/services/team/TeamProvisioningService.ts' ||
    normalizedPath.startsWith('src/main/services/team/provisioning/')
  );
}

export function collectArchitectureOccurrences(records) {
  const occurrences = Object.fromEntries(
    Object.keys(TEAM_PROVISIONING_ARCHITECTURE_RULES).map((ruleName) => [ruleName, {}])
  );

  for (const record of records) {
    const normalizedPath = normalizeRepoPath(record.path);
    if (!isProvisioningProductionPath(normalizedPath)) continue;
    for (const [ruleName, rule] of Object.entries(TEAM_PROVISIONING_ARCHITECTURE_RULES)) {
      const count = Array.from(record.contents.matchAll(rule.pattern)).length;
      if (count > 0) occurrences[ruleName][normalizedPath] = count;
    }
  }

  return occurrences;
}

export function evaluateArchitectureRatchet(records, baseline) {
  const current = collectArchitectureOccurrences(records);
  const violations = [];

  for (const [ruleName, rule] of Object.entries(TEAM_PROVISIONING_ARCHITECTURE_RULES)) {
    const allowed = baseline.rules?.[ruleName] ?? {};
    const observed = current[ruleName];
    for (const [filePath, count] of Object.entries(observed)) {
      const cap = allowed[filePath] ?? 0;
      if (count > cap) {
        violations.push({
          code: 'architecture-debt-grew',
          ruleName,
          path: filePath,
          message: `${filePath}: ${ruleName} count is ${count}, frozen cap is ${cap}. ${rule.guidance}`,
        });
      }
    }
    for (const [filePath, cap] of Object.entries(allowed)) {
      const count = observed[filePath] ?? 0;
      if (count < cap) {
        violations.push({
          code: 'baseline-can-decrease',
          ruleName,
          path: filePath,
          message: `${filePath}: ${ruleName} decreased from ${cap} to ${count}; lower or remove its baseline entry.`,
        });
      }
    }
  }

  return { current, violations };
}

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean);
}

function readWorkingTreeRecords() {
  return splitNullDelimited(
    gitOutput(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  )
    .filter(isProvisioningProductionPath)
    .filter((filePath) => existsSync(path.join(REPO_ROOT, filePath)))
    .map((filePath) => ({
      path: normalizeRepoPath(filePath),
      contents: readFileSync(path.join(REPO_ROOT, filePath), 'utf8'),
    }));
}

function readHeadRecords() {
  const changedPaths = new Set(
    splitNullDelimited(gitOutput(['diff', '--name-only', '-z', 'HEAD']))
  );
  return splitNullDelimited(gitOutput(['ls-tree', '-r', '-z', '--name-only', 'HEAD']))
    .filter(isProvisioningProductionPath)
    .map((filePath) => ({
      path: normalizeRepoPath(filePath),
      contents: changedPaths.has(filePath)
        ? gitOutput(['show', `HEAD:${filePath}`])
        : readFileSync(path.join(REPO_ROOT, filePath), 'utf8'),
    }));
}

function printBaselineFromHead() {
  const rules = collectArchitectureOccurrences(readHeadRecords());
  for (const legacyByPath of Object.values(rules)) {
    const sortedEntries = Object.entries(legacyByPath).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    for (const key of Object.keys(legacyByPath)) delete legacyByPath[key];
    Object.assign(legacyByPath, Object.fromEntries(sortedEntries));
  }
  process.stdout.write(`${JSON.stringify({ rules }, null, 2)}\n`);
}

function runGuard() {
  const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
  const result = evaluateArchitectureRatchet(readWorkingTreeRecords(), baseline);
  if (result.violations.length > 0) {
    console.error(
      `Team Provisioning architecture guard failed with ${result.violations.length} violation(s):\n`
    );
    for (const violation of result.violations) console.error(`- ${violation.message}`);
    console.error(
      '\nFollow docs/team-management/team-provisioning-target-architecture.md. Legacy architecture baselines may only decrease.'
    );
    process.exitCode = 1;
    return;
  }

  const totals = Object.fromEntries(
    Object.entries(result.current).map(([ruleName, byPath]) => [
      ruleName,
      Object.values(byPath).reduce((sum, count) => sum + count, 0),
    ])
  );
  console.log(`Team Provisioning architecture guard passed: ${JSON.stringify(totals)}.`);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  if (process.argv.includes('--print-baseline-from-head')) printBaselineFromHead();
  else runGuard();
}
