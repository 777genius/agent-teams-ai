import { parseHostedOwnerWalNative } from '../../../src/main/composition/hosted/hostedOwnerWalNativeValidator';
import {
  PRODUCER_PROVENANCE_CONTRACT,
  RUNTIME_CAPTURE_STREAMS,
  exactRecord,
  sha256,
  validateDecimal,
  type RuntimeCaptureName,
} from './contracts';

export const CAPTURE_NATIVE_RECORD_TYPES = Object.freeze({
  conditionalPostLedgerPath: Object.freeze(['decision-compare-and-claim-verified'] as const),
  negativeResultsPath: Object.freeze(['browser-negative-response-observed'] as const),
  openCodeTimelinePath: Object.freeze([
    'hosted-capability',
    'hosted-observe',
    'hosted-reply',
    'hosted-reply-raw',
  ] as const),
  ownerWalTimelinePath: Object.freeze(['owner-wal-published'] as const),
  productTimelinePath: Object.freeze([
    'approval-http-response-finalized',
    'approval-http-unadmitted-response-finalized',
    'coordination-sse-write-succeeded',
  ] as const),
  protectedEffectLedgerPath: Object.freeze(['conditional-reply-effect'] as const),
} as const satisfies Readonly<Record<RuntimeCaptureName, readonly string[]>>);

const NATIVE_RECORD_KEYS = Object.freeze({
  'decision-compare-and-claim-verified': Object.freeze([
    'actorId',
    'approvalId',
    'bootId',
    'decision',
    'deploymentId',
    'generationId',
    'idempotencyKeySha256',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'outcome',
    'requestId',
    'sessionId',
    'targetTeamId',
    'targetTeamRunId',
  ]),
  'browser-negative-response-observed': Object.freeze([
    'actorTeamId',
    'harnessRunId',
    'httpStatus',
    'observedOutcome',
    'processStartToken',
    'requestBodySha256',
    'requestFamily',
    'responseBodySha256',
    'targetTeamId',
    'targetTeamRunId',
  ]),
  'approval-http-response-finalized': Object.freeze([
    'actorId',
    'bootId',
    'deploymentId',
    'method',
    'outcome',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'requestBodyBytes',
    'requestBodySha256',
    'requestId',
    'responseBodyBytes',
    'responseBodySha256',
    'routeId',
    'sessionId',
    'status',
  ]),
  'approval-http-unadmitted-response-finalized': Object.freeze([
    'bootId',
    'deploymentId',
    'method',
    'outcome',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'requestBodyBytes',
    'requestBodySha256',
    'responseBodyBytes',
    'responseBodySha256',
    'routeId',
    'status',
  ]),
  'coordination-sse-write-succeeded': Object.freeze([
    'bootId',
    'deploymentId',
    'eventId',
    'eventType',
    'frameBytes',
    'frameKind',
    'frameSha256',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
  ]),
  'owner-wal-published': Object.freeze(['fence', 'mutation', 'revision', 'stateDelta', 'wal']),
  'hosted-capability': Object.freeze([
    'configGeneration',
    'outcome',
    'responseSha256',
    'runtimeInstanceId',
    'status',
  ]),
  'hosted-observe': Object.freeze([
    'configGeneration',
    'outcome',
    'permissionCount',
    'responseSha256',
    'runtimeInstanceId',
    'sessionId',
    'status',
  ]),
  'hosted-reply': Object.freeze([
    'configGeneration',
    'decision',
    'outcome',
    'permissionDigest',
    'requestId',
    'requestIncarnation',
    'responseSha256',
    'runtimeInstanceId',
    'sessionId',
    'sessionIncarnation',
    'status',
  ]),
  'hosted-reply-raw': Object.freeze([
    'configGeneration',
    'outcome',
    'requestBodySha256',
    'requestId',
    'requestIncarnation',
    'responseSha256',
    'runtimeInstanceId',
    'sessionId',
    'sessionIncarnation',
    'status',
  ]),
  'conditional-reply-effect': Object.freeze([
    'configGeneration',
    'decision',
    'outcome',
    'permissionDigest',
    'requestId',
    'requestIncarnation',
    'runtimeInstanceId',
    'sessionId',
    'sessionIncarnation',
  ]),
} as const);

function nativeKeysForRecord(
  recordType: keyof typeof NATIVE_RECORD_KEYS,
  value: unknown
): readonly string[] {
  if (recordType !== 'hosted-reply') return NATIVE_RECORD_KEYS[recordType];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const outcome = (value as Record<string, unknown>).outcome;
  return outcome === 'applied'
    ? NATIVE_RECORD_KEYS['hosted-reply']
    : NATIVE_RECORD_KEYS['hosted-reply'].filter((key) => key !== 'responseSha256');
}

const PRODUCT_HTTP_OUTCOMES: Readonly<Record<string, Readonly<Record<string, number>>>> =
  Object.freeze({
    'team-approvals.page.v1': Object.freeze({
      success: 200,
      invalid_request: 400,
      not_found: 404,
      cancelled: 503,
      unavailable: 503,
    }),
    'team-approvals.preview.v1': Object.freeze({
      success: 200,
      invalid_request: 400,
      stale_generation: 409,
      not_found: 404,
      cancelled: 503,
      unavailable: 503,
    }),
    'team-approvals.decision.v1': Object.freeze({
      committed: 200,
      idempotent_replay: 200,
      already_resolved: 409,
      invalid_request: 400,
      stale_generation: 409,
      conflict: 409,
      expired: 410,
      not_found: 404,
      unavailable: 503,
    }),
  });

function validProductHttpOutcome(
  recordType: string,
  route: unknown,
  outcome: unknown,
  status: unknown
): boolean {
  if (recordType === 'approval-http-unadmitted-response-finalized') {
    return outcome === 'unadmitted' && status === 503;
  }
  return (
    typeof route === 'string' &&
    typeof outcome === 'string' &&
    PRODUCT_HTTP_OUTCOMES[route]?.[outcome] === status
  );
}

function validSseFrameIdentity(kind: unknown, eventId: unknown, eventType: unknown): boolean {
  if (kind === 'heartbeat') return eventId === null && eventType === null;
  if (kind === 'resync_required') return eventId === null && eventType === 'resync_required';
  return (
    kind === 'coordination_event' &&
    typeof eventId === 'string' &&
    eventId.length > 0 &&
    typeof eventType === 'string' &&
    eventType.length > 0
  );
}

function assertNativeRecordSemantics(
  name: RuntimeCaptureName,
  recordType: keyof typeof NATIVE_RECORD_KEYS,
  native: Record<string, unknown>
): void {
  const fail = (): never => {
    throw new Error(`p3c_runtime_capture_native_schema:${name}:${recordType}`);
  };
  const sha = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
  const identity = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
  const count = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;
  const productInstance = (): boolean =>
    identity(native.bootId) &&
    identity(native.deploymentId) &&
    identity(native.ownerAuthority) &&
    Number.isSafeInteger(native.ownerGeneration) &&
    (native.ownerGeneration as number) >= 1 &&
    identity(native.ownerSessionId);
  switch (recordType) {
    case 'decision-compare-and-claim-verified': {
      const joinedApprovalId =
        typeof native.targetTeamId === 'string' &&
        typeof native.targetTeamRunId === 'string' &&
        typeof native.requestId === 'string'
          ? `approval_${sha256(
              JSON.stringify({
                schemaVersion: 1,
                teamId: native.targetTeamId,
                runId: native.targetTeamRunId.replace(/^team-run_/u, 'run_'),
                requestId: native.requestId,
              })
            ).slice(0, 32)}`
          : null;
      if (
        !productInstance() ||
        !identity(native.actorId) ||
        !identity(native.requestId) ||
        !identity(native.sessionId) ||
        typeof native.approvalId !== 'string' ||
        !/^approval_[0-9a-f]{32}$/u.test(native.approvalId) ||
        typeof native.generationId !== 'string' ||
        !/^generation_runtime-permission-[0-9a-f]{64}$/u.test(native.generationId) ||
        !identity(native.targetTeamId) ||
        typeof native.targetTeamRunId !== 'string' ||
        !/^team-run_[0-9a-f]{32}$/u.test(native.targetTeamRunId) ||
        !sha(native.idempotencyKeySha256) ||
        !['allow', 'deny'].includes(native.decision as string) ||
        !['committed', 'idempotent_replay'].includes(native.outcome as string) ||
        native.approvalId !== joinedApprovalId
      )
        fail();
      return;
    }
    case 'browser-negative-response-observed':
      if (
        typeof native.actorTeamId !== 'string' ||
        !/^team_[0-9a-f]{32}$/u.test(native.actorTeamId) ||
        !sha(native.harnessRunId) ||
        !sha(native.processStartToken) ||
        !sha(native.requestBodySha256) ||
        !sha(native.responseBodySha256) ||
        typeof native.targetTeamId !== 'string' ||
        !/^team_[0-9a-f]{32}$/u.test(native.targetTeamId) ||
        typeof native.targetTeamRunId !== 'string' ||
        !/^team-run_[0-9a-f]{32}$/u.test(native.targetTeamRunId) ||
        ![403, 404].includes(native.httpStatus as number) ||
        !(
          (native.observedOutcome === 'cross_team_list_rejected' &&
            native.requestFamily === 'approval-page') ||
          (native.observedOutcome === 'cross_team_preview_rejected' &&
            native.requestFamily === 'approval-preview') ||
          (native.observedOutcome === 'cross_team_decide_rejected' &&
            native.requestFamily === 'approval-decision')
        )
      )
        fail();
      return;
    case 'approval-http-response-finalized':
      if (
        !productInstance() ||
        !identity(native.actorId) ||
        !identity(native.requestId) ||
        !identity(native.sessionId)
      )
        fail();
    // Fall through to the shared exact-wire fields.
    case 'approval-http-unadmitted-response-finalized':
      if (
        !productInstance() ||
        native.method !== 'POST' ||
        !count(native.requestBodyBytes) ||
        !sha(native.requestBodySha256) ||
        !count(native.responseBodyBytes) ||
        !sha(native.responseBodySha256) ||
        ![
          'team-approvals.page.v1',
          'team-approvals.preview.v1',
          'team-approvals.decision.v1',
        ].includes(native.routeId as string) ||
        !validProductHttpOutcome(recordType, native.routeId, native.outcome, native.status)
      )
        fail();
      return;
    case 'coordination-sse-write-succeeded':
      if (
        !productInstance() ||
        !count(native.frameBytes) ||
        !sha(native.frameSha256) ||
        !validSseFrameIdentity(native.frameKind, native.eventId, native.eventType)
      )
        fail();
      return;
    case 'hosted-capability':
      if (
        !identity(native.runtimeInstanceId) ||
        !identity(native.configGeneration) ||
        native.outcome !== 'ok' ||
        !sha(native.responseSha256) ||
        native.status !== 200
      )
        fail();
      return;
    case 'hosted-observe':
      if (
        !identity(native.runtimeInstanceId) ||
        !identity(native.configGeneration) ||
        !identity(native.sessionId) ||
        !count(native.permissionCount) ||
        !sha(native.responseSha256) ||
        !['ok', 'overflow'].includes(native.outcome as string) ||
        ![200, 500].includes(native.status as number)
      )
        fail();
      return;
    case 'hosted-reply':
      if (
        !identity(native.sessionId) ||
        !identity(native.requestId) ||
        !['allow_once', 'reject'].includes(native.decision as string) ||
        !sha(native.permissionDigest)
      )
        fail();
      if (native.outcome === 'applied') {
        if (
          native.status !== 200 ||
          !sha(native.responseSha256) ||
          !identity(native.runtimeInstanceId) ||
          !identity(native.configGeneration) ||
          !identity(native.sessionIncarnation) ||
          !identity(native.requestIncarnation)
        )
          fail();
      } else if (
        !(
          (native.outcome === 'bad-request' && native.status === 400) ||
          (native.outcome === 'precondition-failed' && native.status === 412) ||
          (native.outcome === 'conflict' && native.status === 409)
        ) ||
        native.runtimeInstanceId !== null ||
        native.configGeneration !== null ||
        native.sessionIncarnation !== null ||
        native.requestIncarnation !== null ||
        'responseSha256' in native
      )
        fail();
      return;
    case 'hosted-reply-raw': {
      if (!identity(native.sessionId) || !identity(native.requestId) || !sha(native.responseSha256))
        fail();
      const outcomeStatus: Readonly<Record<string, number>> = Object.freeze({
        unavailable: 404,
        'body-read-failed': 400,
        'invalid-json': 400,
        'invalid-schema': 400,
        'bad-request': 400,
        conflict: 409,
        'precondition-failed': 412,
        applied: 200,
      });
      if (typeof native.outcome !== 'string' || outcomeStatus[native.outcome] !== native.status)
        fail();
      if (native.outcome === 'unavailable' || native.outcome === 'body-read-failed') {
        if (native.requestBodySha256 !== null) fail();
      } else if (!sha(native.requestBodySha256)) fail();
      if (native.outcome === 'applied') {
        if (
          !identity(native.runtimeInstanceId) ||
          !identity(native.configGeneration) ||
          !identity(native.sessionIncarnation) ||
          !identity(native.requestIncarnation)
        )
          fail();
      } else if (
        native.runtimeInstanceId !== null ||
        native.configGeneration !== null ||
        native.sessionIncarnation !== null ||
        native.requestIncarnation !== null
      )
        fail();
      return;
    }
    case 'conditional-reply-effect':
      if (
        !identity(native.sessionId) ||
        !identity(native.requestId) ||
        !['once', 'reject'].includes(native.decision as string)
      )
        fail();
      if (native.outcome === 'applied') {
        if (
          !sha(native.permissionDigest) ||
          !identity(native.runtimeInstanceId) ||
          !identity(native.configGeneration) ||
          !identity(native.sessionIncarnation) ||
          !identity(native.requestIncarnation)
        )
          fail();
      } else if (
        native.outcome !== 'mismatch' ||
        native.permissionDigest !== null ||
        ![
          native.runtimeInstanceId,
          native.configGeneration,
          native.sessionIncarnation,
          native.requestIncarnation,
        ].every((value) => value === null)
      )
        fail();
      return;
    case 'owner-wal-published':
      return;
  }
}

export function parseNativePayload(
  name: RuntimeCaptureName,
  recordType: string,
  value: unknown
): Readonly<Record<string, unknown>> {
  if (recordType === PRODUCER_PROVENANCE_CONTRACT.firstRecordType) {
    const open = exactRecord(value, ['descriptor'], `native_capture_${name}_producer_open`);
    const descriptor = exactRecord(
      open.descriptor,
      ['device', 'fd', 'inode'],
      `native_capture_${name}_producer_open_descriptor`
    );
    if (
      descriptor.fd !== PRODUCER_PROVENANCE_CONTRACT.descriptorSlots[RUNTIME_CAPTURE_STREAMS[name]]
    ) {
      throw new Error(`p3c_runtime_capture_native_schema:${name}:producer-open`);
    }
    validateDecimal(descriptor.device, 'native_open_device');
    validateDecimal(descriptor.inode, 'native_open_inode');
    return Object.freeze({ descriptor: Object.freeze(descriptor) });
  }
  if (recordType === 'producer-close') {
    return Object.freeze(exactRecord(value, [], `native_capture_${name}_producer_close`));
  }
  if (!CAPTURE_NATIVE_RECORD_TYPES[name].includes(recordType as never)) {
    throw new Error(`p3c_runtime_capture_native_schema:${name}:${recordType}`);
  }
  const keys = NATIVE_RECORD_KEYS[recordType as keyof typeof NATIVE_RECORD_KEYS];
  if (keys === undefined) {
    throw new Error(`p3c_runtime_capture_native_schema:${name}:${recordType}`);
  }
  const native = exactRecord(
    value,
    nativeKeysForRecord(recordType as keyof typeof NATIVE_RECORD_KEYS, value),
    `native_capture_${name}_${recordType}`
  );
  if (recordType === 'owner-wal-published') {
    try {
      parseHostedOwnerWalNative(native);
    } catch {
      throw new Error(`p3c_runtime_capture_native_schema:${name}:${recordType}`);
    }
  }
  assertNativeRecordSemantics(name, recordType as keyof typeof NATIVE_RECORD_KEYS, native);
  return Object.freeze(native);
}
