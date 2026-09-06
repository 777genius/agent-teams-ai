import { canonicalJson, sha256 } from './contracts';
import { appliedHttpReceipt, type AppliedHttpReceipt } from './http-entity';
import type { NativeCaptureShard } from './native-captures';
import {
  buildOpenCodeOperationIndex,
  joinHttpOperationBody,
  operationKey,
  type OpenCodeFact,
} from './opencode-operation-index';
import type { SupervisorOutcome } from './processes';
import {
  assertHttpOuterBinding,
  decodeHttpBase64,
  decodeHttpRecord,
  httpCheck,
  httpHeaderStatus,
  httpHex,
  parseHttpCanonical,
  snapshotHttpContext,
} from './raw-http';
import { HTTP_LIMITS, HTTP_OBSERVATION_KIND } from './raw-http-types';
import type {
  HostedHttpContext,
  HttpRequestObservation,
  HttpResponseObservation,
  LocatedHttpRawRecord,
} from './raw-http-types';

export interface HttpCaptureSelection {
  readonly captureSha256: string;
  readonly shardIndex: number;
}

/**
 * Plain independent inputs from the admitted supervisor/activation path. Copying a decoded raw
 * context here proves no authorship. The Owner canonical sink and that composition are a separate
 * slice; absence of these inputs must never fall back to the raw record's own assertions.
 */
export interface P1HttpAdmission {
  readonly context: HostedHttpContext;
  readonly activationPublicationSha256: string;
  readonly endpoint: Readonly<{ address: '127.0.0.1'; port: number }>;
  readonly hosted: Readonly<{ runtimeInstanceId: string; configGeneration: string }>;
  readonly timeline: HttpCaptureSelection;
  readonly effects: HttpCaptureSelection;
}

export interface P1HttpExchange {
  readonly requestRecordId: string;
  readonly responseRecordId: string | null;
  readonly failureRecordIds: readonly string[];
  readonly ownerExchangeNonce: string;
  readonly context: HostedHttpContext;
  readonly activationPublicationSha256: string;
  readonly operationNonce: string | null;
  readonly status: 'joined' | 'unjoined';
  readonly problem: string | null;
  readonly facts: readonly OpenCodeFact[];
  readonly terminal: 'applied' | 'condition-rejected' | 'uncertain';
  readonly appliedReceipt: AppliedHttpReceipt | null;
}

export interface P1JointResult {
  readonly status: 'joined' | 'incomplete';
  readonly controllerNonce: string;
  readonly runId: string;
  readonly ledgerSha256: string;
  readonly recordIds: readonly string[];
  readonly exchanges: readonly P1HttpExchange[];
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
  httpCheck(matches.length === 1, 'admitted_shard');
  return matches[0]!;
}

function bindAdmission(
  admission: P1HttpAdmission,
  shards: readonly NativeCaptureShard[],
  outcome: SupervisorOutcome
) {
  const context = snapshotHttpContext(admission.context);
  httpCheck(httpHex(admission.activationPublicationSha256), 'activation_publication');
  httpCheck(
    admission.endpoint.address === '127.0.0.1' &&
      Number.isSafeInteger(admission.endpoint.port) &&
      admission.endpoint.port > 0 &&
      admission.endpoint.port <= 65535,
    'admitted_endpoint'
  );
  httpCheck(
    /^runtime_instance_[0-9a-f]{32}$/u.test(admission.hosted.runtimeInstanceId) &&
      /^config_generation_[0-9a-f]{32}$/u.test(admission.hosted.configGeneration),
    'admitted_hosted'
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
    'admission_run'
  );
  const timeline = selectedShard(shards, 'openCodeTimelinePath', admission.timeline);
  const effects = selectedShard(shards, 'protectedEffectLedgerPath', admission.effects);
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
    'admitted_producer'
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
  return { admission, owner, producer: first.producer, activation: first.activation };
}

function assertCompleteHttpSelection(
  ledger: Buffer,
  records: readonly LocatedHttpRawRecord[]
): void {
  httpCheck(
    ledger.length > 0 && ledger.length <= HTTP_LIMITS.ledger && ledger.at(-1) === 0x0a,
    'ledger_frame'
  );
  const selected = new Set(records.map(({ byteStart, byteEnd }) => `${byteStart}:${byteEnd}`));
  let byteStart = 0;
  while (byteStart < ledger.length) {
    const byteEnd = ledger.indexOf(0x0a, byteStart);
    httpCheck(byteEnd >= byteStart && byteEnd - byteStart + 1 <= HTTP_LIMITS.line, 'ledger_line');
    const outer = parseHttpCanonical(
      ledger.subarray(byteStart, byteEnd),
      'selection_outer'
    ) as Record<string, unknown>;
    const payload = parseHttpCanonical(
      decodeHttpBase64(outer.payloadBase64, HTTP_LIMITS.payload, 'selection_payload'),
      'selection_payload'
    ) as Record<string, unknown>;
    httpCheck(
      selected.has(`${byteStart}:${byteEnd}`) === (payload.kind === HTTP_OBSERVATION_KIND),
      'raw_selection_incomplete'
    );
    byteStart = byteEnd + 1;
  }
}

/** Joint results are usable P1 facts, never a final scenario/production qualification. */
export function verifyOpenCodeHttpEvidence(input: {
  readonly records: readonly LocatedHttpRawRecord[];
  readonly ledger: Buffer;
  readonly shards: readonly NativeCaptureShard[];
  readonly admissions: readonly P1HttpAdmission[];
  readonly outcome: SupervisorOutcome;
}): P1JointResult {
  const { outcome, records } = input;
  assertCompleteHttpSelection(input.ledger, records);
  const ledgerSha256 = sha256(input.ledger);
  httpCheck(
    outcome.rawFiles.opencode.sha256 === ledgerSha256 &&
      outcome.rawFiles.opencode.size === input.ledger.length,
    'ledger_binding'
  );
  const admissions = new Map<string, ReturnType<typeof bindAdmission>>();
  for (const admission of input.admissions) {
    const key = canonicalJson(admission.context);
    httpCheck(!admissions.has(key), 'duplicate_admission');
    admissions.set(key, bindAdmission(admission, input.shards, outcome));
  }
  const requests = new Map<string, RequestRecord>();
  const responses = new Map<string, ResponseRecord>();
  const failures = new Map<string, string[]>();
  const unboundFailures: string[] = [];
  const recordIds = new Set<string>();
  const exchanges = new Set<string>();
  let previousSequence = 0;
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
    const decoded = decodeHttpRecord(payload as Record<string, unknown>);
    httpCheck(canonicalJson(decoded) === canonicalJson(record.http), 'raw_fact_content');
    assertHttpOuterBinding(record, decoded);
    httpCheck(!recordIds.has(record.recordId), 'duplicate_record');
    recordIds.add(record.recordId);
    const bound = admissions.get(canonicalJson(record.http.context));
    httpCheck(bound, 'admission_missing');
    httpCheck(
      outcome.rawFiles.opencode.producerStartTokens.includes(record.processStartToken) &&
        record.processStartToken === bound.owner.startToken &&
        BigInt(record.monotonicNs) > BigInt(bound.owner.observedMonotonicNs),
      'recorder_start'
    );
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
        canonicalJson(request.http.context) === canonicalJson(record.http.context),
      'exchange_snapshot'
    );
    if (observation.phase === 'exchange-failed') {
      failures.set(requestId, [...(failures.get(requestId) ?? []), record.recordId]);
    } else {
      httpCheck(!responses.has(requestId), 'duplicate_response');
      httpCheck(
        observation.connectedPeer.remoteAddress === bound.admission.endpoint.address &&
          observation.connectedPeer.remotePort === bound.admission.endpoint.port,
        'connected_endpoint'
      );
      responses.set(requestId, record as ResponseRecord);
    }
  }
  const index = buildOpenCodeOperationIndex(input.shards);
  const consumed = new Set<string>();
  const claimedGroups = new Set<string>();
  const results: P1HttpExchange[] = [];
  for (const [requestId, record] of requests) {
    const request = record.http.observation;
    const bound = admissions.get(canonicalJson(record.http.context))!;
    const responseRecord = responses.get(requestId);
    const response = responseRecord?.http.observation;
    const headers = response && httpHeaderStatus(response.responseHeaders);
    let receipt =
      response && headers?.identityEncoding ? appliedHttpReceipt(request, response) : null;
    if (
      receipt &&
      (receipt.runtimeInstanceId !== bound.admission.hosted.runtimeInstanceId ||
        receipt.configGeneration !== bound.admission.hosted.configGeneration)
    )
      receipt = null;
    let problem: string | null = null;
    let facts: readonly OpenCodeFact[] = [];
    let terminal: P1HttpExchange['terminal'] = receipt ? 'applied' : 'uncertain';
    try {
      httpCheck(response, 'missing_response');
      httpCheck(response.complete, 'incomplete_response');
      httpCheck(headers?.identityEncoding, 'response_encoding');
      httpCheck(headers.nonceStatus === 'present' && response.peerOperationNonce, 'response_nonce');
      const key = operationKey(bound.producer, bound.activation, response.peerOperationNonce);
      httpCheck(!claimedGroups.has(key), 'operation_reused');
      claimedGroups.add(key);
      const group = index.get(key);
      httpCheck(group, 'native_operation_missing');
      for (const fact of group.facts) {
        const selection =
          fact.locator.stream === 'openCodeTimeline'
            ? bound.admission.timeline
            : bound.admission.effects;
        httpCheck(
          fact.locator.captureSha256 === selection.captureSha256 &&
            fact.locator.shardIndex === selection.shardIndex &&
            !consumed.has(canonicalJson(fact.locator)),
          'native_fact_binding'
        );
      }
      joinHttpOperationBody(group, request, response, bound.admission.hosted);
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
        activationPublicationSha256: bound.admission.activationPublicationSha256,
        operationNonce: response?.peerOperationNonce ?? null,
        status: problem === null ? 'joined' : 'unjoined',
        problem,
        facts,
        terminal,
        appliedReceipt: receipt,
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
      results.length > 0 &&
      results.every((result) => result.status === 'joined') &&
      unboundFailures.length === 0 &&
      unmatchedNativeFacts.length === 0
        ? 'joined'
        : 'incomplete',
    controllerNonce: outcome.controllerNonce,
    runId: outcome.runId,
    ledgerSha256,
    recordIds: Object.freeze([...recordIds]),
    exchanges: Object.freeze(results),
    unboundFailureRecordIds: Object.freeze(unboundFailures),
    unmatchedNativeFacts: Object.freeze(unmatchedNativeFacts),
    nativeProblems: Object.freeze(nativeProblems),
  });
}

/** Preserves the existing missing Owner semantic gate while handing P1 facts to shared assembly. */
export class P1ScenarioEvidencePending extends Error {
  readonly missing = Object.freeze([
    'owner-wal-disk-custody-and-verified-native-corpus',
    'native-scenario-derivation-without-legacy-effect-total-rows',
  ]);

  constructor(readonly p1: P1JointResult) {
    super('p3c_runtime_capture_semantic_mapping_unavailable:ownerWalTimelinePath');
    this.name = 'P1ScenarioEvidencePending';
  }
}
