import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION = 1;
export const OPENCODE_PRODUCTION_E2E_EVIDENCE_COLLECTION_SCHEMA_VERSION = 1;

export const OPENCODE_PRODUCTION_E2E_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS = [
  'required_tools_proven',
  'delivery_ready',
  'member_ready',
  'run_ready',
] as const;

export const OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS = [
  'app_mcp_tools_visible',
  'state_changing_launch_completed',
  'session_records_persisted',
  'bootstrap_confirmed_alive',
  'canonical_log_projection_observed',
  'reconcile_completed',
  'stop_completed',
  'stale_run_rejected',
] as const;

export type OpenCodeProductionE2ERequiredSignal =
  (typeof OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS)[number];

export interface OpenCodeProductionE2ECheckpointEvidence {
  name: string;
  observedAt: string;
}

export interface OpenCodeProductionE2ESessionEvidence {
  memberName: string;
  sessionId: string;
  launchState: 'confirmed_alive';
}

export interface OpenCodeProductionE2EEvidence {
  schemaVersion: typeof OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION;
  evidenceId: string;
  createdAt: string;
  expiresAt: string;
  version: string;
  passed: boolean;
  artifactPath: string | null;
  binaryFingerprint: string;
  capabilitySnapshotId: string;
  selectedModel: string;
  projectPathFingerprint: string | null;
  requiredSignals: Record<OpenCodeProductionE2ERequiredSignal, boolean>;
  mcpTools: {
    requiredTools: readonly string[];
    observedTools: readonly string[];
  };
  launch: {
    runId: string;
    teamId: string;
    teamLaunchState: 'ready';
    memberCount: number;
    sessions: OpenCodeProductionE2ESessionEvidence[];
    durableCheckpoints: OpenCodeProductionE2ECheckpointEvidence[];
  };
  reconcile: {
    runId: string;
    teamLaunchState: 'ready';
    memberCount: number;
  };
  stop: {
    runId: string;
    stopped: true;
    stoppedSessionIds: string[];
  };
  logProjection: {
    observed: true;
    projectedMessageCount: number;
  };
  diagnostics?: string[];
}

export interface OpenCodeProductionE2EEvidenceCollection {
  collectionSchemaVersion: typeof OPENCODE_PRODUCTION_E2E_EVIDENCE_COLLECTION_SCHEMA_VERSION;
  entriesByModel: Record<string, OpenCodeProductionE2EEvidence>;
}

export type OpenCodeProductionE2EEvidenceStoreData =
  | OpenCodeProductionE2EEvidence
  | OpenCodeProductionE2EEvidenceCollection
  | null;

export interface OpenCodeProductionE2EGateExpectation {
  opencodeVersion: string | null;
  binaryFingerprint: string | null;
  capabilitySnapshotId: string | null;
  /**
   * The currently selected raw model id. Kept for observability and evidence
   * lookup preference, but not as a hard production-proof gate.
   */
  selectedModel: string | null;
  projectPathFingerprint?: string | null;
  requiredMcpTools?: readonly string[];
}

export interface OpenCodeProductionE2EGateResult {
  ok: boolean;
  diagnostics: string[];
}

export function buildOpenCodeProjectPathFingerprint(
  projectPath: string | null | undefined
): string | null {
  const trimmed = projectPath?.trim() ?? '';
  if (!trimmed) {
    return null;
  }

  const normalized = path.resolve(trimmed).replace(/\\/g, '/');
  return `project:${createHash('sha256').update(normalized).digest('hex')}`;
}

export function validateOpenCodeProductionE2EEvidence(
  value: unknown
): OpenCodeProductionE2EEvidence {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence must be an object');
  }

  if (record.schemaVersion !== OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION) {
    throw new Error('OpenCode production E2E evidence has unsupported schemaVersion');
  }

  const evidence: OpenCodeProductionE2EEvidence = {
    schemaVersion: OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION,
    evidenceId: requireString(record.evidenceId, 'evidenceId'),
    createdAt: requireIsoDate(record.createdAt, 'createdAt'),
    expiresAt: requireIsoDate(record.expiresAt, 'expiresAt'),
    version: requireString(record.version, 'version'),
    passed: requireBoolean(record.passed, 'passed'),
    artifactPath: optionalString(record.artifactPath, 'artifactPath'),
    binaryFingerprint: requireString(record.binaryFingerprint, 'binaryFingerprint'),
    capabilitySnapshotId: requireString(record.capabilitySnapshotId, 'capabilitySnapshotId'),
    selectedModel: requireString(record.selectedModel, 'selectedModel'),
    projectPathFingerprint: optionalString(record.projectPathFingerprint, 'projectPathFingerprint'),
    requiredSignals: normalizeRequiredSignals(record.requiredSignals),
    mcpTools: normalizeMcpTools(record.mcpTools),
    launch: normalizeLaunch(record.launch),
    reconcile: normalizeReconcile(record.reconcile),
    stop: normalizeStop(record.stop),
    logProjection: normalizeLogProjection(record.logProjection),
    diagnostics: optionalStringArray(record.diagnostics, 'diagnostics'),
  };

  return evidence;
}

export function validateNullableOpenCodeProductionE2EEvidence(
  value: unknown
): OpenCodeProductionE2EEvidence | null {
  if (value === null) {
    return null;
  }
  return validateOpenCodeProductionE2EEvidence(value);
}

export function validateOpenCodeProductionE2EEvidenceStoreData(
  value: unknown
): OpenCodeProductionE2EEvidenceStoreData {
  if (value === null) {
    return null;
  }

  const record = asRecord(value);
  if (
    record?.collectionSchemaVersion === OPENCODE_PRODUCTION_E2E_EVIDENCE_COLLECTION_SCHEMA_VERSION
  ) {
    return validateOpenCodeProductionE2EEvidenceCollection(record);
  }

  return validateOpenCodeProductionE2EEvidence(value);
}

export function isOpenCodeProductionE2EEvidenceCollection(
  value: OpenCodeProductionE2EEvidenceStoreData
): value is OpenCodeProductionE2EEvidenceCollection {
  return (
    value !== null &&
    typeof value === 'object' &&
    'collectionSchemaVersion' in value &&
    value.collectionSchemaVersion === OPENCODE_PRODUCTION_E2E_EVIDENCE_COLLECTION_SCHEMA_VERSION
  );
}

export function assertOpenCodeProductionE2EEvidenceBasics(input: {
  evidence: OpenCodeProductionE2EEvidence | null;
  testedVersion: string;
  now?: Date;
  artifactPath?: string | null;
}): OpenCodeProductionE2EGateResult {
  const diagnostics: string[] = [];
  const now = input.now ?? new Date();
  const artifactPath = input.artifactPath ?? input.evidence?.artifactPath ?? null;

  if (!input.evidence) {
    return {
      ok: false,
      diagnostics: [
        'OpenCode version is capability-compatible but production E2E evidence is missing',
      ],
    };
  }

  diagnostics.push(...collectArtifactShapeDiagnostics(input.evidence, now, artifactPath));

  if (input.evidence.version !== input.testedVersion) {
    diagnostics.push(
      `OpenCode production E2E evidence version ${input.evidence.version} does not match tested version ${input.testedVersion}`
    );
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  };
}

export function assertOpenCodeProductionE2EArtifactGate(input: {
  evidence: OpenCodeProductionE2EEvidence | null;
  expected: OpenCodeProductionE2EGateExpectation;
  now?: Date;
  artifactPath?: string | null;
}): OpenCodeProductionE2EGateResult {
  const diagnostics: string[] = [];
  const now = input.now ?? new Date();
  const artifactPath = input.artifactPath ?? input.evidence?.artifactPath ?? null;

  if (!input.evidence) {
    return {
      ok: false,
      diagnostics: [
        'OpenCode production launch requires a current production E2E evidence artifact',
      ],
    };
  }

  diagnostics.push(...collectArtifactShapeDiagnostics(input.evidence, now, artifactPath));
  diagnostics.push(...collectExpectedRuntimeDiagnostics(input.evidence, input.expected));

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  };
}

function collectArtifactShapeDiagnostics(
  evidence: OpenCodeProductionE2EEvidence,
  now: Date,
  artifactPath: string | null
): string[] {
  const diagnostics: string[] = [];
  const createdAtMs = Date.parse(evidence.createdAt);
  const expiresAtMs = Date.parse(evidence.expiresAt);

  if (!evidence.passed) {
    diagnostics.push('OpenCode production E2E evidence did not pass');
  }

  if (!artifactPath) {
    diagnostics.push('OpenCode production E2E evidence artifact path is missing');
  }

  if (!Number.isFinite(createdAtMs)) {
    diagnostics.push('OpenCode production E2E evidence createdAt is invalid');
  } else if (now.getTime() - createdAtMs > OPENCODE_PRODUCTION_E2E_EVIDENCE_MAX_AGE_MS) {
    diagnostics.push('OpenCode production E2E evidence is older than the maximum allowed age');
  }

  if (!Number.isFinite(expiresAtMs)) {
    diagnostics.push('OpenCode production E2E evidence expiresAt is invalid');
  } else if (expiresAtMs <= now.getTime()) {
    diagnostics.push('OpenCode production E2E evidence is expired');
  }

  const missingSignals = OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS.filter(
    (signal) => evidence.requiredSignals[signal] !== true
  );
  if (missingSignals.length > 0) {
    diagnostics.push(
      `OpenCode production E2E evidence is missing signals: ${missingSignals.join(', ')}`
    );
  }

  const checkpointNames = new Set(
    evidence.launch.durableCheckpoints.map((checkpoint) => checkpoint.name)
  );
  const missingCheckpoints = OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS.filter(
    (checkpoint) => !checkpointNames.has(checkpoint)
  );
  if (missingCheckpoints.length > 0) {
    diagnostics.push(
      `OpenCode production E2E evidence is missing durable checkpoints: ${missingCheckpoints.join(', ')}`
    );
  }

  if (
    evidence.launch.memberCount <= 0 ||
    evidence.launch.sessions.length !== evidence.launch.memberCount
  ) {
    diagnostics.push(
      'OpenCode production E2E evidence must include confirmed session evidence for every member'
    );
  }

  if (evidence.reconcile.runId !== evidence.launch.runId) {
    diagnostics.push(
      'OpenCode production E2E reconcile evidence runId does not match launch runId'
    );
  }

  if (evidence.reconcile.memberCount !== evidence.launch.memberCount) {
    diagnostics.push(
      'OpenCode production E2E reconcile member count does not match launch member count'
    );
  }

  if (evidence.stop.runId !== evidence.launch.runId) {
    diagnostics.push('OpenCode production E2E stop evidence runId does not match launch runId');
  }

  if (evidence.stop.stoppedSessionIds.length < evidence.launch.sessions.length) {
    diagnostics.push(
      'OpenCode production E2E evidence does not prove every launched session was stopped'
    );
  }

  if (evidence.logProjection.projectedMessageCount <= 0) {
    diagnostics.push('OpenCode production E2E evidence must include projected log messages');
  }

  const observedTools = new Set(evidence.mcpTools.observedTools);
  const missingTools = evidence.mcpTools.requiredTools.filter((tool) => !observedTools.has(tool));
  if (missingTools.length > 0) {
    diagnostics.push(
      `OpenCode production E2E evidence is missing observed MCP tools: ${missingTools.join(', ')}`
    );
  }

  return diagnostics;
}

function collectExpectedRuntimeDiagnostics(
  evidence: OpenCodeProductionE2EEvidence,
  expected: OpenCodeProductionE2EGateExpectation
): string[] {
  const diagnostics: string[] = [];

  if (!expected.opencodeVersion) {
    diagnostics.push('OpenCode production gate cannot verify runtime version');
  } else if (evidence.version !== expected.opencodeVersion) {
    diagnostics.push(
      `OpenCode production E2E evidence version ${evidence.version} does not match runtime version ${expected.opencodeVersion}`
    );
  }

  if (!expected.binaryFingerprint) {
    diagnostics.push('OpenCode production gate cannot verify runtime binary fingerprint');
  } else if (evidence.binaryFingerprint !== expected.binaryFingerprint) {
    diagnostics.push(
      'OpenCode production E2E evidence binary fingerprint does not match runtime binary fingerprint'
    );
  }

  if (!expected.capabilitySnapshotId) {
    diagnostics.push('OpenCode production gate cannot verify capability snapshot id');
  } else if (evidence.capabilitySnapshotId !== expected.capabilitySnapshotId) {
    diagnostics.push(
      'OpenCode production E2E evidence capability snapshot does not match current runtime'
    );
  }

  if (
    expected.projectPathFingerprint &&
    evidence.projectPathFingerprint !== expected.projectPathFingerprint
  ) {
    diagnostics.push(
      'OpenCode production E2E evidence project context does not match the current working directory'
    );
  }

  const requiredTools = expected.requiredMcpTools ?? [];
  if (requiredTools.length > 0) {
    const observedTools = new Set(evidence.mcpTools.observedTools);
    const missingTools = requiredTools.filter((tool) => !observedTools.has(tool));
    if (missingTools.length > 0) {
      diagnostics.push(
        `OpenCode production E2E evidence does not prove required app MCP tools: ${missingTools.join(', ')}`
      );
    }
  }

  return diagnostics;
}

function normalizeRequiredSignals(
  value: unknown
): Record<OpenCodeProductionE2ERequiredSignal, boolean> {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence requiredSignals must be an object');
  }

  return Object.fromEntries(
    OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS.map((signal) => [
      signal,
      requireBoolean(record[signal], `requiredSignals.${signal}`),
    ])
  ) as Record<OpenCodeProductionE2ERequiredSignal, boolean>;
}

function normalizeMcpTools(value: unknown): OpenCodeProductionE2EEvidence['mcpTools'] {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence mcpTools must be an object');
  }
  return {
    requiredTools: requireStringArray(record.requiredTools, 'mcpTools.requiredTools'),
    observedTools: requireStringArray(record.observedTools, 'mcpTools.observedTools'),
  };
}

function validateOpenCodeProductionE2EEvidenceCollection(
  value: Record<string, unknown>
): OpenCodeProductionE2EEvidenceCollection {
  const entriesRecord = asRecord(value.entriesByModel);
  if (!entriesRecord) {
    throw new Error('OpenCode production E2E evidence collection entriesByModel must be an object');
  }

  const entries: Record<string, OpenCodeProductionE2EEvidence> = {};
  for (const [entryKey, rawEvidence] of Object.entries(entriesRecord)) {
    const trimmedEntryKey = entryKey.trim();
    if (!trimmedEntryKey) {
      throw new Error('OpenCode production E2E evidence collection key must be non-empty');
    }

    const evidence = validateOpenCodeProductionE2EEvidence(rawEvidence);
    entries[trimmedEntryKey] = evidence;
  }

  return {
    collectionSchemaVersion: OPENCODE_PRODUCTION_E2E_EVIDENCE_COLLECTION_SCHEMA_VERSION,
    entriesByModel: entries,
  };
}

function normalizeLaunch(value: unknown): OpenCodeProductionE2EEvidence['launch'] {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence launch must be an object');
  }
  if (record.teamLaunchState !== 'ready') {
    throw new Error('OpenCode production E2E evidence launch.teamLaunchState must be ready');
  }
  return {
    runId: requireString(record.runId, 'launch.runId'),
    teamId: requireString(record.teamId, 'launch.teamId'),
    teamLaunchState: 'ready',
    memberCount: requirePositiveInteger(record.memberCount, 'launch.memberCount'),
    sessions: requireArray(record.sessions, 'launch.sessions').map(normalizeSession),
    durableCheckpoints: requireArray(record.durableCheckpoints, 'launch.durableCheckpoints').map(
      normalizeCheckpoint
    ),
  };
}

function normalizeSession(value: unknown): OpenCodeProductionE2ESessionEvidence {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence launch session must be an object');
  }
  if (record.launchState !== 'confirmed_alive') {
    throw new Error('OpenCode production E2E evidence launch session must be confirmed_alive');
  }
  return {
    memberName: requireString(record.memberName, 'launch.sessions.memberName'),
    sessionId: requireString(record.sessionId, 'launch.sessions.sessionId'),
    launchState: 'confirmed_alive',
  };
}

function normalizeCheckpoint(value: unknown): OpenCodeProductionE2ECheckpointEvidence {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence durable checkpoint must be an object');
  }
  return {
    name: requireString(record.name, 'launch.durableCheckpoints.name'),
    observedAt: requireIsoDate(record.observedAt, 'launch.durableCheckpoints.observedAt'),
  };
}

function normalizeReconcile(value: unknown): OpenCodeProductionE2EEvidence['reconcile'] {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence reconcile must be an object');
  }
  if (record.teamLaunchState !== 'ready') {
    throw new Error('OpenCode production E2E evidence reconcile.teamLaunchState must be ready');
  }
  return {
    runId: requireString(record.runId, 'reconcile.runId'),
    teamLaunchState: 'ready',
    memberCount: requirePositiveInteger(record.memberCount, 'reconcile.memberCount'),
  };
}

function normalizeStop(value: unknown): OpenCodeProductionE2EEvidence['stop'] {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence stop must be an object');
  }
  if (record.stopped !== true) {
    throw new Error('OpenCode production E2E evidence stop.stopped must be true');
  }
  return {
    runId: requireString(record.runId, 'stop.runId'),
    stopped: true,
    stoppedSessionIds: requireStringArray(record.stoppedSessionIds, 'stop.stoppedSessionIds'),
  };
}

function normalizeLogProjection(value: unknown): OpenCodeProductionE2EEvidence['logProjection'] {
  const record = asRecord(value);
  if (!record) {
    throw new Error('OpenCode production E2E evidence logProjection must be an object');
  }
  if (record.observed !== true) {
    throw new Error('OpenCode production E2E evidence logProjection.observed must be true');
  }
  return {
    observed: true,
    projectedMessageCount: requirePositiveInteger(
      record.projectedMessageCount,
      'logProjection.projectedMessageCount'
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenCode production E2E evidence ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenCode production E2E evidence ${field} must be a non-empty string or null`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`OpenCode production E2E evidence ${field} must be boolean`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`OpenCode production E2E evidence ${field} must be a positive integer`);
  }
  return value as number;
}

function requireIsoDate(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`OpenCode production E2E evidence ${field} must be an ISO timestamp`);
  }
  return text;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`OpenCode production E2E evidence ${field} must be an array`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  return requireArray(value, field).map((item, index) => requireString(item, `${field}[${index}]`));
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireStringArray(value, field);
}
