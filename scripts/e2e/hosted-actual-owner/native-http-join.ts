import { PRIVATE_HTTP_KIND, type LocatedHttpObservation } from './private-http-types';
import { decodePrivateHttpRecord, assertPrivateHttpOuterBinding } from './private-http';
import { privateHttpPairReader } from './private-http-pairs';
import { canonicalJson, sha256 } from './contracts';
import {
  appliedHttpReceipt,
  decodeReadResponse,
  type AppliedHttpReceipt,
} from './http-entity';
import { parseHttpObservationEnvelope } from './http-observation-envelope';
import type { NativeCaptureShard } from './native-captures';
import {
  buildOpenCodeOperationIndex,
  joinHttpOperationBody,
  openCodeApprovalOperationKey,
  operationKey,
  type OpenCodeApprovalOperationIndex,
  type OpenCodeApprovalOperationTuple,
  type OpenCodeFact,
} from './opencode-operation-index';
import { assertP1NativeBindings } from './p1-admission';
import type { SupervisorOutcome } from './processes';
import {
  assertHttpOuterBinding,
  decodeHttpBase64,
  decodeSupportedHttpRecord,
  httpCheck,
  httpHeaderStatus,
  httpHex,
  ownerHttpOperationRouteV2,
  parseHttpCanonical,
  snapshotHttpContext,
} from './raw-http';
import { HTTP_LIMITS, isHttpObservationKind } from './raw-http-types';
import type {
  HostedHttpContext,
  HttpRequestObservation,
  HttpResponseObservation,
  LocatedHttpRawRecord,
  RetainedHttpBody,
} from './raw-http-types';

export interface NativeHttpApprovalCapture {
  readonly request: HttpRequestObservation;
  readonly response: HttpResponseObservation | null;
}

export interface NativeHttpApprovalCorrelation {
  readonly key: string;
  readonly tuple: OpenCodeApprovalOperationTuple;
  /** The exact Slice A observation entity which established this operation. */
  readonly sourceObservationResponseBody: RetainedHttpBody;
  /** Exact Owner-retained bytes sent across the native HTTP boundary. */
  readonly nativeRequestBody: RetainedHttpBody;
  /** Exact Owner-retained bytes received across the native HTTP boundary. */
  readonly nativeResponseBody: RetainedHttpBody;
  readonly nativeResponseStatus: number;
}

export interface NativeHttpApprovalCorrelationResult {
  readonly status: 'correlated-unverified';
  readonly admission: 'unverified';
  readonly correlations: readonly NativeHttpApprovalCorrelation[];
}

function retainedApprovalBody(
  supplied: RetainedHttpBody,
  label: string
): RetainedHttpBody {
  httpCheck(
    Object.keys(supplied).length === 3 &&
      ['byteLength', 'sha256', 'bodyBase64'].every((field) => field in supplied) &&
      Number.isSafeInteger(supplied.byteLength) &&
      supplied.byteLength >= 0 &&
      supplied.byteLength <= HTTP_LIMITS.body &&
      httpHex(supplied.sha256),
    `${label}_commitment`
  );
  const bytes = decodeHttpBase64(supplied.bodyBase64, HTTP_LIMITS.body, `${label}_base64`);
  httpCheck(
    bytes.length === supplied.byteLength && sha256(bytes) === supplied.sha256,
    `${label}_retention`
  );
  return Object.freeze({
    byteLength: supplied.byteLength,
    sha256: supplied.sha256,
    bodyBase64: supplied.bodyBase64,
  });
}

function tupleWithoutDigest(tuple: OpenCodeApprovalOperationTuple): string {
  return canonicalJson({
    runtimeInstanceId: tuple.runtimeInstanceId,
    configGeneration: tuple.configGeneration,
    sessionId: tuple.sessionId,
    requestId: tuple.requestId,
    sessionIncarnation: tuple.sessionIncarnation,
    requestIncarnation: tuple.requestIncarnation,
  });
}

function retainedApprovalTuple(
  supplied: OpenCodeApprovalOperationTuple
): OpenCodeApprovalOperationTuple {
  const tuple = {
    runtimeInstanceId: supplied.runtimeInstanceId,
    configGeneration: supplied.configGeneration,
    sessionId: supplied.sessionId,
    requestId: supplied.requestId,
    sessionIncarnation: supplied.sessionIncarnation,
    requestIncarnation: supplied.requestIncarnation,
    permissionDigest: supplied.permissionDigest,
  };
  httpCheck(
    Object.values(tuple).every((field) => typeof field === 'string' && field.length > 0) &&
      httpHex(tuple.permissionDigest),
    'native_approval_tuple'
  );
  return Object.freeze(tuple);
}

function validateDecodedApprovalPermissions(
  permissions: readonly OpenCodeApprovalOperationTuple[],
  keys: Set<string>,
  digestByIdentity: Map<string, string>
): void {
  for (const suppliedPermission of permissions) {
    const permission = retainedApprovalTuple(suppliedPermission);
    const key = openCodeApprovalOperationKey(permission);
    httpCheck(!keys.has(key), 'native_approval_observation_duplicate');
    keys.add(key);
    const identity = tupleWithoutDigest(permission);
    const digest = digestByIdentity.get(identity);
    httpCheck(
      digest === undefined || digest === permission.permissionDigest,
      'native_approval_observation_ambiguous'
    );
    digestByIdentity.set(identity, permission.permissionDigest);
  }
}

function validateApprovalIndex(
  index: OpenCodeApprovalOperationIndex
): ReadonlyMap<string, Readonly<{
  tuple: OpenCodeApprovalOperationTuple;
  responseBody: RetainedHttpBody;
}>> {
  httpCheck(
    Object.isFrozen(index) &&
      Object.isFrozen(index.entries) &&
      Number.isSafeInteger(index.size) &&
      index.size === index.entries.length,
    'native_approval_index'
  );
  const byKey = new Map<string, {
    tuple: OpenCodeApprovalOperationTuple;
    responseBody: RetainedHttpBody;
  }>();
  const bindingsByResponse = new Map<string, Array<{
    key: string;
    tuple: OpenCodeApprovalOperationTuple;
    responseBody: RetainedHttpBody;
  }>>();
  const digestByIdentity = new Map<string, string>();
  let previousKey: string | null = null;
  for (const binding of index.entries) {
    const tuple = retainedApprovalTuple(binding.tuple);
    const key = openCodeApprovalOperationKey(tuple);
    httpCheck(
      Object.isFrozen(binding) &&
        Object.isFrozen(binding.tuple) &&
        binding.key === key &&
        index.get(binding.tuple) === binding &&
        !byKey.has(key) &&
        (previousKey === null || Buffer.from(previousKey).compare(Buffer.from(key)) < 0),
      'native_approval_index_binding'
    );
    previousKey = key;
    const identity = tupleWithoutDigest(tuple);
    const digest = digestByIdentity.get(identity);
    httpCheck(
      digest === undefined || digest === tuple.permissionDigest,
      'native_approval_index_ambiguous'
    );
    digestByIdentity.set(identity, tuple.permissionDigest);
    const responseBody = retainedApprovalBody(
      binding.responseBody,
      'native_approval_observation'
    );
    const responseKey = canonicalJson(responseBody);
    bindingsByResponse.set(responseKey, [
      ...(bindingsByResponse.get(responseKey) ?? []),
      { key, tuple, responseBody },
    ]);
    byKey.set(key, { tuple, responseBody });
  }

  // A retained observation body may back several selected bindings. Decode each distinct body once,
  // but apply duplicate and ambiguity checks globally before accepting any selected correlation.
  const observedKeys = new Set<string>();
  const observedDigestByIdentity = new Map<string, string>();
  for (const bindings of bindingsByResponse.values()) {
    const { responseBody } = bindings[0]!;
    const decoded = decodeReadResponse(
      { kind: 'observe', sessionId: bindings[0]!.tuple.sessionId },
      {
        phase: 'response-retained',
        ownerExchangeNonce: 'native-http-approval-index',
        requestRecordId: 'native-http-approval-index',
        status: 200,
        responseHeaders: [],
        peerOperationNonce: null,
        nonceStatus: 'missing',
        connectedPeer: {
          localAddress: '127.0.0.1',
          localPort: 1,
          remoteAddress: '127.0.0.1',
          remotePort: 1,
        },
        body: responseBody,
        complete: true,
      }
    );
    httpCheck(decoded.kind === 'observation', 'native_approval_observation');
    validateDecodedApprovalPermissions(
      decoded.permissions,
      observedKeys,
      observedDigestByIdentity
    );
    for (const { key } of bindings) {
      const matches = decoded.permissions.filter(
        (permission) => openCodeApprovalOperationKey(permission) === key
      );
      httpCheck(matches.length === 1, 'native_approval_observation_tuple');
    }
  }
  return byKey;
}

/**
 * Correlates already-validated Slice A/B approval operations with native HTTP request/response
 * observations. This is retained, observational evidence only: it cannot admit P1 or authorize a
 * decision. Record, fixture, approval and transport IDs are deliberately absent from the join key.
 */
export function correlateNativeHttpApprovalEvidence(input: {
  readonly operationIndex: OpenCodeApprovalOperationIndex;
  readonly captures: readonly NativeHttpApprovalCapture[];
}): NativeHttpApprovalCorrelationResult {
  httpCheck(input.captures.length > 0, 'native_approval_capture_missing');
  const operations = validateApprovalIndex(input.operationIndex);
  const correlations: NativeHttpApprovalCorrelation[] = [];
  const consumed = new Set<string>();
  for (const capture of input.captures) {
    const response = capture.response;
    httpCheck(response !== null, 'native_approval_response_missing');
    httpCheck(response.complete, 'native_approval_response_incomplete');
    const requestBody = retainedApprovalBody(
      capture.request.body,
      'native_approval_request'
    );
    const responseBody = retainedApprovalBody(response.body, 'native_approval_response');
    const route = ownerHttpOperationRouteV2(capture.request.operation);
    httpCheck(
      capture.request.phase === 'request-retained' &&
        capture.request.operation.kind === 'reply' &&
        capture.request.method === route.method &&
        capture.request.path === route.path &&
        response.phase === 'response-retained' &&
        response.ownerExchangeNonce === capture.request.ownerExchangeNonce,
      'native_approval_capture'
    );
    const headers = httpHeaderStatus(response.responseHeaders);
    httpCheck(
      headers.identityEncoding &&
        headers.nonceStatus === response.nonceStatus &&
        headers.peerOperationNonce === response.peerOperationNonce,
      'native_approval_response_headers'
    );
    const receipt = appliedHttpReceipt(
      { ...capture.request, body: requestBody },
      { ...response, body: responseBody }
    );
    httpCheck(receipt !== null, 'native_approval_response_mismatch');
    const tuple = Object.freeze({
      runtimeInstanceId: receipt.runtimeInstanceId,
      configGeneration: receipt.configGeneration,
      sessionId: receipt.sessionId,
      requestId: receipt.requestId,
      sessionIncarnation: receipt.sessionIncarnation,
      requestIncarnation: receipt.requestIncarnation,
      permissionDigest: receipt.permissionDigest,
    });
    const key = openCodeApprovalOperationKey(tuple);
    const operation = operations.get(key);
    httpCheck(operation !== undefined, 'native_approval_operation_missing');
    httpCheck(!consumed.has(key), 'native_approval_capture_duplicate');
    consumed.add(key);
    correlations.push(
      Object.freeze({
        key,
        tuple: operation.tuple,
        sourceObservationResponseBody: operation.responseBody,
        nativeRequestBody: requestBody,
        nativeResponseBody: responseBody,
        nativeResponseStatus: response.status,
      })
    );
  }
  correlations.sort((left, right) => Buffer.from(left.key).compare(Buffer.from(right.key)));
  return Object.freeze({
    status: 'correlated-unverified',
    admission: 'unverified',
    correlations: Object.freeze(correlations),
  });
}

export interface HttpCaptureSelection {
  readonly captureSha256: string;
  readonly shardIndex: number;
}

/** Untrusted assertions used only to characterize correlation. Publication bytes and the
 * independently observed launch/activation chain are absent at this source checkpoint. */
export interface P1HttpCorrelationInput {
  readonly context: HostedHttpContext;
  readonly claimedActivationPublicationSha256: string;
  readonly endpoint: Readonly<{ address: '127.0.0.1'; port: number }>;
  readonly hosted: Readonly<{ runtimeInstanceId: string; configGeneration: string }>;
  readonly timeline: HttpCaptureSelection;
  readonly effects: HttpCaptureSelection;
}

export interface P1HttpExchangeCorrelation {
  readonly requestRecordId: string;
  readonly responseRecordId: string | null;
  readonly failureRecordIds: readonly string[];
  readonly ownerExchangeNonce: string;
  readonly context: HostedHttpContext;
  readonly claimedActivationPublicationSha256: string;
  readonly operationNonce: string | null;
  readonly status: 'correlated-unverified' | 'uncorrelated';
  readonly problem: string | null;
  readonly facts: readonly OpenCodeFact[];
  readonly terminalObservation: 'applied' | 'condition-rejected' | 'uncertain';
  readonly appliedReceiptObservation: AppliedHttpReceipt | null;
}

export interface P1HttpCorrelationResult {
  readonly status: 'correlated-unverified' | 'incomplete-unverified';
  readonly admission: 'unverified';
  readonly controllerNonce: string;
  readonly runId: string;
  readonly ledgerSha256: string;
  readonly recordIds: readonly string[];
  readonly exchanges: readonly P1HttpExchangeCorrelation[];
  readonly privateObservations: readonly { readonly recordId: string; readonly bodyCommitment: 'unverified' }[];
  readonly unboundFailureRecordIds: readonly string[];
  readonly unmatchedNativeFacts: readonly OpenCodeFact[];
  readonly nativeProblems: readonly string[];
}

type RequestRecord = LocatedHttpRawRecord & {
  readonly http: LocatedHttpRawRecord['http'] & { readonly observation: HttpRequestObservation };
};
type ResponseRecord = LocatedHttpRawRecord & {
  readonly http: LocatedHttpRawRecord['http'] & { readonly observation: HttpResponseObservation };
};

function selectedShard(
  shards: readonly NativeCaptureShard[],
  name: NativeCaptureShard['name'],
  selection: HttpCaptureSelection
): NativeCaptureShard {
  const matches = shards.filter(
    (shard) =>
      shard.name === name &&
      shard.shardIndex === selection.shardIndex &&
      shard.captureSha256 === selection.captureSha256
  );
  httpCheck(matches.length === 1, 'selected_shard');
  return matches[0]!;
}

function bindCorrelationInput(
  assertion: P1HttpCorrelationInput,
  shards: readonly NativeCaptureShard[],
  outcome: SupervisorOutcome
) {
  const snapshot = Object.freeze({
    context: snapshotHttpContext(assertion.context),
    claimedActivationPublicationSha256: assertion.claimedActivationPublicationSha256,
    endpoint: Object.freeze({ ...assertion.endpoint }),
    hosted: Object.freeze({ ...assertion.hosted }),
    timeline: Object.freeze({ ...assertion.timeline }),
    effects: Object.freeze({ ...assertion.effects }),
  });
  const { context } = snapshot;
  httpCheck(httpHex(snapshot.claimedActivationPublicationSha256), 'activation_publication');
  httpCheck(
    snapshot.endpoint.address === '127.0.0.1' &&
      Number.isSafeInteger(snapshot.endpoint.port) &&
      snapshot.endpoint.port > 0 &&
      snapshot.endpoint.port <= 65535,
    'asserted_endpoint'
  );
  httpCheck(
    /^runtime_instance_[0-9a-f]{32}$/u.test(snapshot.hosted.runtimeInstanceId) &&
      /^config_generation_[0-9a-f]{32}$/u.test(snapshot.hosted.configGeneration),
    'asserted_hosted'
  );
  const owner = outcome.starts.find(
    (start) => start.startToken === context.recorder.processStartToken
  );
  const peer = outcome.starts.find(
    (start) => start.startToken === context.expectedPeer.supervisorProcessStartToken
  );
  httpCheck(
    owner?.role === 'owner' &&
      owner.pid === context.recorder.pid &&
      owner.startTime === context.recorder.startTicks &&
      owner.generation === context.recorder.ownerGeneration,
    'recorder_start'
  );
  httpCheck(
    peer?.role === 'opencode' &&
      peer.pid === context.expectedPeer.pid &&
      peer.startTime === context.expectedPeer.startTicks &&
      context.expectedPeer.pidNamespaceInode === outcome.filesystem.pidNamespaceInode &&
      context.expectedPeer.networkNamespaceInode === outcome.network.namespaceInode,
    'expected_peer_start'
  );
  httpCheck(
    context.activation.controllerNonce === outcome.controllerNonce &&
      context.activation.runId === outcome.runId,
    'assertion_run'
  );
  const timeline = selectedShard(shards, 'openCodeTimelinePath', snapshot.timeline);
  const effects = selectedShard(shards, 'protectedEffectLedgerPath', snapshot.effects);
  const first = timeline.parsed.records[0]!;
  httpCheck(
    timeline.producerStartToken === peer.startToken &&
      effects.producerStartToken === peer.startToken &&
      first.producer.pid === peer.pid &&
      first.producer.startTicks === peer.startTime &&
      canonicalJson(first.producer) === canonicalJson(effects.parsed.records[0]!.producer) &&
      canonicalJson(first.activation) === canonicalJson(effects.parsed.records[0]!.activation) &&
      first.activation.controllerNonce === context.activation.controllerNonce &&
      first.activation.runId === context.activation.runId &&
      first.activation.stackManifestSha256 === context.activation.stackManifestSha256,
    'asserted_producer'
  );
  const rawFile = outcome.rawFiles.opencode;
  const ownerStarts = outcome.starts.filter(({ role }) => role === 'owner');
  httpCheck(
    canonicalJson([...rawFile.producerStartTokens].sort()) ===
      canonicalJson(ownerStarts.map(({ startToken }) => startToken).sort()) &&
      canonicalJson([...rawFile.producerPidfdInodes].sort()) ===
        canonicalJson(ownerStarts.map(({ pidfdInode }) => pidfdInode).sort()),
    'recorder_writer'
  );
  return { assertion: snapshot, owner, producer: first.producer, activation: first.activation };
}

function assertCompleteHttpSelection(
  ledger: Buffer,
  records: readonly LocatedHttpObservation[]
): void {
  httpCheck(
    ledger.length > 0 && ledger.length <= HTTP_LIMITS.ledger && ledger.at(-1) === 0x0a,
    'ledger_frame'
  );
  const selected = new Set(records.map(({ byteStart, byteEnd }) => `${byteStart}:${byteEnd}`));
  httpCheck(selected.size === records.length, 'duplicate_selection');
  let sequence = 1;
  let previous = -1n;
  let byteStart = 0;
  while (byteStart < ledger.length) {
    const byteEnd = ledger.indexOf(0x0a, byteStart);
    httpCheck(byteEnd >= byteStart && byteEnd - byteStart + 1 <= HTTP_LIMITS.line, 'ledger_line');
    const outer = parseHttpObservationEnvelope(
      ledger.subarray(byteStart, byteEnd), sequence++, records[0]?.controllerNonce ?? ''
    );
    httpCheck(BigInt(outer.monotonicNs) > previous, 'selection_clock');
    previous = BigInt(outer.monotonicNs);
    const payload = parseHttpCanonical(
      decodeHttpBase64(outer.payloadBase64, HTTP_LIMITS.payload, 'selection_payload'),
      'selection_payload'
    ) as Record<string, unknown>;
    httpCheck(isHttpObservationKind(payload.kind) || payload.kind === PRIVATE_HTTP_KIND, 'mixed_recorder_kinds');
    httpCheck(
      selected.has(`${byteStart}:${byteEnd}`) === (isHttpObservationKind(payload.kind) || payload.kind === PRIVATE_HTTP_KIND),
      'raw_selection_incomplete'
    );
    byteStart = byteEnd + 1;
  }
}

/** Characterizes retained-byte agreement only. No caller object or publication digest can
 * authenticate this result, authorize a receipt or supply admitted P1 evidence to derivation. */
export function correlateOpenCodeHttpEvidence(input: {
  readonly records: readonly LocatedHttpObservation[];
  readonly ledger: Buffer;
  readonly shards: readonly NativeCaptureShard[];
  readonly correlations: readonly P1HttpCorrelationInput[];
  readonly outcome: SupervisorOutcome;
}): P1HttpCorrelationResult {
  const { outcome, records } = input;
  assertCompleteHttpSelection(input.ledger, records);
  assertP1NativeBindings(input.shards, outcome);
  const ledgerSha256 = sha256(input.ledger);
  httpCheck(
    outcome.rawFiles.opencode.sha256 === ledgerSha256 &&
      outcome.rawFiles.opencode.size === input.ledger.length,
    'ledger_binding'
  );
  const correlations = new Map<string, ReturnType<typeof bindCorrelationInput>>();
  for (const assertion of input.correlations) {
    const key = canonicalJson(assertion.context);
    httpCheck(!correlations.has(key), 'duplicate_assertion');
    correlations.set(key, bindCorrelationInput(assertion, input.shards, outcome));
  }
  const requests = new Map<string, RequestRecord>();
  const responses = new Map<string, ResponseRecord>();
  const failures = new Map<string, string[]>();
  const unboundFailures: string[] = [];
  const recordIds = new Set<string>();
  const exchanges = new Set<string>();
  let previousSequence = 0;
  const pair = privateHttpPairReader(input.ledger.length);
  for (const record of records) {
    const line = input.ledger.subarray(record.byteStart, record.byteEnd + 1);
    httpCheck(
      Number.isSafeInteger(record.byteStart) &&
        record.byteStart >= 0 &&
        Number.isSafeInteger(record.byteEnd) &&
        record.byteEnd > record.byteStart &&
        record.byteEnd < input.ledger.length &&
        line.at(-1) === 0x0a &&
        sha256(line) === record.lineSha256 &&
        record.sequence > previousSequence,
      'raw_fact_locator'
    );
    previousSequence = record.sequence;
    const outer = parseHttpCanonical(line.subarray(0, -1), 'located_outer') as Record<
      string,
      unknown
    >;
    // Parsed data has no trust brand. Bind every supplied observation to its retained bytes.
    httpCheck(
      Object.entries(outer).every(
        ([key, value]) => (record as unknown as Record<string, unknown>)[key] === value
      ),
      'raw_fact_locator'
    );
    const payload = parseHttpCanonical(
      Buffer.from(record.payloadBase64, 'base64'),
      'located_payload'
    );
    httpCheck((payload as Record<string, unknown>).kind === record.kind, 'raw_fact_kind');
    const decoded = record.kind === PRIVATE_HTTP_KIND
      ? decodePrivateHttpRecord(payload as Record<string, unknown>)
      : decodeSupportedHttpRecord(payload as Record<string, unknown>);
    httpCheck(canonicalJson(decoded) === canonicalJson(record.http), 'raw_fact_content');
    if (decoded.purpose === 'agent-teams.p3c.opencode-http-private-observation/v1') assertPrivateHttpOuterBinding(record, decoded);
    else assertHttpOuterBinding(record, decoded);
    httpCheck(!recordIds.has(record.recordId), 'duplicate_record');
    recordIds.add(record.recordId);
    const bound = correlations.get(canonicalJson(record.http.context));
    httpCheck(bound, 'assertion_missing');
    httpCheck(
      outcome.rawFiles.opencode.producerStartTokens.includes(record.processStartToken) &&
        record.processStartToken === bound.owner.startToken &&
        BigInt(record.monotonicNs) > BigInt(bound.owner.observedMonotonicNs),
      'recorder_start'
    );
    pair(record);
    if (record.kind === PRIVATE_HTTP_KIND) {
      const observation = record.http.observation;
      if (observation.phase === 'response-retained') httpCheck(
        observation.connectedPeer.remoteAddress === bound.assertion.endpoint.address &&
        observation.connectedPeer.remotePort === bound.assertion.endpoint.port, 'connected_endpoint');
      continue; // Custody-bound UNVERIFIED commitment; never enter any approval body parser.
    }
    const observation = record.http.observation;
    if (observation.phase === 'request-retained') {
      httpCheck(!exchanges.has(observation.ownerExchangeNonce), 'exchange_reused');
      exchanges.add(observation.ownerExchangeNonce);
      requests.set(record.recordId, record as RequestRecord);
      continue;
    }
    if (observation.phase === 'exchange-failed' && observation.requestRecordId === null) {
      unboundFailures.push(record.recordId);
      continue;
    }
    const requestId = observation.requestRecordId!;
    const request = requests.get(requestId);
    httpCheck(
      request &&
        request.http.observation.ownerExchangeNonce === observation.ownerExchangeNonce &&
        request.sequence < record.sequence &&
        request.kind === record.kind &&
        canonicalJson(request.http.context) === canonicalJson(record.http.context),
      'exchange_snapshot'
    );
    if (observation.phase === 'exchange-failed') {
      failures.set(requestId, [...(failures.get(requestId) ?? []), record.recordId]);
    } else {
      httpCheck(!responses.has(requestId), 'duplicate_response');
      httpCheck(
        observation.connectedPeer.remoteAddress === bound.assertion.endpoint.address &&
          observation.connectedPeer.remotePort === bound.assertion.endpoint.port,
        'connected_endpoint'
      );
      responses.set(requestId, record as ResponseRecord);
    }
  }
  const index = buildOpenCodeOperationIndex(
    input.shards.filter(
      (shard) => shard.name === 'openCodeTimelinePath' || shard.name === 'protectedEffectLedgerPath'
    )
  );
  const consumed = new Set<string>();
  const claimedGroups = new Set<string>();
  const results: P1HttpExchangeCorrelation[] = [];
  for (const [requestId, record] of requests) {
    const request = record.http.observation;
    const bound = correlations.get(canonicalJson(record.http.context))!;
    const responseRecord = responses.get(requestId);
    const response = responseRecord?.http.observation;
    const headers = response && httpHeaderStatus(response.responseHeaders);
    let receipt =
      response && headers?.identityEncoding ? appliedHttpReceipt(request, response) : null;
    if (
      receipt &&
      (receipt.runtimeInstanceId !== bound.assertion.hosted.runtimeInstanceId ||
        receipt.configGeneration !== bound.assertion.hosted.configGeneration)
    )
      receipt = null;
    let problem: string | null = null;
    let facts: readonly OpenCodeFact[] = [];
    let terminal: P1HttpExchangeCorrelation['terminalObservation'] = receipt ? 'applied' : 'uncertain';
    try {
      httpCheck(response, 'missing_response');
      httpCheck(response.complete, 'incomplete_response');
      httpCheck(headers?.identityEncoding, 'response_encoding');
      httpCheck(headers.nonceStatus === 'present' && response.peerOperationNonce, 'response_nonce');
      const key = operationKey(bound.producer, bound.activation, response.peerOperationNonce);
      httpCheck(!claimedGroups.has(key), 'operation_reused');
      claimedGroups.add(key);
      httpCheck(
        request.operation.kind === 'capability' || request.operation.kind === 'observe' ||
          request.operation.kind === 'reply',
        'general_operation_native_facts_unavailable'
      );
      const group = index.get(key);
      httpCheck(group, 'native_operation_missing');
      for (const fact of group.facts) {
        const selection =
          fact.locator.stream === 'openCodeTimeline'
            ? bound.assertion.timeline
            : bound.assertion.effects;
        httpCheck(
          fact.locator.captureSha256 === selection.captureSha256 &&
            fact.locator.shardIndex === selection.shardIndex &&
            !consumed.has(canonicalJson(fact.locator)),
          'native_fact_binding'
        );
      }
      joinHttpOperationBody(group, request, response, bound.assertion.hosted);
      facts = group.facts;
      facts.forEach((fact) => consumed.add(canonicalJson(fact.locator)));
      if (group.outcome === 'conflict' || group.outcome === 'precondition-failed')
        terminal = 'condition-rejected';
    } catch (error) {
      problem = error instanceof Error ? error.message : 'p3c_http_join_failed';
    }
    results.push(
      Object.freeze({
        requestRecordId: requestId,
        responseRecordId: responseRecord?.recordId ?? null,
        failureRecordIds: Object.freeze(failures.get(requestId) ?? []),
        ownerExchangeNonce: request.ownerExchangeNonce,
        context: record.http.context,
        claimedActivationPublicationSha256: bound.assertion.claimedActivationPublicationSha256,
        operationNonce: response?.peerOperationNonce ?? null,
        status: problem === null ? 'correlated-unverified' : 'uncorrelated',
        problem,
        facts,
        terminalObservation: terminal,
        appliedReceiptObservation: receipt,
      })
    );
  }
  const groups = [...index.values()];
  const unmatchedNativeFacts = groups
    .flatMap((group) => group.facts)
    .filter((fact) => !consumed.has(canonicalJson(fact.locator)));
  const nativeProblems = groups.flatMap((group) => (group.problem === null ? [] : [group.problem]));
  return Object.freeze({
    status:
      !records.some(record => record.kind === PRIVATE_HTTP_KIND) &&
      results.length > 0 &&
      results.every((result) => result.status === 'correlated-unverified') &&
      unboundFailures.length === 0 &&
      unmatchedNativeFacts.length === 0
        ? 'correlated-unverified'
        : 'incomplete-unverified',
    admission: 'unverified',
    controllerNonce: outcome.controllerNonce,
    runId: outcome.runId,
    ledgerSha256,
    recordIds: Object.freeze([...recordIds]),
    exchanges: Object.freeze(results),
    privateObservations: Object.freeze(records.filter(record => record.kind === PRIVATE_HTTP_KIND).map(record =>
      Object.freeze({ recordId: record.recordId, bodyCommitment: 'unverified' as const }))),
    unboundFailureRecordIds: Object.freeze(unboundFailures),
    unmatchedNativeFacts: Object.freeze(unmatchedNativeFacts),
    nativeProblems: Object.freeze(nativeProblems),
  });
}
