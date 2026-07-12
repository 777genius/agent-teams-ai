#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatIssues,
  isNormalizedRelativePath,
  parseCliArgs,
  readJsonFile,
  REQUIRED_WORKER_DOCS,
  validateWorkerStartContract as validateCoreWorkerStartContract,
} from './contract-lib.mjs';

export const MAX_MANDATORY_READS_PER_LIST = 64;

export { REQUIRED_WORKER_DOCS };

const MANDATORY_READ_LISTS = Object.freeze([
  'mandatoryDocs',
  'mandatoryScripts',
  'mandatoryFixtures',
]);
const UNBOUNDED_READ_ROOTS = new Set(['docs', 'docs/research', 'docs/research/hosted-web']);
const PRESERVED_RESEARCH_PREFIX = 'docs/research/hosted-web/';
export function validateWorkerStartContract(contract, options = {}) {
  const coreResult = validateCoreWorkerStartContract(contract, options);
  const issues = [...coreResult.issues];

  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
    return { ok: false, issues };
  }

  const researchReferences = new Set();
  for (const listName of MANDATORY_READ_LISTS) {
    const values = contract[listName];
    if (!Array.isArray(values)) continue;
    if (values.length > MAX_MANDATORY_READS_PER_LIST) {
      issues.push(`${listName}:exceeds_max_items:${values.length}:${MAX_MANDATORY_READS_PER_LIST}`);
    }
    for (const value of values) {
      if (isNormalizedRelativePath(value) && UNBOUNDED_READ_ROOTS.has(value)) {
        issues.push(`${listName}:unbounded_read_root:${value}`);
      }
      if (isNormalizedRelativePath(value) && value.startsWith(PRESERVED_RESEARCH_PREFIX)) {
        researchReferences.add(value);
      }
    }
  }

  if (
    researchReferences.size > 0 &&
    options.checkFilesystem !== false &&
    path.isAbsolute(contract.workspaceRoot ?? '') &&
    isNormalizedRelativePath(contract.lanePacket)
  ) {
    try {
      const lanePacket = readFileSync(
        path.resolve(contract.workspaceRoot, contract.lanePacket),
        'utf8'
      );
      const packetTokens = new Set(lanePacket.split(/[\s`"'()[\]{},;:<>]+/u));
      for (const reference of researchReferences) {
        if (!packetTokens.has(reference)) {
          issues.push(`mandatoryReads:research_reference_not_in_lane_packet:${reference}`);
        }
      }
    } catch {
      // Core validation reports missing or unreadable packet files.
    }
  }

  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

export function validateWorkerStartFile(contractPath, options = {}) {
  const absolutePath = path.resolve(contractPath);
  return validateWorkerStartContract(readJsonFile(absolutePath), options);
}

function main() {
  const args = parseCliArgs(process.argv.slice(2), ['contract']);
  if (!args.contract) throw new Error('--contract is required');
  const result = validateWorkerStartFile(args.contract);
  if (!result.ok) throw new Error(formatIssues('worker-start validation', result.issues));
  process.stdout.write('worker-start contract valid\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
