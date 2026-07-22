import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_LINES = 800;
const POLICY_URL = new URL('./source-file-size-baseline.json', import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SOURCE_EXTENSION_PATTERN =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|css|scss|sass|less|html|sh)$/i;
const GENERATED_SOURCE_PATHS = new Set(['src/features/localization/renderer/resources.d.ts']);
const TEST_FILE_PATTERN =
  /(?:^|\/)[^/]*\.(?:test|spec)(?:\.[^/]+)*\.[^/]+$|\.safe-e2e\.|\.integration\.test\./i;
const EXCLUDED_SEGMENT_PATTERN =
  /(?:^|\/)(?:test|tests|__tests__|fixture|fixtures|mock|mocks|__mocks__|e2e|smoke)(?:\/|$)/i;
const EXCLUDED_ROOT_PATTERN =
  /^(?:docs|resources|vendor|public|coverage|dist|dist-electron|build|out|node_modules)\//i;
const TEST_SCRIPT_PATTERN = /^scripts\/(?:prove-[^/]+|[^/]*(?:smoke|e2e)[^/]*)\.[^/]+$/i;

export function normalizeRepoPath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isProductionSourcePath(filePath) {
  const normalizedPath = normalizeRepoPath(filePath);
  return (
    SOURCE_EXTENSION_PATTERN.test(normalizedPath) &&
    !GENERATED_SOURCE_PATHS.has(normalizedPath) &&
    !TEST_FILE_PATTERN.test(normalizedPath) &&
    !EXCLUDED_SEGMENT_PATTERN.test(normalizedPath) &&
    !EXCLUDED_ROOT_PATTERN.test(normalizedPath) &&
    !TEST_SCRIPT_PATTERN.test(normalizedPath)
  );
}

export function countPhysicalLines(contents) {
  if (contents.length === 0) return 0;
  const newlineCount = contents.match(/\n/g)?.length ?? 0;
  return newlineCount + (contents.endsWith('\n') ? 0 : 1);
}

export function evaluateSourceFileSizes(records, policy) {
  const maxLines = policy.maxLines ?? DEFAULT_MAX_LINES;
  const legacy = policy.legacy ?? {};
  const sourceRecords = records
    .map((record) => ({ ...record, path: normalizeRepoPath(record.path) }))
    .filter((record) => isProductionSourcePath(record.path));
  const recordsByPath = new Map(sourceRecords.map((record) => [record.path, record]));
  const violations = [];
  const ratchetCandidates = [];

  if (!Number.isInteger(maxLines) || maxLines < 1) {
    violations.push({
      code: 'invalid-policy',
      message: `Policy maxLines must be a positive integer, got ${String(maxLines)}.`,
    });
  }

  for (const [legacyPath, legacyCap] of Object.entries(legacy)) {
    const normalizedPath = normalizeRepoPath(legacyPath);
    if (!isProductionSourcePath(normalizedPath)) {
      violations.push({
        code: 'invalid-legacy-path',
        path: normalizedPath,
        message: `${normalizedPath}: legacy exception does not point to a production source file.`,
      });
      continue;
    }
    if (!Number.isInteger(legacyCap) || legacyCap <= maxLines) {
      violations.push({
        code: 'invalid-legacy-cap',
        path: normalizedPath,
        message: `${normalizedPath}: legacy cap must be an integer above ${maxLines}, got ${String(legacyCap)}.`,
      });
      continue;
    }
    if (!recordsByPath.has(normalizedPath)) {
      violations.push({
        code: 'missing-legacy-file',
        path: normalizedPath,
        message: `${normalizedPath}: file was removed; remove its stale legacy exception.`,
      });
    }
  }

  for (const record of sourceRecords) {
    const legacyCap = legacy[record.path];
    if (record.lineCount <= maxLines) {
      if (legacyCap !== undefined) {
        violations.push({
          code: 'retired-legacy-file',
          path: record.path,
          lineCount: record.lineCount,
          message: `${record.path}: now ${record.lineCount} lines; remove its retired legacy exception.`,
        });
      }
      continue;
    }

    if (legacyCap === undefined) {
      violations.push({
        code: 'new-oversized-file',
        path: record.path,
        lineCount: record.lineCount,
        message: `${record.path}: ${record.lineCount} lines exceeds the ${maxLines}-line limit. Split the file instead of adding a new exception.`,
      });
      continue;
    }

    if (record.lineCount > legacyCap) {
      violations.push({
        code: 'legacy-file-grew',
        path: record.path,
        lineCount: record.lineCount,
        message: `${record.path}: legacy file grew to ${record.lineCount} lines; its frozen cap is ${legacyCap}.`,
      });
    } else if (record.lineCount < legacyCap) {
      ratchetCandidates.push({
        path: record.path,
        lineCount: record.lineCount,
        legacyCap,
      });
    }
  }

  return {
    checkedFiles: sourceRecords.length,
    legacyFiles: Object.keys(legacy).length,
    maxLines,
    ratchetCandidates,
    violations,
  };
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean);
}

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readWorkingTreeRecords() {
  const fileNames = splitNullDelimited(
    gitOutput(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  );
  return fileNames
    .filter(isProductionSourcePath)
    .filter((fileName) => existsSync(path.join(REPO_ROOT, fileName)))
    .map((fileName) => {
      const contents = readFileSync(path.join(REPO_ROOT, fileName), 'utf8');
      return { path: normalizeRepoPath(fileName), lineCount: countPhysicalLines(contents) };
    });
}

function readHeadRecords() {
  const changedPaths = new Set(
    splitNullDelimited(gitOutput(['diff', '--name-only', '-z', 'HEAD']))
  );
  const fileNames = splitNullDelimited(gitOutput(['ls-tree', '-r', '-z', '--name-only', 'HEAD']));
  return fileNames.filter(isProductionSourcePath).map((fileName) => {
    const contents = changedPaths.has(fileName)
      ? gitOutput(['show', `HEAD:${fileName}`])
      : readFileSync(path.join(REPO_ROOT, fileName), 'utf8');
    return { path: normalizeRepoPath(fileName), lineCount: countPhysicalLines(contents) };
  });
}

function loadPolicy() {
  return JSON.parse(readFileSync(POLICY_URL, 'utf8'));
}

function printBaselineFromHead() {
  const records = readHeadRecords();
  const legacy = Object.fromEntries(
    records
      .filter((record) => record.lineCount > DEFAULT_MAX_LINES)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((record) => [record.path, record.lineCount])
  );
  process.stdout.write(`${JSON.stringify({ maxLines: DEFAULT_MAX_LINES, legacy }, null, 2)}\n`);
}

function runGuard() {
  const result = evaluateSourceFileSizes(readWorkingTreeRecords(), loadPolicy());
  if (result.violations.length > 0) {
    console.error(`Source file size guard failed with ${result.violations.length} violation(s):\n`);
    for (const violation of result.violations) console.error(`- ${violation.message}`);
    console.error(
      `\nNew production files must stay at or below ${result.maxLines} physical lines. ` +
        'Legacy caps in scripts/ci/source-file-size-baseline.json may only move downward.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Source file size guard passed: ${result.checkedFiles} production files checked, ` +
      `${result.legacyFiles} frozen legacy exceptions, ${result.maxLines}-line limit.`
  );
  if (result.ratchetCandidates.length > 0) {
    console.log(
      `${result.ratchetCandidates.length} legacy file(s) are below their frozen caps; ` +
        'lower those caps when committing the refactor.'
    );
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  if (process.argv.includes('--print-baseline-from-head')) printBaselineFromHead();
  else runGuard();
}
