import { readdir } from 'node:fs/promises';

import { assertRootCurrent, procFdPath, type RootAnchor } from './anchors';
import {
  MATRIX_ROWS,
  P3C_LANE,
  RAW_ORIGINS,
  RAW_RECORD_PURPOSE,
  canonicalJson,
  exactRecord,
  sha256,
  validateDecimal,
  validateRecordId,
  validateSafeId,
  type MatrixRow,
  type RawOrigin,
  type RawRecord,
} from './contracts';
import type { ProcessStartEvidence, SupervisorOutcome } from './processes';
import type { CleanupResult } from './sandbox';
import { assertNoSecretLikeBytes, writeExclusive } from './secure-files';

type Requirement = readonly [RawOrigin, string, number];

export const EVIDENCE_REQUIREMENTS: Readonly<Record<MatrixRow, readonly Requirement[]>> =
  Object.freeze({
    '01_pending_before_http': [
      ['owner-wal', 'pending_fsynced', 0],
      ['supervisor', 'owner_restart_completed', 0],
      ['owner-wal', 'pending_restored_after_restart', 0],
      ['product-http', 'pending_observed', 0],
      ['product-http', 'approval_preview_observed', 0],
      ['product-sse', 'pending_event_observed', 0],
    ],
    '02_browser_allow_deny': [
      ['browser', 'allow_submitted', 0],
      ['browser', 'deny_submitted', 0],
      ['product-http', 'allow_accepted', 0],
      ['product-http', 'deny_accepted', 0],
      ['opencode', 'allow_conditional_request', 0],
      ['opencode', 'allow_effect', 1],
      ['opencode', 'allow_conditional_response', 1],
      ['opencode', 'deny_conditional_request', 1],
      ['opencode', 'deny_effect', 2],
      ['opencode', 'deny_conditional_response', 2],
    ],
    '03_owner_effect_settlement': [
      ['owner-wal', 'allow_terminal_fsynced', 2],
      ['owner-wal', 'deny_terminal_fsynced', 2],
      ['product-http', 'terminal_state_observed', 2],
      ['product-sse', 'terminal_events_observed', 2],
      ['opencode', 'effect_total_two', 2],
    ],
    '04_auth_replay_rejections': [
      ['product-http', 'missing_session_rejected', 2],
      ['product-http', 'invalid_session_rejected', 2],
      ['product-http', 'origin_rejected', 2],
      ['product-http', 'csrf_rejected', 2],
      ['product-http', 'stale_revision_rejected', 2],
      ['product-http', 'wrong_team_rejected', 2],
      ['product-http', 'wrong_run_rejected', 2],
      ['product-http', 'wrong_provider_rejected', 2],
      ['product-http', 'non_owner_browser_rejected', 2],
      ['product-http', 'duplicate_post_rejected', 2],
      ['product-http', 'nonce_replay_rejected', 2],
      ['owner-wal', 'owner_response_replay_rejected', 2],
      ['product-sse', 'duplicate_suppressed', 2],
      ['product-sse', 'gap_reconnected', 2],
      ['opencode', 'negative_effect_delta_zero', 2],
    ],
    '05_restart_generation_fences': [
      ['supervisor', 'restart_boundary_one', 2],
      ['supervisor', 'restart_boundary_two', 2],
      ['supervisor', 'restart_boundary_three', 2],
      ['owner-wal', 'stale_generations_rejected', 2],
      ['owner-wal', 'stale_sockets_rejected', 2],
      ['owner-wal', 'truth_reconstructed', 2],
    ],
    '06_ambiguity_reconciliation': [
      ['owner-wal', 'operator_required_fsynced', 2],
      ['owner-wal', 'automatic_retry_absent', 2],
      ['opencode', 'reconcile_delivered_no_effect', 2],
      ['opencode', 'reconcile_not_delivered_one_retry', 3],
      ['owner-wal', 'reconcile_unknown_held', 3],
      ['product-http', 'reconcile_while_lease_open_rejected', 3],
      ['product-http', 'reconcile_identity_mismatch_rejected', 3],
    ],
    '07_socket_capability_admission': [
      ['product-http', 'wrong_lane_routes_absent', 3],
      ['product-http', 'wrong_socket_path_routes_absent', 3],
      ['product-http', 'wrong_socket_device_routes_absent', 3],
      ['product-http', 'wrong_socket_inode_routes_absent', 3],
      ['product-http', 'replaced_socket_routes_absent', 3],
      ['product-http', 'wrong_socket_uid_routes_absent', 3],
      ['product-http', 'wrong_socket_gid_routes_absent', 3],
      ['product-http', 'wrong_socket_mode_routes_absent', 3],
      ['product-http', 'dead_owner_routes_absent', 3],
      ['product-http', 'wrong_artifact_digest_routes_absent', 3],
      ['product-http', 'wrong_capability_digest_routes_absent', 3],
      ['product-http', 'legacy_generation_routes_absent', 3],
      ['product-http', 'provisioning_routes_absent', 3],
      ['product-http', 'restart_required_routes_absent', 3],
      ['product-http', 'missing_capability_routes_absent', 3],
      ['product-http', 'capability_downgrade_routes_absent', 3],
      ['owner-wal', 'new_activation_required', 3],
    ],
    '08_cross_team_isolation': [
      ['browser', 'cross_team_list_rejected', 3],
      ['browser', 'cross_team_preview_rejected', 3],
      ['browser', 'cross_team_decide_rejected', 3],
      ['product-http', 'team_b_item_observed', 3],
      ['product-http', 'team_b_preview_request_observed', 3],
      ['product-http', 'team_b_preview_result_observed', 3],
      ['product-http', 'cross_team_list_rejected', 3],
      ['product-http', 'cross_team_preview_rejected', 3],
      ['product-http', 'cross_team_read_rejected', 3],
      ['product-http', 'cross_team_decide_rejected', 3],
      ['product-http', 'cross_team_reconcile_rejected', 3],
      ['product-sse', 'cross_team_subscribe_rejected', 3],
      ['owner-wal', 'partitions_unchanged', 3],
      ['opencode', 'cross_team_effect_delta_zero', 3],
    ],
    '09_forced_failure_shutdown': [
      ['supervisor', 'forced_owner_failure_drained', 3],
      ['supervisor', 'forced_owner_failure_zero_survivors', 3],
      ['supervisor', 'forced_owner_failure_no_outside_effect', 3],
      ['supervisor', 'forced_opencode_failure_drained', 3],
      ['supervisor', 'forced_opencode_failure_zero_survivors', 3],
      ['supervisor', 'forced_opencode_failure_no_outside_effect', 3],
    ],
    '10_normal_shutdown_cleanup': [
      ['supervisor', 'normal_shutdown_drained', 3],
      ['supervisor', 'normal_shutdown_zero_survivors', 3],
      ['supervisor', 'normal_shutdown_marker_checked', 3],
      ['supervisor', 'normal_shutdown_no_outside_effect', 3],
    ],
  });

export interface OriginEvidence {
  readonly sha256: string;
  readonly size: number;
  readonly count: number;
  readonly firstMonotonicNs: string;
  readonly lastMonotonicNs: string;
}

export interface RowEvidence {
  readonly row: MatrixRow;
  readonly correlations: readonly string[];
  readonly identityDigests: readonly string[];
  readonly recordIds: readonly string[];
  readonly records: readonly {
    readonly origin: RawOrigin;
    readonly recordId: string;
    readonly byteStart: number;
    readonly byteEnd: number;
    readonly lineSha256: string;
  }[];
}

export interface SemanticIdentity {
  readonly lane: typeof P3C_LANE;
  readonly controllerNonce: string;
  readonly harnessRunId: string;
  readonly authenticatedActorTeamId: string;
  readonly targetTeamRunId: string;
  readonly targetTeamId: string;
  readonly approvalId: string;
  readonly generationId: string;
  readonly idempotencyKey: string;
  readonly previewRef: string;
  readonly decision: 'allow' | 'deny' | 'none';
}

interface CausalEvidence {
  readonly chainId: string;
  readonly phase: number;
  readonly providerEffectId: string | null;
  readonly attempt: number;
  readonly retryObserved: boolean;
  readonly providerEffectSha256: string | null;
  readonly effectSetDigest: string | null;
  readonly effectSetSha256s: readonly string[] | null;
}

interface ParsedRawRecord extends RawRecord {
  readonly semanticIdentity: SemanticIdentity;
  readonly ownerGeneration: number;
  readonly processEvidenceSetId: string | null;
  readonly causal: CausalEvidence;
}

interface LocatedRawRecord extends ParsedRawRecord {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineSha256: string;
}

export interface EvidenceDocument {
  readonly schemaVersion: 1;
  readonly purpose: 'agent-teams.p3c.evidence/v1';
  readonly controllerNonce: string;
  readonly runId: string;
  readonly result: 'verified';
  readonly raw: Readonly<Record<RawOrigin, OriginEvidence>>;
  readonly rows: readonly RowEvidence[];
  readonly exactlyOnce: ExactlyOnceEvidence;
  readonly supervisorTranscriptSha256: string;
  readonly cleanup: CleanupResult;
  readonly evidenceDigest: string;
}

export interface ExactlyOnceEvidence {
  readonly normalProviderEffects: readonly {
    readonly decision: 'allow' | 'deny';
    readonly chainId: string;
    readonly providerEffectId: string;
    readonly providerEffectRecordId: string;
    readonly attempt: 1;
    readonly retryObserved: false;
  }[];
  readonly globallyUniqueProviderEffectIds: true;
  readonly observedNormalRetryCount: 0;
}

function parseRecord(
  value: unknown,
  origin: RawOrigin,
  sequence: number,
  controllerNonce: string
): ParsedRawRecord {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'purpose',
      'controllerNonce',
      'origin',
      'row',
      'sequence',
      'monotonicNs',
      'processStartToken',
      'recordId',
      'event',
      'correlation',
      'effectCount',
      'payloadBase64',
      'payloadSha256',
    ],
    'raw_record'
  );
  if (
    item.schemaVersion !== 1 ||
    item.purpose !== RAW_RECORD_PURPOSE ||
    item.controllerNonce !== controllerNonce ||
    item.origin !== origin ||
    item.sequence !== sequence ||
    !MATRIX_ROWS.includes(item.row as MatrixRow) ||
    !Number.isSafeInteger(item.effectCount) ||
    (item.effectCount as number) < 0 ||
    (item.effectCount as number) > 16 ||
    typeof item.payloadBase64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.payloadBase64)
  )
    throw new Error('p3c_raw_record_value');
  const payload = Buffer.from(item.payloadBase64, 'base64');
  if (
    payload.length < 2 ||
    payload.length > 1024 * 1024 ||
    payload.toString('base64') !== item.payloadBase64
  )
    throw new Error('p3c_raw_payload_frame');
  assertNoSecretLikeBytes(payload);
  const semantic = validateStructuralPayload(
    origin,
    item.row as MatrixRow,
    String(item.event),
    controllerNonce,
    payload
  );
  const payloadSha256 = validateRecordId(item.payloadSha256, 'raw_payload_sha');
  if (sha256(payload) !== payloadSha256) throw new Error('p3c_raw_payload_digest');
  const unsigned = { ...item };
  delete unsigned.recordId;
  const recordId = validateRecordId(item.recordId, 'raw_record_id');
  if (sha256(`agent-teams.p3c.raw-record-id/v1\0${canonicalJson(unsigned)}`) !== recordId)
    throw new Error('p3c_raw_record_identity');
  return Object.freeze({
    schemaVersion: 1,
    purpose: RAW_RECORD_PURPOSE,
    controllerNonce,
    origin,
    row: item.row as MatrixRow,
    sequence,
    monotonicNs: validateDecimal(item.monotonicNs, 'raw_monotonic'),
    processStartToken: validateRecordId(item.processStartToken, 'raw_process_start'),
    recordId,
    event: validateSafeId(item.event, 'raw_event'),
    correlation: validateRecordId(item.correlation, 'raw_correlation'),
    effectCount: item.effectCount as number,
    payloadBase64: item.payloadBase64,
    payloadSha256,
    semanticIdentity: semantic.identity,
    ownerGeneration: semantic.ownerGeneration,
    processEvidenceSetId: semantic.processEvidenceSetId,
    causal: semantic.causal,
  });
}

const SEMANTIC_PURPOSE = 'agent-teams.p3c.semantic-record/v1' as const;
const ID_PATTERNS = Object.freeze({
  authenticatedActorTeamId: /^team_[0-9a-f]{32}$/u,
  targetTeamId: /^team_[0-9a-f]{32}$/u,
  approvalId: /^approval_[0-9a-f]{32}$/u,
  generationId: /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u,
  idempotencyKey: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
  previewRef: /^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u,
});

function parseSemanticIdentity(value: unknown, controllerNonce: string): SemanticIdentity {
  const identity = exactRecord(
    value,
    [
      'lane',
      'controllerNonce',
      'harnessRunId',
      'authenticatedActorTeamId',
      'targetTeamRunId',
      'targetTeamId',
      'approvalId',
      'generationId',
      'idempotencyKey',
      'previewRef',
      'decision',
    ],
    'semantic_identity'
  );
  if (
    identity.lane !== P3C_LANE ||
    identity.controllerNonce !== controllerNonce ||
    typeof identity.harnessRunId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(identity.harnessRunId) ||
    typeof identity.targetTeamRunId !== 'string' ||
    !/^run_[0-9a-f]{32}$/u.test(identity.targetTeamRunId) ||
    !['allow', 'deny', 'none'].includes(identity.decision as string) ||
    Object.entries(ID_PATTERNS).some(
      ([key, pattern]) =>
        typeof identity[key] !== 'string' || !pattern.test(identity[key] as string)
    )
  )
    throw new Error('p3c_semantic_identity');
  return Object.freeze(identity as unknown as SemanticIdentity);
}

interface RetainedObservedBody {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly value: Record<string, unknown>;
}

function validateRedactedStructure(value: unknown, label: string): RetainedObservedBody {
  const structure = exactRecord(
    value,
    ['schemaVersion', 'bodyBase64', 'sha256', 'redacted'],
    `${label}_structure`
  );
  if (
    structure.schemaVersion !== 1 ||
    structure.redacted !== true ||
    typeof structure.bodyBase64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      structure.bodyBase64
    ) ||
    typeof structure.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(structure.sha256)
  )
    throw new Error(`p3c_${label}_redacted_structure`);
  const body = Buffer.from(structure.bodyBase64, 'base64');
  if (
    body.length < 2 ||
    body.length > 256 * 1024 ||
    body.toString('base64') !== structure.bodyBase64 ||
    sha256(body) !== structure.sha256
  )
    throw new Error(`p3c_${label}_redacted_body_digest`);
  assertNoSecretLikeBytes(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new Error(`p3c_${label}_redacted_body_json`);
  }
  if (canonicalJson(parsed) !== body.toString('utf8'))
    throw new Error(`p3c_${label}_redacted_body_noncanonical`);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`p3c_${label}_redacted_body_shape`);
  return Object.freeze({
    bytes: body,
    sha256: structure.sha256 as string,
    value: parsed as Record<string, unknown>,
  });
}

function ownerGenerationForEvent(event: string): number {
  if (/boundary_three|after_effect|truth_reconstructed|stale_sockets/u.test(event)) return 4;
  if (/boundary_two|after_decision|stale_generations/u.test(event)) return 3;
  if (/restart|restored|boundary_one/u.test(event)) return 2;
  return 1;
}

export function semanticScopeForEvent(row: MatrixRow, event: string): string {
  if (/^allow_|allow_terminal/u.test(event)) return 'decision:allow';
  if (/^deny_|deny_terminal/u.test(event)) return 'decision:deny';
  if (row === '08_cross_team_isolation') return 'cross-team:team-b-request';
  return `${row}:${event}`;
}

export function semanticDecisionForEvent(
  row: MatrixRow,
  event: string
): SemanticIdentity['decision'] {
  if (/^allow_|allow_terminal/u.test(event)) return 'allow';
  if (/^deny_|deny_terminal/u.test(event)) return 'deny';
  if (row === '08_cross_team_isolation' && event === 'cross_team_decide_rejected')
    return 'deny';
  return 'none';
}

export function canonicalRowIdentity(
  row: MatrixRow,
  identity: SemanticIdentity
): unknown {
  if (row !== '08_cross_team_isolation') return identity;
  return Object.freeze({
    lane: identity.lane,
    controllerNonce: identity.controllerNonce,
    harnessRunId: identity.harnessRunId,
    authenticatedActorTeamId: identity.authenticatedActorTeamId,
    targetTeamRunId: identity.targetTeamRunId,
    targetTeamId: identity.targetTeamId,
    approvalId: identity.approvalId,
    generationId: identity.generationId,
    idempotencyKey: identity.idempotencyKey,
    previewRef: identity.previewRef,
  });
}

function causalPhaseForEvent(event: string): number {
  const normalDecisionPhases: Readonly<Record<string, number>> = Object.freeze({
    allow_submitted: 10,
    deny_submitted: 10,
    allow_accepted: 20,
    deny_accepted: 20,
    allow_conditional_request: 30,
    deny_conditional_request: 30,
    allow_effect: 40,
    deny_effect: 40,
    allow_conditional_response: 50,
    deny_conditional_response: 50,
    allow_terminal_fsynced: 60,
    deny_terminal_fsynced: 60,
  });
  return normalDecisionPhases[event] ?? 1;
}

function causalAttempt(
  event: string,
  origin: RawOrigin
): { attempt: number; retryObserved: boolean } {
  if (event === 'reconcile_not_delivered_one_retry') {
    return { attempt: 2, retryObserved: true };
  }
  if (
    origin === 'opencode' &&
    /^(?:allow|deny)_(?:conditional_request|effect|conditional_response)$/u.test(event)
  ) {
    return { attempt: 1, retryObserved: false };
  }
  return { attempt: 0, retryObserved: false };
}

function expectedHttpConditions(event: string): Record<string, boolean> {
  const conditions: Record<string, boolean> = {
    laneMatch: true,
    socketPathMatch: true,
    socketDeviceMatch: true,
    socketInodeMatch: true,
    socketUidMatch: true,
    socketGidMatch: true,
    socketModeMatch: true,
    ownerAlive: true,
    artifactDigestMatch: true,
    capabilityDigestMatch: true,
    activationV2: true,
    provisioningReady: true,
    restartRequired: false,
    capabilityPresent: true,
    capabilityNoDowngrade: true,
    reconciliationLeaseOpen: false,
    reconciliationIdentityMatch: true,
  };
  const falseByEvent: Readonly<Record<string, string>> = Object.freeze({
    wrong_lane_routes_absent: 'laneMatch',
    wrong_socket_path_routes_absent: 'socketPathMatch',
    wrong_socket_device_routes_absent: 'socketDeviceMatch',
    wrong_socket_inode_routes_absent: 'socketInodeMatch',
    replaced_socket_routes_absent: 'socketInodeMatch',
    wrong_socket_uid_routes_absent: 'socketUidMatch',
    wrong_socket_gid_routes_absent: 'socketGidMatch',
    wrong_socket_mode_routes_absent: 'socketModeMatch',
    dead_owner_routes_absent: 'ownerAlive',
    wrong_artifact_digest_routes_absent: 'artifactDigestMatch',
    wrong_capability_digest_routes_absent: 'capabilityDigestMatch',
    legacy_generation_routes_absent: 'activationV2',
    provisioning_routes_absent: 'provisioningReady',
    missing_capability_routes_absent: 'capabilityPresent',
    capability_downgrade_routes_absent: 'capabilityNoDowngrade',
    reconcile_identity_mismatch_rejected: 'reconciliationIdentityMatch',
  });
  const falseField = falseByEvent[event];
  if (falseField) conditions[falseField] = false;
  if (event === 'restart_required_routes_absent') conditions.restartRequired = true;
  if (event === 'reconcile_while_lease_open_rejected') conditions.reconciliationLeaseOpen = true;
  return conditions;
}

function expectedHttpRequestHeaders(event: string): Record<string, string> {
  return {
    authenticationState:
      event === 'missing_session_rejected'
        ? 'absent'
        : event === 'invalid_session_rejected'
          ? 'invalid-redacted'
          : 'present-redacted',
    contentType: 'application/json',
    originState: event === 'origin_rejected' ? 'invalid-redacted' : 'loopback-redacted',
    actionProofState: event === 'csrf_rejected' ? 'absent' : 'present-redacted',
  };
}

const APPROVAL_PAGE_PATH = '/api/hosted/v1/team-approvals/page' as const;
const APPROVAL_PREVIEW_PATH = '/api/hosted/v1/team-approvals/preview' as const;
const APPROVAL_DECISIONS_PATH = '/api/hosted/v1/team-approvals/decisions' as const;

function httpEndpointForEvent(event: string): {
  readonly family: 'page' | 'preview' | 'decisions';
  readonly path:
    | typeof APPROVAL_PAGE_PATH
    | typeof APPROVAL_PREVIEW_PATH
    | typeof APPROVAL_DECISIONS_PATH;
} {
  if (
    event === 'approval_preview_observed' ||
    event === 'team_b_preview_request_observed' ||
    event === 'team_b_preview_result_observed' ||
    event === 'cross_team_preview_rejected'
  )
    return Object.freeze({ family: 'preview', path: APPROVAL_PREVIEW_PATH });
  const pageEvent =
    event === 'pending_observed' ||
    event === 'team_b_item_observed' ||
    event === 'terminal_state_observed' ||
    event === 'cross_team_list_rejected' ||
    event === 'cross_team_read_rejected';
  return pageEvent
    ? Object.freeze({ family: 'page', path: APPROVAL_PAGE_PATH })
    : Object.freeze({ family: 'decisions', path: APPROVAL_DECISIONS_PATH });
}

function httpDecision(identity: SemanticIdentity): 'allow' | 'deny' {
  return identity.decision === 'allow' ? 'allow' : 'deny';
}

function expectedHttpRequestBody(
  event: string,
  identity: SemanticIdentity
): Readonly<Record<string, unknown>> {
  const endpoint = httpEndpointForEvent(event);
  if (endpoint.family === 'page') {
    return Object.freeze({
      schemaVersion: 1,
      teamId: identity.targetTeamId,
      expectedRunId: identity.targetTeamRunId,
      cursor: null,
      limit: 32,
    });
  }
  if (endpoint.family === 'preview') {
    return Object.freeze({
      schemaVersion: 1,
      teamId: identity.targetTeamId,
      expectedRunId: identity.targetTeamRunId,
      approvalId: identity.approvalId,
      expectedGeneration: identity.generationId,
      previewRef: identity.previewRef,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    teamId: identity.targetTeamId,
    expectedRunId: identity.targetTeamRunId,
    approvalId: identity.approvalId,
    expectedGeneration: identity.generationId,
    idempotencyKey: identity.idempotencyKey,
    decision: httpDecision(identity),
  });
}

function validateHttpResponseBody(
  event: string,
  body: Record<string, unknown>,
  identity: SemanticIdentity,
  approvalIds: Set<string> = new Set<string>()
): number {
  if (/rejected|routes_absent/u.test(event)) {
    const optionalKeys = ['currentGeneration', 'resolvedDecision'].filter((key) =>
      Object.hasOwn(body, key)
    );
    const item = exactRecord(
      body,
      ['schemaVersion', 'kind', 'error', 'retryable', ...optionalKeys],
      'http_error'
    );
    const errorValue = exactRecord(
      item.error,
      [
        'code',
        'reason',
        ...['diagnosticId', 'retryAfterMs'].filter(
          (key) =>
            typeof item.error === 'object' && item.error !== null && Object.hasOwn(item.error, key)
        ),
      ],
      'http_error_value'
    );
    if (
      item.schemaVersion !== 1 ||
      item.kind !== 'error' ||
      typeof item.retryable !== 'boolean' ||
      ![
        'invalid_request',
        'unauthenticated',
        'forbidden',
        'not_found',
        'conflict',
        'unsupported',
        'unavailable',
        'cancelled',
        'internal',
      ].includes(errorValue.code as string) ||
      typeof errorValue.reason !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(errorValue.reason) ||
      (Object.hasOwn(errorValue, 'diagnosticId') &&
        (typeof errorValue.diagnosticId !== 'string' ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(errorValue.diagnosticId))) ||
      (Object.hasOwn(errorValue, 'retryAfterMs') &&
        (errorValue.code !== 'unavailable' ||
          !Number.isSafeInteger(errorValue.retryAfterMs) ||
          (errorValue.retryAfterMs as number) < 1 ||
          (errorValue.retryAfterMs as number) > 60_000)) ||
      (Object.hasOwn(item, 'currentGeneration') &&
        (typeof item.currentGeneration !== 'string' ||
          !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u.test(item.currentGeneration))) ||
      (Object.hasOwn(item, 'resolvedDecision') &&
        !['allow', 'deny'].includes(item.resolvedDecision as string))
    )
      throw new Error('p3c_semantic_http_error_body');
    return 0;
  }
  const endpoint = httpEndpointForEvent(event);
  if (endpoint.family === 'preview') {
    const item = exactRecord(
      body,
      [
        'schemaVersion',
        'kind',
        'teamId',
        'runId',
        'approvalId',
        'generation',
        'content',
        'byteLength',
        'truncated',
        'isBinary',
      ],
      'http_preview_response'
    );
    if (
      item.schemaVersion !== 1 ||
      item.kind !== 'approval_preview' ||
      item.teamId !== identity.targetTeamId ||
      item.runId !== identity.targetTeamRunId ||
      item.approvalId !== identity.approvalId ||
      item.generation !== identity.generationId ||
      typeof item.content !== 'string' ||
      !Number.isSafeInteger(item.byteLength) ||
      (item.byteLength as number) < 0 ||
      (item.byteLength as number) > 64 * 1024 ||
      new TextEncoder().encode(item.content).byteLength > (item.byteLength as number) ||
      typeof item.truncated !== 'boolean' ||
      typeof item.isBinary !== 'boolean' ||
      (item.isBinary && item.content !== '')
    )
      throw new Error('p3c_semantic_http_preview_body');
    return 0;
  }
  if (endpoint.family === 'page') {
    const page = exactRecord(
      body,
      ['schemaVersion', 'kind', 'teamId', 'items', 'nextCursor', 'truncated', 'budget'],
      'http_page_response'
    );
    if (
      page.schemaVersion !== 1 ||
      page.kind !== 'approval_page' ||
      page.teamId !== identity.targetTeamId ||
      !Array.isArray(page.items) ||
      page.items.length > 50 ||
      typeof page.truncated !== 'boolean' ||
      (page.nextCursor !== null && typeof page.nextCursor !== 'string') ||
      (page.truncated && page.nextCursor === null) ||
      (!page.truncated && page.nextCursor !== null)
    )
      throw new Error('p3c_semantic_http_page_body');
    const matches = page.items.filter((value) => {
      const item = exactRecord(
        value,
        [
          'teamId',
          'runId',
          'approvalId',
          'generation',
          'category',
          'summary',
          'requestedAtMs',
          'expiresAtMs',
          'previewRef',
        ],
        'http_page_item'
      );
      if (
        item.teamId !== identity.targetTeamId ||
        typeof item.runId !== 'string' ||
        !/^run_[0-9a-f]{32}$/u.test(item.runId) ||
        typeof item.approvalId !== 'string' ||
        !/^approval_[0-9a-f]{32}$/u.test(item.approvalId) ||
        typeof item.generation !== 'string' ||
        !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u.test(item.generation) ||
        !['file_change', 'command', 'network', 'other'].includes(item.category as string) ||
        typeof item.summary !== 'string' ||
        item.summary.length < 1 ||
        item.summary.length > 512 ||
        item.summary.trim() !== item.summary ||
        !Number.isSafeInteger(item.requestedAtMs) ||
        (item.requestedAtMs as number) < 0 ||
        (item.expiresAtMs !== null &&
          (!Number.isSafeInteger(item.expiresAtMs) ||
            (item.expiresAtMs as number) <= (item.requestedAtMs as number))) ||
        (item.previewRef !== null &&
          (typeof item.previewRef !== 'string' ||
            !/^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(item.previewRef)))
      )
        throw new Error('p3c_semantic_http_page_item');
      if (approvalIds.has(item.approvalId as string))
        throw new Error('p3c_semantic_http_page_duplicate_approval');
      approvalIds.add(item.approvalId as string);
      return (
        item.runId === identity.targetTeamRunId &&
        item.approvalId === identity.approvalId &&
        item.generation === identity.generationId &&
        item.previewRef === identity.previewRef
      );
    });
    const budget = exactRecord(
      page.budget,
      ['itemLimit', 'byteLimit', 'timeLimitMs', 'usedItems', 'usedBytes', 'elapsedMs'],
      'http_page_budget'
    );
    if (
      (page.nextCursor !== null &&
        (page.nextCursor.length > 256 ||
          !/^cursor_[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(page.nextCursor))) ||
      Object.values(budget).some(
        (value) => !Number.isSafeInteger(value) || (value as number) < 0
      ) ||
      budget.usedItems !== page.items.length ||
      (budget.itemLimit as number) < 1 ||
      (budget.itemLimit as number) > 50 ||
      (budget.byteLimit as number) < 1 ||
      (budget.byteLimit as number) > 128 * 1024 ||
      (budget.timeLimitMs as number) < 1 ||
      (budget.timeLimitMs as number) > 250 ||
      (budget.usedItems as number) > (budget.itemLimit as number) ||
      (budget.usedBytes as number) > (budget.byteLimit as number)
    )
      throw new Error('p3c_semantic_http_page_body');
    return matches.length;
  }
  const receipt = exactRecord(
    body,
    ['schemaVersion', 'outcome', 'teamId', 'runId', 'approvalId', 'generation', 'decision'],
    'http_decision_receipt'
  );
  if (
    receipt.schemaVersion !== 1 ||
    !['committed', 'idempotent_replay'].includes(receipt.outcome as string) ||
    receipt.teamId !== identity.targetTeamId ||
    receipt.runId !== identity.targetTeamRunId ||
    receipt.approvalId !== identity.approvalId ||
    receipt.generation !== identity.generationId ||
    receipt.decision !== httpDecision(identity)
  )
    throw new Error('p3c_semantic_http_receipt_body');
  return 0;
}

function validateApprovalPageExchanges(
  value: unknown,
  firstRequest: ReturnType<typeof validateRedactedStructure>,
  firstResponse: ReturnType<typeof validateRedactedStructure>,
  event: string,
  identity: SemanticIdentity
): void {
  if (!Array.isArray(value) || value.length < 1) throw new Error('p3c_semantic_http_page_missing');
  const cursors = new Set<string>();
  const approvalIds = new Set<string>();
  let expectedCursor: string | null = null;
  let matchCount = 0;
  let terminal = false;
  for (const [index, exchangeValue] of value.entries()) {
    if (terminal) throw new Error('p3c_semantic_http_page_after_terminal');
    const exchange = exactRecord(exchangeValue, ['request', 'response'], 'http_page_exchange');
    const request = validateRedactedStructure(exchange.request, 'http_page_request');
    const response = validateRedactedStructure(exchange.response, 'http_page_response');
    if (
      index === 0 &&
      (request.sha256 !== firstRequest.sha256 || response.sha256 !== firstResponse.sha256)
    )
      throw new Error('p3c_semantic_http_page_first_binding');
    const expectedRequest = { ...expectedHttpRequestBody(event, identity), cursor: expectedCursor };
    if (canonicalJson(request.value) !== canonicalJson(expectedRequest))
      throw new Error('p3c_semantic_http_page_cursor_binding');
    const cursorKey = expectedCursor === null ? '<initial>' : expectedCursor;
    if (cursors.has(cursorKey)) throw new Error('p3c_semantic_http_page_cursor_cycle');
    cursors.add(cursorKey);
    matchCount += validateHttpResponseBody(event, response.value, identity, approvalIds);
    const page = response.value;
    terminal = page.truncated === false;
    expectedCursor = page.nextCursor as string | null;
  }
  if (!terminal) throw new Error('p3c_semantic_http_page_missing_tail');
  if (matchCount !== 1) throw new Error('p3c_semantic_http_page_identity_match');
}

function validateTransport(
  origin: RawOrigin,
  row: MatrixRow,
  event: string,
  transport: unknown,
  identity: SemanticIdentity,
  providerEffectId: string | null
): number {
  if (origin === 'browser') {
    const rejectedCrossTeam = row08BrowserEvent(event);
    const endpoint = httpEndpointForEvent(event);
    const item = exactRecord(
      transport,
      [
        'kind',
        'method',
        'path',
        'decision',
        'status',
        'receiptOutcome',
        'authenticatedActorTeamId',
        'targetTeamId',
        'targetRunId',
        'approvalId',
        'generationId',
        'idempotencyKey',
        'retryCount',
        'observation',
      ],
      'semantic_browser'
    );
    if (
      item.kind !== 'browser' ||
      item.method !== 'POST' ||
      item.path !== (rejectedCrossTeam ? endpoint.path : APPROVAL_DECISIONS_PATH) ||
      !['allow', 'deny', 'none'].includes(item.decision as string) ||
      !Number.isSafeInteger(item.status) ||
      (rejectedCrossTeam
        ? ![403, 404].includes(item.status as number) || item.receiptOutcome !== 'rejected'
        : item.status !== 200 || item.receiptOutcome !== 'committed') ||
      item.authenticatedActorTeamId !== identity.authenticatedActorTeamId ||
      item.targetTeamId !== identity.targetTeamId ||
      item.targetRunId !== identity.targetTeamRunId ||
      item.approvalId !== identity.approvalId ||
      item.generationId !== identity.generationId ||
      item.idempotencyKey !== identity.idempotencyKey ||
      item.retryCount !== 0 ||
      typeof item.observation !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,127}$/u.test(item.observation)
    )
      throw new Error('p3c_semantic_browser');
    if (event === 'allow_submitted' && item.decision !== 'allow')
      throw new Error('p3c_semantic_browser_allow');
    if (event === 'deny_submitted' && item.decision !== 'deny')
      throw new Error('p3c_semantic_browser_deny');
    if (rejectedCrossTeam && item.decision !== (endpoint.family === 'decisions' ? 'deny' : 'none'))
      throw new Error('p3c_semantic_browser_cross_team');
    return 1;
  }
  if (origin === 'product-http') {
    const item = exactRecord(
      transport,
      [
        'kind',
        'endpointFamily',
        'method',
        'path',
        'status',
        'requestHeaders',
        'responseHeaders',
        'request',
        'response',
        'conditions',
        'pageExchanges',
      ],
      'semantic_http'
    );
    const endpoint = httpEndpointForEvent(event);
    if (
      item.kind !== 'http' ||
      item.endpointFamily !== endpoint.family ||
      item.method !== 'POST' ||
      item.path !== endpoint.path ||
      !Number.isSafeInteger(item.status)
    )
      throw new Error('p3c_semantic_http');
    const requestBody = validateRedactedStructure(item.request, 'http_request');
    const responseBody = validateRedactedStructure(item.response, 'http_response');
    if (
      canonicalJson(requestBody.value) !== canonicalJson(expectedHttpRequestBody(event, identity))
    )
      throw new Error('p3c_semantic_http_body_binding');
    const rejected = /rejected|routes_absent/u.test(event);
    if (endpoint.family === 'page' && !rejected) {
      validateApprovalPageExchanges(
        item.pageExchanges,
        requestBody,
        responseBody,
        event,
        identity
      );
    } else {
      if (item.pageExchanges !== null) throw new Error('p3c_semantic_http_page_unexpected');
      validateHttpResponseBody(event, responseBody.value, identity);
    }
    if (
      canonicalJson(item.requestHeaders) !== canonicalJson(expectedHttpRequestHeaders(event)) ||
      canonicalJson(item.responseHeaders) !==
        canonicalJson({
          contentType: 'application/json',
          cacheControl: 'no-store',
        })
    )
      throw new Error('p3c_semantic_http_headers');
    if (canonicalJson(item.conditions) !== canonicalJson(expectedHttpConditions(event)))
      throw new Error('p3c_semantic_http_conditions');
    if (
      (rejected && ![401, 403, 404, 409, 503].includes(item.status as number)) ||
      (!rejected && item.status !== 200)
    )
      throw new Error('p3c_semantic_http_status');
    return ownerGenerationForEvent(event);
  }
  if (origin === 'product-sse') {
    const item = exactRecord(
      transport,
      ['kind', 'eventId', 'eventType', 'reconnectAttempt', 'data'],
      'semantic_sse'
    );
    if (
      item.kind !== 'sse' ||
      typeof item.eventId !== 'string' ||
      !/^[1-9]\d*$/u.test(item.eventId) ||
      typeof item.eventType !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,127}$/u.test(item.eventType) ||
      !Number.isSafeInteger(item.reconnectAttempt) ||
      (item.reconnectAttempt as number) < 0
    )
      throw new Error('p3c_semantic_sse');
    const data = validateRedactedStructure(item.data, 'sse_data').value;
    const decoded = exactRecord(
      data,
      ['schemaVersion', 'kind', 'event', 'decision', 'approvalId', 'generation'],
      'sse_data_body'
    );
    if (
      item.eventType !== event ||
      decoded.schemaVersion !== 1 ||
      decoded.kind !== 'sse-data' ||
      decoded.event !== event ||
      decoded.decision !== semanticDecisionForEvent(row, event) ||
      decoded.decision !== identity.decision ||
      decoded.approvalId !== identity.approvalId ||
      decoded.generation !== identity.generationId
    )
      throw new Error('p3c_semantic_sse_label_binding');
    return ownerGenerationForEvent(event);
  }
  if (origin === 'owner-wal') {
    const item = exactRecord(
      transport,
      [
        'kind',
        'offset',
        'length',
        'recordSha256',
        'fsynced',
        'state',
        'ownerGeneration',
        'providerEffectId',
        'attempt',
        'retryObserved',
        'record',
      ],
      'semantic_wal'
    );
    const expectedGeneration = ownerGenerationForEvent(event);
    const retainedRecord = validateRedactedStructure(item.record, 'wal_record');
    const record = exactRecord(
      retainedRecord.value,
      [
        'schemaVersion',
        'kind',
        'event',
        'state',
        'decision',
        'ownerGeneration',
        'providerEffectId',
        'identity',
      ],
      'wal_record_body'
    );
    if (
      item.kind !== 'wal' ||
      typeof item.offset !== 'string' ||
      !/^\d+$/u.test(item.offset) ||
      !Number.isSafeInteger(item.length) ||
      (item.length as number) < 1 ||
      typeof item.recordSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(item.recordSha256) ||
      item.fsynced !== true ||
      item.state !== event ||
      item.length !== retainedRecord.bytes.length ||
      item.recordSha256 !== retainedRecord.sha256 ||
      record.schemaVersion !== 1 ||
      record.kind !== 'wal-record' ||
      record.event !== event ||
      record.state !== event ||
      record.decision !== semanticDecisionForEvent(row, event) ||
      record.decision !== identity.decision ||
      record.ownerGeneration !== expectedGeneration ||
      record.providerEffectId !== providerEffectId ||
      canonicalJson(record.identity) !== canonicalJson(identity) ||
      item.ownerGeneration !== expectedGeneration ||
      item.providerEffectId !== providerEffectId ||
      item.attempt !== causalAttempt(event, origin).attempt ||
      item.retryObserved !== causalAttempt(event, origin).retryObserved
    )
      throw new Error('p3c_semantic_wal');
    return expectedGeneration;
  }
  if (origin === 'opencode') {
    const item = exactRecord(
      transport,
      [
        'kind',
        'direction',
        'endpoint',
        'status',
        'conditional',
        'ownerGeneration',
        'providerEffectId',
        'attempt',
        'retryObserved',
        'effectSetDigest',
        'effectSetSha256s',
        'request',
        'response',
      ],
      'semantic_opencode'
    );
    const expectedGeneration = ownerGenerationForEvent(event);
    const expectedAttempt = causalAttempt(event, origin);
    const isProviderEffect = /_effect$/u.test(event);
    const isEffectTotal = event === 'effect_total_two';
    if (
      item.kind !== 'opencode' ||
      !['request', 'response', 'effect', 'observation'].includes(item.direction as string) ||
      item.endpoint !== '/v1/conditional-decisions' ||
      !Number.isSafeInteger(item.status) ||
      item.conditional !== true ||
      item.ownerGeneration !== expectedGeneration ||
      item.providerEffectId !== providerEffectId ||
      !Number.isSafeInteger(item.attempt) ||
      (item.attempt as number) < 0 ||
      (item.attempt as number) > 2 ||
      item.attempt !== expectedAttempt.attempt ||
      item.retryObserved !== expectedAttempt.retryObserved
    )
      throw new Error('p3c_semantic_opencode');
    if (
      isProviderEffect
        ? item.effectSetDigest !== null || item.effectSetSha256s !== null
        : isEffectTotal
          ? typeof item.effectSetDigest !== 'string' ||
            !/^[0-9a-f]{64}$/u.test(item.effectSetDigest) ||
            !Array.isArray(item.effectSetSha256s) ||
            item.effectSetSha256s.length !== 2 ||
            item.effectSetSha256s.some(
              (digest) => typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)
            )
          : item.effectSetDigest !== null || item.effectSetSha256s !== null
    )
      throw new Error('p3c_semantic_opencode_effect_join');
    const requestBody = validateRedactedStructure(item.request, 'opencode_request');
    const responseBody = validateRedactedStructure(item.response, 'opencode_response');
    const expectedRequest = {
      schemaVersion: 1,
      kind: 'conditional-decision-request',
      approvalId: identity.approvalId,
      generation: identity.generationId,
      decision: identity.decision,
      providerEffectId,
    };
    const expectedResponse = {
      schemaVersion: 1,
      kind: isProviderEffect ? 'provider-effect' : 'conditional-decision-result',
      approvalId: identity.approvalId,
      generation: identity.generationId,
      decision: identity.decision,
      providerEffectId,
      outcome: isProviderEffect ? 'committed' : isEffectTotal ? 'total_observed' : 'observed',
    };
    if (
      canonicalJson(requestBody.value) !== canonicalJson(expectedRequest) ||
      canonicalJson(responseBody.value) !== canonicalJson(expectedResponse)
    )
      throw new Error('p3c_semantic_opencode_body_binding');
    if (/request/u.test(event) && item.direction !== 'request')
      throw new Error('p3c_semantic_opencode_request');
    if (/response/u.test(event) && item.direction !== 'response')
      throw new Error('p3c_semantic_opencode_response');
    if (/effect(?!_total)/u.test(event) && item.direction !== 'effect')
      throw new Error('p3c_semantic_opencode_effect');
    return expectedGeneration;
  }
  const item = exactRecord(
    transport,
    ['kind', 'observation', 'ownerGeneration', 'bounded', 'zeroSurvivors', 'processEvidenceSetId'],
    'semantic_supervisor'
  );
  const expectedGeneration = ownerGenerationForEvent(event);
  if (
    item.kind !== 'supervisor' ||
    typeof item.observation !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,127}$/u.test(item.observation) ||
    item.ownerGeneration !== expectedGeneration ||
    item.bounded !== true ||
    item.zeroSurvivors !== true ||
    typeof item.processEvidenceSetId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(item.processEvidenceSetId)
  )
    throw new Error('p3c_semantic_supervisor');
  return expectedGeneration;
}

export function validateStructuralPayload(
  origin: RawOrigin,
  row: MatrixRow,
  event: string,
  controllerNonce: string,
  payload: Buffer
): {
  readonly identity: SemanticIdentity;
  readonly ownerGeneration: number;
  readonly processEvidenceSetId: string | null;
  readonly causal: CausalEvidence;
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new Error('p3c_raw_payload_json');
  }
  if (canonicalJson(value) !== payload.toString('utf8'))
    throw new Error('p3c_raw_payload_noncanonical');
  const item = exactRecord(value, ['kind', 'recordBase64', 'recordSha256'], 'raw_payload');
  const kinds: Readonly<Record<RawOrigin, string>> = Object.freeze({
    browser: 'browser-observation',
    'product-http': 'http-structure',
    'product-sse': 'sse-structure',
    'owner-wal': 'wal-structure',
    opencode: 'opencode-structure',
    supervisor: 'supervisor-structure',
  });
  if (
    item.kind !== kinds[origin] ||
    typeof item.recordBase64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.recordBase64) ||
    typeof item.recordSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(item.recordSha256)
  )
    throw new Error('p3c_raw_payload_structure');
  const rawRecord = Buffer.from(item.recordBase64, 'base64');
  if (
    rawRecord.length < 2 ||
    rawRecord.length > 1024 * 1024 ||
    rawRecord.toString('base64') !== item.recordBase64 ||
    sha256(rawRecord) !== item.recordSha256
  )
    throw new Error('p3c_raw_structural_record_digest');
  assertNoSecretLikeBytes(rawRecord);
  let rawValue: unknown;
  try {
    rawValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawRecord));
  } catch {
    throw new Error('p3c_raw_structural_record_json');
  }
  if (canonicalJson(rawValue) !== rawRecord.toString('utf8'))
    throw new Error('p3c_raw_structural_record_noncanonical');
  const semantic = exactRecord(
    rawValue,
    ['schemaVersion', 'purpose', 'origin', 'row', 'event', 'identity', 'causal', 'transport'],
    'semantic_record'
  );
  if (
    semantic.schemaVersion !== 1 ||
    semantic.purpose !== SEMANTIC_PURPOSE ||
    semantic.origin !== origin ||
    semantic.row !== row ||
    semantic.event !== event
  )
    throw new Error('p3c_semantic_record_binding');
  const identity = parseSemanticIdentity(semantic.identity, controllerNonce);
  if (identity.decision !== semanticDecisionForEvent(row, event))
    throw new Error('p3c_semantic_decision_binding');
  const causal = exactRecord(
    semantic.causal,
    ['chainId', 'phase', 'providerEffectId', 'attempt', 'retryObserved'],
    'semantic_causal'
  );
  const expectedAttempt = causalAttempt(event, origin);
  const expectedChainId = sha256(`agent-teams.p3c.causal-chain/v1\0${canonicalJson(identity)}`);
  const actualProviderEffect =
    origin === 'opencode' && (event === 'allow_effect' || event === 'deny_effect');
  if (
    causal.chainId !== expectedChainId ||
    causal.phase !== causalPhaseForEvent(event) ||
    (causal.providerEffectId !== null &&
      (typeof causal.providerEffectId !== 'string' ||
        !/^effect_[0-9a-f]{32}$/u.test(causal.providerEffectId))) ||
    (actualProviderEffect && causal.providerEffectId === null) ||
    causal.attempt !== expectedAttempt.attempt ||
    causal.retryObserved !== expectedAttempt.retryObserved
  )
    throw new Error('p3c_semantic_causal_binding');
  return Object.freeze({
    identity,
    ownerGeneration: validateTransport(
      origin,
      row,
      event,
      semantic.transport,
      identity,
      causal.providerEffectId as string | null
    ),
    processEvidenceSetId:
      origin === 'supervisor'
        ? ((semantic.transport as Record<string, unknown>).processEvidenceSetId as string)
        : null,
    causal: Object.freeze({
      chainId: expectedChainId,
      phase: causal.phase as number,
      providerEffectId: causal.providerEffectId as string | null,
      attempt: causal.attempt as number,
      retryObserved: causal.retryObserved as boolean,
      providerEffectSha256:
        origin === 'opencode' && /_effect$/u.test(event)
          ? validateRedactedStructure(
              (semantic.transport as Record<string, unknown>).response,
              'opencode_response'
            ).sha256
          : null,
      effectSetDigest:
        origin === 'opencode'
          ? (((semantic.transport as Record<string, unknown>).effectSetDigest as string | null) ??
            null)
          : null,
      effectSetSha256s:
        origin === 'opencode' &&
        Array.isArray((semantic.transport as Record<string, unknown>).effectSetSha256s)
          ? Object.freeze([
              ...((semantic.transport as Record<string, unknown>).effectSetSha256s as string[]),
            ])
          : null,
    }),
  });
}

function parseOrigin(
  bytes: Buffer,
  origin: RawOrigin,
  controllerNonce: string
): readonly LocatedRawRecord[] {
  if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024 || bytes.at(-1) !== 0x0a)
    throw new Error('p3c_raw_origin_frame');
  assertNoSecretLikeBytes(bytes);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\n');
  let previous = -1n;
  let byteStart = 0;
  const records = lines.map((line, index) => {
    if (!line || line.includes('\r') || line.length > 2 * 1024 * 1024)
      throw new Error('p3c_raw_origin_line');
    const value = JSON.parse(line) as unknown;
    if (canonicalJson(value) !== line) throw new Error('p3c_raw_origin_noncanonical');
    const record = parseRecord(value, origin, index + 1, controllerNonce);
    const current = BigInt(record.monotonicNs);
    if (current <= previous) throw new Error('p3c_raw_origin_clock');
    previous = current;
    const lineBytes = Buffer.from(line);
    const located = Object.freeze({
      ...record,
      byteStart,
      byteEnd: byteStart + lineBytes.length,
      lineSha256: sha256(lineBytes),
    });
    byteStart += lineBytes.length + 1;
    return located;
  });
  if (byteStart !== bytes.length) throw new Error('p3c_raw_origin_range');
  return Object.freeze(records);
}

function expectedStarts(
  outcome: SupervisorOutcome
): Readonly<Record<RawOrigin, readonly ProcessStartEvidence[]>> {
  const find = (role: string) => {
    const value = outcome.starts.filter((start) => start.role === role);
    if (value.length < 1) throw new Error('p3c_evidence_process_start_missing');
    return Object.freeze(value);
  };
  return Object.freeze({
    browser: find('browser'),
    'product-http': find('product'),
    'product-sse': find('product'),
    'owner-wal': find('owner'),
    opencode: find('opencode'),
    supervisor: Object.freeze([outcome.supervisorStart]),
  });
}

export function deriveEvidence(
  raw: Readonly<Record<RawOrigin, Buffer>>,
  controllerNonce: string,
  outcome: SupervisorOutcome
): {
  readonly origins: Readonly<Record<RawOrigin, OriginEvidence>>;
  readonly rows: readonly RowEvidence[];
  readonly exactlyOnce: ExactlyOnceEvidence;
} {
  if (!outcome.zeroOwnedSurvivors) throw new Error('p3c_evidence_survivors');
  if (outcome.controllerNonce !== controllerNonce)
    throw new Error('p3c_evidence_controller_disagreement');
  const starts = expectedStarts(outcome);
  const parsed = {} as Record<RawOrigin, readonly LocatedRawRecord[]>;
  const origins = {} as Record<RawOrigin, OriginEvidence>;
  for (const origin of RAW_ORIGINS) {
    const bytes = raw[origin];
    if (
      sha256(bytes) !== outcome.rawFiles[origin].sha256 ||
      bytes.length !== outcome.rawFiles[origin].size
    )
      throw new Error('p3c_evidence_supervisor_raw_disagreement');
    const records = parseOrigin(bytes, origin, controllerNonce);
    if (
      records.some(({ processStartToken, monotonicNs, ownerGeneration, semanticIdentity }) => {
        const start = starts[origin].find(({ startToken }) => startToken === processStartToken);
        return (
          !start ||
          BigInt(monotonicNs) <= BigInt(start.observedMonotonicNs) ||
          semanticIdentity.harnessRunId !== outcome.runId ||
          (origin === 'owner-wal' && start.generation !== ownerGeneration)
        );
      }) ||
      (origin === 'supervisor' &&
        records.some(
          ({ processEvidenceSetId }) => processEvidenceSetId !== outcome.processEvidenceSetId
        ))
    )
      throw new Error('p3c_evidence_process_start_disagreement');
    parsed[origin] = records;
    origins[origin] = Object.freeze({
      sha256: sha256(bytes),
      size: bytes.length,
      count: records.length,
      firstMonotonicNs: records[0].monotonicNs,
      lastMonotonicNs: records.at(-1)!.monotonicNs,
    });
  }
  const all = RAW_ORIGINS.flatMap((origin) => parsed[origin]);
  if (new Set(all.map(({ recordId }) => recordId)).size !== all.length)
    throw new Error('p3c_evidence_duplicate_record');
  const globallyOrdered = [...all].sort((left, right) =>
    BigInt(left.monotonicNs) < BigInt(right.monotonicNs) ? -1 : 1
  );
  if (
    new Set(globallyOrdered.map(({ monotonicNs }) => monotonicNs)).size !==
      globallyOrdered.length ||
    globallyOrdered.some(
      (record, index) => index > 0 && record.effectCount < globallyOrdered[index - 1].effectCount
    )
  )
    throw new Error('p3c_evidence_global_causal_order');
  const byChain = new Map<string, LocatedRawRecord[]>();
  for (const record of globallyOrdered) {
    const records = byChain.get(record.causal.chainId) ?? [];
    if (records.length > 0 && record.causal.phase < records.at(-1)!.causal.phase)
      throw new Error('p3c_evidence_global_causal_order');
    records.push(record);
    byChain.set(record.causal.chainId, records);
  }
  for (const record of all) {
    const identityDigest = sha256(
      canonicalJson(canonicalRowIdentity(record.row, record.semanticIdentity))
    );
    const expectedCorrelation = sha256(
      `agent-teams.p3c.row-identity/v1\0${controllerNonce}\0${record.row}\0${identityDigest}`
    );
    if (record.correlation !== expectedCorrelation)
      throw new Error(`p3c_evidence_correlation:${record.row}`);
    const crossTeam = record.row === '08_cross_team_isolation';
    const teamBBaseline = crossTeam && /^team_b_/u.test(record.event);
    if (
      (crossTeam &&
        !teamBBaseline &&
        record.semanticIdentity.authenticatedActorTeamId ===
          record.semanticIdentity.targetTeamId) ||
      (!crossTeam &&
        record.semanticIdentity.authenticatedActorTeamId !== record.semanticIdentity.targetTeamId)
    )
      throw new Error(`p3c_evidence_actor_target_binding:${record.row}`);
  }
  const crossTeamRecords = all.filter(({ row }) => row === '08_cross_team_isolation');
  for (const record of crossTeamRecords) {
    const isTeamBBaseline = /^team_b_/u.test(record.event);
    if (
      (isTeamBBaseline &&
        record.semanticIdentity.authenticatedActorTeamId !==
          record.semanticIdentity.targetTeamId) ||
      (!isTeamBBaseline &&
        record.semanticIdentity.authenticatedActorTeamId === record.semanticIdentity.targetTeamId)
    )
      throw new Error('p3c_evidence_cross_team_observed_actor_binding');
  }
  const crossTeamIdentities = crossTeamRecords.map(({ semanticIdentity }) => ({
    target: semanticIdentity.targetTeamId,
    run: semanticIdentity.targetTeamRunId,
    approval: semanticIdentity.approvalId,
    generation: semanticIdentity.generationId,
    previewRef: semanticIdentity.previewRef,
    idempotencyKey: semanticIdentity.idempotencyKey,
  }));
  if (new Set(crossTeamIdentities.map(canonicalJson)).size !== 1)
    throw new Error('p3c_evidence_cross_team_real_request_binding');
  const teamBBaseline = [
    'team_b_item_observed',
    'team_b_preview_request_observed',
    'team_b_preview_result_observed',
  ].map((event) => {
    const matches = crossTeamRecords.filter((record) => record.event === event);
    if (matches.length !== 1) throw new Error('p3c_evidence_cross_team_observation_order');
    return matches[0];
  });
  if (
    teamBBaseline.some(
      (record, index) =>
        index > 0 && BigInt(record.monotonicNs) <= BigInt(teamBBaseline[index - 1].monotonicNs)
    )
  )
    throw new Error('p3c_evidence_cross_team_observation_order');
  const rows = MATRIX_ROWS.map((row) => {
    const records = all.filter((record) => record.row === row);
    const correlations = new Set(records.map(({ correlation }) => correlation));
    const identityDigests = new Set(
      records.map(({ semanticIdentity }) => sha256(canonicalJson(semanticIdentity)))
    );
    const required = EVIDENCE_REQUIREMENTS[row];
    if (
      records.length !== required.length ||
      required.some(
        ([origin, event, effectCount]) =>
          !records.some(
            (record) =>
              record.origin === origin &&
              record.event === event &&
              record.effectCount === effectCount
          )
      )
    )
      throw new Error(`p3c_evidence_matrix:${row}`);
    const sorted = [...records].sort((left, right) =>
      Buffer.from(left.recordId).compare(Buffer.from(right.recordId))
    );
    return Object.freeze({
      row,
      correlations: Object.freeze(
        [...correlations].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      ),
      identityDigests: Object.freeze(
        [...identityDigests].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      ),
      recordIds: Object.freeze(sorted.map(({ recordId }) => recordId)),
      records: Object.freeze(
        sorted.map(({ origin, recordId, byteStart, byteEnd, lineSha256 }) =>
          Object.freeze({ origin, recordId, byteStart, byteEnd, lineSha256 })
        )
      ),
    });
  });
  const authenticatedTeamAActors = all
    .filter(
      ({ origin, row, event }) =>
        origin === 'browser' &&
        row === '02_browser_allow_deny' &&
        (event === 'allow_submitted' || event === 'deny_submitted')
    )
    .map(({ semanticIdentity }) => semanticIdentity.authenticatedActorTeamId);
  const crossTeamBrowserActors = crossTeamRecords
    .filter(({ origin }) => origin === 'browser')
    .map(({ semanticIdentity }) => semanticIdentity.authenticatedActorTeamId);
  const rejectedCrossTeamActors = crossTeamRecords
    .filter(({ event }) => !/^team_b_/u.test(event))
    .map(({ semanticIdentity }) => semanticIdentity.authenticatedActorTeamId);
  if (
    authenticatedTeamAActors.length !== 2 ||
    new Set(authenticatedTeamAActors).size !== 1 ||
    crossTeamBrowserActors.length !== 3 ||
    crossTeamBrowserActors.some((actor) => actor !== authenticatedTeamAActors[0]) ||
    rejectedCrossTeamActors.length !== crossTeamRecords.length - 3 ||
    rejectedCrossTeamActors.some((actor) => actor !== authenticatedTeamAActors[0])
  )
    throw new Error('p3c_evidence_cross_team_authenticated_actor_binding');
  const normalEffects = (['allow', 'deny'] as const).map((decision) => {
    const expectedEvents = [
      `${decision}_submitted`,
      `${decision}_accepted`,
      `${decision}_conditional_request`,
      `${decision}_effect`,
      `${decision}_conditional_response`,
      `${decision}_terminal_fsynced`,
    ];
    const records = expectedEvents.map((event) => {
      const matches = all.filter((record) => record.event === event);
      if (matches.length !== 1) throw new Error(`p3c_exactly_once_event:${event}`);
      return matches[0];
    });
    const observedProviderEffectIds = records
      .map(({ causal }) => causal.providerEffectId)
      .filter((value): value is string => value !== null);
    if (
      new Set(records.map(({ causal }) => causal.chainId)).size !== 1 ||
      new Set(observedProviderEffectIds).size !== 1 ||
      records.some(
        (record, index) =>
          index > 0 && BigInt(record.monotonicNs) <= BigInt(records[index - 1].monotonicNs)
      )
    )
      throw new Error(`p3c_exactly_once_causal_order:${decision}`);
    const provider = records.filter(({ origin }) => origin === 'opencode');
    const effectRecords = provider.filter((record) => record.event === `${decision}_effect`);
    if (
      effectRecords.length !== 1 ||
      effectRecords[0].causal.providerEffectId === null ||
      provider.some(({ causal }) => causal.attempt !== 1 || causal.retryObserved)
    )
      throw new Error(`p3c_exactly_once_provider_attempt:${decision}`);
    return Object.freeze({
      decision,
      chainId: records[0].causal.chainId,
      providerEffectId: effectRecords[0].causal.providerEffectId!,
      providerEffectRecordId: effectRecords[0].recordId,
      attempt: 1 as const,
      retryObserved: false as const,
    });
  });
  const providerEffectRecords = all.filter(
    (record) => record.origin === 'opencode' && record.causal.phase === 40
  );
  if (
    new Set(normalEffects.map(({ providerEffectId }) => providerEffectId)).size !==
      normalEffects.length ||
    new Set(providerEffectRecords.map(({ causal }) => causal.providerEffectId)).size !==
      providerEffectRecords.length
  )
    throw new Error('p3c_provider_effect_identity_not_global_unique');
  const effectTotalRecords = all.filter(
    (record) => record.origin === 'opencode' && record.event === 'effect_total_two'
  );
  const normalEffectSha256s = providerEffectRecords
    .map(({ causal }) => causal.providerEffectSha256)
    .filter((digest): digest is string => digest !== null)
    .sort();
  const expectedEffectSetDigest = sha256(
    `agent-teams.p3c.provider-effect-set/v1\0${canonicalJson(normalEffectSha256s)}`
  );
  if (
    effectTotalRecords.length === 1 &&
    providerEffectRecords.some(
      (record) => BigInt(record.monotonicNs) >= BigInt(effectTotalRecords[0].monotonicNs)
    )
  )
    throw new Error('p3c_provider_effect_total_order');
  if (
    effectTotalRecords.length !== 1 ||
    normalEffectSha256s.length !== 2 ||
    new Set(normalEffectSha256s).size !== 2 ||
    canonicalJson([...(effectTotalRecords[0].causal.effectSetSha256s ?? [])].sort()) !==
      canonicalJson(normalEffectSha256s) ||
    effectTotalRecords[0].causal.effectSetDigest !== expectedEffectSetDigest
  )
    throw new Error('p3c_provider_effect_total_join');
  const exactlyOnce = Object.freeze({
    normalProviderEffects: Object.freeze(normalEffects),
    globallyUniqueProviderEffectIds: true as const,
    observedNormalRetryCount: 0 as const,
  });
  return Object.freeze({
    origins: Object.freeze(origins),
    rows: Object.freeze(rows),
    exactlyOnce,
  });
}

export function assembleEvidence(input: {
  readonly raw: Readonly<Record<RawOrigin, Buffer>>;
  readonly controllerNonce: string;
  readonly runId: string;
  readonly outcome: SupervisorOutcome;
  readonly cleanup: CleanupResult;
}): EvidenceDocument {
  if (
    input.cleanup.disposition !== 'removed' ||
    !input.cleanup.markerVerified ||
    !input.cleanup.zeroOwnedSurvivors ||
    input.cleanup.runId !== input.runId
  )
    throw new Error('p3c_evidence_cleanup_unproven');
  const derived = deriveEvidence(input.raw, input.controllerNonce, input.outcome);
  const unsigned = {
    schemaVersion: 1,
    purpose: 'agent-teams.p3c.evidence/v1',
    controllerNonce: input.controllerNonce,
    runId: input.runId,
    result: 'verified',
    raw: derived.origins,
    rows: derived.rows,
    exactlyOnce: derived.exactlyOnce,
    supervisorTranscriptSha256: input.outcome.transcriptSha256,
    cleanup: input.cleanup,
  } as const;
  return Object.freeze({
    ...unsigned,
    evidenceDigest: sha256(`agent-teams.p3c.evidence-document/v1\0${canonicalJson(unsigned)}`),
  });
}

export async function retainEvidence(
  evidenceRoot: RootAnchor,
  raw: Readonly<Record<RawOrigin, Buffer>>,
  document: EvidenceDocument,
  supervisorTranscript: Buffer
): Promise<Readonly<Record<string, string>>> {
  if (evidenceRoot.name !== 'evidenceRoot') throw new Error('p3c_evidence_wrong_root');
  await assertRootCurrent(evidenceRoot);
  if ((await readdir(procFdPath(evidenceRoot.handle))).length !== 0)
    throw new Error('p3c_evidence_root_not_empty');
  const digests: Record<string, string> = {};
  for (const origin of RAW_ORIGINS) {
    assertNoSecretLikeBytes(raw[origin]);
    const pin = await writeExclusive(evidenceRoot, `raw-${origin}.ndjson`, raw[origin], 0o400);
    if (pin.sha256 !== document.raw[origin].sha256) throw new Error('p3c_evidence_publish_digest');
    digests[pin.relativePath] = pin.sha256;
  }
  assertNoSecretLikeBytes(supervisorTranscript);
  if (sha256(supervisorTranscript) !== document.supervisorTranscriptSha256)
    throw new Error('p3c_evidence_supervisor_transcript_digest');
  const transcript = await writeExclusive(
    evidenceRoot,
    'supervisor-transcript.ndjson',
    supervisorTranscript,
    0o400
  );
  digests[transcript.relativePath] = transcript.sha256;
  const bytes = Buffer.from(canonicalJson(document));
  const pin = await writeExclusive(evidenceRoot, 'evidence.json', bytes, 0o400);
  digests[pin.relativePath] = pin.sha256;
  await evidenceRoot.handle.sync();
  await assertRootCurrent(evidenceRoot);
  const expectedNames = [
    ...RAW_ORIGINS.map((origin) => `raw-${origin}.ndjson`),
    'supervisor-transcript.ndjson',
    'evidence.json',
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const names = (await readdir(procFdPath(evidenceRoot.handle))).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right))
  );
  if (canonicalJson(names) !== canonicalJson(expectedNames))
    throw new Error('p3c_evidence_root_changed');
  return Object.freeze(digests);
}

export async function retainFailureEvidence(
  evidenceRoot: RootAnchor,
  controllerNonce: string,
  runId: string | null,
  error: unknown
): Promise<string> {
  const reason = error instanceof Error ? error.message : 'p3c_unknown_failure';
  const safeReason = /^[a-z0-9_:.-]{1,256}$/iu.test(reason) ? reason : 'p3c_unreportable_failure';
  const document = Object.freeze({
    schemaVersion: 1,
    purpose: 'agent-teams.p3c.failure-evidence/v1',
    controllerNonce,
    runId,
    result: 'failed',
    matrixClaim: false,
    reason: safeReason,
  });
  const bytes = Buffer.from(canonicalJson(document));
  assertNoSecretLikeBytes(bytes);
  return (await writeExclusive(evidenceRoot, 'failure.json', bytes, 0o400)).sha256;
}

export function observedSemanticIdentity(input: SemanticIdentity): SemanticIdentity {
  return parseSemanticIdentity(input, input.controllerNonce);
}

function redactedStructure(body: Buffer): Record<string, unknown> {
  assertNoSecretLikeBytes(body);
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  if (canonicalJson(value) !== body.toString('utf8'))
    throw new Error('p3c_observed_redacted_body_noncanonical');
  return Object.freeze({
    schemaVersion: 1,
    bodyBase64: body.toString('base64'),
    sha256: sha256(body),
    redacted: true,
  });
}

function requiredObservedBody(body: Buffer | undefined, label: string): Buffer {
  if (!body) throw new Error(`p3c_${label}_observed_body_required`);
  return body;
}

export function makeSemanticPayload(input: {
  readonly origin: RawOrigin;
  readonly row: MatrixRow;
  readonly event: string;
  readonly identity: SemanticIdentity;
  readonly processEvidenceSetId?: string;
  readonly providerEffectId?: string;
  readonly effectSetSha256s?: readonly string[];
  readonly observedRequestBody?: Buffer;
  readonly observedResponseBody?: Buffer;
  readonly observedPageExchanges?: readonly {
    readonly request: Buffer;
    readonly response: Buffer;
  }[];
  readonly observedBrowserStatus?: number;
}): Readonly<Record<string, unknown>> {
  const generation = ownerGenerationForEvent(input.event);
  let transport: Record<string, unknown>;
  switch (input.origin) {
    case 'browser': {
      const rejectedCrossTeam = row08BrowserEvent(input.event);
      const endpoint = httpEndpointForEvent(input.event);
      transport = {
        kind: 'browser',
        method: 'POST',
        path: rejectedCrossTeam ? endpoint.path : APPROVAL_DECISIONS_PATH,
        decision: rejectedCrossTeam
          ? endpoint.family === 'decisions'
            ? 'deny'
            : 'none'
          : input.event.startsWith('allow_')
            ? 'allow'
            : input.event.startsWith('deny_')
              ? 'deny'
              : 'none',
        status: rejectedCrossTeam ? input.observedBrowserStatus : 200,
        receiptOutcome: rejectedCrossTeam ? 'rejected' : 'committed',
        authenticatedActorTeamId: input.identity.authenticatedActorTeamId,
        targetTeamId: input.identity.targetTeamId,
        targetRunId: input.identity.targetTeamRunId,
        approvalId: input.identity.approvalId,
        generationId: input.identity.generationId,
        idempotencyKey: input.identity.idempotencyKey,
        retryCount: 0,
        observation: input.event,
      };
      break;
    }
    case 'product-http': {
      const rejected = /rejected|routes_absent/u.test(input.event);
      const endpoint = httpEndpointForEvent(input.event);
      const requestBody = requiredObservedBody(input.observedRequestBody, 'http_request');
      const responseBody = requiredObservedBody(input.observedResponseBody, 'http_response');
      const pageExchanges =
        endpoint.family === 'page' && !rejected
          ? (input.observedPageExchanges ?? [{ request: requestBody, response: responseBody }]).map(
              (exchange) => ({
                request: redactedStructure(exchange.request),
                response: redactedStructure(exchange.response),
              })
            )
          : null;
      transport = {
        kind: 'http',
        endpointFamily: endpoint.family,
        method: 'POST',
        path: endpoint.path,
        status: rejected ? 403 : 200,
        requestHeaders: expectedHttpRequestHeaders(input.event),
        responseHeaders: {
          contentType: 'application/json',
          cacheControl: 'no-store',
        },
        request: redactedStructure(requestBody),
        response: redactedStructure(responseBody),
        conditions: expectedHttpConditions(input.event),
        pageExchanges,
      };
      break;
    }
    case 'product-sse':
      transport = {
        kind: 'sse',
        eventId: '1',
        eventType: input.event,
        reconnectAttempt: input.event.includes('reconnect') ? 1 : 0,
        data: redactedStructure(
          Buffer.from(
            canonicalJson({
              schemaVersion: 1,
              kind: 'sse-data',
              event: input.event,
              decision: input.identity.decision,
              approvalId: input.identity.approvalId,
              generation: input.identity.generationId,
            })
          )
        ),
      };
      break;
    case 'owner-wal': {
      const record = Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          kind: 'wal-record',
          event: input.event,
          state: input.event,
          decision: input.identity.decision,
          ownerGeneration: generation,
          providerEffectId: input.providerEffectId ?? null,
          identity: input.identity,
        })
      );
      transport = {
        kind: 'wal',
        offset: '0',
        length: record.length,
        recordSha256: sha256(record),
        fsynced: true,
        state: input.event,
        ownerGeneration: generation,
        providerEffectId: input.providerEffectId ?? null,
        ...causalAttempt(input.event, input.origin),
        record: redactedStructure(record),
      };
      break;
    }
    case 'opencode':
      transport = {
        kind: 'opencode',
        direction: /request/u.test(input.event)
          ? 'request'
          : /response/u.test(input.event)
            ? 'response'
            : /effect(?!_total)/u.test(input.event)
              ? 'effect'
              : 'observation',
        endpoint: '/v1/conditional-decisions',
        status: 200,
        conditional: true,
        ownerGeneration: generation,
        providerEffectId: input.providerEffectId ?? null,
        ...causalAttempt(input.event, input.origin),
        effectSetSha256s:
          input.event === 'effect_total_two'
            ? Object.freeze([...(input.effectSetSha256s ?? [])])
            : null,
        effectSetDigest:
          input.event === 'effect_total_two'
            ? sha256(
                `agent-teams.p3c.provider-effect-set/v1\0${canonicalJson(
                  [...(input.effectSetSha256s ?? [])].sort()
                )}`
              )
            : null,
        request: redactedStructure(
          requiredObservedBody(input.observedRequestBody, 'opencode_request')
        ),
        response: redactedStructure(
          requiredObservedBody(input.observedResponseBody, 'opencode_response')
        ),
      };
      break;
    case 'supervisor':
      if (
        typeof input.processEvidenceSetId !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(input.processEvidenceSetId)
      )
        throw new Error('p3c_semantic_supervisor_process_evidence');
      transport = {
        kind: 'supervisor',
        observation: input.event,
        ownerGeneration: generation,
        bounded: true,
        zeroSurvivors: true,
        processEvidenceSetId: input.processEvidenceSetId,
      };
      break;
  }
  const semantic = {
    schemaVersion: 1,
    purpose: SEMANTIC_PURPOSE,
    origin: input.origin,
    row: input.row,
    event: input.event,
    identity: input.identity,
    causal: {
      chainId: sha256(`agent-teams.p3c.causal-chain/v1\0${canonicalJson(input.identity)}`),
      phase: causalPhaseForEvent(input.event),
      providerEffectId: input.providerEffectId ?? null,
      ...causalAttempt(input.event, input.origin),
    },
    transport,
  };
  const bytes = Buffer.from(canonicalJson(semantic));
  const kinds: Readonly<Record<RawOrigin, string>> = Object.freeze({
    browser: 'browser-observation',
    'product-http': 'http-structure',
    'product-sse': 'sse-structure',
    'owner-wal': 'wal-structure',
    opencode: 'opencode-structure',
    supervisor: 'supervisor-structure',
  });
  return Object.freeze({
    kind: kinds[input.origin],
    recordBase64: bytes.toString('base64'),
    recordSha256: sha256(bytes),
  });
}

function row08BrowserEvent(event: string): boolean {
  return [
    'cross_team_list_rejected',
    'cross_team_preview_rejected',
    'cross_team_decide_rejected',
  ].includes(event);
}

export function makeRawRecord(
  input: Omit<
    RawRecord,
    'schemaVersion' | 'purpose' | 'recordId' | 'payloadBase64' | 'payloadSha256'
  > & { readonly payload: unknown }
): RawRecord {
  const payloadBytes = Buffer.from(canonicalJson(input.payload));
  const record = {
    schemaVersion: 1 as const,
    purpose: RAW_RECORD_PURPOSE,
    controllerNonce: input.controllerNonce,
    origin: input.origin,
    row: input.row,
    sequence: input.sequence,
    monotonicNs: input.monotonicNs,
    processStartToken: input.processStartToken,
    event: input.event,
    correlation: input.correlation,
    effectCount: input.effectCount,
    payloadBase64: payloadBytes.toString('base64'),
    payloadSha256: sha256(payloadBytes),
  };
  return Object.freeze({
    ...record,
    recordId: sha256(`agent-teams.p3c.raw-record-id/v1\0${canonicalJson(record)}`),
  });
}
