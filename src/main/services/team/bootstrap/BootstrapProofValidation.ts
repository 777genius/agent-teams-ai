export const LEGACY_MEMBER_BRIEFING_BOOTSTRAP_PROOF_SOURCE = 'member_briefing_tool_success';
export const NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE =
  'native_app_managed_bootstrap_private_turn';

type BootstrapProofField =
  | 'source'
  | 'bootstrapProofToken'
  | 'contextHash'
  | 'briefingHash'
  | 'runId';

export type BootstrapProofSource =
  | typeof LEGACY_MEMBER_BRIEFING_BOOTSTRAP_PROOF_SOURCE
  | typeof NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE;

export type BootstrapProofValidationFailureReason =
  | 'wrong_event_type'
  | 'wrong_team'
  | 'stale_timestamp'
  | 'unsupported_source'
  | 'missing_team'
  | 'missing_token'
  | 'token_mismatch'
  | 'missing_run_id'
  | 'run_id_mismatch'
  | 'missing_hash'
  | 'hash_mismatch'
  | 'wrong_proof_mode';

export type BootstrapProofValidationResult =
  | { ok: true; source: BootstrapProofSource }
  | { ok: false; reason: BootstrapProofValidationFailureReason; diagnostic: string };

export interface BootstrapRuntimeProofEventLike {
  type?: unknown;
  timestamp?: unknown;
  teamName?: unknown;
  source?: unknown;
  bootstrapProofToken?: unknown;
  contextHash?: unknown;
  briefingHash?: unknown;
  runId?: unknown;
  detail?: unknown;
}

export interface BootstrapRuntimeProofExpected {
  teamName: string;
  boundaryMs: number;
  proofToken?: string;
  proofMode?: string;
  contextHash?: string;
  briefingHash?: string;
  runId?: string;
}

export function parseBootstrapRuntimeProofDetail(detail: unknown): Record<string, unknown> {
  if (typeof detail !== 'string' || detail.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(detail) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readProofField(
  event: BootstrapRuntimeProofEventLike,
  detail: Record<string, unknown>,
  field: BootstrapProofField
): string | undefined {
  const direct = event[field];
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim();
  }
  const nested = detail[field];
  return typeof nested === 'string' && nested.trim().length > 0 ? nested.trim() : undefined;
}

function getBootstrapProofSource(
  event: BootstrapRuntimeProofEventLike,
  detail: Record<string, unknown>
): BootstrapProofSource | undefined {
  const source = readProofField(event, detail, 'source');
  return source === LEGACY_MEMBER_BRIEFING_BOOTSTRAP_PROOF_SOURCE ||
    source === NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE
    ? source
    : undefined;
}

function reject(
  reason: BootstrapProofValidationFailureReason,
  diagnostic: string
): BootstrapProofValidationResult {
  return { ok: false, reason, diagnostic };
}

function validateExpectedProofToken(input: {
  event: BootstrapRuntimeProofEventLike;
  detail: Record<string, unknown>;
  expected: BootstrapRuntimeProofExpected;
}): BootstrapProofValidationResult | null {
  if (!input.expected.proofToken) {
    return null;
  }
  const eventToken = readProofField(input.event, input.detail, 'bootstrapProofToken');
  if (!eventToken) {
    return reject('missing_token', 'Bootstrap proof token is missing');
  }
  if (eventToken !== input.expected.proofToken) {
    return reject('token_mismatch', 'Bootstrap proof token does not match the current attempt');
  }
  return null;
}

function validateLegacyMemberBriefingProof(input: {
  event: BootstrapRuntimeProofEventLike;
  detail: Record<string, unknown>;
  expected: BootstrapRuntimeProofExpected;
}): BootstrapProofValidationResult {
  const tokenFailure = validateExpectedProofToken(input);
  return tokenFailure ?? { ok: true, source: LEGACY_MEMBER_BRIEFING_BOOTSTRAP_PROOF_SOURCE };
}

function validateNativeAppManagedProof(input: {
  event: BootstrapRuntimeProofEventLike;
  detail: Record<string, unknown>;
  expected: BootstrapRuntimeProofExpected;
}): BootstrapProofValidationResult {
  const eventTeamName = typeof input.event.teamName === 'string' ? input.event.teamName.trim() : '';
  if (!eventTeamName) {
    return reject('missing_team', 'Native app-managed bootstrap proof is missing teamName');
  }
  if (eventTeamName !== input.expected.teamName) {
    return reject('wrong_team', 'Native app-managed bootstrap proof teamName does not match');
  }
  if (input.expected.proofMode !== 'native_app_managed_context') {
    return reject('wrong_proof_mode', 'Native app-managed bootstrap proof mode is not expected');
  }

  const tokenFailure = validateExpectedProofToken(input);
  if (tokenFailure) {
    return tokenFailure;
  }
  if (!input.expected.proofToken) {
    return reject('missing_token', 'Native app-managed bootstrap expected proof token is missing');
  }

  const runId = readProofField(input.event, input.detail, 'runId');
  if (!input.expected.runId || !runId) {
    return reject('missing_run_id', 'Native app-managed bootstrap runId is missing');
  }
  if (runId !== input.expected.runId) {
    return reject('run_id_mismatch', 'Native app-managed bootstrap runId does not match');
  }

  const contextHash = readProofField(input.event, input.detail, 'contextHash');
  const briefingHash = readProofField(input.event, input.detail, 'briefingHash');
  if (
    !input.expected.contextHash ||
    !input.expected.briefingHash ||
    !contextHash ||
    !briefingHash
  ) {
    return reject('missing_hash', 'Native app-managed bootstrap proof hash metadata is missing');
  }
  if (contextHash !== input.expected.contextHash || briefingHash !== input.expected.briefingHash) {
    return reject('hash_mismatch', 'Native app-managed bootstrap proof hashes do not match');
  }

  return { ok: true, source: NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE };
}

const BOOTSTRAP_PROOF_VALIDATORS: Record<
  BootstrapProofSource,
  (input: {
    event: BootstrapRuntimeProofEventLike;
    detail: Record<string, unknown>;
    expected: BootstrapRuntimeProofExpected;
  }) => BootstrapProofValidationResult
> = {
  [LEGACY_MEMBER_BRIEFING_BOOTSTRAP_PROOF_SOURCE]: validateLegacyMemberBriefingProof,
  [NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE]: validateNativeAppManagedProof,
};

export function validateBootstrapRuntimeProofEnvelopeDetailed(input: {
  event: BootstrapRuntimeProofEventLike;
  detail?: Record<string, unknown>;
  expected: BootstrapRuntimeProofExpected;
}): BootstrapProofValidationResult {
  const { event, expected } = input;
  const detail = input.detail ?? parseBootstrapRuntimeProofDetail(event.detail);
  if (event.type !== 'bootstrap_confirmed') {
    return reject('wrong_event_type', 'Runtime event is not bootstrap_confirmed');
  }
  if (typeof event.teamName === 'string' && event.teamName.trim() !== expected.teamName) {
    return reject('wrong_team', 'Bootstrap proof teamName does not match');
  }
  const timestamp = typeof event.timestamp === 'string' ? event.timestamp : '';
  const eventMs = Date.parse(timestamp);
  if (
    Number.isFinite(expected.boundaryMs) &&
    (!Number.isFinite(eventMs) || eventMs < expected.boundaryMs)
  ) {
    return reject('stale_timestamp', 'Bootstrap proof timestamp is older than the current attempt');
  }

  const source = getBootstrapProofSource(event, detail);
  if (!source) {
    return reject('unsupported_source', 'Bootstrap proof source is missing or unsupported');
  }

  return BOOTSTRAP_PROOF_VALIDATORS[source]({ event, detail, expected });
}

export function validateBootstrapRuntimeProofEnvelope(input: {
  event: BootstrapRuntimeProofEventLike;
  detail?: Record<string, unknown>;
  expected: BootstrapRuntimeProofExpected;
}): boolean {
  return validateBootstrapRuntimeProofEnvelopeDetailed(input).ok;
}
