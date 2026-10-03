import { classifyNativeVersion } from './generation';

import type {
  EndpointAuthority,
  NativeIdentity,
  Operation,
  OperationMap,
  OwnerPermissionReply,
  Protocol2CommandContext,
  Protocol2Handshake,
  Protocol2Offer,
} from '../../contracts';

type Check = (value: unknown) => boolean;
type Row = Record<string, unknown>;
const text: Check = (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const hash: Check = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer: Check = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive: Check = (v) => integer(v) && (v as number) > 0;
const literal =
  (...values: unknown[]): Check =>
  (v) =>
    values.includes(v);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const row = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (v) =>
    row(v) &&
    Object.keys(v).every((key) => Object.hasOwn(required, key) || Object.hasOwn(optional, key)) &&
    Object.entries(required).every(([key, check]) => Object.hasOwn(v, key) && check(v[key])) &&
    Object.entries(optional).every(([key, check]) => !Object.hasOwn(v, key) || check(v[key]));
}
const operations: readonly Operation[] = [
  'generationIdentity',
  'bootstrap',
  'deliveryAcceptance',
  'interaction',
  'permissionAnswer',
  'transcriptNormalization',
  'fileParts',
  'taskLedgerEvidence',
  'expectedBehaviorFingerprint',
];
const dialects = ['v1', 'v2-2.0.0', 'v2-2.0.21'] as const;
const versions: Record<Operation, number> = {
  generationIdentity: 1,
  bootstrap: 2,
  deliveryAcceptance: 3,
  interaction: 1,
  permissionAnswer: 1,
  transcriptNormalization: 2,
  fileParts: 2,
  taskLedgerEvidence: 1,
  expectedBehaviorFingerprint: 2,
};
function operationVersion(operation: string, version: unknown, dialect: string): boolean {
  return (
    operations.includes(operation as Operation) &&
    version ===
      (operation === 'bootstrap' && dialect === 'v1' ? 1 : versions[operation as Operation])
  );
}
const nativeShape = shape({
  generation: literal('v1', 'v2'),
  apiDialect: literal(...dialects),
  version: text,
  executablePath: text,
  executableSha256: hash,
  launcherPath: text,
  packageName: literal('opencode-ai', '@opencode/cli', null),
  source: literal('app-managed', 'explicit', 'path'),
});
const native: Check = (v) => {
  if (!nativeShape(v)) return false;
  const value = v as NativeIdentity;
  const classified = classifyNativeVersion(value.version);
  return (
    classified.kind === 'recognized' &&
    classified.generation === value.generation &&
    classified.apiDialect === value.apiDialect &&
    (value.packageName === null ||
      value.packageName === (value.generation === 'v1' ? 'opencode-ai' : '@opencode/cli'))
  );
};
const birth: Check = (v) =>
  shape({ format: literal('linux-start-ticks'), value: text, bootId: text })(v) ||
  shape({ format: literal('utc-ms'), value: text, bootId: literal(null) })(v);
const endpointShape = shape({
  native,
  selectionEpoch: text,
  profileEpoch: text,
  profileRootKey: text,
  profileGeneration: literal('v1', 'v2'),
  canonicalDirectory: text,
  projectId: text,
  baseUrl: text,
  pid: positive,
  processBirth: birth,
  observedSpawnAtUtcMs: integer,
  hostInstanceId: text,
  ownership: literal('spawned', 'managed-reused'),
  capabilitySnapshotId: text,
});
const endpoint: Check = (v) =>
  endpointShape(v) &&
  (v as EndpointAuthority).profileGeneration === (v as EndpointAuthority).native.generation;
const session = shape({
  endpoint,
  teamId: text,
  runId: text,
  laneId: text,
  memberName: text,
  sessionId: text,
  rootSessionId: text,
  parentSessionId: nullable(text),
  bindingId: text,
  leaseId: text,
  leaseEpoch: text,
  sessionRevision: text,
});
const scopeShape = shape({
  kind: literal('session'),
  authority: session,
  requestId: text,
  relation: literal('root', 'child'),
});
const scope: Check = (v) => {
  if (!scopeShape(v)) return false;
  const value = v as OwnerPermissionReply['scope'];
  return value.relation === 'root'
    ? value.authority.sessionId === value.authority.rootSessionId &&
        value.authority.parentSessionId === null
    : value.authority.sessionId !== value.authority.rootSessionId &&
        value.authority.parentSessionId !== null &&
        value.authority.parentSessionId !== value.authority.sessionId;
};
const permissionShape = shape(
  {
    schemaVersion: literal(1),
    scope,
    approvalId: text,
    bindingId: text,
    expectedRevision: text,
    operationId: text,
    decision: literal('once', 'always', 'reject'),
  },
  { message: (v) => typeof v === 'string' && v.length <= 4096 }
);
const permission: Check = (v) =>
  permissionShape(v) &&
  (v as OwnerPermissionReply).bindingId === (v as OwnerPermissionReply).scope.authority.bindingId;
const offer: Check = (v) =>
  shape({
    schemaVersion: literal(1),
    minVersion: literal(1),
    currentVersion: literal(2),
    selected: native,
    requiredOperations: (map) =>
      row(map) &&
      Object.keys(map).length > 0 &&
      Object.entries(map).every(([key, version]) =>
        operationVersion(key, version, (v as Protocol2Offer).selected.apiDialect)
      ),
  })(v);
const operationEntry = shape({
  version: positive,
  fingerprint: hash,
  availability: literal('qualified', 'pending', 'absent'),
  qualificationDigest: nullable(hash),
});
const handshakeShape = shape({
  schemaVersion: literal(1),
  protocolVersion: literal(2),
  supportedGenerations: (v) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 2 &&
    new Set(v).size === v.length &&
    v.every(literal('v1', 'v2')),
  dialects: (v) =>
    row(v) &&
    Object.keys(v).every(
      (key) =>
        dialects.includes(key as (typeof dialects)[number]) &&
        row(v[key]) &&
        Object.entries(v[key]).every(
          ([operation, entry]) =>
            operationEntry(entry) &&
            operationVersion(operation, (entry as { version: number }).version, key)
        )
    ),
  selectedNative: nullable(native),
  selectionEpoch: nullable(text),
  selectedAuthority: nullable(endpoint),
  support: literal(
    'not_installed',
    'unsupported_version',
    'unqualified_version',
    'runtime_upgrade_required',
    'binary_host_mismatch',
    'capabilities_pending',
    'configuration_blocked',
    'ready'
  ),
  qualificationDigest: nullable(hash),
});
const handshake: Check = (v) => {
  if (!handshakeShape(v)) return false;
  const value = v as Protocol2Handshake;
  if (value.selectedNative === null)
    return (
      value.selectedAuthority === null && value.selectionEpoch === null && value.support !== 'ready'
    );
  if (!value.supportedGenerations.includes(value.selectedNative.generation)) return false;
  if (value.selectedAuthority === null)
    return value.selectionEpoch === null && value.support !== 'ready';
  return (
    same(value.selectedAuthority.native, value.selectedNative) &&
    value.selectedAuthority.selectionEpoch === value.selectionEpoch
  );
};
const contextShape = shape({
  schemaVersion: literal(1),
  protocolVersion: literal(2),
  operation: literal(...operations),
  operationVersion: positive,
  operationFingerprint: hash,
  native,
  selectionEpoch: text,
  authority: session,
  operationId: text,
  expectedObservationEpoch: text,
  expectedCapabilitySnapshotId: text,
  expectedManifestHighWatermark: integer,
  expectedRunId: text,
  handshakeIdentityHash: hash,
});
const context: Check = (v) => {
  if (!contextShape(v)) return false;
  const value = v as Protocol2CommandContext;
  return (
    operationVersion(value.operation, value.operationVersion, value.native.apiDialect) &&
    same(value.native, value.authority.endpoint.native) &&
    value.selectionEpoch === value.authority.endpoint.selectionEpoch &&
    value.expectedCapabilitySnapshotId === value.authority.endpoint.capabilitySnapshotId &&
    value.expectedRunId === value.authority.runId
  );
};

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string };
/** Clone only bounded JSON data. Reject accessors/prototypes/cycles before inspecting authority. */
function decode<T>(input: unknown, check: Check): DecodeResult<T> {
  try {
    if (typeof input === 'string') {
      if (input.length > 65536) throw new Error('oversize');
      input = JSON.parse(input) as unknown;
    }
    let nodes = 0;
    let characters = 0;
    function clone(value: unknown, depth: number): unknown {
      if (++nodes > 4096 || depth > 16) throw new Error('bounded');
      if (typeof value === 'string') {
        characters += value.length;
        if (value.length > 8192 || characters > 65536) throw new Error('bounded');
        return value;
      }
      if (
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      )
        return value;
      if (typeof value !== 'object') throw new Error('non-JSON');
      if (Array.isArray(value)) {
        if (value.length > 128 || Object.getOwnPropertySymbols(value).length)
          throw new Error('bounded');
        const entries = Object.getOwnPropertyDescriptors(value);
        if (Object.keys(entries).length !== value.length + 1) throw new Error('array properties');
        return Object.freeze(
          Array.from({ length: value.length }, (_, i) => {
            const descriptor = entries[i];
            if (!descriptor || !('value' in descriptor)) throw new Error('accessor');
            return clone(descriptor.value, depth + 1);
          })
        );
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw new Error('prototype');
      const output: Row = Object.create(null) as Row;
      const entries = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).length > 128) throw new Error('bounded');
      for (const [key, descriptor] of Object.entries(entries)) {
        if (
          !('value' in descriptor) ||
          !descriptor.enumerable ||
          key === '__proto__' ||
          key === 'constructor' ||
          key === 'prototype'
        )
          throw new Error('property');
        characters += key.length;
        if (characters > 65536) throw new Error('bounded');
        output[key] = clone(descriptor.value, depth + 1);
      }
      if (Object.getOwnPropertySymbols(value).length) throw new Error('symbol');
      return Object.freeze(output);
    }
    const value = clone(input, 0);
    return check(value)
      ? { ok: true, value: value as T }
      : { ok: false, reason: 'Invalid protocol2 contract' };
  } catch {
    return { ok: false, reason: 'Malformed or oversized protocol2 data' };
  }
}
/** Decoders validate syntax and detach/freeze data; they never establish live authority. */
export const decodeProtocol2Offer = (input: unknown): DecodeResult<Protocol2Offer> =>
  decode(input, offer);
export const decodeProtocol2Handshake = (input: unknown): DecodeResult<Protocol2Handshake> =>
  decode(input, handshake);
export const decodeProtocol2CommandContext = (
  input: unknown
): DecodeResult<Protocol2CommandContext> => decode(input, context);
export const decodeOwnerPermissionReply = (input: unknown): DecodeResult<OwnerPermissionReply> =>
  decode(input, permission);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (row(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

export type NegotiationResult =
  | { kind: 'legacy'; protocolVersion: 1; generation: 'v1' }
  | { kind: 'compatible'; protocolVersion: 2; generation: 'v1' }
  | { kind: 'blocked'; reason: string };
/** Pure compatibility only: a compatible result grants no transport or native qualification. */
export function negotiateOpenCodeProtocol(input: {
  version: string;
  offer?: unknown;
  handshake?: unknown;
  expectedAuthority?: unknown;
  expectedOperations?: unknown;
}): NegotiationResult {
  const block = (reason: string): NegotiationResult => ({ kind: 'blocked', reason });
  const generation = classifyNativeVersion(input.version);
  if (generation.kind !== 'recognized') return block('Unsupported native generation');
  if (input.offer === undefined) {
    if (input.handshake !== undefined) return block('Unsolicited protocol2 response');
    return generation.generation === 'v1'
      ? { kind: 'legacy', protocolVersion: 1, generation: 'v1' }
      : block('V2 requires an upgraded qualified owner');
  }
  const decodedOffer = decodeProtocol2Offer(input.offer);
  if (!decodedOffer.ok) return block(decodedOffer.reason);
  const selected = decodedOffer.value.selected;
  if (
    selected.generation !== generation.generation ||
    selected.apiDialect !== generation.apiDialect ||
    selected.version !== input.version.trim().replace(/^v/, '')
  )
    return block('Offer native identity mismatch');
  if (input.handshake === undefined)
    return selected.generation === 'v1'
      ? { kind: 'legacy', protocolVersion: 1, generation: 'v1' }
      : block('V2 requires an upgraded qualified owner');
  const decodedHandshake = decodeProtocol2Handshake(input.handshake);
  if (!decodedHandshake.ok) return block(decodedHandshake.reason);
  const agreed = decodedHandshake.value;
  if (generation.generation === 'v2') return block('V2 remains unqualified in A0');
  const authority = decode<EndpointAuthority>(input.expectedAuthority, endpoint);
  const expected = decode<OperationMap>(
    input.expectedOperations,
    (v) =>
      row(v) &&
      Object.entries(v).every(
        ([operation, entry]) =>
          operationEntry(entry) &&
          operationVersion(operation, (entry as { version: number }).version, selected.apiDialect)
      )
  );
  if (
    !authority.ok ||
    !expected.ok ||
    agreed.support !== 'ready' ||
    !agreed.qualificationDigest ||
    !same(agreed.selectedNative, selected) ||
    !same(agreed.selectedAuthority, authority.value)
  )
    return block('Unqualified or mismatched authority');
  const map = agreed.dialects[selected.apiDialect];
  for (const [operation, version] of Object.entries(decodedOffer.value.requiredOperations)) {
    const entry = map?.[operation as Operation];
    const required = expected.value[operation as Operation];
    if (
      !entry ||
      !required ||
      entry.version !== version ||
      entry.availability !== 'qualified' ||
      !entry.qualificationDigest ||
      !same(entry, required)
    )
      return block('Unqualified or mismatched operation fingerprint');
  }
  return { kind: 'compatible', protocolVersion: 2, generation: 'v1' };
}
