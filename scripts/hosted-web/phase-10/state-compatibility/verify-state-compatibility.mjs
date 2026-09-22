#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tsImport } from 'tsx/esm/api';

const RESULT_FORMAT = 'hosted-state-compatibility-verifier-result/v1';
const FIXTURE_FORMAT = 'hosted-state-compatibility-fixture/v1';
const REQUIRED_CASE_IDS = Object.freeze([
  'corrupted-archive-refusal',
  'cross-snapshot-mismatch-refusal',
  'future-version-refusal',
  'interrupted-migration-recovery',
  'n-read-write',
  'n-to-n-plus-one',
]);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../../..');
const defaultFixtureDirectory = join(repositoryRoot, 'test/fixtures/hosted-state-compatibility');
const publicFeatureEntrypoint = join(
  repositoryRoot,
  'src/features/hosted-state-compatibility/index.ts'
);

export async function runStateCompatibilityVerifier(options = {}) {
  const fixtureDirectory = resolve(options.fixtureDirectory ?? defaultFixtureDirectory);
  const fixtureDirectoryLabel = labelPath(fixtureDirectory);
  let feature;
  let fixtureFiles;
  try {
    [feature, fixtureFiles] = await Promise.all([
      tsImport(publicFeatureEntrypoint, { parentURL: import.meta.url }),
      listFixtureFiles(fixtureDirectory),
    ]);
  } catch (error) {
    return fatalResult('fixture_load_failed', safeErrorMessage(error), fixtureDirectoryLabel);
  }

  const checks = [];
  const caseIds = [];
  for (const fileName of fixtureFiles) {
    try {
      const fixture = JSON.parse(await readFile(join(fixtureDirectory, fileName), 'utf8'));
      validateFixtureEnvelope(fixture, fileName);
      caseIds.push(fixture.caseId);
      const actual = evaluateFixture(feature, fixture);
      const passed = stableJson(actual) === stableJson(fixture.expected);
      checks.push({
        caseId: fixture.caseId,
        file: fileName,
        status: passed ? 'passed' : 'failed',
        expected: fixture.expected,
        actual,
        ...(passed ? {} : { error: 'unexpected_policy_result' }),
      });
    } catch (error) {
      checks.push({
        caseId: `invalid:${fileName}`,
        file: fileName,
        status: 'failed',
        error: safeErrorMessage(error),
      });
    }
  }

  const fixtureSetError = inspectFixtureSet(caseIds);
  if (fixtureSetError) {
    checks.push({
      caseId: 'fixture-set',
      file: null,
      status: 'failed',
      error: fixtureSetError,
    });
  }
  const failed = checks.filter((check) => check.status === 'failed').length;
  const result = {
    format: RESULT_FORMAT,
    status: failed === 0 ? 'passed' : 'failed',
    fixtureDirectory: fixtureDirectoryLabel,
    summary: {
      total: checks.length,
      passed: checks.length - failed,
      failed,
    },
    checks,
  };
  return { exitCode: failed === 0 ? 0 : 1, result };
}

function evaluateFixture(feature, fixture) {
  if (fixture.kind === 'state_admission') {
    return summarizeStateAdmission(
      feature.evaluateHostedStateAdmission({
        artifactManifest: fixture.artifactManifest,
        artifactIntegrity: 'verified',
        stateHeader: fixture.stateHeader,
        migrationJournal: fixture.migrationJournal,
      })
    );
  }
  if (fixture.kind === 'restore_archive') {
    const inspection = feature.inspectRestoreArchive(fixture.evidence);
    return inspection.status === 'verified'
      ? { status: inspection.status }
      : { status: inspection.status, reasons: inspection.reasons };
  }
  throw new Error('fixture_kind_unsupported');
}

function summarizeStateAdmission(admission) {
  if (admission.status === 'read_write') {
    return {
      status: admission.status,
      hostedStateSchemaVersion: admission.hostedStateSchemaVersion,
    };
  }
  if (admission.status === 'migration_required') {
    return {
      status: admission.status,
      fromVersion: admission.fromVersion,
      toVersion: admission.toVersion,
      migrationIds: admission.orderedMigrations.map((migration) => migration.migrationId),
      backupRequired: admission.backupRequired,
    };
  }
  if (admission.status === 'migration_recovery_required') {
    return {
      status: admission.status,
      recovery: admission.recovery,
      migrationId: admission.migration.migrationId,
      journalPhase: admission.journalPhase,
    };
  }
  return { status: admission.status, reason: admission.reason };
}

function validateFixtureEnvelope(fixture, fileName) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error('fixture_not_an_object');
  }
  if (fixture.fixtureFormat !== FIXTURE_FORMAT || fixture.schemaVersion !== 1) {
    throw new Error('fixture_format_unsupported');
  }
  if (typeof fixture.caseId !== 'string' || fixture.caseId.length === 0) {
    throw new Error('fixture_case_id_invalid');
  }
  if (!fileName.endsWith('.json') || fixture.expected === undefined) {
    throw new Error('fixture_shape_invalid');
  }
}

function inspectFixtureSet(caseIds) {
  if (new Set(caseIds).size !== caseIds.length) return 'fixture_case_id_duplicate';
  const observed = [...caseIds].sort((left, right) => left.localeCompare(right));
  return stableJson(observed) === stableJson(REQUIRED_CASE_IDS) ? null : 'fixture_set_incomplete';
}

async function listFixtureFiles(fixtureDirectory) {
  const entries = await readdir(fixtureDirectory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error('fixture_directory_empty');
  return files;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function labelPath(path) {
  const repositoryRelative = relative(repositoryRoot, path);
  return repositoryRelative &&
    !repositoryRelative.startsWith('..') &&
    !isAbsolute(repositoryRelative)
    ? repositoryRelative
    : path;
}

function fatalResult(code, message, fixtureDirectory = null) {
  return {
    exitCode: 2,
    result: {
      format: RESULT_FORMAT,
      status: 'error',
      fixtureDirectory,
      error: { code, message },
      summary: { total: 0, passed: 0, failed: 0 },
      checks: [],
    },
  };
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseCommandLine(arguments_) {
  if (arguments_.length === 0) return {};
  if (arguments_.length === 2 && arguments_[0] === '--fixture-dir') {
    if (!arguments_[1]) throw new Error('fixture_directory_missing');
    return { fixtureDirectory: arguments_[1] };
  }
  throw new Error('usage: verify-state-compatibility.mjs [--fixture-dir <path>]');
}

async function main() {
  let outcome;
  try {
    outcome = await runStateCompatibilityVerifier(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    outcome = fatalResult('invalid_arguments', safeErrorMessage(error));
  }
  process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
  process.exitCode = outcome.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
