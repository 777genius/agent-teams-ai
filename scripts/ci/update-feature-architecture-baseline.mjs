#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectFeatureArchitectureViolations,
  compareViolations,
  toBaselineEntry,
} from './feature-architecture-policy.mjs';

if (!process.argv.includes('--write')) {
  throw new Error('pass --write to replace the feature architecture baseline');
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const baselinePath = path.join(repoRoot, 'scripts/ci/feature-architecture-baseline.json');
const { violations } = collectFeatureArchitectureViolations(repoRoot);
const entries = violations.map(toBaselineEntry).sort(compareViolations);

writeFileSync(
  baselinePath,
  `${JSON.stringify({ version: 2, violations: entries }, null, 2)}\n`
);
console.log(`[feature-architecture] Wrote ${entries.length} exact baseline entries`);
