import {
  type AuthoritativeRuntimePlanSourcePort,
  decodeCompositeRuntimePlan,
  type RuntimePlanAttestationAuthorityPort,
} from '../../../core/application/planning';

import type {
  CompositeRuntimePlan,
  RuntimePlanAttestation,
  RuntimePlanAttestationBinding,
  RuntimePlanAttestationRedemption,
} from '../../../contracts';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_RECORDS = 4_096;

interface AttestationRecord {
  readonly attestation: RuntimePlanAttestation;
  readonly plan: CompositeRuntimePlan;
  readonly planRevision: number;
  consumed: boolean;
}

export interface InMemoryRuntimePlanAttestationAuthorityOptions {
  readonly authorityId: string;
  readonly bootId: string;
  readonly plans: AuthoritativeRuntimePlanSourcePort;
  readonly crypto: RuntimePlanAttestationCrypto;
  readonly nowEpochMs?: () => number;
  readonly ttlMs?: number;
  readonly maxRecords?: number;
}

export interface RuntimePlanAttestationCrypto {
  randomBytes(length: number): Uint8Array;
  base64UrlEncode(value: Uint8Array): string;
  secureEqual(left: string, right: string): boolean;
}

/** One process-local CSPRNG authority. Tokens and reconstructed plans are never persisted. */
export class InMemoryRuntimePlanAttestationAuthority implements RuntimePlanAttestationAuthorityPort {
  private readonly records = new Map<string, AttestationRecord>();
  private readonly recordByBinding = new Map<string, AttestationRecord>();
  private readonly inFlightIssueByBinding = new Map<
    string,
    Promise<RuntimePlanAttestation | null>
  >();
  private readonly nowEpochMs: () => number;
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(private readonly options: InMemoryRuntimePlanAttestationAuthorityOptions) {
    if (!validId(options.authorityId) || !validId(options.bootId)) {
      throw new TypeError('runtime-plan-attestation-owner-invalid');
    }
    if (
      typeof options.plans?.reconstruct !== 'function' ||
      typeof options.plans?.currentRevision !== 'function'
    ) {
      throw new TypeError('runtime-plan-attestation-plan-source-missing');
    }
    if (
      typeof options.crypto?.randomBytes !== 'function' ||
      typeof options.crypto?.base64UrlEncode !== 'function' ||
      typeof options.crypto?.secureEqual !== 'function'
    ) {
      throw new TypeError('runtime-plan-attestation-crypto-missing');
    }
    this.nowEpochMs = options.nowEpochMs ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 300_000) {
      throw new TypeError('runtime-plan-attestation-ttl-invalid');
    }
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 65_536) {
      throw new TypeError('runtime-plan-attestation-record-limit-invalid');
    }
  }

  async issue(input: {
    readonly candidate: CompositeRuntimePlan;
    readonly binding: RuntimePlanAttestationBinding;
  }): Promise<RuntimePlanAttestation | null> {
    if (!this.matchesOwner(input.binding) || !validBinding(input.binding)) return null;
    const key = bindingKey(input.binding);
    const inFlight = this.inFlightIssueByBinding.get(key);
    if (inFlight) {
      await inFlight;
      return await this.issue(input);
    }
    const issuing = this.issueAtomically(input, key).finally(() => {
      if (this.inFlightIssueByBinding.get(key) === issuing) {
        this.inFlightIssueByBinding.delete(key);
      }
    });
    this.inFlightIssueByBinding.set(key, issuing);
    return await issuing;
  }

  private async issueAtomically(
    input: {
      readonly candidate: CompositeRuntimePlan;
      readonly binding: RuntimePlanAttestationBinding;
    },
    key: string
  ): Promise<RuntimePlanAttestation | null> {
    const existing = this.recordByBinding.get(key);
    const now = this.nowEpochMs();
    if (existing?.consumed) return null;
    if (existing && now < Date.parse(existing.attestation.expiresAtIso)) {
      const isCurrent = this.isCurrentPlan(existing);
      if (samePlanIdentity(existing.plan, input.candidate) && isCurrent) {
        return existing.attestation;
      }
      if (isCurrent) return null;
    }
    if (existing) {
      this.records.delete(existing.attestation.token);
      this.recordByBinding.delete(key);
    }

    let snapshot: Awaited<ReturnType<AuthoritativeRuntimePlanSourcePort['reconstruct']>>;
    try {
      snapshot = await this.options.plans.reconstruct(input);
    } catch {
      return null;
    }
    if (!snapshot || !validRevision(snapshot.revision)) return null;
    let plan: CompositeRuntimePlan;
    try {
      plan = decodeCompositeRuntimePlan(snapshot.plan);
    } catch {
      return null;
    }
    if (
      !samePlanIdentity(plan, input.candidate) ||
      !plan.lanes.some((lane) => lane.laneId === input.binding.laneId) ||
      this.readCurrentRevision(input.candidate) !== snapshot.revision
    ) {
      return null;
    }
    const issueNow = this.nowEpochMs();
    if (!Number.isFinite(issueNow)) return null;
    this.pruneExpiredUnconsumed(issueNow);
    if (this.records.size >= this.maxRecords) return null;
    const token = this.createUniqueToken();
    const attestation = Object.freeze({
      attestationVersion: 1 as const,
      token,
      authorityId: this.options.authorityId,
      bootId: this.options.bootId,
      planHash: plan.planHash,
      laneId: input.binding.laneId,
      operation: input.binding.operation,
      operationId: input.binding.operationId,
      issuedAtIso: new Date(issueNow).toISOString(),
      expiresAtIso: new Date(issueNow + this.ttlMs).toISOString(),
    });
    const record = { attestation, plan, planRevision: snapshot.revision, consumed: false };
    this.records.set(token, record);
    this.recordByBinding.set(key, record);
    return attestation;
  }

  async redeem(
    value: unknown,
    binding: RuntimePlanAttestationBinding
  ): Promise<RuntimePlanAttestationRedemption> {
    if (!this.matchesOwner(binding) || !validBinding(binding) || !validAttestationShape(value)) {
      return { status: 'rejected', reason: 'binding_mismatch' };
    }
    const presented = value;
    const record = this.records.get(presented.token);
    if (!record) return { status: 'rejected', reason: 'unknown' };
    const current = this.recordByBinding.get(bindingKey(binding));
    if (
      current !== record ||
      !this.attestationsEqual(record.attestation, presented) ||
      !attestationMatches(binding, presented)
    ) {
      return { status: 'rejected', reason: 'binding_mismatch' };
    }
    if (record.consumed) return { status: 'rejected', reason: 'consumed' };
    if (!this.isCurrentPlan(record)) return { status: 'rejected', reason: 'unavailable' };
    const now = this.nowEpochMs();
    if (!Number.isFinite(now)) return { status: 'rejected', reason: 'unavailable' };
    if (now < Date.parse(presented.issuedAtIso) || now >= Date.parse(presented.expiresAtIso)) {
      return { status: 'rejected', reason: 'expired' };
    }
    // Consume before yielding the plan. Concurrent redemption cannot reach a backend twice.
    record.consumed = true;
    return { status: 'redeemed', plan: record.plan };
  }

  private isCurrentPlan(record: AttestationRecord): boolean {
    return this.readCurrentRevision(record.plan) === record.planRevision;
  }

  private readCurrentRevision(candidate: CompositeRuntimePlan): number | null {
    try {
      const revision = this.options.plans.currentRevision({ candidate });
      return validRevision(revision) ? revision : null;
    } catch {
      return null;
    }
  }

  private pruneExpiredUnconsumed(now: number): void {
    for (const [token, record] of this.records) {
      if (record.consumed || now < Date.parse(record.attestation.expiresAtIso)) continue;
      this.records.delete(token);
      const key = bindingKey(record.attestation);
      if (this.recordByBinding.get(key) === record) this.recordByBinding.delete(key);
    }
  }

  private matchesOwner(binding: RuntimePlanAttestationBinding): boolean {
    return (
      binding.authorityId === this.options.authorityId && binding.bootId === this.options.bootId
    );
  }

  private createUniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.options.crypto.base64UrlEncode(this.options.crypto.randomBytes(32));
      if (/^[A-Za-z0-9_-]{43,512}$/.test(token) && !this.records.has(token)) return token;
    }
    throw new Error('runtime-plan-attestation-random-source-unavailable');
  }

  private attestationsEqual(left: RuntimePlanAttestation, right: RuntimePlanAttestation): boolean {
    return this.options.crypto.secureEqual(JSON.stringify(left), JSON.stringify(right));
  }
}

function samePlanIdentity(left: CompositeRuntimePlan, right: CompositeRuntimePlan): boolean {
  return (
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.generation === right.generation &&
    left.planHash === right.planHash
  );
}

function bindingKey(binding: RuntimePlanAttestationBinding): string {
  return [
    binding.authorityId,
    binding.bootId,
    binding.laneId,
    binding.operation,
    binding.operationId,
  ].join('\u0000');
}

function attestationMatches(
  binding: RuntimePlanAttestationBinding,
  attestation: RuntimePlanAttestation
): boolean {
  return (
    attestation.authorityId === binding.authorityId &&
    attestation.bootId === binding.bootId &&
    attestation.laneId === binding.laneId &&
    attestation.operation === binding.operation &&
    attestation.operationId === binding.operationId
  );
}

function validAttestationShape(value: unknown): value is RuntimePlanAttestation {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    hasExactKeys(value as Record<string, unknown>, [
      'attestationVersion',
      'token',
      'authorityId',
      'bootId',
      'planHash',
      'laneId',
      'operation',
      'operationId',
      'issuedAtIso',
      'expiresAtIso',
    ]) &&
    (value as RuntimePlanAttestation).attestationVersion === 1 &&
    typeof (value as RuntimePlanAttestation).token === 'string' &&
    /^[A-Za-z0-9_-]{43,512}$/.test((value as RuntimePlanAttestation).token) &&
    validId((value as RuntimePlanAttestation).authorityId) &&
    validId((value as RuntimePlanAttestation).bootId) &&
    /^sha256:[a-f0-9]{64}$/.test((value as RuntimePlanAttestation).planHash) &&
    validId((value as RuntimePlanAttestation).laneId) &&
    ['preflight', 'launch', 'observe', 'stop', 'recover'].includes(
      (value as RuntimePlanAttestation).operation
    ) &&
    validId((value as RuntimePlanAttestation).operationId) &&
    Number.isFinite(Date.parse((value as RuntimePlanAttestation).issuedAtIso)) &&
    Number.isFinite(Date.parse((value as RuntimePlanAttestation).expiresAtIso))
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function validBinding(value: RuntimePlanAttestationBinding): boolean {
  return (
    validId(value.authorityId) &&
    validId(value.bootId) &&
    validId(value.laneId) &&
    ['preflight', 'launch', 'observe', 'stop', 'recover'].includes(value.operation) &&
    validId(value.operationId)
  );
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value);
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
