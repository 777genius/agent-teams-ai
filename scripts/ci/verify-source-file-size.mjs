#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateSourceFileSizes as evaluateBroadSourceFileSizes,
  readWorkingTreeRecords as readBroadWorkingTreeRecords,
  strictSourceFileSizeViolations,
} from './check-source-file-size.mjs';

export const MAX_PRODUCTION_SOURCE_LINES = 800;

export const SOURCE_ROOTS = [
  'src',
  'packages',
  'agent-teams-controller/src',
  'landing',
  'mcp-server/src',
];
const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.less',
  '.sass',
  '.scss',
  '.ts',
  '.tsx',
  '.vue',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.nuxt',
  '.output',
  '__fixtures__',
  '__tests__',
  'coverage',
  'dist',
  'fixtures',
  'node_modules',
  'public',
]);
const TEST_FILE_PATTERN = /\.(?:spec|test)\.[^.]+$/;
const DECLARATION_FILE_PATTERN = /\.d\.(?:cts|mts|ts)$/;

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const legacyManifestPath = path.join(repoRoot, 'scripts', 'ci', 'source-file-size-legacy.json');
const legacyManifestRelativePath = normalizeRelativePath(
  path.relative(repoRoot, legacyManifestPath)
);
const policyManifestPath = path.join(repoRoot, 'scripts', 'ci', 'source-file-size-baseline.json');
const policyManifestRelativePath = normalizeRelativePath(
  path.relative(repoRoot, policyManifestPath)
);
const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
const NO_PRIOR_COMMIT_REF = '0'.repeat(40);

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function countPhysicalLines(source) {
  if (source.length === 0) return 0;
  const separators = source.match(/\r\n|\r|\n/g)?.length ?? 0;
  return separators + (source.endsWith('\n') || source.endsWith('\r') ? 0 : 1);
}

export function isProductionSourcePath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  const segments = normalized.split('/');
  const belongsToSourceRoot = SOURCE_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`)
  );

  if (!belongsToSourceRoot) return false;
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return false;
  if (DECLARATION_FILE_PATTERN.test(normalized)) return false;
  if (TEST_FILE_PATTERN.test(normalized)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(normalized));
}

export function parseWorkspacePackagePatterns(workspaceSource) {
  const packageBlock =
    /^packages:\s*\n((?:[ \t]+-[^\n]*(?:\n|$))*)/m.exec(workspaceSource)?.[1] ?? '';
  return packageBlock
    .split(/\r?\n/)
    .map((line) => /^[ \t]+-[ \t]+(.+?)[ \t]*$/.exec(line)?.[1])
    .filter(Boolean)
    .map((pattern) => pattern.replace(/^(['"])(.*)\1$/, '$2'));
}

export function evaluateWorkspaceSourceCoverage({
  sourceRoots = SOURCE_ROOTS,
  workspacePackagePatterns,
}) {
  return workspacePackagePatterns
    .filter(
      (pattern) =>
        !sourceRoots.some(
          (root) =>
            root === pattern || root.startsWith(`${pattern}/`) || pattern.startsWith(`${root}/`)
        )
    )
    .map((pattern) => ({
      code: 'uncovered-workspace-package',
      filePath: 'pnpm-workspace.yaml',
      message: `workspace package ${pattern} has no production source root`,
    }));
}

export function collectFiles(rootPath) {
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) return [];
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) return collectFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

export function collectProductionSourceLineCounts(root = repoRoot) {
  const lineCounts = new Map();

  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = path.join(root, sourceRoot);
    for (const absolutePath of collectFiles(absoluteRoot)) {
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      if (!isProductionSourcePath(relativePath)) continue;
      lineCounts.set(relativePath, countPhysicalLines(readFileSync(absolutePath, 'utf8')));
    }
  }

  return lineCounts;
}

export function evaluateSourceFileSizePolicy({
  lineCounts,
  legacyMaxLines,
  maxLines = MAX_PRODUCTION_SOURCE_LINES,
}) {
  const diagnostics = [];

  for (const [filePath, legacyLimit] of Object.entries(legacyMaxLines).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (!Number.isSafeInteger(legacyLimit) || legacyLimit <= maxLines) {
      diagnostics.push({
        code: 'invalid-legacy-cap',
        filePath,
        message: `legacy cap must be an integer greater than ${maxLines}, got ${legacyLimit}`,
      });
      continue;
    }
    if (!isProductionSourcePath(filePath)) {
      diagnostics.push({
        code: 'invalid-legacy-path',
        filePath,
        message: 'legacy exception does not point to an included production source file',
      });
      continue;
    }

    const actualLines = lineCounts.get(filePath);
    if (actualLines === undefined) {
      diagnostics.push({
        code: 'missing-legacy-file',
        filePath,
        message: 'legacy exception points to a missing file and must be removed',
      });
      continue;
    }
    if (actualLines <= maxLines) {
      diagnostics.push({
        code: 'stale-legacy-exception',
        filePath,
        message: `${actualLines} lines is within the ${maxLines}-line limit; remove the exception`,
      });
      continue;
    }
    if (actualLines !== legacyLimit) {
      diagnostics.push({
        code: actualLines > legacyLimit ? 'legacy-file-grew' : 'legacy-cap-not-tight',
        filePath,
        message: `${actualLines} lines does not match the ratcheted cap ${legacyLimit}`,
      });
    }
  }

  for (const [filePath, actualLines] of [...lineCounts.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (actualLines > maxLines && legacyMaxLines[filePath] === undefined) {
      diagnostics.push({
        code: 'unapproved-oversized-file',
        filePath,
        message: `${actualLines} lines exceeds the ${maxLines}-line production source limit`,
      });
    }
  }

  return diagnostics;
}

export function evaluateLegacyManifestRatchet({
  baselineLegacyMaxLines,
  baselineSourceLineCounts = new Map(),
  legacyMaxLines,
}) {
  if (baselineLegacyMaxLines === null) return [];

  const diagnostics = [];
  for (const [filePath, legacyLimit] of Object.entries(legacyMaxLines).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const manifestLimit = baselineLegacyMaxLines[filePath] ?? 0;
    const sourceLimit = baselineSourceLineCounts.get(filePath) ?? 0;
    const effectiveBaselineLimit = Math.max(manifestLimit, sourceLimit);
    if (effectiveBaselineLimit <= MAX_PRODUCTION_SOURCE_LINES) {
      diagnostics.push({
        code: 'new-legacy-exception',
        filePath,
        message: 'new legacy exceptions are forbidden; split the file below the global limit',
      });
    } else if (legacyLimit > effectiveBaselineLimit) {
      diagnostics.push({
        code: 'raised-legacy-cap',
        filePath,
        message:
          `legacy cap ${legacyLimit} exceeds the base source/manifest cap ` +
          `${effectiveBaselineLimit}`,
      });
    }
  }

  return diagnostics;
}

export function evaluatePolicyManifestRatchet({ baselinePolicy, policy }) {
  if (baselinePolicy === null) return [];

  const diagnostics = [];
  if (policy.maxLines > baselinePolicy.maxLines) {
    diagnostics.push({
      code: 'raised-global-limit',
      filePath: policyManifestRelativePath,
      message: `global limit ${policy.maxLines} exceeds the base limit ${baselinePolicy.maxLines}`,
    });
  }
  diagnostics.push(
    ...evaluateLegacyManifestRatchet({
      baselineLegacyMaxLines: baselinePolicy.legacy,
      legacyMaxLines: policy.legacy,
    })
  );
  return diagnostics;
}

export function evaluatePolicyCurrentFiles({ policy, records }) {
  return strictSourceFileSizeViolations(evaluateBroadSourceFileSizes(records, policy)).map(
    ({ code, message, path: filePath }) => ({
      code,
      filePath: filePath ?? policyManifestRelativePath,
      message,
    })
  );
}

function readBaselineManifest(baselineRef, manifestRelativePath) {
  if (!baselineRef) return null;
  if (!/^[0-9a-f]{40}$/i.test(baselineRef)) {
    throw new Error('SOURCE_FILE_SIZE_BASELINE_REF must be a 40-character commit SHA');
  }

  const objectName = `${baselineRef}:${manifestRelativePath}`;
  try {
    execFileSync('git', ['cat-file', '-e', objectName], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch {
    return null;
  }

  return JSON.parse(
    execFileSync('git', ['show', objectName], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
  );
}

function readBaselineSourceLineCounts(baselineRef, filePaths) {
  if (!baselineRef) return new Map();
  if (!/^[0-9a-f]{40}$/i.test(baselineRef)) {
    throw new Error('SOURCE_FILE_SIZE_BASELINE_REF must be a 40-character commit SHA');
  }

  const lineCounts = new Map();
  for (const filePath of filePaths) {
    const objectName = `${baselineRef}:${filePath}`;
    try {
      execFileSync('git', ['cat-file', '-e', objectName], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
    } catch {
      continue;
    }
    lineCounts.set(
      filePath,
      countPhysicalLines(
        execFileSync('git', ['show', objectName], {
          cwd: repoRoot,
          encoding: 'utf8',
        })
      )
    );
  }
  return lineCounts;
}

export function verifySourceFileSizePolicy(root = repoRoot, { requireBaseline = false } = {}) {
  const legacyMaxLines = JSON.parse(readFileSync(legacyManifestPath, 'utf8'));
  const policy = JSON.parse(readFileSync(policyManifestPath, 'utf8'));
  const configuredBaselineRef = process.env.SOURCE_FILE_SIZE_BASELINE_REF;
  const baselineRef = configuredBaselineRef === NO_PRIOR_COMMIT_REF ? null : configuredBaselineRef;
  const baselineRequired = requireBaseline && configuredBaselineRef !== NO_PRIOR_COMMIT_REF;
  if (baselineRequired && !baselineRef) {
    throw new Error('SOURCE_FILE_SIZE_BASELINE_REF is required in source-size ratchet mode');
  }
  const baselineLegacyManifest = readBaselineManifest(baselineRef, legacyManifestRelativePath);
  // Pre-ratchet baselines have no legacy manifest; exact baseline source counts below
  // still bound every current exception when a real baseline ref was supplied.
  const baselineLegacyMaxLines = baselineLegacyManifest ?? (baselineRef ? {} : null);
  const baselinePolicy = readBaselineManifest(baselineRef, policyManifestRelativePath);
  if (baselineRequired && baselinePolicy === null) {
    throw new Error(
      `SOURCE_FILE_SIZE_BASELINE_REF must resolve to ${policyManifestRelativePath} ` +
        'in source-size ratchet mode'
    );
  }
  const baselineSourceLineCounts = readBaselineSourceLineCounts(
    baselineRef,
    Object.keys(legacyMaxLines)
  );
  const workspacePackagePatterns = parseWorkspacePackagePatterns(
    readFileSync(workspacePath, 'utf8')
  );
  const lineCounts = collectProductionSourceLineCounts(root);
  const diagnostics = [
    ...evaluateWorkspaceSourceCoverage({ workspacePackagePatterns }),
    ...evaluatePolicyManifestRatchet({ baselinePolicy, policy }),
    ...evaluatePolicyCurrentFiles({
      policy,
      records: readBroadWorkingTreeRecords(root),
    }),
    ...evaluateLegacyManifestRatchet({
      baselineLegacyMaxLines,
      baselineSourceLineCounts,
      legacyMaxLines,
    }),
    ...evaluateSourceFileSizePolicy({ lineCounts, legacyMaxLines }),
  ];

  if (diagnostics.length > 0) {
    const details = diagnostics
      .map(({ code, filePath, message }) => `  - [${code}] ${filePath}: ${message}`)
      .join('\n');
    throw new Error(`Production source file-size policy failed:\n${details}`);
  }

  return {
    legacyFileCount: Object.keys(legacyMaxLines).length,
    productionFileCount: lineCounts.size,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = verifySourceFileSizePolicy(repoRoot, {
      requireBaseline: process.argv.includes('--require-baseline'),
    });
    console.log(
      `[source-file-size] OK: ${result.productionFileCount} production files, ` +
        `${result.legacyFileCount} ratcheted legacy exceptions, ` +
        `${MAX_PRODUCTION_SOURCE_LINES}-line limit`
    );
  } catch (error) {
    console.error(`[source-file-size] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
