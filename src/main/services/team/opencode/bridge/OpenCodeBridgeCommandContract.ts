import { createHash } from 'crypto';

export const OPEN_CODE_BRIDGE_SCHEMA_VERSION = 1 as const;

export type OpenCodeBridgeCommandName =
  | 'opencode.handshake'
  | 'opencode.commandStatus'
  | 'opencode.readiness'
  | 'opencode.launchTeam'
  | 'opencode.reconcileTeam'
  | 'opencode.stopTeam'
  | 'opencode.sendMessage'
  | 'opencode.answerPermission'
  | 'opencode.listRuntimePermissions'
  | 'opencode.getRuntimeTranscript'
  | 'opencode.recoverDeliveryJournal';

export type OpenCodeTeamLaunchBridgeState =
  | 'blocked'
  | 'launching'
  | 'ready'
  | 'permission_blocked'
  | 'failed';

export type OpenCodeTeamMemberLaunchBridgeState =
  | 'created'
  | 'confirmed_alive'
  | 'permission_blocked'
  | 'failed';

export interface OpenCodeTeamBridgeDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface OpenCodeTeamBridgeWarning {
  code: string;
  message: string;
}

export interface OpenCodeTeamLaunchMemberCommandSpec {
  name: string;
  role: string;
  prompt: string;
}

export interface OpenCodeLaunchTeamCommandBody {
  runId: string;
  laneId: string;
  teamId: string;
  teamName: string;
  projectPath: string;
  selectedModel: string;
  members: OpenCodeTeamLaunchMemberCommandSpec[];
  leadPrompt: string;
  expectedCapabilitySnapshotId: string | null;
  manifestHighWatermark: number | null;
}

export interface OpenCodeTeamMemberLaunchCommandData {
  sessionId: string;
  launchState: OpenCodeTeamMemberLaunchBridgeState;
  pendingPermissionRequestIds?: string[];
  diagnostics?: string[];
  model: string;
  runtimePid?: number;
  evidence: { kind: string; observedAt: string }[];
}

export interface OpenCodeLaunchTeamCommandData {
  runId: string;
  teamLaunchState: OpenCodeTeamLaunchBridgeState;
  members: Record<string, OpenCodeTeamMemberLaunchCommandData>;
  warnings: OpenCodeTeamBridgeWarning[];
  diagnostics: OpenCodeTeamBridgeDiagnostic[];
  idempotencyKey?: string;
  manifestHighWatermark?: number | null;
  runtimeStoreManifestHighWatermark?: number | null;
  durableCheckpoints?: { name: string; memberName?: string | null; observedAt: string }[];
}

export interface OpenCodeReconcileTeamCommandBody {
  runId: string;
  laneId: string;
  teamId: string;
  teamName: string;
  projectPath?: string;
  expectedCapabilitySnapshotId?: string | null;
  manifestHighWatermark?: number | null;
  reconcileAttemptId?: string;
  expectedMembers: { name: string; model: string | null }[];
  reason: string;
}

export interface OpenCodeStopTeamCommandBody {
  runId: string;
  laneId: string;
  teamId: string;
  teamName: string;
  projectPath?: string;
  expectedCapabilitySnapshotId?: string | null;
  manifestHighWatermark?: number | null;
  reason: string;
  force?: boolean;
}

export interface OpenCodeStopTeamCommandData {
  runId: string;
  stopped: boolean;
  members: Record<string, { sessionId?: string; stopped: boolean; diagnostics: string[] }>;
  warnings: OpenCodeTeamBridgeWarning[];
  diagnostics: OpenCodeTeamBridgeDiagnostic[];
  idempotencyKey?: string;
  manifestHighWatermark?: number | null;
  runtimeStoreManifestHighWatermark?: number | null;
}

export interface OpenCodeSendMessageCommandBody {
  runId?: string;
  laneId: string;
  teamId: string;
  teamName: string;
  projectPath: string;
  memberName: string;
  text: string;
  messageId?: string;
  agent?: string;
  noReply?: boolean;
}

export interface OpenCodeSendMessageCommandData {
  accepted: boolean;
  sessionId?: string;
  memberName: string;
  runtimePid?: number;
  diagnostics: OpenCodeTeamBridgeDiagnostic[];
}

export type OpenCodeBridgePeerName = 'claude_team' | 'agent_teams_orchestrator';

export type OpenCodeBridgeFailureKind =
  | 'unsupported_schema'
  | 'unsupported_command'
  | 'invalid_input'
  | 'runtime_not_ready'
  | 'provider_error'
  | 'timeout'
  | 'contract_violation'
  | 'internal_error';

export interface OpenCodeBridgeDiagnosticEvent {
  id?: string;
  type: string;
  providerId: 'opencode';
  teamName?: string;
  runId?: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface OpenCodeBridgeCommandEnvelope<TBody> {
  schemaVersion: typeof OPEN_CODE_BRIDGE_SCHEMA_VERSION;
  requestId: string;
  command: OpenCodeBridgeCommandName;
  cwd: string;
  startedAt: string;
  timeoutMs: number;
  body: TBody;
}

export interface OpenCodeBridgeRuntimeSnapshot {
  providerId: 'opencode';
  binaryPath: string | null;
  binaryFingerprint: string | null;
  version: string | null;
  capabilitySnapshotId: string | null;
}

export interface OpenCodeBridgeSuccess<TData> {
  ok: true;
  schemaVersion: typeof OPEN_CODE_BRIDGE_SCHEMA_VERSION;
  requestId: string;
  command: OpenCodeBridgeCommandName;
  completedAt: string;
  durationMs: number;
  runtime: OpenCodeBridgeRuntimeSnapshot;
  diagnostics: OpenCodeBridgeDiagnosticEvent[];
  data: TData;
}

export interface OpenCodeBridgeFailure {
  ok: false;
  schemaVersion: typeof OPEN_CODE_BRIDGE_SCHEMA_VERSION;
  requestId: string;
  command: OpenCodeBridgeCommandName;
  completedAt: string;
  durationMs: number;
  error: {
    kind: OpenCodeBridgeFailureKind;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  diagnostics: OpenCodeBridgeDiagnosticEvent[];
}

export type OpenCodeBridgeResult<TData> = OpenCodeBridgeSuccess<TData> | OpenCodeBridgeFailure;

export interface OpenCodeBridgePeerIdentity {
  schemaVersion: typeof OPEN_CODE_BRIDGE_SCHEMA_VERSION;
  peer: OpenCodeBridgePeerName;
  appVersion: string;
  gitSha: string | null;
  buildId: string | null;
  bridgeProtocol: {
    minVersion: number;
    currentVersion: number;
    supportedCommands: OpenCodeBridgeCommandName[];
  };
  runtime: {
    providerId: 'opencode';
    binaryPath: string | null;
    binaryFingerprint: string | null;
    version: string | null;
    capabilitySnapshotId: string | null;
    runtimeStoreManifestHighWatermark: number | null;
    activeRunId: string | null;
  };
  featureFlags: {
    opencodeTeamLaunch: boolean;
    opencodeStateChangingCommands: boolean;
  };
}

export interface OpenCodeBridgeHandshake {
  schemaVersion: typeof OPEN_CODE_BRIDGE_SCHEMA_VERSION;
  requestId: string;
  client: OpenCodeBridgePeerIdentity;
  server: OpenCodeBridgePeerIdentity;
  agreedProtocolVersion: number;
  acceptedCommands: OpenCodeBridgeCommandName[];
  serverTime: string;
  identityHash: string;
}

export interface OpenCodeBridgeCommandPreconditions {
  handshakeIdentityHash: string;
  laneId: string | null;
  expectedRunId: string | null;
  expectedCapabilitySnapshotId: string | null;
  expectedBehaviorFingerprint: string | null;
  expectedManifestHighWatermark: number | null;
  commandLeaseId: string | null;
  idempotencyKey: string;
}

export interface OpenCodeStateChangingBridgeEnvelope<
  TBody,
> extends OpenCodeBridgeCommandEnvelope<TBody> {
  stateChanging: true;
  preconditions: OpenCodeBridgeCommandPreconditions;
}

export interface RuntimeStoreManifestEvidence {
  highWatermark: number;
  activeRunId?: string | null;
  capabilitySnapshotId?: string | null;
}

const VALID_COMMANDS: ReadonlySet<OpenCodeBridgeCommandName> = new Set([
  'opencode.handshake',
  'opencode.commandStatus',
  'opencode.readiness',
  'opencode.launchTeam',
  'opencode.reconcileTeam',
  'opencode.stopTeam',
  'opencode.sendMessage',
  'opencode.answerPermission',
  'opencode.listRuntimePermissions',
  'opencode.getRuntimeTranscript',
  'opencode.recoverDeliveryJournal',
]);

const VALID_FAILURE_KINDS: ReadonlySet<OpenCodeBridgeFailureKind> = new Set([
  'unsupported_schema',
  'unsupported_command',
  'invalid_input',
  'runtime_not_ready',
  'provider_error',
  'timeout',
  'contract_violation',
  'internal_error',
]);

export function isOpenCodeBridgeCommandName(value: unknown): value is OpenCodeBridgeCommandName {
  return typeof value === 'string' && VALID_COMMANDS.has(value as OpenCodeBridgeCommandName);
}

export function parseSingleBridgeJsonResult<TData>(
  stdout: string
): { ok: true; value: OpenCodeBridgeResult<TData> } | { ok: false; error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: false, error: 'Bridge stdout was empty' };
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    return {
      ok: false,
      error: `Bridge stdout must contain exactly one JSON line, got ${lines.length}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]);
  } catch (error) {
    return { ok: false, error: `Bridge stdout JSON parse failed: ${stringifyError(error)}` };
  }

  const validation = validateOpenCodeBridgeResultShape(parsed);
  if (!validation.ok) {
    return { ok: false, error: validation.reason };
  }

  return { ok: true, value: validation.value as OpenCodeBridgeResult<TData> };
}

export function validateBridgeResultEnvelope<TBody, TData>(
  result: OpenCodeBridgeResult<TData>,
  envelope: Pick<OpenCodeBridgeCommandEnvelope<TBody>, 'schemaVersion' | 'requestId' | 'command'>
): { ok: true } | { ok: false; reason: string } {
  const shape = validateOpenCodeBridgeResultShape(result);
  if (!shape.ok) {
    return { ok: false, reason: shape.reason };
  }

  if (result.schemaVersion !== envelope.schemaVersion) {
    return { ok: false, reason: 'OpenCode bridge schemaVersion mismatch' };
  }

  if (result.requestId !== envelope.requestId) {
    return { ok: false, reason: 'OpenCode bridge requestId mismatch' };
  }

  if (result.command !== envelope.command) {
    return { ok: false, reason: 'OpenCode bridge command mismatch' };
  }

  return { ok: true };
}

export function assertBridgeResultCanMutateState<TData>(
  result: OpenCodeBridgeResult<TData>,
  expected: {
    requestId: string;
    command: OpenCodeBridgeCommandName;
    runId: string | null;
    capabilitySnapshotId: string | null;
  }
): asserts result is OpenCodeBridgeSuccess<TData> {
  if (!result.ok) {
    throw new Error(
      `OpenCode bridge command failed: ${result.error.kind}: ${result.error.message}`
    );
  }

  if (result.requestId !== expected.requestId) {
    throw new Error('OpenCode bridge requestId mismatch');
  }

  if (result.command !== expected.command) {
    throw new Error('OpenCode bridge command mismatch');
  }

  if (extractRunId(result.data) !== expected.runId) {
    throw new Error('OpenCode bridge runId mismatch');
  }

  if (
    expected.capabilitySnapshotId !== null &&
    result.runtime.capabilitySnapshotId !== expected.capabilitySnapshotId
  ) {
    throw new Error('OpenCode bridge capability snapshot mismatch');
  }
}

export function validateOpenCodeBridgeHandshake(input: {
  handshake: OpenCodeBridgeHandshake;
  expectedClient: OpenCodeBridgePeerIdentity;
  requiredCommand: OpenCodeBridgeCommandName;
  expectedCapabilitySnapshotId: string | null;
  expectedManifestHighWatermark: number | null;
  expectedRunId: string | null;
}): { ok: true } | { ok: false; reason: string } {
  const shape = validateOpenCodeBridgeHandshakeShape(input.handshake);
  if (!shape.ok) {
    return shape;
  }

  if (input.handshake.client.peer !== input.expectedClient.peer) {
    return { ok: false, reason: 'Bridge handshake client peer mismatch' };
  }

  if (stableHash(input.handshake.client) !== stableHash(input.expectedClient)) {
    return { ok: false, reason: 'Bridge handshake client identity mismatch' };
  }

  const minimumProtocol = Math.max(
    input.handshake.client.bridgeProtocol.minVersion,
    input.handshake.server.bridgeProtocol.minVersion
  );
  const maximumProtocol = Math.min(
    input.handshake.client.bridgeProtocol.currentVersion,
    input.handshake.server.bridgeProtocol.currentVersion
  );

  if (
    input.handshake.agreedProtocolVersion < minimumProtocol ||
    input.handshake.agreedProtocolVersion > maximumProtocol
  ) {
    return { ok: false, reason: 'Bridge handshake protocol version mismatch' };
  }

  if (!input.handshake.acceptedCommands.includes(input.requiredCommand)) {
    return { ok: false, reason: `Bridge server does not accept command ${input.requiredCommand}` };
  }

  if (!input.handshake.server.bridgeProtocol.supportedCommands.includes(input.requiredCommand)) {
    return { ok: false, reason: `Bridge server does not support command ${input.requiredCommand}` };
  }

  if (
    input.expectedCapabilitySnapshotId &&
    input.handshake.server.runtime.capabilitySnapshotId !== input.expectedCapabilitySnapshotId
  ) {
    return { ok: false, reason: 'Bridge server capability snapshot mismatch' };
  }

  if (
    input.expectedRunId &&
    input.handshake.server.runtime.activeRunId &&
    input.handshake.server.runtime.activeRunId !== input.expectedRunId
  ) {
    return { ok: false, reason: 'Bridge server active run mismatch' };
  }

  const serverHighWatermark = input.handshake.server.runtime.runtimeStoreManifestHighWatermark;
  if (
    input.expectedManifestHighWatermark !== null &&
    serverHighWatermark !== null &&
    serverHighWatermark < input.expectedManifestHighWatermark
  ) {
    return { ok: false, reason: 'Bridge server runtime manifest high watermark is stale' };
  }

  const expectedIdentityHash = createOpenCodeBridgeHandshakeIdentityHash(input.handshake);
  if (input.handshake.identityHash !== expectedIdentityHash) {
    return { ok: false, reason: 'Bridge handshake identity hash mismatch' };
  }

  return { ok: true };
}

export function createOpenCodeBridgeHandshakeIdentityHash(
  handshake: Omit<OpenCodeBridgeHandshake, 'identityHash'> | OpenCodeBridgeHandshake
): string {
  const { identityHash: _ignored, ...hashable } = handshake as OpenCodeBridgeHandshake;
  return stableHash(hashable);
}

export function assertBridgeEvidenceCanCommitToRuntimeStores(input: {
  result: OpenCodeBridgeResult<unknown>;
  requestId: string;
  command: OpenCodeBridgeCommandName;
  runId: string | null;
  capabilitySnapshotId: string | null;
  manifest: RuntimeStoreManifestEvidence;
  idempotencyKey: string;
}): asserts input is {
  result: OpenCodeBridgeSuccess<unknown>;
  requestId: string;
  command: OpenCodeBridgeCommandName;
  runId: string | null;
  capabilitySnapshotId: string | null;
  manifest: RuntimeStoreManifestEvidence;
  idempotencyKey: string;
} {
  assertBridgeResultCanMutateState(input.result, {
    requestId: input.requestId,
    command: input.command,
    runId: input.runId,
    capabilitySnapshotId: input.capabilitySnapshotId,
  });

  const resultManifestHighWatermark = extractManifestHighWatermark(input.result.data);
  if (
    typeof resultManifestHighWatermark === 'number' &&
    resultManifestHighWatermark < input.manifest.highWatermark
  ) {
    throw new Error('Bridge result manifest high watermark is stale');
  }

  if (extractIdempotencyKey(input.result.data) !== input.idempotencyKey) {
    throw new Error('Bridge result idempotency key mismatch');
  }
}

export function createOpenCodeBridgeIdempotencyKey(input: {
  command: OpenCodeBridgeCommandName;
  teamName: string;
  laneId?: string | null;
  runId: string | null;
  body: unknown;
}): string {
  const scope = [
    'opencode',
    sanitizeKeyPart(input.command),
    sanitizeKeyPart(input.teamName),
    sanitizeKeyPart(input.laneId ?? 'no-lane'),
    sanitizeKeyPart(input.runId ?? 'no-run'),
  ].join(':');
  return `${scope}:${stableHash(input).slice(0, 32)}`;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeStableJson(value));
}

export function extractRunId(value: unknown): string | null {
  return (
    extractStringByPath(value, ['runId']) ??
    extractStringByPath(value, ['runtimeRunId']) ??
    extractStringByPath(value, ['runtime', 'runId']) ??
    extractStringByPath(value, ['launch', 'runId'])
  );
}

export function extractIdempotencyKey(value: unknown): string | null {
  return (
    extractStringByPath(value, ['idempotencyKey']) ??
    extractStringByPath(value, ['preconditions', 'idempotencyKey']) ??
    extractStringByPath(value, ['command', 'idempotencyKey'])
  );
}

export function extractManifestHighWatermark(value: unknown): number | null {
  return (
    extractNumberByPath(value, ['runtimeStoreManifestHighWatermark']) ??
    extractNumberByPath(value, ['manifestHighWatermark']) ??
    extractNumberByPath(value, ['manifest', 'highWatermark'])
  );
}

function validateOpenCodeBridgeResultShape(
  value: unknown
): { ok: true; value: OpenCodeBridgeResult<unknown> } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: 'Bridge result must be a JSON object' };
  }

  if (value.schemaVersion !== OPEN_CODE_BRIDGE_SCHEMA_VERSION) {
    return { ok: false, reason: 'Bridge result has unsupported schemaVersion' };
  }

  if (typeof value.ok !== 'boolean') {
    return { ok: false, reason: 'Bridge result missing ok boolean' };
  }

  if (typeof value.requestId !== 'string' || !value.requestId.trim()) {
    return { ok: false, reason: 'Bridge result missing requestId' };
  }

  if (!isOpenCodeBridgeCommandName(value.command)) {
    return { ok: false, reason: 'Bridge result has unsupported command' };
  }

  if (typeof value.completedAt !== 'string' || !value.completedAt.trim()) {
    return { ok: false, reason: 'Bridge result missing completedAt' };
  }

  if (!isNonNegativeFiniteNumber(value.durationMs)) {
    return { ok: false, reason: 'Bridge result has invalid durationMs' };
  }

  if (!Array.isArray(value.diagnostics) || !value.diagnostics.every(isDiagnosticEvent)) {
    return { ok: false, reason: 'Bridge result diagnostics are invalid' };
  }

  if (value.ok) {
    if (!isRuntimeSnapshot(value.runtime)) {
      return { ok: false, reason: 'Bridge success runtime snapshot is invalid' };
    }

    if (!Object.prototype.hasOwnProperty.call(value, 'data')) {
      return { ok: false, reason: 'Bridge success missing data' };
    }

    return { ok: true, value: value as unknown as OpenCodeBridgeSuccess<unknown> };
  }

  if (!isRecord(value.error)) {
    return { ok: false, reason: 'Bridge failure missing error object' };
  }

  if (!VALID_FAILURE_KINDS.has(value.error.kind as OpenCodeBridgeFailureKind)) {
    return { ok: false, reason: 'Bridge failure has unsupported error kind' };
  }

  if (typeof value.error.message !== 'string' || !value.error.message.trim()) {
    return { ok: false, reason: 'Bridge failure missing error message' };
  }

  if (typeof value.error.retryable !== 'boolean') {
    return { ok: false, reason: 'Bridge failure missing retryable boolean' };
  }

  if (
    value.error.details !== undefined &&
    (value.error.details === null || !isRecord(value.error.details))
  ) {
    return { ok: false, reason: 'Bridge failure details must be an object' };
  }

  return { ok: true, value: value as unknown as OpenCodeBridgeFailure };
}

function validateOpenCodeBridgeHandshakeShape(
  handshake: OpenCodeBridgeHandshake
): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(handshake)) {
    return { ok: false, reason: 'Bridge handshake must be a JSON object' };
  }

  if (handshake.schemaVersion !== OPEN_CODE_BRIDGE_SCHEMA_VERSION) {
    return { ok: false, reason: 'Bridge handshake has unsupported schemaVersion' };
  }

  if (typeof handshake.requestId !== 'string' || !handshake.requestId.trim()) {
    return { ok: false, reason: 'Bridge handshake missing requestId' };
  }

  if (!isPeerIdentity(handshake.client) || !isPeerIdentity(handshake.server)) {
    return { ok: false, reason: 'Bridge handshake peer identity is invalid' };
  }

  if (!Number.isInteger(handshake.agreedProtocolVersion) || handshake.agreedProtocolVersion < 1) {
    return { ok: false, reason: 'Bridge handshake protocol version is invalid' };
  }

  if (
    !Array.isArray(handshake.acceptedCommands) ||
    !handshake.acceptedCommands.every(isOpenCodeBridgeCommandName)
  ) {
    return { ok: false, reason: 'Bridge handshake accepted commands are invalid' };
  }

  if (typeof handshake.serverTime !== 'string' || !handshake.serverTime.trim()) {
    return { ok: false, reason: 'Bridge handshake serverTime is invalid' };
  }

  if (typeof handshake.identityHash !== 'string' || !handshake.identityHash.trim()) {
    return { ok: false, reason: 'Bridge handshake identityHash is invalid' };
  }

  return { ok: true };
}

function isPeerIdentity(value: unknown): value is OpenCodeBridgePeerIdentity {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schemaVersion !== OPEN_CODE_BRIDGE_SCHEMA_VERSION ||
    (value.peer !== 'claude_team' && value.peer !== 'agent_teams_orchestrator') ||
    typeof value.appVersion !== 'string' ||
    !isNullableString(value.gitSha) ||
    !isNullableString(value.buildId)
  ) {
    return false;
  }

  const bridgeProtocol = value.bridgeProtocol;
  if (!isRecord(bridgeProtocol)) {
    return false;
  }

  if (
    !Number.isInteger(bridgeProtocol.minVersion) ||
    !Number.isInteger(bridgeProtocol.currentVersion) ||
    (bridgeProtocol.minVersion as number) < 1 ||
    (bridgeProtocol.currentVersion as number) < (bridgeProtocol.minVersion as number) ||
    !Array.isArray(bridgeProtocol.supportedCommands) ||
    !bridgeProtocol.supportedCommands.every(isOpenCodeBridgeCommandName)
  ) {
    return false;
  }

  const runtime = value.runtime;
  if (!isRecord(runtime) || runtime.providerId !== 'opencode') {
    return false;
  }

  if (
    !isNullableString(runtime.binaryPath) ||
    !isNullableString(runtime.binaryFingerprint) ||
    !isNullableString(runtime.version) ||
    !isNullableString(runtime.capabilitySnapshotId) ||
    !isNullableInteger(runtime.runtimeStoreManifestHighWatermark) ||
    !isNullableString(runtime.activeRunId)
  ) {
    return false;
  }

  const featureFlags = value.featureFlags;
  if (!isRecord(featureFlags)) {
    return false;
  }

  return (
    typeof featureFlags.opencodeTeamLaunch === 'boolean' &&
    typeof featureFlags.opencodeStateChangingCommands === 'boolean'
  );
}

function isRuntimeSnapshot(value: unknown): value is OpenCodeBridgeRuntimeSnapshot {
  return (
    isRecord(value) &&
    value.providerId === 'opencode' &&
    isNullableString(value.binaryPath) &&
    isNullableString(value.binaryFingerprint) &&
    isNullableString(value.version) &&
    isNullableString(value.capabilitySnapshotId)
  );
}

function isDiagnosticEvent(value: unknown): value is OpenCodeBridgeDiagnosticEvent {
  return (
    isRecord(value) &&
    value.providerId === 'opencode' &&
    typeof value.type === 'string' &&
    value.type.trim().length > 0 &&
    (value.severity === 'info' || value.severity === 'warning' || value.severity === 'error') &&
    typeof value.message === 'string' &&
    value.message.trim().length > 0 &&
    typeof value.createdAt === 'string' &&
    value.createdAt.trim().length > 0 &&
    (value.data === undefined || isRecord(value.data))
  );
}

function extractStringByPath(value: unknown, pathParts: string[]): string | null {
  const nested = getByPath(value, pathParts);
  return typeof nested === 'string' && nested.trim() ? nested : null;
}

function extractNumberByPath(value: unknown, pathParts: string[]): number | null {
  const nested = getByPath(value, pathParts);
  return isNonNegativeFiniteNumber(nested) ? nested : null;
}

function getByPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function sanitizeKeyPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized.slice(0, 64) || 'unknown';
}

function stableJsonComparableNumber(value: number): number | string {
  if (Number.isFinite(value)) {
    return value;
  }
  return String(value);
}

function normalizeStableJson(value: unknown): unknown {
  if (value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return stableJsonComparableNumber(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeStableJson);
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) {
      output[key] = normalizeStableJson(nested);
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
