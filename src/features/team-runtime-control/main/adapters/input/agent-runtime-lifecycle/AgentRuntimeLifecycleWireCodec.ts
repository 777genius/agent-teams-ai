import {
  AGENT_RUNTIME_LIFECYCLE_ACL_MAX_FRAME_BYTES,
  AGENT_RUNTIME_LIFECYCLE_ACL_PROTOCOL_VERSION,
  AGENT_RUNTIME_LIFECYCLE_EFFECTS,
  type AgentRuntimeLifecycleCallerLease,
  type AgentRuntimeLifecycleEffect,
  type AgentRuntimeLifecycleEffectLease,
  type AgentRuntimeLifecycleReadinessReceipt,
  type AgentRuntimeLifecycleRequest,
  type AgentRuntimeLifecycleResponse,
} from '../../../../contracts/agent-runtime-lifecycle-acl';

export type DecodeAgentRuntimeLifecycleFrameOutcome =
  | { readonly status: 'decoded'; readonly request: AgentRuntimeLifecycleRequest }
  | {
      readonly status: 'rejected';
      readonly requestId: string;
      readonly effect: AgentRuntimeLifecycleEffect | null;
    };

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const EXECUTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PROVIDERS = Object.freeze(['anthropic', 'codex', 'gemini', 'opencode'] as const);
const BACKENDS = Object.freeze(['provisioning_cli', 'opencode'] as const);

export class AgentRuntimeLifecycleWireCodec {
  constructor(readonly maximumFrameBytes = AGENT_RUNTIME_LIFECYCLE_ACL_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
      throw new TypeError('agent-runtime-lifecycle-frame-limit-invalid');
    }
  }

  decode(frame: string): DecodeAgentRuntimeLifecycleFrameOutcome {
    if (typeof frame !== 'string' || utf8ByteLength(frame) > this.maximumFrameBytes) {
      return { status: 'rejected', requestId: 'invalid-request', effect: null };
    }
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      return { status: 'rejected', requestId: 'invalid-request', effect: null };
    }
    const requestId = readDiagnosticRequestId(value);
    const effect = readDiagnosticEffect(value);
    const request = parseRequest(value);
    return request ? { status: 'decoded', request } : { status: 'rejected', requestId, effect };
  }

  encode(response: AgentRuntimeLifecycleResponse): string {
    return `${JSON.stringify(response)}\n`;
  }
}

function parseRequest(value: unknown): AgentRuntimeLifecycleRequest | null {
  if (!isPlainRecord(value)) return null;
  const effect = readDiagnosticEffect(value);
  if (!effect || value.protocolVersion !== AGENT_RUNTIME_LIFECYCLE_ACL_PROTOCOL_VERSION) {
    return null;
  }
  const expectedKeys = [
    'protocolVersion',
    'requestId',
    'callerLease',
    'operationId',
    'effectLease',
    'plan',
    'laneId',
    'effect',
    ...(effect === 'launch' ? ['readiness'] : []),
    ...(effect === 'observe' ? ['executionRef'] : []),
    ...(effect === 'stop' ? ['executionRef', 'mode'] : []),
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !isIdentifier(value.requestId) ||
    !isIdentifier(value.operationId) ||
    !isIdentifier(value.laneId) ||
    !isPlainRecord(value.plan)
  ) {
    return null;
  }
  const callerLease = parseCallerLease(value.callerLease);
  const effectLease = parseEffectLease(value.effectLease);
  if (!callerLease || !effectLease) return null;
  if (effect === 'launch' && !parseReadiness(value.readiness)) return null;
  if (
    (effect === 'observe' || effect === 'stop') &&
    (typeof value.executionRef !== 'string' || !EXECUTION_REF_PATTERN.test(value.executionRef))
  ) {
    return null;
  }
  if (effect === 'stop' && value.mode !== 'graceful' && value.mode !== 'immediate') return null;
  return value as unknown as AgentRuntimeLifecycleRequest;
}

function parseCallerLease(value: unknown): AgentRuntimeLifecycleCallerLease | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'bootId',
      'leaseId',
      'authority',
      'callerId',
      'token',
      'issuedAtIso',
      'expiresAtIso',
    ]) ||
    value.kind !== 'agent-runtime-lifecycle-caller-lease/v1' ||
    value.authority !== 'external_lifecycle_orchestrator' ||
    !isIdentifier(value.bootId) ||
    !isIdentifier(value.leaseId) ||
    !isIdentifier(value.callerId) ||
    typeof value.token !== 'string' ||
    !TOKEN_PATTERN.test(value.token) ||
    !isCanonicalTimestamp(value.issuedAtIso) ||
    !isCanonicalTimestamp(value.expiresAtIso) ||
    Date.parse(value.expiresAtIso) <= Date.parse(value.issuedAtIso)
  ) {
    return null;
  }
  return value as unknown as AgentRuntimeLifecycleCallerLease;
}

function parseEffectLease(value: unknown): AgentRuntimeLifecycleEffectLease | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['token', 'fence', 'ownerId', 'claimedAtIso', 'expiresAtIso']) ||
    typeof value.token !== 'string' ||
    !TOKEN_PATTERN.test(value.token) ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    !isIdentifier(value.ownerId) ||
    !isCanonicalTimestamp(value.claimedAtIso) ||
    !isCanonicalTimestamp(value.expiresAtIso) ||
    Date.parse(value.expiresAtIso) <= Date.parse(value.claimedAtIso)
  ) {
    return null;
  }
  return value as unknown as AgentRuntimeLifecycleEffectLease;
}

function parseReadiness(value: unknown): AgentRuntimeLifecycleReadinessReceipt | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'backend',
      'bindingId',
      'laneId',
      'planHash',
      'bindingRevision',
      'providerRevisions',
    ]) ||
    !(BACKENDS as readonly unknown[]).includes(value.backend) ||
    !isIdentifier(value.bindingId) ||
    !isIdentifier(value.laneId) ||
    typeof value.planHash !== 'string' ||
    !SHA256_PATTERN.test(value.planHash) ||
    !Number.isSafeInteger(value.bindingRevision) ||
    (value.bindingRevision as number) < 1 ||
    !Array.isArray(value.providerRevisions) ||
    value.providerRevisions.length < 1 ||
    value.providerRevisions.some(
      (entry) =>
        !isPlainRecord(entry) ||
        !hasExactKeys(entry, ['providerId', 'capabilityRevision']) ||
        !(PROVIDERS as readonly unknown[]).includes(entry.providerId) ||
        !Number.isSafeInteger(entry.capabilityRevision) ||
        (entry.capabilityRevision as number) < 1
    )
  ) {
    return null;
  }
  return value as unknown as AgentRuntimeLifecycleReadinessReceipt;
}

function readDiagnosticRequestId(value: unknown): string {
  return isPlainRecord(value) && isIdentifier(value.requestId)
    ? value.requestId
    : 'invalid-request';
}

function readDiagnosticEffect(value: unknown): AgentRuntimeLifecycleEffect | null {
  return isPlainRecord(value) &&
    (AGENT_RUNTIME_LIFECYCLE_EFFECTS as readonly unknown[]).includes(value.effect)
    ? (value.effect as AgentRuntimeLifecycleEffect)
    : null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
