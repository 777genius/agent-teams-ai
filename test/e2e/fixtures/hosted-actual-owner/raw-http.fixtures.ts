import {
  canonicalJson,
  PRODUCER_PROVENANCE_CONTRACT,
  PRODUCER_PROVENANCE_CONTRACT_SHA256,
  RAW_ORIGINS,
  type RawOrigin,
  type RawRecord,
  RUNTIME_CAPTURE_NAMES,
  RUNTIME_CAPTURE_STREAMS,
  type RuntimeCaptureName,
  sha256,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  makeRawRecord,
  parseRawOrigin,
} from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import {
  type NativeCaptureRecord,
  parseKernelBoundNativeCaptures,
} from '../../../../scripts/e2e/hosted-actual-owner/native-captures';
import {
  correlateOpenCodeHttpEvidence,
  type P1HttpCorrelationInput,
} from '../../../../scripts/e2e/hosted-actual-owner/native-http-join';
import { snapshotHttpContext } from '../../../../scripts/e2e/hosted-actual-owner/raw-http';
import {
  type HostedHttpContext,
  type HostedHttpOperation,
  type HostedHttpRecord,
  HTTP_OBSERVATION_KIND,
  HTTP_OBSERVATION_PURPOSE,
  type HttpResponseObservation,
  type LocatedHttpRawRecord,
} from '../../../../scripts/e2e/hosted-actual-owner/raw-http-types';

import type {
  ProcessStartEvidence,
  ProducerCaptureShardEvidence,
  SupervisorOutcome,
} from '../../../../scripts/e2e/hosted-actual-owner/processes';

// Source-derived fixtures, not runtime evidence or qualification:
// OpenCode 8147af1b9e8564af8218e88fa92733a1b93b35b1:
// packages/opencode/src/server/routes/instance/httpapi/handlers/permission.ts:110-449
// packages/opencode/src/permission/index.ts:275-337
// packages/opencode/src/hosted-approval/provenance.ts:426-553
// Owner 1d1abaa100e24c9f5b94dcc4b63899bc474bece7:
// src/services/opencode/OpenCodeHostedRawRetention.ts and OpenCodeSupervisedHostCustody.ts.
// Envelopes reproduce the producer's per-stream sequence and LF hash chain. Branch payloads
// below preserve its actual nulls, omitted fields, body serialization and cross-stream emissions.
export const hex = (value: number) => value.toString(16).padStart(64, '0');
export const controllerNonce = hex(100);
export const runId = hex(101);
export const activation = { controllerNonce, runId, stackManifestSha256: hex(102) };
export const hosted = {
  runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
  configGeneration: `config_generation_${'2'.repeat(32)}`,
};
export const protocol = 'agent-teams-hosted-approval-v2';
export const body = (bytes: Buffer) => ({
  byteLength: bytes.length,
  bodyBase64: bytes.toString('base64'),
  sha256: sha256(bytes),
});

function start(role: ProcessStartEvidence['role'], pid: number): ProcessStartEvidence {
  return {
    role,
    pid,
    instanceId: `${role}-1`,
    generation: 1,
    restartBoundary: 'initial',
    pidfdInode: String(pid + 1000),
    startTime: String(pid + 2000),
    observedMonotonicNs: '1',
    startToken: hex(pid),
    parentStartToken: hex(250),
    observerStartToken: hex(250),
    executableDevice: '31',
    executableInode: String(pid + 3000),
    executableSha256: sha256(role),
    argvSha256: hex(210),
    cwdDevice: '71',
    cwdInode: '900',
  };
}
export const starts = [
  start('opencode', 201),
  start('owner', 202),
  start('product', 204),
  start('browser', 205),
];
export const owner = starts[1]!;
export const peer = starts[0]!;
export const supervisorStart = start('supervisor', 250);
export const context: HostedHttpContext = snapshotHttpContext({
  bootstrapV2HeaderSha256: hex(110),
  expectedHostSha256: hex(111),
  descriptorMapSha256: hex(112),
  captureId: hex(113),
  row: '02_browser_allow_deny',
  routeId: 'route_1',
  activation: {
    ...activation,
    bootstrapDigest: hex(114),
    admissionDocumentDigest: `sha256:${hex(115)}`,
    ownerArtifactDigest: `sha256:${hex(116)}`,
    ownerGeneration: 1,
    ownerSessionId: 'owner_session_1',
  },
  recorder: {
    role: 'owner',
    pid: owner.pid,
    startTicks: owner.startTime,
    processStartToken: owner.startToken,
    ownerGeneration: 1,
    ownerSessionId: 'owner_session_1',
  },
  expectedPeer: {
    pid: peer.pid,
    startTicks: peer.startTime,
    startIdentity: `start_${sha256(`${peer.pid}\0proc:${peer.startTime}`)}`,
    supervisorProcessStartToken: peer.startToken,
    pidNamespaceInode: '501',
    networkNamespaceInode: '502',
  },
});

export type NativeEmission = Pick<NativeCaptureRecord, 'recordType' | 'operationNonce' | 'native'>;
export interface OperationFixture {
  nonce: string;
  operation: HostedHttpOperation;
  requestBytes: Buffer;
  responseBytes: Buffer;
  status: number;
  timeline: NativeEmission[];
  effects: NativeEmission[];
}
export const replyOperation = (): Extract<HostedHttpOperation, { kind: 'reply' }> => ({
  kind: 'reply',
  sessionId: 'ses_1',
  requestId: 'per_1',
  ...hosted,
  sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
  requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
  permissionDigest: hex(120),
  decision: 'allow_once',
});

export function readOperation(
  kind: 'capability' | 'observe' | 'overflow',
  id = 1
): OperationFixture {
  const operation: HostedHttpOperation =
    kind === 'capability' ? { kind } : { kind: 'observe', sessionId: 'ses_1' };
  const value =
    kind === 'capability'
      ? { schemaVersion: 2, protocol, ...hosted, authentication: 'opencode-basic' }
      : kind === 'observe'
        ? { schemaVersion: 2, protocol, ...hosted, sessionId: 'ses_1', permissions: [] }
        : { _tag: 'InternalServerError' };
  const responseBytes = Buffer.from(JSON.stringify(value));
  const status = kind === 'overflow' ? 500 : 200;
  const native = {
    ...hosted,
    outcome: kind === 'overflow' ? 'overflow' : 'ok',
    status,
    responseSha256: sha256(responseBytes),
    ...(kind === 'capability'
      ? {}
      : { sessionId: 'ses_1', permissionCount: kind === 'overflow' ? 257 : 0 }),
  };
  return {
    nonce: hex(id),
    operation,
    requestBytes: Buffer.alloc(0),
    responseBytes,
    status,
    timeline: [
      {
        recordType: kind === 'capability' ? 'hosted-capability' : 'hosted-observe',
        operationNonce: hex(id),
        native,
      },
    ],
    effects: [],
  };
}

export function reply(
  outcome:
    | 'applied'
    | 'bad-request'
    | 'conflict'
    | 'precondition-failed'
    | 'unavailable'
    | 'body-read-failed'
    | 'invalid-json'
    | 'invalid-schema',
  id = 1,
  decision: 'allow_once' | 'reject' = 'allow_once'
): OperationFixture {
  const operation = { ...replyOperation(), decision };
  if (outcome === 'precondition-failed')
    operation.runtimeInstanceId = `runtime_instance_${'9'.repeat(32)}`;
  const submitted = {
    schemaVersion: 2,
    protocol,
    runtimeInstanceId: operation.runtimeInstanceId,
    expectedConfigGeneration: operation.configGeneration,
    requestId: outcome === 'bad-request' ? 'per_other' : operation.requestId,
    sessionId: operation.sessionId,
    sessionIncarnation: operation.sessionIncarnation,
    requestIncarnation: operation.requestIncarnation,
    expectedPermissionDigest: operation.permissionDigest,
    decision,
  };
  const requestBytes = Buffer.from(
    outcome === 'invalid-json'
      ? '{'
      : outcome === 'invalid-schema'
        ? '{}'
        : JSON.stringify(submitted)
  );
  const receipt = {
    schemaVersion: 2,
    protocol,
    status: 'applied',
    ...hosted,
    requestId: operation.requestId,
    sessionId: operation.sessionId,
    sessionIncarnation: operation.sessionIncarnation,
    requestIncarnation: operation.requestIncarnation,
    permissionDigest: operation.permissionDigest,
    decision,
  };
  const responseBytes =
    outcome === 'applied' ? Buffer.from(JSON.stringify(receipt)) : Buffer.alloc(0);
  const status =
    outcome === 'applied'
      ? 200
      : outcome === 'unavailable'
        ? 404
        : outcome === 'conflict'
          ? 409
          : outcome === 'precondition-failed'
            ? 412
            : 400;
  const identities =
    outcome === 'applied'
      ? {
          ...hosted,
          sessionIncarnation: operation.sessionIncarnation,
          requestIncarnation: operation.requestIncarnation,
        }
      : {
          runtimeInstanceId: null,
          configGeneration: null,
          sessionIncarnation: null,
          requestIncarnation: null,
        };
  const raw = {
    ...identities,
    outcome,
    status,
    sessionId: operation.sessionId,
    requestId: operation.requestId,
    responseSha256: sha256(responseBytes),
    requestBodySha256: ['unavailable', 'body-read-failed'].includes(outcome)
      ? null
      : sha256(requestBytes),
  };
  const typed = {
    ...identities,
    outcome,
    status,
    sessionId: submitted.sessionId,
    requestId: submitted.requestId,
    permissionDigest: submitted.expectedPermissionDigest,
    decision,
    ...(outcome === 'applied' ? { responseSha256: sha256(responseBytes) } : {}),
  };
  const emission = (recordType: string, native: Record<string, unknown>): NativeEmission => ({
    recordType,
    native,
    operationNonce: hex(id),
  });
  return {
    nonce: hex(id),
    operation,
    requestBytes,
    responseBytes,
    status,
    timeline: [
      emission('hosted-reply-raw', raw),
      ...(['applied', 'bad-request', 'conflict', 'precondition-failed'].includes(outcome)
        ? [emission('hosted-reply', typed)]
        : []),
    ],
    effects:
      outcome === 'applied'
        ? [
            emission('conditional-reply-effect', {
              ...hosted,
              sessionId: operation.sessionId,
              requestId: operation.requestId,
              sessionIncarnation: operation.sessionIncarnation,
              requestIncarnation: operation.requestIncarnation,
              permissionDigest: operation.permissionDigest,
              outcome,
              decision: decision === 'allow_once' ? 'once' : 'reject',
            }),
          ]
        : [],
  };
}

export function rawRecord(record: HostedHttpRecord, sequence: number): RawRecord {
  const recordBytes = Buffer.from(canonicalJson(record));
  const phase = record.observation.phase;
  return makeRawRecord({
    controllerNonce: record.context.activation.controllerNonce,
    origin: 'opencode',
    row: record.context.row,
    sequence,
    monotonicNs: String(sequence + 10),
    processStartToken: record.context.recorder.processStartToken,
    event:
      phase === 'request-retained'
        ? 'hosted_http_request_retained'
        : phase === 'response-retained'
          ? 'hosted_http_response_retained'
          : 'hosted_http_exchange_failed',
    correlation: record.observation.ownerExchangeNonce ?? record.context.captureId,
    effectCount: 0,
    payload: {
      kind: HTTP_OBSERVATION_KIND,
      recordBase64: recordBytes.toString('base64'),
      recordSha256: sha256(recordBytes),
    },
  });
}
export function recordData(record: RawRecord): HostedHttpRecord {
  const payload = JSON.parse(Buffer.from(record.payloadBase64, 'base64').toString('utf8'));
  return JSON.parse(Buffer.from(payload.recordBase64, 'base64').toString('utf8'));
}
export const ledger = (records: readonly RawRecord[]) =>
  Buffer.from(records.map((record) => `${canonicalJson(record)}\n`).join(''));

export function exchangeRecords(op: OperationFixture, offset = 0): RawRecord[] {
  const ownerExchangeNonce = sha256(`owner-exchange:${op.nonce}`);
  const path =
    op.operation.kind === 'capability'
      ? '/experimental/agent-teams/hosted-approval-capability'
      : `/experimental/agent-teams/hosted-approval/session/${op.operation.sessionId}/` +
        (op.operation.kind === 'observe'
          ? 'permissions'
          : `permission/${op.operation.requestId}/reply`);
  const request = rawRecord(
    {
      schemaVersion: 1,
      purpose: HTTP_OBSERVATION_PURPOSE,
      context,
      observation: {
        phase: 'request-retained',
        ownerExchangeNonce,
        operation: op.operation,
        method: op.operation.kind === 'reply' ? 'POST' : 'GET',
        path,
        body: body(op.requestBytes),
      },
    },
    offset + 1
  );
  return [
    request,
    rawRecord(
      {
        schemaVersion: 1,
        purpose: HTTP_OBSERVATION_PURPOSE,
        context,
        observation: {
          phase: 'response-retained',
          ownerExchangeNonce,
          requestRecordId: request.recordId,
          status: op.status,
          responseHeaders: [['x-agent-teams-hosted-operation-nonce', op.nonce]],
          peerOperationNonce: op.nonce,
          nonceStatus: 'present',
          connectedPeer: {
            localAddress: '127.0.0.1',
            localPort: 45000,
            remoteAddress: '127.0.0.1',
            remotePort: 4096,
          },
          body: body(op.responseBytes),
          complete: true,
        },
      },
      offset + 2
    ),
  ];
}
export function changeResponse(
  records: RawRecord[],
  patch: Partial<HttpResponseObservation>,
  index = 1
): void {
  const data = recordData(records[index]!);
  if (data.observation.phase !== 'response-retained') throw new Error('fixture response required');
  records[index] = rawRecord(
    { ...data, observation: { ...data.observation, ...patch } },
    index + 1
  );
}

// Exact writeRecord framing from provenance.ts, with deterministic test entropy and no I/O.
export function nativeCapture(
  name: RuntimeCaptureName,
  emissions: NativeEmission[],
  salt: string = name
) {
  const stream = RUNTIME_CAPTURE_STREAMS[name];
  const role =
    name === 'ownerWalTimelinePath'
      ? 'owner'
      : name === 'negativeResultsPath'
        ? 'browser'
        : ['openCodeTimelinePath', 'protectedEffectLedgerPath'].includes(name)
          ? 'opencode'
          : 'product-producer';
  const process = starts.find(
    (value) => value.role === (role === 'product-producer' ? 'product' : role)
  )!;
  const descriptor = {
    fd: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots[stream],
    device: '71',
    inode: String(9000 + RUNTIME_CAPTURE_NAMES.indexOf(name)),
  };
  const producer = {
    artifactManifestSha256: sha256(`${role}:artifact`),
    exeDev: process.executableDevice,
    exeIno: process.executableInode,
    exeSha256: process.executableSha256,
    implementationId:
      role === 'opencode'
        ? 'agent-teams.opencode.hosted-approval.v1'
        : role === 'owner'
          ? 'agent-teams.orchestrator.hosted-approval-owner.v1'
          : role === 'browser'
            ? 'agent-teams.product.browser-observer.v1'
            : 'agent-teams.product.hosted-approval.v1',
    moduleSha256: sha256(`${role}:module`),
    pid: process.pid,
    role,
    startTicks: process.startTime,
  };
  let previousRecordSha256: string | null = null;
  const records: NativeEmission[] = [
    { recordType: 'producer-open', operationNonce: null, native: { descriptor } },
    ...emissions,
    { recordType: 'producer-close', operationNonce: null, native: {} },
  ];
  const bytes = Buffer.from(
    records
      .map((record, sequence) => {
        const line = `${canonicalJson({
          activation,
          contract: PRODUCER_PROVENANCE_CONTRACT.contract,
          contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
          emissionNonce: sha256(`${salt}:${sequence}`),
          ...record,
          previousRecordSha256,
          producer,
          sequence,
          stream,
          version: 2,
        })}\n`;
        previousRecordSha256 = sha256(line);
        return line;
      })
      .join('')
  );
  // Unit-level kernel observations have explicit fixture identities. This factory cannot qualify a run.
  const shard = {
    authority: 'kernel-observed',
    path: `/sandbox/native/${name}.ndjson`,
    sha256: sha256(bytes),
    size: bytes.length,
    contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
    stream,
    captureDevice: descriptor.device,
    captureInode: descriptor.inode,
    producerPid: process.pid,
    producerStartToken: process.startToken,
    producerPidfdInode: process.pidfdInode,
    producerRole: process.role,
    producerFd: descriptor.fd,
    producerArtifactSha256: producer.artifactManifestSha256,
    producerModuleSha256: producer.moduleSha256,
  } as ProducerCaptureShardEvidence;
  return { bytes, shard };
}

export function fixture(operations: OperationFixture[] = [reply('applied')]) {
  const records = operations.flatMap((operation, index) => exchangeRecords(operation, index * 2));
  const raw = Object.fromEntries(
    RAW_ORIGINS.map((origin) => [
      origin,
      origin === 'opencode' ? ledger(records) : Buffer.from('unread legacy bytes\n'),
    ])
  ) as Record<RawOrigin, Buffer>;
  const capturePairs = Object.fromEntries(
    RUNTIME_CAPTURE_NAMES.map((name) => [
      name,
      nativeCapture(
        name,
        name === 'openCodeTimelinePath'
          ? operations.flatMap(({ timeline }) => timeline)
          : name === 'protectedEffectLedgerPath'
            ? operations.flatMap(({ effects }) => effects)
            : []
      ),
    ])
  ) as Record<RuntimeCaptureName, ReturnType<typeof nativeCapture>>;
  const captures = Object.fromEntries(
    RUNTIME_CAPTURE_NAMES.map((name) => [name, [capturePairs[name].bytes]])
  ) as Record<RuntimeCaptureName, Buffer[]>;
  const outcome = {
    controllerNonce,
    runId,
    starts,
    supervisorStart,
    zeroOwnedSurvivors: true,
    filesystem: { pidNamespaceInode: '501' },
    network: { namespaceInode: '502' },
    rawFiles: Object.fromEntries(
      RAW_ORIGINS.map((origin, index) => {
        const writer =
          origin === 'opencode' || origin === 'owner-wal'
            ? owner
            : origin === 'supervisor'
              ? supervisorStart
              : starts.find(
                  (value) => value.role === (origin === 'browser' ? 'browser' : 'product')
                )!;
        return [
          origin,
          {
            path: `/sandbox/raw/${origin}.ndjson`,
            size: raw[origin].length,
            sha256: sha256(raw[origin]),
            captureDevice: '81',
            captureInode: String(9500 + index),
            producerStartTokens: [writer.startToken],
            producerPidfdInodes: [writer.pidfdInode],
            parentCreatedExclusive: true,
            writerDescriptorsClosed: true,
            sealedBeforeParse: true,
          },
        ];
      })
    ),
    captureFiles: Object.fromEntries(
      RUNTIME_CAPTURE_NAMES.map((name) => [
        name,
        {
          stream: RUNTIME_CAPTURE_STREAMS[name],
          contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
          shards: [capturePairs[name].shard],
        },
      ])
    ),
  } as unknown as SupervisorOutcome;
  const correlations: P1HttpCorrelationInput[] = [
    {
      context,
      claimedActivationPublicationSha256: hex(130),
      endpoint: { address: '127.0.0.1', port: 4096 },
      hosted,
      timeline: { captureSha256: sha256(captures.openCodeTimelinePath[0]!), shardIndex: 0 },
      effects: { captureSha256: sha256(captures.protectedEffectLedgerPath[0]!), shardIndex: 0 },
    },
  ];
  return {
    records,
    raw,
    captures,
    outcome,
    correlations,
    controllerNonce,
    runId,
    cleanup: {
      disposition: 'removed' as const,
      markerVerified: true,
      zeroOwnedSurvivors: true,
      runId,
      reason: null,
      path: '/sandbox/fixture',
    },
  };
}
export type HttpFixture = ReturnType<typeof fixture>;
export function retainChanges(input: HttpFixture): void {
  input.raw.opencode = ledger(input.records);
  Object.assign(input.outcome.rawFiles.opencode, {
    size: input.raw.opencode.length,
    sha256: sha256(input.raw.opencode),
  });
}
export function joint(input: HttpFixture) {
  retainChanges(input);
  const parsed = parseKernelBoundNativeCaptures(input);
  return correlateOpenCodeHttpEvidence({
    records: parseRawOrigin(input.raw.opencode, 'opencode', controllerNonce).filter(
      (record): record is LocatedHttpRawRecord => record.kind === HTTP_OBSERVATION_KIND
    ),
    ledger: input.raw.opencode,
    shards: [...Object.values(parsed.shards).flat()],
    correlations: input.correlations,
    outcome: input.outcome,
  });
}
