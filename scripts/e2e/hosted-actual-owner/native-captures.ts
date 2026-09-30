import {
  OPENCODE_IDENTITIES,
  PRODUCER_PROVENANCE_CONTRACT,
  PRODUCER_PROVENANCE_CONTRACT_SHA256,
  RUNTIME_CAPTURE_NAMES,
  RUNTIME_CAPTURE_STREAMS,
  canonicalJson,
  exactRecord,
  sha256,
  validateRecordId,
  type RuntimeCaptureName,
} from './contracts';
import { CAPTURE_NATIVE_RECORD_TYPES, parseNativePayload } from './native-payload';
import type { ProducerCaptureFileEvidence, SupervisorOutcome } from './processes';

const CAPTURE_PRODUCER_ROLES = Object.freeze({
  conditionalPostLedgerPath: 'product-producer',
  negativeResultsPath: 'browser',
  openCodeTimelinePath: 'opencode',
  ownerWalTimelinePath: 'owner',
  productTimelinePath: 'product-producer',
  protectedEffectLedgerPath: 'opencode',
} as const satisfies Readonly<Record<RuntimeCaptureName, string>>);

const CAPTURE_IMPLEMENTATION_IDS = Object.freeze({
  conditionalPostLedgerPath: 'agent-teams.product.hosted-approval.v1',
  negativeResultsPath: 'agent-teams.product.browser-observer.v1',
  openCodeTimelinePath: 'agent-teams.opencode.hosted-approval.v1',
  ownerWalTimelinePath: 'agent-teams.orchestrator.hosted-approval-owner.v1',
  productTimelinePath: 'agent-teams.product.hosted-approval.v1',
  protectedEffectLedgerPath: 'agent-teams.opencode.hosted-approval.v1',
} as const satisfies Readonly<Record<RuntimeCaptureName, string>>);

export interface NativeCaptureRecord {
  readonly stream: (typeof RUNTIME_CAPTURE_STREAMS)[RuntimeCaptureName];
  readonly recordType: string;
  readonly sequence: number;
  readonly previousRecordSha256: string | null;
  readonly emissionNonce: string;
  readonly operationNonce: string | null;
  readonly producer: Readonly<{
    role: string;
    pid: number;
    startTicks: string;
    exeDev: string;
    exeIno: string;
    exeSha256: string;
    artifactManifestSha256: string;
    implementationId: string;
    moduleSha256: string;
  }>;
  readonly activation: Readonly<{
    controllerNonce: string;
    runId: string;
    stackManifestSha256: string;
  }>;
  readonly native: Readonly<Record<string, unknown>>;
  readonly lineSha256: string;
}

export interface ParsedNativeCapture {
  readonly producerRole: string;
  readonly semanticRecordCount: number;
  readonly records: readonly NativeCaptureRecord[];
  readonly finalLineSha256: string;
}

/**
 * Parses producer-authored r307 bytes without accepting raw observations or an expected serializer.
 * Fixed parser goldens may call this function, but parsing alone is never acceptance evidence.
 */
export function parseNativeRuntimeCapture(
  name: RuntimeCaptureName,
  bytes: Buffer,
  controllerNonce: string,
  runId: string,
  runNonces: Set<string> = new Set<string>()
): ParsedNativeCapture {
  if (bytes.length < 2 || bytes.length > 8 * 1024 * 1024 || bytes.at(-1) !== 0x0a) {
    throw new Error('p3c_runtime_capture_frame');
  }
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (source.includes('\r')) {
    throw new Error('p3c_runtime_capture_frame');
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.length < 2) throw new Error(`p3c_runtime_capture_empty_semantic_stream:${name}`);
  const records: NativeCaptureRecord[] = [];
  let previousLineSha256: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) + 1 > PRODUCER_PROVENANCE_CONTRACT.maximumLineBytes) {
      throw new Error('p3c_runtime_capture_line_too_large');
    }
    const parsed = JSON.parse(line) as unknown;
    if (canonicalJson(parsed) !== line) throw new Error('p3c_runtime_capture_noncanonical');
    const item = exactRecord(
      parsed,
      [
        'contract',
        'version',
        'contractSha256',
        'stream',
        'recordType',
        'sequence',
        'previousRecordSha256',
        'emissionNonce',
        'producer',
        'activation',
        'native',
        'operationNonce',
      ],
      `runtime_capture_${name}_record`
    );
    const producer = exactRecord(
      item.producer,
      [
        'role',
        'pid',
        'startTicks',
        'exeDev',
        'exeIno',
        'exeSha256',
        'artifactManifestSha256',
        'implementationId',
        'moduleSha256',
      ],
      `runtime_capture_${name}_producer`
    );
    const activation = exactRecord(
      item.activation,
      ['controllerNonce', 'runId', 'stackManifestSha256'],
      `runtime_capture_${name}_activation`
    );
    if (typeof item.recordType !== 'string') {
      throw new Error(`p3c_runtime_capture_binding:${name}:${index}`);
    }
    const native = parseNativePayload(name, item.recordType, item.native);
    const emissionNonce = validateRecordId(item.emissionNonce, 'native_emission_nonce');
    if (
      item.contract !== PRODUCER_PROVENANCE_CONTRACT.contract ||
      item.version !== PRODUCER_PROVENANCE_CONTRACT.version ||
      item.contractSha256 !== PRODUCER_PROVENANCE_CONTRACT_SHA256 ||
      item.stream !== RUNTIME_CAPTURE_STREAMS[name] ||
      item.sequence !== index ||
      item.previousRecordSha256 !== previousLineSha256 ||
      (index === 0 && item.recordType !== PRODUCER_PROVENANCE_CONTRACT.firstRecordType) ||
      (index > 0 && item.recordType === PRODUCER_PROVENANCE_CONTRACT.firstRecordType) ||
      (index === lines.length - 1 && item.recordType !== 'producer-close') ||
      (index > 0 &&
        index < lines.length - 1 &&
        !CAPTURE_NATIVE_RECORD_TYPES[name].includes(item.recordType as never)) ||
      (index === 0 || item.recordType === 'producer-close'
        ? item.operationNonce !== null
        : typeof item.operationNonce !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(item.operationNonce)) ||
      producer.role !== CAPTURE_PRODUCER_ROLES[name] ||
      producer.implementationId !== CAPTURE_IMPLEMENTATION_IDS[name] ||
      !Number.isSafeInteger(producer.pid) ||
      (producer.pid as number) < 2 ||
      activation.controllerNonce !== controllerNonce ||
      activation.runId !== runId ||
      typeof activation.stackManifestSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(activation.stackManifestSha256) ||
      !/^[a-z][a-z0-9-]{0,127}$/u.test(item.recordType) ||
      typeof producer.startTicks !== 'string' ||
      !/^(?:0|[1-9]\d*)$/u.test(producer.startTicks) ||
      typeof producer.exeDev !== 'string' ||
      !/^(?:0|[1-9]\d*)$/u.test(producer.exeDev) ||
      typeof producer.exeIno !== 'string' ||
      !/^(?:0|[1-9]\d*)$/u.test(producer.exeIno) ||
      [producer.exeSha256, producer.artifactManifestSha256, producer.moduleSha256].some(
        (digest) => typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)
      ) ||
      runNonces.has(emissionNonce)
    ) {
      throw new Error(`p3c_runtime_capture_binding:${name}:${index}`);
    }
    runNonces.add(emissionNonce);
    previousLineSha256 = sha256(`${line}\n`);
    records.push(
      Object.freeze({
        stream: item.stream as NativeCaptureRecord['stream'],
        recordType: item.recordType,
        sequence: index,
        previousRecordSha256: item.previousRecordSha256 as string | null,
        emissionNonce,
        operationNonce: item.operationNonce as string | null,
        producer: Object.freeze({
          role: producer.role as string,
          pid: producer.pid as number,
          startTicks: producer.startTicks as string,
          exeDev: producer.exeDev as string,
          exeIno: producer.exeIno as string,
          exeSha256: producer.exeSha256 as string,
          artifactManifestSha256: producer.artifactManifestSha256 as string,
          implementationId: producer.implementationId as string,
          moduleSha256: producer.moduleSha256 as string,
        }),
        activation: Object.freeze({
          controllerNonce,
          runId,
          stackManifestSha256: activation.stackManifestSha256 as string,
        }),
        native: Object.freeze(native),
        lineSha256: previousLineSha256,
      })
    );
  }
  return Object.freeze({
    producerRole: CAPTURE_PRODUCER_ROLES[name],
    semanticRecordCount: records.length - 2,
    records: Object.freeze(records),
    finalLineSha256: previousLineSha256!,
  });
}

function assertProducerCaptureFileEvidence(
  name: RuntimeCaptureName,
  expected: ProducerCaptureFileEvidence
): void {
  if (
    expected.stream !== RUNTIME_CAPTURE_STREAMS[name] ||
    expected.contractSha256 !== PRODUCER_PROVENANCE_CONTRACT_SHA256 ||
    expected.shards.length === 0 ||
    (name !== 'ownerWalTimelinePath' && expected.shards.length !== 1) ||
    new Set(expected.shards.map(({ path }) => path)).size !== expected.shards.length ||
    new Set(
      expected.shards.map(({ captureDevice, captureInode }) => `${captureDevice}:${captureInode}`)
    ).size !== expected.shards.length
  ) {
    throw new Error(`p3c_runtime_capture_producer_proof:${name}`);
  }
  if (
    (name === 'openCodeTimelinePath' || name === 'protectedEffectLedgerPath') &&
    expected.shards.some(
      ({ producerModuleSha256 }) =>
        producerModuleSha256 === OPENCODE_IDENTITIES.linuxX64BinarySha256
    )
  ) {
    throw new Error(`p3c_runtime_capture_old_opencode_artifact:${name}`);
  }
}

function assertNativeCaptureKernelBinding(
  name: RuntimeCaptureName,
  parsed: ParsedNativeCapture,
  shard: ProducerCaptureFileEvidence['shards'][number],
  outcome: SupervisorOutcome
): void {
  const observedProcess = outcome.starts.find(
    ({ pid, startToken }) => pid === shard.producerPid && startToken === shard.producerStartToken
  );
  if (observedProcess === undefined) {
    throw new Error(`p3c_runtime_capture_process_binding:${name}`);
  }
  const descriptor = parsed.records[0]?.native.descriptor as Record<string, unknown> | undefined;
  if (
    descriptor?.fd !== shard.producerFd ||
    descriptor.device !== shard.captureDevice ||
    descriptor.inode !== shard.captureInode ||
    observedProcess.pidfdInode !== shard.producerPidfdInode
  ) {
    throw new Error(`p3c_runtime_capture_descriptor_binding:${name}`);
  }
  for (const record of parsed.records) {
    if (
      canonicalJson(record.activation) !== canonicalJson(parsed.records[0]!.activation) ||
      record.producer.role !== CAPTURE_PRODUCER_ROLES[name] ||
      observedProcess.role !== shard.producerRole ||
      record.producer.pid !== observedProcess.pid ||
      record.producer.startTicks !== observedProcess.startTime ||
      record.producer.exeDev !== observedProcess.executableDevice ||
      record.producer.exeIno !== observedProcess.executableInode ||
      record.producer.exeSha256 !== observedProcess.executableSha256 ||
      record.producer.artifactManifestSha256 !== shard.producerArtifactSha256 ||
      record.producer.moduleSha256 !== shard.producerModuleSha256
    ) {
      throw new Error(`p3c_runtime_capture_process_binding:${name}:${record.sequence}`);
    }
  }
}

export interface NativeCaptureShard {
  readonly name: RuntimeCaptureName;
  readonly shardIndex: number;
  readonly captureSha256: string;
  readonly producerStartToken: string;
  readonly parsed: ParsedNativeCapture;
}

export interface NativeCaptureSummary {
  readonly sha256: string;
  readonly size: number;
  readonly shardCount: number;
  readonly shardSha256s: readonly string[];
  readonly producerRole: string;
  readonly semanticRecordCount: number;
}

/** Complete the run-wide emission and kernel pass before any semantic derivation. */
export function parseKernelBoundNativeCaptures(input: {
  readonly captures: Readonly<Record<RuntimeCaptureName, readonly Buffer[]>>;
  readonly controllerNonce: string;
  readonly runId: string;
  readonly outcome: SupervisorOutcome;
}): {
  readonly shards: Readonly<Record<RuntimeCaptureName, readonly NativeCaptureShard[]>>;
  readonly summaries: Readonly<Record<RuntimeCaptureName, NativeCaptureSummary>>;
} {
  if (
    input.controllerNonce !== input.outcome.controllerNonce ||
    input.runId !== input.outcome.runId
  ) {
    throw new Error('p3c_runtime_capture_run_binding');
  }
  const emissionNonces = new Set<string>();
  const shards = {} as Record<RuntimeCaptureName, readonly NativeCaptureShard[]>;
  const summaries = {} as Record<RuntimeCaptureName, NativeCaptureSummary>;
  for (const name of RUNTIME_CAPTURE_NAMES) {
    const expected = input.outcome.captureFiles[name];
    assertProducerCaptureFileEvidence(name, expected);
    const bytes = input.captures[name];
    if (bytes.length !== expected.shards.length || bytes.length === 0) {
      throw new Error('p3c_evidence_supervisor_capture_shard_disagreement');
    }
    shards[name] = Object.freeze(
      bytes.map((bytes, shardIndex) => {
        const shard = expected.shards[shardIndex]!;
        if (bytes.length !== shard.size || sha256(bytes) !== shard.sha256) {
          throw new Error('p3c_evidence_supervisor_capture_disagreement');
        }
        const parsed = parseNativeRuntimeCapture(
          name,
          bytes,
          input.controllerNonce,
          input.runId,
          emissionNonces
        );
        assertNativeCaptureKernelBinding(name, parsed, shard, input.outcome);
        return Object.freeze({
          name,
          shardIndex,
          captureSha256: shard.sha256,
          producerStartToken: shard.producerStartToken,
          parsed,
        });
      })
    );
    const shardSha256s = Object.freeze(expected.shards.map(({ sha256 }) => sha256));
    const semanticRecordCount = shards[name].reduce(
      (total, shard) => total + shard.parsed.semanticRecordCount,
      0
    );
    summaries[name] = Object.freeze({
      sha256: sha256(
        `agent-teams.p3c.logical-native-capture/v1\0${name}\0${canonicalJson(shardSha256s)}`
      ),
      size: expected.shards.reduce((total, shard) => total + shard.size, 0),
      shardCount: shards[name].length,
      shardSha256s,
      producerRole: shards[name][0]!.parsed.producerRole,
      semanticRecordCount,
    });
  }
  return Object.freeze({ shards: Object.freeze(shards), summaries: Object.freeze(summaries) });
}
