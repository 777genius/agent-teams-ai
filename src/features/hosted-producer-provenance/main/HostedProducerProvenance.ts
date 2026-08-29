import { createHash } from 'node:crypto';

import {
  HOSTED_PRODUCER_PROVENANCE_CONTRACT,
  HOSTED_PRODUCER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_PRODUCER_PROVENANCE_ENV,
  HOSTED_PRODUCER_PROVENANCE_VERSION,
  type HostedProducerNativeRecord,
  type HostedProducerProvenanceDescriptorContract,
  type HostedProducerProvenanceEnvironmentContract,
  type HostedProducerProvenanceRole,
  type HostedProducerProvenanceStream,
} from '../contracts';
import producerProvenanceContractArtifact from '../contracts/hosted-producer-provenance-v2.schema.json?raw';
import {
  defaultHostedProducerProvenanceOperations,
  type HostedProducerDerivedIdentity,
  type HostedProducerProvenanceOperations,
} from './HostedProducerProvenanceOperations';
import {
  fatalProvenanceError,
  HostedProducerProvenanceFatalError,
  poisonInstalledProductProvenance,
} from './HostedProducerProvenanceRegistry';
const HEX_64 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const SAFE_RECORD_TYPE = /^[a-z][a-z0-9-]{0,95}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const APPROVAL_ID = /^approval_[0-9a-f]{32}$/u;
const APPROVAL_GENERATION = /^generation_runtime-permission-[0-9a-f]{64}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const TEAM_RUN_ID = /^team-run_[0-9a-f]{32}$/u;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_CONTRACT_BYTES = 128 * 1024;

const IMPLEMENTATION_IDS = Object.freeze({
  browser: 'agent-teams.product.browser-observer.v1',
  opencode: 'agent-teams.opencode.hosted-approval.v1',
  owner: 'agent-teams.orchestrator.hosted-approval-owner.v1',
  'product-producer': 'agent-teams.product.hosted-approval.v1',
} as const satisfies Readonly<Record<HostedProducerProvenanceRole, string>>);

const ROLE_STREAMS = Object.freeze({
  browser: Object.freeze({ negativeResults: 9 }),
  opencode: Object.freeze({ openCodeTimeline: 9, protectedEffectLedger: 10 }),
  owner: Object.freeze({ ownerWalTimeline: 9 }),
  'product-producer': Object.freeze({ conditionalPostLedger: 9, productTimeline: 10 }),
} satisfies Readonly<Record<HostedProducerProvenanceRole, Readonly<Record<string, number>>>>);

export interface CreateHostedProducerProvenanceOptions {
  readonly role: HostedProducerProvenanceRole;
  /** Exact loaded Product entry/spec module whose bytes the supervisor admitted. */
  readonly modulePath: string;
  readonly operations?: HostedProducerProvenanceOperations;
  readonly onFailure?: (error: Error) => void;
}
export interface HostedProducerProvenance {
  readonly role: HostedProducerProvenanceRole;
  readonly controllerNonce: string;
  readonly runId: string;
  emit(stream: HostedProducerProvenanceStream, record: HostedProducerNativeRecord): void;
  poison(reason: string): never;
  bindInvalidation(invalidate: (error: Error) => void): void;
  close(): void;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('producer-provenance-native-json');
    return serialized;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('producer-provenance-native-json');
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('producer-provenance-native-json');
    return serialized;
  }
  if (typeof value !== 'object') throw new TypeError('producer-provenance-native-json');
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('producer-provenance-native-json');
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}
function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
const contractArtifact = Buffer.from(producerProvenanceContractArtifact, 'utf8');
const contractSha256 = sha256(contractArtifact);
if (
  contractArtifact.byteLength !== 54_393 ||
  contractSha256 !== HOSTED_PRODUCER_PROVENANCE_CONTRACT_SHA256
) {
  throw new Error('producer-provenance-schema-digest-mismatch');
}
function exactObject(
  value: unknown,
  keys: readonly string[],
  reason: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(reason);
  }
  const item = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(item);
  if (
    actual.some((key) => typeof key !== 'string') ||
    [...(actual as string[])]
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      .join('\0') !==
      [...keys].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))).join('\0')
  ) {
    throw new TypeError(reason);
  }
  return item;
}
function parseDescriptor(value: unknown, fd: number): HostedProducerProvenanceDescriptorContract {
  const descriptor = exactObject(
    value,
    ['fd', 'device', 'inode'],
    'producer-provenance-descriptor'
  );
  if (
    descriptor.fd !== fd ||
    typeof descriptor.device !== 'string' ||
    !DECIMAL.test(descriptor.device) ||
    typeof descriptor.inode !== 'string' ||
    !DECIMAL.test(descriptor.inode)
  ) {
    throw new TypeError('producer-provenance-descriptor');
  }
  return Object.freeze({
    fd,
    device: descriptor.device,
    inode: descriptor.inode,
  });
}
function safeByteCount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 64 * 1024 * 1024
  );
}
function validProductInstance(native: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof native.bootId === 'string' &&
    SAFE_ID.test(native.bootId) &&
    typeof native.deploymentId === 'string' &&
    SAFE_ID.test(native.deploymentId) &&
    typeof native.ownerAuthority === 'string' &&
    SAFE_ID.test(native.ownerAuthority) &&
    Number.isSafeInteger(native.ownerGeneration) &&
    (native.ownerGeneration as number) >= 1 &&
    typeof native.ownerSessionId === 'string' &&
    SAFE_ID.test(native.ownerSessionId)
  );
}

const HTTP_OUTCOMES = Object.freeze({
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
} as const);

function validHttpOutcome(route: unknown, outcome: unknown, status: unknown): boolean {
  if (typeof route !== 'string' || typeof outcome !== 'string') return false;
  const outcomes = HTTP_OUTCOMES[route as keyof typeof HTTP_OUTCOMES];
  return (
    outcomes !== undefined && (outcomes as Readonly<Record<string, number>>)[outcome] === status
  );
}

function validSseIdentity(frameKind: unknown, eventId: unknown, eventType: unknown): boolean {
  if (frameKind === 'heartbeat') return eventId === null && eventType === null;
  if (frameKind === 'resync_required') return eventId === null && eventType === 'resync_required';
  return (
    frameKind === 'coordination_event' &&
    typeof eventId === 'string' &&
    SAFE_ID.test(eventId) &&
    typeof eventType === 'string' &&
    SAFE_ID.test(eventType)
  );
}
function validBrowserVariant(outcome: unknown, family: unknown): boolean {
  return (
    (outcome === 'cross_team_list_rejected' && family === 'approval-page') ||
    (outcome === 'cross_team_preview_rejected' && family === 'approval-preview') ||
    (outcome === 'cross_team_decide_rejected' && family === 'approval-decision')
  );
}

function validateNativeRecord(
  stream: HostedProducerProvenanceStream,
  record: HostedProducerNativeRecord
): void {
  if (!SAFE_RECORD_TYPE.test(record.recordType)) {
    throw new TypeError('producer-provenance-record-type');
  }
  const native = record.native as Readonly<Record<string, unknown>>;
  switch (record.recordType) {
    case 'approval-http-unadmitted-response-finalized': {
      exactObject(
        native,
        [
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
        ],
        'producer-provenance-native-http-unadmitted'
      );
      if (
        stream !== 'productTimeline' ||
        !validProductInstance(native) ||
        native.method !== 'POST' ||
        native.outcome !== 'unadmitted' ||
        !safeByteCount(native.requestBodyBytes) ||
        typeof native.requestBodySha256 !== 'string' ||
        !HEX_64.test(native.requestBodySha256) ||
        !safeByteCount(native.responseBodyBytes) ||
        typeof native.responseBodySha256 !== 'string' ||
        !HEX_64.test(native.responseBodySha256) ||
        typeof native.routeId !== 'string' ||
        ![
          'team-approvals.page.v1',
          'team-approvals.preview.v1',
          'team-approvals.decision.v1',
        ].includes(native.routeId) ||
        native.status !== 503
      ) {
        throw new TypeError('producer-provenance-native-http-unadmitted');
      }
      return;
    }
    case 'decision-compare-and-claim-verified': {
      exactObject(
        native,
        [
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
        ],
        'producer-provenance-native-decision'
      );
      if (
        stream !== 'conditionalPostLedger' ||
        !validProductInstance(native) ||
        typeof native.actorId !== 'string' ||
        !SAFE_ID.test(native.actorId) ||
        typeof native.approvalId !== 'string' ||
        !APPROVAL_ID.test(native.approvalId) ||
        typeof native.bootId !== 'string' ||
        !SAFE_ID.test(native.bootId) ||
        (native.decision !== 'allow' && native.decision !== 'deny') ||
        typeof native.deploymentId !== 'string' ||
        !SAFE_ID.test(native.deploymentId) ||
        typeof native.generationId !== 'string' ||
        !APPROVAL_GENERATION.test(native.generationId) ||
        typeof native.idempotencyKeySha256 !== 'string' ||
        !HEX_64.test(native.idempotencyKeySha256) ||
        (native.outcome !== 'committed' && native.outcome !== 'idempotent_replay') ||
        typeof native.requestId !== 'string' ||
        !SAFE_ID.test(native.requestId) ||
        typeof native.sessionId !== 'string' ||
        !SAFE_ID.test(native.sessionId) ||
        typeof native.targetTeamId !== 'string' ||
        !TEAM_ID.test(native.targetTeamId) ||
        typeof native.targetTeamRunId !== 'string' ||
        !TEAM_RUN_ID.test(native.targetTeamRunId)
      ) {
        throw new TypeError('producer-provenance-native-decision');
      }
      return;
    }
    case 'approval-http-response-finalized': {
      exactObject(
        native,
        [
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
        ],
        'producer-provenance-native-http'
      );
      if (
        stream !== 'productTimeline' ||
        !validProductInstance(native) ||
        typeof native.actorId !== 'string' ||
        !SAFE_ID.test(native.actorId) ||
        typeof native.bootId !== 'string' ||
        !SAFE_ID.test(native.bootId) ||
        typeof native.deploymentId !== 'string' ||
        !SAFE_ID.test(native.deploymentId) ||
        native.method !== 'POST' ||
        !safeByteCount(native.requestBodyBytes) ||
        typeof native.requestBodySha256 !== 'string' ||
        !HEX_64.test(native.requestBodySha256) ||
        typeof native.requestId !== 'string' ||
        !SAFE_ID.test(native.requestId) ||
        !safeByteCount(native.responseBodyBytes) ||
        typeof native.responseBodySha256 !== 'string' ||
        !HEX_64.test(native.responseBodySha256) ||
        typeof native.routeId !== 'string' ||
        ![
          'team-approvals.page.v1',
          'team-approvals.preview.v1',
          'team-approvals.decision.v1',
        ].includes(native.routeId) ||
        typeof native.sessionId !== 'string' ||
        !SAFE_ID.test(native.sessionId) ||
        !validHttpOutcome(native.routeId, native.outcome, native.status)
      ) {
        throw new TypeError('producer-provenance-native-http');
      }
      return;
    }
    case 'coordination-sse-write-succeeded': {
      exactObject(
        native,
        [
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
        ],
        'producer-provenance-native-sse'
      );
      if (
        stream !== 'productTimeline' ||
        !validProductInstance(native) ||
        !safeByteCount(native.frameBytes) ||
        !validSseIdentity(native.frameKind, native.eventId, native.eventType) ||
        typeof native.frameSha256 !== 'string' ||
        !HEX_64.test(native.frameSha256)
      ) {
        throw new TypeError('producer-provenance-native-sse');
      }
      return;
    }
    case 'browser-negative-response-observed': {
      exactObject(
        native,
        [
          'actorTeamId',
          'harnessRunId',
          'httpStatus',
          'processStartToken',
          'observedOutcome',
          'requestBodySha256',
          'requestFamily',
          'responseBodySha256',
          'targetTeamId',
          'targetTeamRunId',
        ],
        'producer-provenance-native-browser-negative'
      );
      if (
        stream !== 'negativeResults' ||
        typeof native.actorTeamId !== 'string' ||
        !TEAM_ID.test(native.actorTeamId) ||
        typeof native.harnessRunId !== 'string' ||
        !HEX_64.test(native.harnessRunId) ||
        !Number.isSafeInteger(native.httpStatus) ||
        ![403, 404].includes(native.httpStatus as number) ||
        typeof native.processStartToken !== 'string' ||
        !HEX_64.test(native.processStartToken) ||
        !validBrowserVariant(native.observedOutcome, native.requestFamily) ||
        typeof native.requestBodySha256 !== 'string' ||
        !HEX_64.test(native.requestBodySha256) ||
        typeof native.responseBodySha256 !== 'string' ||
        !HEX_64.test(native.responseBodySha256) ||
        typeof native.targetTeamId !== 'string' ||
        !TEAM_ID.test(native.targetTeamId) ||
        typeof native.targetTeamRunId !== 'string' ||
        !TEAM_RUN_ID.test(native.targetTeamRunId)
      ) {
        throw new TypeError('producer-provenance-native-browser-negative');
      }
      return;
    }
    default:
      throw new TypeError('producer-provenance-native-record');
  }
}

export function parseHostedProducerProvenanceContract(
  source: string,
  expectedRole: HostedProducerProvenanceRole
): HostedProducerProvenanceEnvironmentContract {
  if (Buffer.byteLength(source) > MAX_CONTRACT_BYTES) {
    throw new TypeError('producer-provenance-contract-bounded');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError('producer-provenance-contract-json');
  }
  if (canonicalJson(parsed) !== source) {
    throw new TypeError('producer-provenance-contract-canonical');
  }
  const item = exactObject(
    parsed,
    [
      'activation',
      'contract',
      'contractSha256',
      'expectedProducer',
      'producerRole',
      'streams',
      'version',
    ],
    'producer-provenance-contract'
  );
  if (
    item.contract !== HOSTED_PRODUCER_PROVENANCE_CONTRACT ||
    item.version !== HOSTED_PRODUCER_PROVENANCE_VERSION ||
    item.contractSha256 !== contractSha256 ||
    item.producerRole !== expectedRole
  ) {
    throw new TypeError('producer-provenance-contract');
  }
  const activation = exactObject(
    item.activation,
    ['controllerNonce', 'runId', 'stackManifestSha256'],
    'producer-provenance-activation'
  );
  const expectedProducer = exactObject(
    item.expectedProducer,
    ['artifactManifestSha256', 'executableSha256', 'implementationId', 'moduleSha256'],
    'producer-provenance-expected-producer'
  );
  if (
    typeof activation.controllerNonce !== 'string' ||
    !HEX_64.test(activation.controllerNonce) ||
    typeof activation.runId !== 'string' ||
    !SAFE_ID.test(activation.runId) ||
    typeof activation.stackManifestSha256 !== 'string' ||
    !HEX_64.test(activation.stackManifestSha256) ||
    typeof expectedProducer.artifactManifestSha256 !== 'string' ||
    !HEX_64.test(expectedProducer.artifactManifestSha256) ||
    typeof expectedProducer.executableSha256 !== 'string' ||
    !HEX_64.test(expectedProducer.executableSha256) ||
    expectedProducer.implementationId !== IMPLEMENTATION_IDS[expectedRole] ||
    typeof expectedProducer.moduleSha256 !== 'string' ||
    !HEX_64.test(expectedProducer.moduleSha256)
  ) {
    throw new TypeError('producer-provenance-contract');
  }
  const expectedStreams = ROLE_STREAMS[expectedRole];
  const streams = exactObject(
    item.streams,
    Object.keys(expectedStreams),
    'producer-provenance-streams'
  );
  const parsedStreams = Object.fromEntries(
    Object.entries(expectedStreams).map(([stream, fd]) => [
      stream,
      parseDescriptor(streams[stream], fd),
    ])
  ) as Partial<Record<HostedProducerProvenanceStream, HostedProducerProvenanceDescriptorContract>>;
  const descriptorIdentities = Object.values(parsedStreams).map(
    (descriptor) => `${descriptor!.device}:${descriptor!.inode}`
  );
  if (new Set(descriptorIdentities).size !== descriptorIdentities.length) {
    throw new TypeError('producer-provenance-descriptor-alias');
  }
  return Object.freeze({
    activation: Object.freeze({
      controllerNonce: activation.controllerNonce,
      runId: activation.runId,
      stackManifestSha256: activation.stackManifestSha256,
    }),
    contract: HOSTED_PRODUCER_PROVENANCE_CONTRACT,
    version: HOSTED_PRODUCER_PROVENANCE_VERSION,
    contractSha256,
    expectedProducer: Object.freeze({
      artifactManifestSha256: expectedProducer.artifactManifestSha256,
      executableSha256: expectedProducer.executableSha256,
      implementationId: expectedProducer.implementationId as string,
      moduleSha256: expectedProducer.moduleSha256,
    }),
    producerRole: expectedRole,
    streams: Object.freeze(parsedStreams),
  });
}

class NativeHostedProducerProvenance implements HostedProducerProvenance {
  readonly role: HostedProducerProvenanceRole;
  readonly controllerNonce: string;
  readonly runId: string;
  private readonly previousLineHashes = new Map<HostedProducerProvenanceStream, string>();
  private readonly sequences = new Map<HostedProducerProvenanceStream, number>();
  private invalidation: ((error: Error) => void) | null = null;
  private failed = false;
  private fatalError: HostedProducerProvenanceFatalError | null = null;
  private closing = false;
  private closed = false;

  constructor(
    private readonly contract: HostedProducerProvenanceEnvironmentContract,
    private readonly identity: HostedProducerDerivedIdentity,
    private readonly operations: HostedProducerProvenanceOperations,
    private readonly onFailure?: (error: Error) => void
  ) {
    this.role = contract.producerRole;
    this.controllerNonce = contract.activation.controllerNonce;
    this.runId = contract.activation.runId;
    for (const stream of Object.keys(contract.streams) as HostedProducerProvenanceStream[]) {
      this.writeRecord(stream, 'producer-open', null, {
        descriptor: {
          device: contract.streams[stream]!.device,
          fd: contract.streams[stream]!.fd,
          inode: contract.streams[stream]!.inode,
        },
      });
    }
  }

  emit(stream: HostedProducerProvenanceStream, record: HostedProducerNativeRecord): void {
    try {
      validateNativeRecord(stream, record);
      if (!HEX_64.test(record.operationNonce)) {
        throw new TypeError('producer-provenance-operation-nonce');
      }
      this.writeRecord(
        stream,
        record.recordType,
        record.operationNonce,
        record.native as Readonly<Record<string, unknown>>
      );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('producer-provenance-native-record'));
    }
  }

  bindInvalidation(invalidate: (error: Error) => void): void {
    if (this.invalidation !== null) throw new Error('producer-provenance-invalidation-bound');
    this.invalidation = invalidate;
    if (this.fatalError !== null) invalidate(this.fatalError);
  }

  poison(reason: string): never {
    return this.fail(new TypeError(reason));
  }

  close(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    let firstError: Error | null = null;
    for (const [stream, descriptor] of Object.entries(this.contract.streams)) {
      if (descriptor === undefined) continue;
      if (!this.failed) {
        try {
          this.writeRecord(stream as HostedProducerProvenanceStream, 'producer-close', null, {});
        } catch (error) {
          firstError ??= error instanceof Error ? error : new Error('producer-provenance-close');
        }
      }
      try {
        this.operations.sync(descriptor.fd);
      } catch (error) {
        firstError ??= error instanceof Error ? error : new Error('producer-provenance-close');
      }
      try {
        this.operations.close(descriptor.fd);
      } catch (error) {
        firstError ??= error instanceof Error ? error : new Error('producer-provenance-close');
      }
    }
    this.closed = true;
    this.closing = false;
    if (firstError !== null) this.fail(firstError);
  }

  private writeRecord(
    stream: HostedProducerProvenanceStream,
    recordType: string,
    operationNonce: string | null,
    native: Readonly<Record<string, unknown>>
  ): void {
    if (this.fatalError !== null) throw this.fatalError;
    if (this.closed) {
      throw new HostedProducerProvenanceFatalError('producer-provenance-writer-closed');
    }
    const descriptor = this.contract.streams[stream];
    if (descriptor === undefined) throw new TypeError('producer-provenance-stream-not-owned');
    const sequence = this.sequences.get(stream) ?? 0;
    let line: string;
    try {
      const emissionNonce = this.operations.randomNonce();
      if (!HEX_64.test(emissionNonce)) {
        throw new TypeError('producer-provenance-emission-nonce');
      }
      line = `${canonicalJson({
        activation: {
          controllerNonce: this.controllerNonce,
          runId: this.runId,
          stackManifestSha256: this.contract.activation.stackManifestSha256,
        },
        contract: HOSTED_PRODUCER_PROVENANCE_CONTRACT,
        contractSha256,
        emissionNonce,
        native,
        operationNonce,
        previousRecordSha256: this.previousLineHashes.get(stream) ?? null,
        producer: {
          artifactManifestSha256: this.contract.expectedProducer.artifactManifestSha256,
          exeDev: this.identity.exeDevice,
          exeIno: this.identity.exeInode,
          exeSha256: this.identity.exeSha256,
          implementationId: this.contract.expectedProducer.implementationId,
          moduleSha256: this.identity.moduleSha256,
          pid: this.identity.pid,
          role: this.role,
          startTicks: this.identity.startTicks,
        },
        recordType,
        sequence,
        stream,
        version: HOSTED_PRODUCER_PROVENANCE_VERSION,
      })}\n`;
      const bytes = Buffer.from(line);
      if (bytes.byteLength > MAX_LINE_BYTES) {
        throw new RangeError('producer-provenance-line-bounded');
      }
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = this.operations.write(descriptor.fd, bytes, offset);
        if (!Number.isSafeInteger(written) || written < 1 || offset + written > bytes.byteLength) {
          throw new Error('producer-provenance-short-write');
        }
        offset += written;
      }
      this.operations.sync(descriptor.fd);
      this.previousLineHashes.set(stream, sha256(bytes));
      this.sequences.set(stream, sequence + 1);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('producer-provenance-write'));
    }
  }

  private fail(error: Error): never {
    const fatal = fatalProvenanceError(error);
    if (!this.failed) {
      this.failed = true;
      this.fatalError = fatal;
      poisonInstalledProductProvenance(this, fatal);
      try {
        this.onFailure?.(fatal);
      } catch {
        // Preserve the native capture failure while still invalidating the hosted surface.
      }
      try {
        this.invalidation?.(fatal);
      } catch {
        // Invalidation is best-effort cleanup; the capture error remains authoritative.
      }
    }
    throw this.fatalError ?? fatal;
  }
}

export function createHostedProducerProvenanceFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  options: CreateHostedProducerProvenanceOptions
): HostedProducerProvenance | null {
  const source = environment[HOSTED_PRODUCER_PROVENANCE_ENV];
  if (source === undefined) return null;
  const contract = parseHostedProducerProvenanceContract(source, options.role);
  const operations = options.operations ?? defaultHostedProducerProvenanceOperations();
  try {
    const identity = operations.deriveIdentity(options.modulePath);
    if (
      identity.pid !== process.pid ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid < 1 ||
      !DECIMAL.test(identity.startTicks) ||
      !DECIMAL.test(identity.exeDevice) ||
      !DECIMAL.test(identity.exeInode) ||
      !DECIMAL.test(identity.moduleDevice) ||
      !DECIMAL.test(identity.moduleInode) ||
      !HEX_64.test(identity.exeSha256) ||
      identity.moduleSha256 !== contract.expectedProducer.moduleSha256 ||
      identity.exeSha256 !== contract.expectedProducer.executableSha256
    ) {
      throw new TypeError('producer-provenance-producer-identity');
    }
    for (const descriptor of Object.values(contract.streams)) {
      if (descriptor === undefined) continue;
      const observed = operations.descriptorIdentity(descriptor.fd);
      if (
        !observed.regularFile ||
        !observed.append ||
        !observed.writeOnly ||
        observed.mode !== 0o600 ||
        observed.nlink !== '1' ||
        observed.size !== '0' ||
        observed.device !== descriptor.device ||
        observed.inode !== descriptor.inode
      ) {
        throw new TypeError('producer-provenance-descriptor-identity');
      }
    }
    return new NativeHostedProducerProvenance(contract, identity, operations, options.onFailure);
  } catch (error) {
    for (const descriptor of Object.values(contract.streams)) {
      if (descriptor === undefined) continue;
      try {
        operations.close(descriptor.fd);
      } catch {
        // The initialization error is authoritative; every descriptor still gets a close attempt.
      }
    }
    throw error;
  }
}

export function createBrowserHostedProducerProvenanceFromEnvironment(
  environment: Record<string, string | undefined>,
  options: Omit<CreateHostedProducerProvenanceOptions, 'role'>
): HostedProducerProvenance | null {
  const provenance = createHostedProducerProvenanceFromEnvironment(environment, {
    ...options,
    role: 'browser',
  });
  if (provenance !== null) {
    // Chromium is launched after the spec module loads. Node child processes close
    // undeclared stdio FDs; removing the contract also prevents a descendant from
    // discovering and deliberately forwarding the runner-only FD9 capture slot.
    delete environment[HOSTED_PRODUCER_PROVENANCE_ENV];
  }
  return provenance;
}
