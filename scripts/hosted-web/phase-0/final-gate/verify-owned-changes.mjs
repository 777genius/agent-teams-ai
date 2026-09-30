import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const canonicalHead = '3bc0dfa7c00261785c0c752270cb302a9294e751';
const allowedPaths = [
  /^docs\/research\/hosted-web\/phase-0\/final-gate\//,
  /^scripts\/hosted-web\/phase-0\/final-gate\//,
  /^test\/architecture\/hosted-web\/phase-0\/final-gate\//,
  /^\.codex-handoff\/final-gate-candidate-reconcile-h4\.json$/,
];
const secretPatterns = [
  [
    'private_key',
    new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join('')),
  ],
  ['openai_key', new RegExp(['s', 'k-[A-Za-z0-9_-]{20,}'].join(''))],
  ['aws_access_key', new RegExp(['AK', 'IA[0-9A-Z]{16}'].join(''))],
  ['github_token', new RegExp(['gh', '[pousr]_[A-Za-z0-9]{30,}'].join(''))],
  ['slack_token', new RegExp(['xo', 'x[baprs]-[A-Za-z0-9-]{20,}'].join(''))],
];
const useCapturedGit = process.argv.includes('--captured-git');

function gitChangedPaths() {
  if (useCapturedGit) {
    const output = process.env.PHASE0_OWNED_CHANGES_STATUS;
    if (output === undefined) throw new Error('missing captured Git status');
    return parseChangedPaths(output.split('\n').filter(Boolean));
  }
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr.trim() || 'git status failed');
  }
  return parseChangedPaths(result.stdout.split('\0').filter(Boolean));
}

function parseChangedPaths(records) {
  return records.map((record) => {
    const status = record.slice(0, 2);
    const payload = record.slice(3);
    const renamedPath = payload.includes(' -> ') ? payload.split(' -> ').at(-1) : payload;
    return { path: renamedPath.replaceAll('\\', '/'), status };
  });
}

function gitHead() {
  if (useCapturedGit) {
    const head = process.env.PHASE0_OWNED_CHANGES_HEAD;
    if (head === undefined) throw new Error('missing captured Git HEAD');
    return head.trim();
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr.trim() || 'git rev-parse failed');
  }
  return result.stdout.trim();
}

const startedAt = process.hrtime.bigint();
const observedHead = gitHead();
const changes = gitChangedPaths();
const scopeViolations = changes.filter(
  (change) => !allowedPaths.some((allowed) => allowed.test(change.path))
);
const secretFindings = [];
for (const change of changes) {
  if (change.status.includes('D')) continue;
  const content = readFileSync(path.join(repositoryRoot, change.path), 'utf8');
  for (const [id, pattern] of secretPatterns) {
    if (pattern.test(content)) secretFindings.push({ path: change.path, pattern: id });
  }
}
const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
const report = {
  schemaVersion: 1,
  gate: 'phase-0-final-gate-owned-scope-and-secrets',
  passed:
    observedHead === canonicalHead && scopeViolations.length === 0 && secretFindings.length === 0,
  durationMs: Math.round(durationMs * 100) / 100,
  canonicalHead,
  observedHead,
  changedPaths: changes.map((change) => change.path).sort(),
  scopeViolations,
  secretFindings,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
