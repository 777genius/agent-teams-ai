#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
  compareViolations,
  toBaselineEntry,
  violationKey,
} from './feature-architecture-policy.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const baselineRelativePath = 'scripts/ci/feature-architecture-baseline.json';
const BASELINE_VERSION = 1;
const KNOWN_RULES = new Set(Object.values(FEATURE_ARCHITECTURE_RULES));

function diagnostic(code, message, entry) {
  return { code, entry, message };
}

function sameObjectKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

export function validateFeatureArchitectureBaseline(manifest) {
  const diagnostics = [];
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest) ||
    !sameObjectKeys(manifest, ['version', 'violations'])
  ) {
    return {
      diagnostics: [
        diagnostic(
          'invalid-baseline-shape',
          'baseline must contain exactly version and violations',
          null
        ),
      ],
      entries: [],
    };
  }
  if (manifest.version !== BASELINE_VERSION || !Array.isArray(manifest.violations)) {
    return {
      diagnostics: [
        diagnostic(
          'invalid-baseline-version',
          `baseline version must be ${BASELINE_VERSION} and violations must be an array`,
          null
        ),
      ],
      entries: [],
    };
  }

  const entries = [];
  const seenKeys = new Set();
  for (const entry of manifest.violations) {
    const hasPublicEntrypoint =
      typeof entry === 'object' && entry !== null && 'publicEntrypoint' in entry;
    const expectedKeys = hasPublicEntrypoint
      ? ['publicEntrypoint', 'rule', 'source', 'specifier']
      : ['rule', 'source', 'specifier'];
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      !sameObjectKeys(entry, expectedKeys) ||
      typeof entry.rule !== 'string' ||
      typeof entry.source !== 'string' ||
      typeof entry.specifier !== 'string' ||
      (hasPublicEntrypoint && typeof entry.publicEntrypoint !== 'string')
    ) {
      diagnostics.push(
        diagnostic(
          'invalid-baseline-entry',
          'each entry must contain rule, source, specifier, and optional publicEntrypoint strings',
          entry
        )
      );
      continue;
    }
    if (
      entry.source.length === 0 ||
      !entry.source.startsWith('src/') ||
      entry.source.includes('\\') ||
      entry.specifier.length === 0 ||
      (hasPublicEntrypoint &&
        (entry.publicEntrypoint.length === 0 ||
          !entry.publicEntrypoint.startsWith('src/features/') ||
          entry.publicEntrypoint.includes('\\')))
    ) {
      diagnostics.push(
        diagnostic(
          'invalid-baseline-path',
          'baseline paths must be non-empty normalized production source paths',
          entry
        )
      );
      continue;
    }
    if (!KNOWN_RULES.has(entry.rule)) {
      diagnostics.push(
        diagnostic('unknown-baseline-rule', `unknown architecture rule ${entry.rule}`, entry)
      );
      continue;
    }
    if (
      !entry.publicEntrypoint &&
      entry.rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    ) {
      diagnostics.push(
        diagnostic(
          'missing-public-entrypoint',
          'public API export violations must identify the exposing entrypoint',
          entry
        )
      );
      continue;
    }
    if (
      entry.publicEntrypoint &&
      entry.rule !== FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    ) {
      diagnostics.push(
        diagnostic(
          'unexpected-public-entrypoint',
          'publicEntrypoint is valid only for public API export violations',
          entry
        )
      );
      continue;
    }

    const key = violationKey(entry);
    if (seenKeys.has(key)) {
      diagnostics.push(
        diagnostic('duplicate-baseline-entry', 'baseline entry is duplicated', entry)
      );
      continue;
    }
    seenKeys.add(key);
    entries.push(entry);
  }

  const sortedEntries = [...entries].sort(compareViolations);
  if (entries.some((entry, index) => violationKey(entry) !== violationKey(sortedEntries[index]))) {
    diagnostics.push(
      diagnostic(
        'unsorted-baseline',
        'baseline entries must use canonical rule/path ordering',
        null
      )
    );
  }

  return { diagnostics, entries };
}

export function evaluateFeatureArchitectureRatchet({
  baselineEntries,
  baselineReferenceEntries,
  violations,
}) {
  const diagnostics = [];
  const actualByKey = new Map(violations.map((violation) => [violationKey(violation), violation]));
  const baselineByKey = new Map(baselineEntries.map((entry) => [violationKey(entry), entry]));

  for (const [key, violation] of actualByKey) {
    if (!baselineByKey.has(key)) {
      diagnostics.push(
        diagnostic('new-architecture-violation', violation.message, toBaselineEntry(violation))
      );
    }
  }
  for (const [key, entry] of baselineByKey) {
    if (!actualByKey.has(key)) {
      diagnostics.push(
        diagnostic(
          'stale-baseline-entry',
          'the dependency edge no longer violates the policy; remove this baseline entry',
          entry
        )
      );
    }
  }

  if (baselineReferenceEntries !== null) {
    const referenceKeys = new Set(baselineReferenceEntries.map(violationKey));
    for (const [key, entry] of baselineByKey) {
      if (!referenceKeys.has(key)) {
        diagnostics.push(
          diagnostic(
            'baseline-expansion',
            'new baseline exceptions are forbidden; fix the dependency direction instead',
            entry
          )
        );
      }
    }
  }

  return diagnostics;
}

function readManifest(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }
}

function readBaselineReferenceManifest(baselineRef, root) {
  if (!baselineRef) return null;
  if (!/^[0-9a-f]{40}$/i.test(baselineRef)) {
    throw new Error('FEATURE_ARCHITECTURE_BASELINE_REF must be a 40-character commit SHA');
  }

  const objectName = `${baselineRef}:${baselineRelativePath}`;
  try {
    execFileSync('git', ['cat-file', '-e', objectName], { cwd: root, stdio: 'ignore' });
  } catch {
    return null;
  }

  const manifest = readManifest(
    execFileSync('git', ['show', objectName], { cwd: root, encoding: 'utf8' }),
    `baseline at ${baselineRef}`
  );
  const validation = validateFeatureArchitectureBaseline(manifest);
  if (validation.diagnostics.length > 0) {
    throw new Error(`baseline at ${baselineRef} is invalid`);
  }
  return validation.entries;
}

function formatDiagnostic({ code, entry, message }) {
  const location = entry
    ? `${entry.source}:${entry.specifier}${
        entry.publicEntrypoint ? ` (public via ${entry.publicEntrypoint})` : ''
      }`
    : baselineRelativePath;
  return `  - [${code}] ${location}: ${message}`;
}

export function verifyFeatureArchitecture({
  baselineRef = process.env.FEATURE_ARCHITECTURE_BASELINE_REF,
  root = repoRoot,
} = {}) {
  const manifest = readManifest(
    readFileSync(path.join(root, baselineRelativePath), 'utf8'),
    'baseline'
  );
  const validation = validateFeatureArchitectureBaseline(manifest);
  if (validation.diagnostics.length > 0) {
    throw new Error(
      `Feature architecture baseline is invalid:\n${validation.diagnostics
        .map(formatDiagnostic)
        .join('\n')}`
    );
  }

  const { sourceFileCount, violations } = collectFeatureArchitectureViolations(root);
  const diagnostics = evaluateFeatureArchitectureRatchet({
    baselineEntries: validation.entries,
    baselineReferenceEntries: readBaselineReferenceManifest(baselineRef, root),
    violations,
  });
  if (diagnostics.length > 0) {
    throw new Error(
      `Feature architecture policy failed:\n${diagnostics.map(formatDiagnostic).join('\n')}`
    );
  }

  return {
    baselineEntries: validation.entries,
    sourceFileCount,
    violations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = verifyFeatureArchitecture();
    console.log(
      `[feature-architecture] OK: ${result.sourceFileCount} production source files, ` +
        `${result.baselineEntries.length} exact legacy dependency edges, 0 new violations`
    );
    if (process.argv.includes('--report')) {
      for (const violation of result.violations) {
        console.log(
          `  - [${violation.rule}] ${violation.source}:${violation.line} -> ${violation.specifier}`
        );
      }
    }
  } catch (error) {
    console.error(
      `[feature-architecture] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
