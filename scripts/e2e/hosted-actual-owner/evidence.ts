import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { REQUIRED_SCENARIOS } from './contracts';
import { atomicPrivateFile, canonicalJson } from './secure-files';

export type ProofRow = Readonly<{
  scenario: (typeof REQUIRED_SCENARIOS)[number];
  passed: boolean;
  rawRecordPath: string;
  rawRecordSha256: string;
  recordIds: readonly string[];
  effectCount: number;
}>;

type RawProofRecord = Readonly<{
  schemaVersion: 1;
  scenario: ProofRow['scenario'];
  recordId: string;
  passed: boolean;
  effectCount: number;
  raw: Readonly<Record<string, unknown>>;
}>;

function parseRawRecord(value: unknown): RawProofRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('actual_owner_raw_record_invalid');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input)
      .sort((left, right) => left.localeCompare(right))
      .join(',') !== 'effectCount,passed,raw,recordId,scenario,schemaVersion' ||
    input.schemaVersion !== 1 ||
    !(REQUIRED_SCENARIOS as readonly unknown[]).includes(input.scenario) ||
    typeof input.recordId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u.test(input.recordId) ||
    input.passed !== true ||
    typeof input.effectCount !== 'number' ||
    !Number.isSafeInteger(input.effectCount) ||
    input.effectCount < 0
  ) {
    throw new Error('actual_owner_raw_record_invalid');
  }
  if (!input.raw || typeof input.raw !== 'object' || Array.isArray(input.raw)) {
    throw new Error('actual_owner_raw_record_invalid');
  }
  return input as RawProofRecord;
}

export async function deriveProofRows(evidenceRoot: string): Promise<readonly ProofRow[]> {
  const paths = (await readdir(evidenceRoot))
    .filter((path) => path.endsWith('.ndjson'))
    .sort((left, right) => left.localeCompare(right));
  const records: { path: string; sha256: string; value: RawProofRecord }[] = [];
  for (const name of paths) {
    const path = join(evidenceRoot, name);
    const bytes = await readFile(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      records.push({ path, sha256, value: parseRawRecord(JSON.parse(line)) });
    }
  }
  const rows = REQUIRED_SCENARIOS.map((scenario) => {
    const matches = records.filter((record) => record.value.scenario === scenario);
    const first = matches[0];
    if (!first) throw new Error(`actual_owner_proof_${scenario}_missing`);
    return Object.freeze({
      scenario,
      passed: true,
      rawRecordPath: first.path,
      rawRecordSha256: first.sha256,
      recordIds: Object.freeze(matches.map((match) => match.value.recordId)),
      effectCount: matches.reduce((sum, record) => sum + record.value.effectCount, 0),
    });
  });
  validateProofMatrix(rows);
  return Object.freeze(rows);
}

export function validateProofMatrix(rows: readonly ProofRow[]): void {
  if (rows.length !== REQUIRED_SCENARIOS.length)
    throw new Error('actual_owner_proof_matrix_incomplete');
  for (const scenario of REQUIRED_SCENARIOS) {
    const matches = rows.filter((row) => row.scenario === scenario);
    if (
      matches.length !== 1 ||
      matches[0]?.passed !== true ||
      matches[0].recordIds.length === 0 ||
      !/^[0-9a-f]{64}$/u.test(matches[0].rawRecordSha256)
    ) {
      throw new Error(`actual_owner_proof_${scenario}_invalid`);
    }
  }
  const exactlyOne = rows.find((row) => row.scenario === 'exactly-one');
  if (exactlyOne?.effectCount !== 1) throw new Error('actual_owner_exactly_one_effect_invalid');
}

export async function verifyProofRows(rows: readonly ProofRow[]): Promise<void> {
  validateProofMatrix(rows);
  for (const row of rows) {
    const bytes = await readFile(row.rawRecordPath);
    if (createHash('sha256').update(bytes).digest('hex') !== row.rawRecordSha256) {
      throw new Error(`actual_owner_proof_${row.scenario}_digest_mismatch`);
    }
  }
}

export async function writeEvidenceIndex(
  path: string,
  root: string,
  rows: readonly ProofRow[]
): Promise<void> {
  await verifyProofRows(rows);
  await atomicPrivateFile(
    path,
    canonicalJson({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e.evidence/v1',
      productionEligible: false,
      rows,
    }),
    root
  );
}
