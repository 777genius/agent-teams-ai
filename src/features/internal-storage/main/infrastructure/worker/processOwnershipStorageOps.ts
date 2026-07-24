import {
  PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION,
  type ProcessOwnershipStorageCompareAndSwapRequest,
  type ProcessOwnershipStorageCompareAndSwapResult,
  type ProcessOwnershipStorageLoadResult,
  type ProcessOwnershipStorageScope,
  type StoredProcessOwnershipPhase,
  type StoredProcessOwnershipState,
} from '../ProcessOwnershipStorageGateway';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

const TABLE_NAME = 'process_ownership_records';
const SCOPE_INDEX = 'idx_process_ownership_immutable_scope';
const PROCESS_REF_INDEX = 'idx_process_ownership_opaque_ref';
const RESIDUAL_UPDATE_TRIGGER = 'trg_process_ownership_residual_update_immutable';
const RESIDUAL_DELETE_TRIGGER = 'trg_process_ownership_residual_delete_immutable';
const CORRUPTION_MARKER_TABLE = 'process_ownership_corruption_markers';
const MAX_STATE_JSON_BYTES = 64 * 1_024;
const MAX_OWNERSHIP_RECORDS = 10_000;
const SHA_256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROCESS_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
const PHASES: readonly StoredProcessOwnershipPhase[] = [
  'spawn_intent',
  'owned',
  'stopping',
  'drained',
  'unclassified_residual',
];
const EXPECTED_INDEX_COLUMNS = new Map<string, readonly string[]>([
  [SCOPE_INDEX, ['team_id', 'run_id', 'plan_generation', 'plan_hash', 'execution_unit_id']],
  [PROCESS_REF_INDEX, ['process_ref']],
]);

export const PROCESS_OWNERSHIP_STORAGE_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    plan_generation INTEGER NOT NULL CHECK (plan_generation > 0),
    plan_hash TEXT NOT NULL,
    execution_unit_id TEXT NOT NULL,
    process_ref TEXT NOT NULL,
    codec_version INTEGER NOT NULL CHECK (codec_version = 1),
    state_version INTEGER NOT NULL CHECK (state_version = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    phase TEXT NOT NULL CHECK (
      phase IN ('spawn_intent', 'owned', 'stopping', 'drained', 'unclassified_residual')
    ),
    state_json TEXT NOT NULL CHECK (json_valid(state_json))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${SCOPE_INDEX}
    ON ${TABLE_NAME} (
      team_id, run_id, plan_generation, plan_hash, execution_unit_id
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${PROCESS_REF_INDEX}
    ON ${TABLE_NAME} (process_ref)`,
  `CREATE TRIGGER IF NOT EXISTS ${RESIDUAL_UPDATE_TRIGGER}
    BEFORE UPDATE ON ${TABLE_NAME}
    WHEN OLD.phase = 'unclassified_residual'
    BEGIN
      SELECT RAISE(ABORT, 'process-ownership-residual-immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS ${RESIDUAL_DELETE_TRIGGER}
    BEFORE DELETE ON ${TABLE_NAME}
    WHEN OLD.phase = 'unclassified_residual'
    BEGIN
      SELECT RAISE(ABORT, 'process-ownership-residual-immutable');
    END`,
  `CREATE TABLE IF NOT EXISTS ${CORRUPTION_MARKER_TABLE} (
    marker_id INTEGER PRIMARY KEY CHECK (marker_id = 1),
    reason TEXT NOT NULL CHECK (reason = 'database_corruption_recovery'),
    detected_at TEXT NOT NULL
  )`,
] as const;

interface StoredRow {
  readonly team_id: unknown;
  readonly run_id: unknown;
  readonly plan_generation: unknown;
  readonly plan_hash: unknown;
  readonly execution_unit_id: unknown;
  readonly process_ref: unknown;
  readonly codec_version: unknown;
  readonly state_version: unknown;
  readonly revision: unknown;
  readonly phase: unknown;
  readonly state_json: unknown;
}

const SELECT_COLUMNS = `team_id, run_id, plan_generation, plan_hash, execution_unit_id,
  process_ref, codec_version, state_version, revision, phase, state_json`;

export class ProcessOwnershipStorageOps {
  constructor(
    private readonly getDatabase: () => SqliteDatabase,
    private readonly now: () => number = Date.now
  ) {}

  loadByScope(scopeValue: unknown): ProcessOwnershipStorageLoadResult {
    const scope = parseScope(scopeValue);
    const db = this.database();
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM ${TABLE_NAME}
         WHERE team_id = ? AND run_id = ? AND plan_generation = ? AND plan_hash = ?
           AND execution_unit_id = ?
         LIMIT 2`
      )
      .all(...scopeParameters(scope)) as StoredRow[];
    return singleLoadResult(rows);
  }

  loadByProcessRef(value: unknown): ProcessOwnershipStorageLoadResult {
    const processRef = processRefValue(value);
    const db = this.database();
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM ${TABLE_NAME}
         WHERE process_ref = ?
         LIMIT 2`
      )
      .all(processRef) as StoredRow[];
    return singleLoadResult(rows);
  }

  list(): readonly StoredProcessOwnershipState[] {
    const db = this.database();
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM ${TABLE_NAME}
         ORDER BY row_id ASC
         LIMIT ?`
      )
      .all(MAX_OWNERSHIP_RECORDS + 1) as StoredRow[];
    if (rows.length > MAX_OWNERSHIP_RECORDS) {
      throw new Error('process-ownership-storage-record-limit-exceeded');
    }
    const records = rows.map(parseStoredRow);
    assertNoAmbiguousRecords(records);
    return Object.freeze(records);
  }

  compareAndSwap(
    requestValue: unknown,
    deadlineAtMsValue: unknown
  ): ProcessOwnershipStorageCompareAndSwapResult {
    const request = parseCompareAndSwapRequest(requestValue);
    const deadlineAtMs = positiveInteger(deadlineAtMsValue, 'deadline');
    const db = this.database();
    return db.transaction(() => {
      if (this.now() >= deadlineAtMs) {
        throw new Error('process-ownership-storage-deadline-expired');
      }
      assertProcessOwnershipStorageSchema(db);
      const existing = this.readCandidates(db, request.scope, request.next.processRef);
      if (request.expectedRevision === null) {
        if (
          request.next.revision !== 1 ||
          request.next.phase !== 'spawn_intent' ||
          request.expectedCurrent !== null ||
          existing.length !== 0
        ) {
          return { status: 'conflict' } as const;
        }
        if (this.now() >= deadlineAtMs) {
          throw new Error('process-ownership-storage-deadline-expired');
        }
        const result = db
          .prepare(
            `INSERT INTO ${TABLE_NAME} (
              team_id, run_id, plan_generation, plan_hash, execution_unit_id, process_ref,
              codec_version, state_version, revision, phase, state_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`
          )
          .run(...recordParameters(request.next));
        return result.changes === 1
          ? ({ status: 'applied', record: request.next } as const)
          : ({ status: 'conflict' } as const);
      }

      if (
        request.next.revision !== request.expectedRevision + 1 ||
        existing.length !== 1 ||
        existing[0].revision !== request.expectedRevision ||
        request.expectedCurrent === null ||
        !storedRecordsEqual(existing[0], request.expectedCurrent) ||
        existing[0].processRef !== request.next.processRef ||
        !scopesEqual(existing[0].scope, request.scope) ||
        existing[0].phase === 'unclassified_residual'
      ) {
        return { status: 'conflict' } as const;
      }
      if (this.now() >= deadlineAtMs) {
        throw new Error('process-ownership-storage-deadline-expired');
      }
      const result = db
        .prepare(
          `UPDATE ${TABLE_NAME}
           SET codec_version = ?, state_version = ?, revision = ?, phase = ?, state_json = ?
           WHERE team_id = ? AND run_id = ? AND plan_generation = ? AND plan_hash = ?
             AND execution_unit_id = ? AND process_ref = ? AND revision = ?`
        )
        .run(
          request.next.codecVersion,
          request.next.stateVersion,
          request.next.revision,
          request.next.phase,
          request.next.stateJson,
          ...scopeParameters(request.scope),
          request.next.processRef,
          request.expectedRevision
        );
      return result.changes === 1
        ? ({ status: 'applied', record: request.next } as const)
        : ({ status: 'conflict' } as const);
    })();
  }

  private database(): SqliteDatabase {
    const db = this.getDatabase();
    assertProcessOwnershipStorageSchema(db);
    return db;
  }

  private readCandidates(
    db: SqliteDatabase,
    scope: ProcessOwnershipStorageScope,
    processRef: string
  ): StoredProcessOwnershipState[] {
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM ${TABLE_NAME}
         WHERE process_ref = ?
            OR (team_id = ? AND run_id = ? AND plan_generation = ? AND plan_hash = ?
              AND execution_unit_id = ?)
         LIMIT 3`
      )
      .all(processRef, ...scopeParameters(scope)) as StoredRow[];
    const records = rows.map(parseStoredRow);
    assertNoAmbiguousRecords(records);
    return records;
  }
}

function parseCompareAndSwapRequest(value: unknown): ProcessOwnershipStorageCompareAndSwapRequest {
  const record = exactRecord(
    value,
    ['scope', 'expectedRevision', 'expectedCurrent', 'next'],
    'cas'
  );
  const scope = parseScope(record.scope);
  const expectedRevision =
    record.expectedRevision === null ? null : positiveInteger(record.expectedRevision, 'revision');
  const expectedCurrent =
    record.expectedCurrent === null ? null : parseStoredRecord(record.expectedCurrent);
  const next = parseStoredRecord(record.next);
  if (
    !scopesEqual(scope, next.scope) ||
    (expectedRevision === null) !== (expectedCurrent === null) ||
    (expectedCurrent !== null &&
      (expectedCurrent.revision !== expectedRevision ||
        expectedCurrent.processRef !== next.processRef ||
        !scopesEqual(expectedCurrent.scope, scope))) ||
    next.revision !== (expectedRevision ?? 0) + 1
  ) {
    throw new Error('process-ownership-storage-cas-binding-invalid');
  }
  return { scope, expectedRevision, expectedCurrent, next };
}

function parseStoredRecord(value: unknown): StoredProcessOwnershipState {
  const record = exactRecord(
    value,
    ['scope', 'processRef', 'codecVersion', 'stateVersion', 'revision', 'phase', 'stateJson'],
    'record'
  );
  const phase = record.phase;
  if (!PHASES.includes(phase as StoredProcessOwnershipPhase)) {
    throw new Error('process-ownership-storage-phase-invalid');
  }
  if (
    record.codecVersion !== PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION ||
    record.stateVersion !== 1
  ) {
    throw new Error('process-ownership-storage-version-invalid');
  }
  const revision = positiveInteger(record.revision, 'revision');
  const encodedState = stateJson(record.stateJson);
  const state = (
    JSON.parse(encodedState) as {
      readonly state: Record<string, unknown>;
    }
  ).state;
  if (state.revision !== revision || state.phase !== phase) {
    throw new Error('process-ownership-storage-state-metadata-invalid');
  }
  return {
    scope: parseScope(record.scope),
    processRef: processRefValue(record.processRef),
    codecVersion: PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION,
    stateVersion: 1,
    revision,
    phase: phase as StoredProcessOwnershipPhase,
    stateJson: encodedState,
  };
}

function parseStoredRow(row: StoredRow): StoredProcessOwnershipState {
  return parseStoredRecord({
    scope: {
      teamId: row.team_id,
      runId: row.run_id,
      planGeneration: row.plan_generation,
      planHash: row.plan_hash,
      executionUnitId: row.execution_unit_id,
    },
    processRef: row.process_ref,
    codecVersion: row.codec_version,
    stateVersion: row.state_version,
    revision: row.revision,
    phase: row.phase,
    stateJson: row.state_json,
  });
}

function parseScope(value: unknown): ProcessOwnershipStorageScope {
  const record = exactRecord(
    value,
    ['teamId', 'runId', 'planGeneration', 'planHash', 'executionUnitId'],
    'scope'
  );
  if (typeof record.planHash !== 'string' || !SHA_256_PATTERN.test(record.planHash)) {
    throw new Error('process-ownership-storage-plan-hash-invalid');
  }
  return {
    teamId: opaqueValue(record.teamId, 'team-id'),
    runId: opaqueValue(record.runId, 'run-id'),
    planGeneration: positiveInteger(record.planGeneration, 'plan-generation'),
    planHash: record.planHash,
    executionUnitId: opaqueValue(record.executionUnitId, 'execution-unit-id'),
  };
}

function singleLoadResult(rows: StoredRow[]): ProcessOwnershipStorageLoadResult {
  if (rows.length === 0) return { status: 'missing' };
  if (rows.length !== 1) throw new Error('process-ownership-storage-ambiguous');
  return { status: 'found', record: parseStoredRow(rows[0]) };
}

function assertNoAmbiguousRecords(records: readonly StoredProcessOwnershipState[]): void {
  const refs = new Set<string>();
  const scopes = new Set<string>();
  for (const record of records) {
    const scopeKey = JSON.stringify(scopeParameters(record.scope));
    if (refs.has(record.processRef) || scopes.has(scopeKey)) {
      throw new Error('process-ownership-storage-ambiguous');
    }
    refs.add(record.processRef);
    scopes.add(scopeKey);
  }
}

function assertProcessOwnershipStorageSchema(db: SqliteDatabase): void {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(TABLE_NAME) as { readonly name?: unknown } | undefined;
  if (table?.name !== TABLE_NAME) throw new Error('process-ownership-storage-schema-missing');
  const indexes = db.pragma(`index_list('${TABLE_NAME}')`) as {
    readonly name?: unknown;
    readonly unique?: unknown;
  }[];
  for (const expected of [SCOPE_INDEX, PROCESS_REF_INDEX]) {
    if (!indexes.some((index) => index.name === expected && index.unique === 1)) {
      throw new Error('process-ownership-storage-schema-invalid');
    }
    const columns = db.pragma(`index_info('${expected}')`) as { readonly name?: unknown }[];
    if (
      columns.length !== EXPECTED_INDEX_COLUMNS.get(expected)?.length ||
      columns.some((column, index) => column.name !== EXPECTED_INDEX_COLUMNS.get(expected)?.[index])
    ) {
      throw new Error('process-ownership-storage-schema-invalid');
    }
  }
  const triggers = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
    .all(TABLE_NAME) as { readonly name?: unknown }[];
  for (const expected of [RESIDUAL_UPDATE_TRIGGER, RESIDUAL_DELETE_TRIGGER]) {
    if (!triggers.some((trigger) => trigger.name === expected)) {
      throw new Error('process-ownership-storage-schema-invalid');
    }
  }
  const markerTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(CORRUPTION_MARKER_TABLE) as { readonly name?: unknown } | undefined;
  if (markerTable?.name !== CORRUPTION_MARKER_TABLE) {
    throw new Error('process-ownership-storage-schema-invalid');
  }
  const marker = db.prepare(`SELECT marker_id FROM ${CORRUPTION_MARKER_TABLE} LIMIT 1`).get() as
    | { readonly marker_id?: unknown }
    | undefined;
  if (marker) throw new Error('process-ownership-storage-corruption-recovered');
}

export function recordProcessOwnershipCorruptionMarker(
  db: SqliteDatabase,
  detectedAt: string
): void {
  db.prepare(
    `INSERT INTO ${CORRUPTION_MARKER_TABLE} (marker_id, reason, detected_at)
     VALUES (1, 'database_corruption_recovery', ?)
     ON CONFLICT(marker_id) DO NOTHING`
  ).run(detectedAt);
}

function recordParameters(record: StoredProcessOwnershipState): readonly unknown[] {
  return [
    ...scopeParameters(record.scope),
    record.processRef,
    record.codecVersion,
    record.stateVersion,
    record.revision,
    record.phase,
    record.stateJson,
  ];
}

function scopeParameters(scope: ProcessOwnershipStorageScope): readonly unknown[] {
  return [scope.teamId, scope.runId, scope.planGeneration, scope.planHash, scope.executionUnitId];
}

function scopesEqual(
  left: ProcessOwnershipStorageScope,
  right: ProcessOwnershipStorageScope
): boolean {
  return scopeParameters(left).every((value, index) => value === scopeParameters(right)[index]);
}

function stateJson(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_STATE_JSON_BYTES) {
    throw new Error('process-ownership-storage-state-json-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('process-ownership-storage-state-json-invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('process-ownership-storage-state-json-invalid');
  }
  const envelope = exactRecord(parsed, ['codecVersion', 'state'], 'state-envelope');
  const state = exactRecord(envelope.state, Object.keys(envelope.state as object), 'state');
  if (
    envelope.codecVersion !== PROCESS_OWNERSHIP_STORAGE_CODEC_VERSION ||
    canonicalJson(parsed) !== value ||
    state.stateVersion !== 1
  ) {
    throw new Error('process-ownership-storage-state-json-invalid');
  }
  return value;
}

function storedRecordsEqual(
  left: StoredProcessOwnershipState,
  right: StoredProcessOwnershipState
): boolean {
  return (
    scopesEqual(left.scope, right.scope) &&
    left.processRef === right.processRef &&
    left.codecVersion === right.codecVersion &&
    left.stateVersion === right.stateVersion &&
    left.revision === right.revision &&
    left.phase === right.phase &&
    left.stateJson === right.stateJson
  );
}

function opaqueValue(value: unknown, reason: string): string {
  if (typeof value !== 'string' || !OPAQUE_VALUE_PATTERN.test(value)) {
    throw new Error(`process-ownership-storage-${reason}-invalid`);
  }
  return value;
}

function processRefValue(value: unknown): string {
  if (typeof value !== 'string' || !PROCESS_REF_PATTERN.test(value)) {
    throw new Error('process-ownership-storage-process-ref-invalid');
  }
  return value;
}

function positiveInteger(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`process-ownership-storage-${reason}-invalid`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  reason: string
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`process-ownership-storage-${reason}-invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(record);
  const sorted = [...keys].sort((left, right) => left.localeCompare(right));
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== sorted.length ||
    [...(actual as string[])]
      .sort((left, right) => left.localeCompare(right))
      .some((key, index) => key !== sorted[index])
  ) {
    throw new Error(`process-ownership-storage-${reason}-invalid`);
  }
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(record));
  if (descriptors.some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
    throw new Error(`process-ownership-storage-${reason}-invalid`);
  }
  return record;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('process-ownership-storage-number-invalid');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = exactRecord(value, Object.keys(value as object), 'canonical-value');
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
