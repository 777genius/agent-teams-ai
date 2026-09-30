import { parseHostedOwnerWalNative } from '../../../src/main/composition/hosted/hostedOwnerWalNativeValidator';

import {
  ACTOR,
  array,
  bindingTuple,
  compactOwnerWalState,
  decodeOwnerWalDelivery,
  decodeOwnerWalIngress,
  decodeOwnerWalState,
  equal,
  hash,
  HASH,
  ingressBinding,
  integer,
  iso,
  object,
  OWNER_WAL_COLLECTIONS,
  OWNER_WAL_FIELDS,
  OWNER_WAL_MAX_BYTES,
  parseOwnerWalJson,
  requireWal,
  text,
} from './owner-wal-image-state';

import type {
  OwnerWalDelivery,
  OwnerWalIngress,
  OwnerWalRoute,
  OwnerWalState,
} from './owner-wal-image-state';
import type {
  HostedOwnerLeaseClaim,
  HostedOwnerWalNative,
} from '../../../src/features/hosted-producer-provenance/contracts';

export interface OwnerWalImage {
  readonly byteSize: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}
export type PreviousOwnerWalImage =
  | Readonly<{ kind: 'retained'; image: OwnerWalImage }>
  /** An absence assertion supplied by the future fenced/sealed loader, not proved by this module. */
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unavailable' }>;
export interface OwnerWalAdmissionSnapshot {
  readonly admissionGeneration: string;
  readonly digest: string;
  readonly routes: readonly OwnerWalRoute[];
  readonly actorMembers: Readonly<Record<string, string>>;
}
export interface OwnerWalClaimRequest {
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
}
export interface OwnerWalAckRequest {
  readonly outboxId: string;
  readonly generation: number;
  readonly ownerId: string;
  readonly leaseToken: string;
}
export interface OwnerWalDeliveryRequest {
  readonly providerDeliveryId: string;
  readonly reconciliationRef: string;
  readonly principal:
    | Readonly<{ kind: 'operator'; actorId: string }>
    | Readonly<{ kind: 'system_timeout' }>;
  readonly deliveryRef: string;
  readonly approvalId: string;
  readonly approvalGeneration: string;
  readonly decision: 'allow' | 'deny' | 'timeout';
  readonly partition: Readonly<{ teamId: string; runId: string }>;
  readonly requestId: string;
}
/** Actual operation values are mandatory, including when compaction erases the target.
 * These are validation inputs, NOT evidence of their origin. P2-B must bind them to retained
 * requests/results and the operation nonce in a fully parsed, custody-verified native capture. */
export type OwnerWalMutationWitness =
  | Readonly<{ kind: 'admission-reconciled'; admission: OwnerWalAdmissionSnapshot }>
  | Readonly<{ kind: 'ingress-admitted' | 'binding-quarantined'; record: OwnerWalIngress }>
  | Readonly<{
      kind: 'ingress-lease-claimed';
      request: OwnerWalClaimRequest;
      claimedAtIso: string;
      maximumAggregateBytes: number;
    }>
  | Readonly<{
      kind: 'ingress-acknowledged';
      request: OwnerWalAckRequest;
      acknowledgedAtIso: string;
    }>
  | Readonly<{ kind: 'delivery-started'; request: OwnerWalDeliveryRequest }>
  | Readonly<{
      kind: 'delivery-settled';
      request: OwnerWalDeliveryRequest;
      delivery: OwnerWalDelivery;
    }>;
export interface OwnerWalImageVerificationInput {
  readonly previous: PreviousOwnerWalImage;
  readonly next: OwnerWalImage;
  readonly native: unknown;
  readonly witness: OwnerWalMutationWitness;
}
export interface ValidatedOwnerStoredImage {
  readonly byteSize: number;
  readonly sha256: string;
  readonly revision: number;
  readonly schemaVersion: 1 | 2 | 3;
}
export interface ValidatedOwnerWalImages {
  readonly kind: 'validated-owner-wal-images';
  readonly custodyVerified: false;
  readonly native: HostedOwnerWalNative;
  readonly previous:
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'retained'; image: ValidatedOwnerStoredImage }>;
  readonly next: ValidatedOwnerStoredImage & Readonly<{ schemaVersion: 3 }>;
}
interface DecodedImage {
  stored: Record<string, unknown>;
  working: OwnerWalState;
  source: string;
  summary: ValidatedOwnerStoredImage;
}
function decodeImage(input: OwnerWalImage): DecodedImage {
  const i = object(input, ['byteSize', 'sha256', 'bytes']);
  const byteSize = integer(i.byteSize, 2, OWNER_WAL_MAX_BYTES),
    sha256 = text(i.sha256, HASH);
  requireWal(
    i.bytes instanceof Uint8Array &&
      i.bytes.byteLength === byteSize &&
      !(i.bytes.buffer instanceof SharedArrayBuffer),
    'image-bytes'
  );
  const bytes = Buffer.from(i.bytes); // owned copy; no async read, filesystem or later reread
  requireWal(hash(bytes) === sha256, 'image-hash');
  // Match Owner's UTF-8 decoder for P, including its optional leading BOM handling.
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const stored = object(parseOwnerWalJson(source));
  const working = decodeOwnerWalState(stored);
  requireWal(
    stored.schemaVersion === 1 || stored.schemaVersion === 2 || stored.schemaVersion === 3,
    'schema'
  );
  return {
    stored,
    working,
    source,
    summary: { byteSize, sha256, revision: working.revision, schemaVersion: stored.schemaVersion },
  };
}

function classifyObservation(
  state: OwnerWalState,
  record: OwnerWalIngress
): 'admit' | 'quarantine' {
  const old = [...state.ingress, ...state.retiredIngress].find(
    (r) => r.outboxId === record.outboxId || r.deliveryRef === record.deliveryRef
  );
  if (old) {
    const observation = (r: OwnerWalIngress) => {
      const {
        lease: _lease,
        acknowledgedAtIso: _ack,
        observedAtIso: _observed,
        acceptedAtIso: _accepted,
        ...rest
      } = r;
      return rest;
    };
    requireWal(equal(observation(old), observation(record)), 'ingress-conflict');
    requireWal(false, 'ingress-replay');
  }
  const b = ingressBinding(record, false);
  const same = state.bindings.filter(
    (oldBinding) =>
      bindingTuple(oldBinding) === bindingTuple(b) &&
      (oldBinding.effectRef === null || oldBinding.effectRef === b.effectRef)
  );
  requireWal(
    !same.some(
      (oldBinding) =>
        oldBinding.effectRef === b.effectRef && oldBinding.bindingDigest === b.bindingDigest
    ),
    'binding-replay'
  );
  return same.length ? 'quarantine' : 'admit';
}

function claim(
  state: OwnerWalState,
  witness: Extract<OwnerWalMutationWitness, { kind: 'ingress-lease-claimed' }>,
  native: HostedOwnerWalNative
): OwnerWalState {
  object(witness, ['kind', 'request', 'claimedAtIso', 'maximumAggregateBytes']);
  const r = object(witness.request, ['ownerId', 'leaseToken', 'leaseDurationMs', 'limit']);
  const ownerId = text(r.ownerId),
    leaseToken = text(r.leaseToken);
  const limit = integer(r.limit, 1, 100),
    duration = integer(r.leaseDurationMs, 1, 300_000);
  const maximum = integer(witness.maximumAggregateBytes, 2, 8 * 1024 * 1024 - 8192);
  const claimedAtIso = iso(witness.claimedAtIso),
    now = Date.parse(claimedAtIso);
  integer(now);
  const leaseExpiresAtIso = new Date(now + duration).toISOString();
  const claims: HostedOwnerLeaseClaim[] = [];
  let returned = 0,
    bytes = 2,
    stopped = false;
  const ingress = state.ingress.map((record) => {
    if (stopped || returned >= limit || record.acknowledgedAtIso !== null) return record;
    const live = record.lease !== null && Date.parse(record.lease.leaseExpiresAtIso) > now;
    if (live && (record.lease!.ownerId !== ownerId || record.lease!.leaseToken !== leaseToken)) {
      stopped = true;
      return record;
    }
    const lease = live
      ? record.lease!
      : {
          generation: integer((record.lease?.generation ?? 0) + 1, 1),
          ownerId,
          leaseToken,
          claimedAtIso,
          leaseExpiresAtIso,
        };
    const next = live ? record : { ...record, lease };
    const size = Buffer.byteLength(JSON.stringify(next)) + (returned ? 1 : 0);
    if (bytes + size > maximum) {
      stopped = true;
      return record;
    }
    bytes += size;
    returned++;
    if (!live) claims.push({ outboxId: record.outboxId, ...lease });
    return next;
  });
  requireWal(
    native.mutation.kind === 'ingress-lease-claimed' &&
      claims.length > 0 &&
      equal(native.mutation.claims, claims),
    'changed-claims'
  );
  return { ...state, ingress };
}

/** Fingerprint the accepted wire decoder's insertion order, not sorted JSON or raw HTTP bytes. */
function deliveryRequest(value: OwnerWalDeliveryRequest): OwnerWalDeliveryRequest {
  const r = object(value, [
    'providerDeliveryId',
    'reconciliationRef',
    'principal',
    'deliveryRef',
    'approvalId',
    'approvalGeneration',
    'decision',
    'partition',
    'requestId',
  ]);
  const p = object(r.partition, ['teamId', 'runId']);
  const principal = object(r.principal);
  object(principal, principal.kind === 'operator' ? ['kind', 'actorId'] : ['kind']);
  requireWal(
    r.decision === 'allow' || r.decision === 'deny' || r.decision === 'timeout',
    'decision'
  );
  requireWal(
    r.decision === 'timeout' ? principal.kind === 'system_timeout' : principal.kind === 'operator',
    'principal'
  );
  return {
    providerDeliveryId: text(r.providerDeliveryId),
    reconciliationRef: text(
      r.reconciliationRef,
      /^approval-reconciliation_[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u
    ),
    principal:
      principal.kind === 'operator'
        ? { kind: 'operator', actorId: text(principal.actorId, ACTOR) }
        : { kind: 'system_timeout' },
    deliveryRef: text(r.deliveryRef, /^delivery_ref_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u),
    approvalId: text(r.approvalId, /^approval_[0-9a-f]{32}$/u),
    approvalGeneration: text(r.approvalGeneration, /^generation_runtime-permission-[0-9a-f]{64}$/u),
    decision: r.decision,
    partition: {
      teamId: text(p.teamId, /^team_[0-9a-f]{32}$/u),
      runId: text(p.runId, /^run_[0-9a-f]{32}$/u),
    },
    requestId: text(r.requestId),
  };
}
function deliveryForRequest(
  state: OwnerWalState,
  request: OwnerWalDeliveryRequest,
  initial: boolean
): OwnerWalDelivery {
  const records = initial ? state.ingress : [...state.ingress, ...state.retiredIngress];
  const record = records.find(
    (r) =>
      r.deliveryRef === request.deliveryRef &&
      r.commandId === request.requestId &&
      r.authority.teamId === request.partition.teamId &&
      r.authority.runId === request.partition.runId
  );
  requireWal(record?.outboxVersion === 2, 'delivery-request-binding');
  if (initial)
    requireWal(
      state.routes.some((route) => equal(route.authority, record.authority)),
      'delivery-route'
    );
  const approvalId = `approval_${hash(
    JSON.stringify({
      schemaVersion: 1,
      teamId: request.partition.teamId,
      runId: request.partition.runId,
      requestId: request.requestId,
    })
  ).slice(0, 32)}`;
  requireWal(
    request.approvalId === approvalId &&
      request.approvalGeneration === `generation_runtime-permission-${record.effectRef.slice(7)}`,
    'approval-binding'
  );
  return {
    providerDeliveryId: request.providerDeliveryId,
    reconciliationRef: request.reconciliationRef,
    deliveryRef: record.deliveryRef,
    payloadFingerprint: hash(JSON.stringify(request)),
    outboxId: record.outboxId,
    effectRef: record.effectRef,
    phase: 'started',
    result: null,
  };
}

/** Service guards after binding and before the first delivery publication.
 * Expiry precedes actor checks. No clock is retained in this witness: a finite
 * expiry permits that rejection, but its timing still needs P2-B evidence. */
function validateInitialDeliveryOutcome(
  state: OwnerWalState,
  request: OwnerWalDeliveryRequest,
  delivery: OwnerWalDelivery
): void {
  const record = state.ingress.find((r) => r.outboxId === delivery.outboxId)!;
  const member =
    request.principal.kind === 'operator' ? state.actorMembers[request.principal.actorId] : null;
  const actorFailure =
    request.principal.kind !== 'operator'
      ? null
      : !member
        ? 'unavailable'
        : member === record.authority.deliveryOwnerId
          ? 'self_approval'
          : null;
  if (delivery.phase === 'started') {
    requireWal(actorFailure === null, 'delivery-start-actor');
  } else {
    const payload = object(parseOwnerWalJson(record.payloadJson));
    requireWal(
      (actorFailure !== null && delivery.result === actorFailure) ||
        (delivery.result === 'expired' && payload.expiresAtMs !== null),
      'direct-rejection-precondition'
    );
  }
}

/** Apply only the witnessed logical action to M. The caller subsequently decodes and
 * compacts this proposal; it is NEVER reported as an intermediate persisted image. */
function applyAction(
  previous: OwnerWalState | null,
  native: HostedOwnerWalNative,
  witness: OwnerWalMutationWitness
): OwnerWalState {
  object(witness);
  requireWal(witness.kind === native.mutation.kind, 'mutation-witness-kind');
  const revision = integer((previous?.revision ?? 0) + 1, 1);
  if (witness.kind === 'admission-reconciled') {
    object(witness, ['kind', 'admission']);
    const a = object(witness.admission, [
      'admissionGeneration',
      'digest',
      'routes',
      'actorMembers',
    ]);
    const admitted = decodeOwnerWalState({
      schemaVersion: 3,
      revision,
      admissionGeneration: a.admissionGeneration,
      admissionDigest: a.digest,
      routes: a.routes,
      actorMembers: a.actorMembers,
      ingress: [],
      retiredIngress: [],
      bindings: [],
      deliveries: [],
      writerFence: native.fence,
    });
    requireWal(
      !previous ||
        previous.admissionGeneration !== admitted.admissionGeneration ||
        previous.admissionDigest !== admitted.admissionDigest ||
        !equal(previous.routes, admitted.routes) ||
        !equal(previous.actorMembers, admitted.actorMembers),
      'admission-noop'
    );
    const ingress =
      previous?.ingress.filter((record) => {
        const route = previous.routes.find((r) => equal(r.authority, record.authority));
        return route && admitted.routes.some((r) => equal(r, route));
      }) ?? [];
    const active = new Set(ingress.map((r) => r.outboxId));
    const durable = new Set(previous?.deliveries.map((d) => d.outboxId));
    const retired = new Map(
      [...(previous?.retiredIngress ?? []), ...(previous?.ingress ?? [])]
        .filter((r) => !active.has(r.outboxId) && durable.has(r.outboxId))
        .map((r) => [r.outboxId, r])
    );
    return {
      ...admitted,
      ingress,
      retiredIngress: [...retired.values()],
      bindings: previous?.bindings ?? [],
      deliveries: previous?.deliveries ?? [],
    };
  }
  requireWal(previous, 'mutation-needs-predecessor');
  const state = { ...previous, revision, writerFence: native.fence };
  switch (witness.kind) {
    case 'ingress-admitted':
    case 'binding-quarantined': {
      object(witness, ['kind', 'record']);
      const record = decodeOwnerWalIngress(witness.record, state.routes, 2);
      const quarantined = witness.kind === 'binding-quarantined';
      requireWal(
        classifyObservation(state, record) === (quarantined ? 'quarantine' : 'admit'),
        'observation-predecessor'
      );
      return {
        ...state,
        ingress: quarantined ? state.ingress : [...state.ingress, record],
        bindings: [...state.bindings, ingressBinding(record, quarantined)],
      };
    }
    case 'ingress-lease-claimed':
      return claim(state, witness, native);
    case 'ingress-acknowledged': {
      object(witness, ['kind', 'request', 'acknowledgedAtIso']);
      const r = object(witness.request, ['outboxId', 'generation', 'ownerId', 'leaseToken']);
      text(r.outboxId, /^runtime_permission:effect:[0-9a-f]{64}$/u);
      integer(r.generation, 1);
      text(r.ownerId);
      text(r.leaseToken);
      const record = state.ingress.find((item) => item.outboxId === r.outboxId);
      const lease = record?.lease,
        acknowledgedAtIso = iso(witness.acknowledgedAtIso),
        now = Date.parse(acknowledgedAtIso);
      requireWal(
        record &&
          record.acknowledgedAtIso === null &&
          lease &&
          lease.generation === r.generation &&
          lease.ownerId === r.ownerId &&
          lease.leaseToken === r.leaseToken &&
          now >= Date.parse(lease.claimedAtIso) &&
          now < Date.parse(lease.leaseExpiresAtIso),
        'ack-lease-or-replay'
      );
      return {
        ...state,
        ingress: state.ingress.map((item) =>
          item === record ? { ...item, acknowledgedAtIso } : item
        ),
      };
    }
    case 'delivery-started': {
      object(witness, ['kind', 'request']);
      const request = deliveryRequest(witness.request);
      const delivery = deliveryForRequest(state, request, true);
      validateInitialDeliveryOutcome(state, request, delivery);
      return { ...state, deliveries: [...state.deliveries, delivery] }; // full decoder rejects all conflicting identities
    }
    case 'delivery-settled': {
      object(witness, ['kind', 'request', 'delivery']);
      const request = deliveryRequest(witness.request);
      const index = state.deliveries.findIndex(
        (d) => d.providerDeliveryId === request.providerDeliveryId
      );
      const started = deliveryForRequest(state, request, index < 0);
      const delivery = decodeOwnerWalDelivery(witness.delivery, [
        ...state.ingress,
        ...state.retiredIngress,
      ]);
      requireWal(
        native.mutation.kind === 'delivery-settled' &&
          delivery.phase === native.mutation.phase &&
          delivery.result === native.mutation.outcome &&
          equal(delivery, { ...started, phase: delivery.phase, result: delivery.result }),
        'settlement-witness'
      );
      if (index < 0) {
        requireWal(delivery.phase === 'rejected', 'completed-without-start');
        validateInitialDeliveryOutcome(state, request, delivery);
        return { ...state, deliveries: [...state.deliveries, delivery] };
      }
      requireWal(equal(state.deliveries[index], started), 'settlement-predecessor-or-replay');
      requireWal(
        delivery.result === 'delivered' ||
          delivery.result === 'stale_generation' ||
          delivery.result === 'unavailable',
        'started-settlement-outcome'
      );
      return { ...state, deliveries: state.deliveries.map((d, i) => (i === index ? delivery : d)) };
    }
  }
}

function size(
  stored: Record<string, unknown> | null,
  key: (typeof OWNER_WAL_COLLECTIONS)[number]
): number {
  if (!stored || (key === 'bindings' && stored.schemaVersion !== 3)) return 0;
  return key === 'actorMembers'
    ? Object.keys(object(stored[key])).length
    : array(stored[key]).length;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Bound caller-supplied operation/native objects before decoding. Accessors, toJSON,
// cycles and non-JSON values cannot execute code or hide data during serialization.
function boundObject(value: unknown, maximum: number): void {
  let bytes = 0;
  const active = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    requireWal(depth <= 32, 'input-depth');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') {
      requireWal(typeof v !== 'number' || Number.isFinite(v), 'input-number');
      // Avoid allocating an escaped serialization of an already oversized string.
      requireWal(typeof v !== 'string' || v.length <= maximum - bytes, 'input-size');
      bytes += Buffer.byteLength(JSON.stringify(v));
    } else {
      requireWal(v !== null && typeof v === 'object' && !active.has(v), 'input-object');
      active.add(v);
      const keys = Array.isArray(v) ? Object.keys(array(v)) : Object.keys(object(v));
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(v, key)!;
        requireWal(Object.hasOwn(property, 'value'), 'input-accessor');
        if (!Array.isArray(v)) {
          requireWal(key.length <= maximum - bytes, 'input-size');
          bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        }
        visit(property.value, depth + 1);
      }
      active.delete(v);
    }
    requireWal(bytes <= maximum, 'input-size');
  };
  visit(value, 0);
}

/** P2-A: deterministic, bounded P/M/N consistency, with non-null typed success or rejection.
 * This is NOT VerifiedOwnerPublication: bytes cannot prove absence, fsync, a process/fence's
 * authority, operation truth, capture completeness, custody, or admission. P2-B must first
 * parse complete captures with parseNativeRuntimeCapture, resolve each line exactly once,
 * bind witnesses and absence, and join sealed artifacts and replacement-process lineages.
 * No permission D/B preimages or native OpenCode identity are reconstructed here. */
export function verifyOwnerWalImages(
  input: OwnerWalImageVerificationInput
): ValidatedOwnerWalImages {
  object(input, ['previous', 'next', 'native', 'witness']);
  boundObject(input.witness, OWNER_WAL_MAX_BYTES);
  // Necessary payload bound only: the complete canonical envelope/line remains P2-B's input.
  boundObject(input.native, 65_536);
  const p = object(input.previous);
  requireWal(p.kind === 'absent' || p.kind === 'retained', 'predecessor-unavailable');
  object(p, p.kind === 'retained' ? ['kind', 'image'] : ['kind']);
  const previous = input.previous.kind === 'retained' ? decodeImage(input.previous.image) : null;
  const next = decodeImage(input.next);
  requireWal(next.summary.schemaVersion === 3, 'next-schema');
  // N is Owner's JSON.stringify output with one LF; it is not canonical sorted NDJSON.
  requireWal(
    equal(Object.keys(next.stored), OWNER_WAL_FIELDS) &&
      next.source === `${JSON.stringify(next.stored)}\n` &&
      next.summary.byteSize === Buffer.byteLength(next.source),
    'next-serialization'
  );
  const native = parseHostedOwnerWalNative(input.native);
  const delta = native.stateDelta;
  const revision = integer((previous?.summary.revision ?? 0) + 1, 1);
  requireWal(
    next.summary.revision === revision &&
      native.revision === revision &&
      delta.nextRevision === revision &&
      delta.previousRevision === (previous?.summary.revision ?? null),
    'revision'
  );
  requireWal(
    delta.previousStateSha256 === (previous?.summary.sha256 ?? null) &&
      delta.nextStateSha256 === next.summary.sha256 &&
      native.wal.sha256 === next.summary.sha256 &&
      native.wal.byteSize === next.summary.byteSize,
    'native-image-binding'
  );
  // locked() rejects a retained P whose fence differs from the acquired identity;
  // publication injects that same identity into N and the native record.
  requireWal(
    equal(native.fence, next.working.writerFence) &&
      (!previous || equal(previous.working.writerFence, native.fence)),
    'fence'
  );
  const proposal = applyAction(previous?.working ?? null, native, input.witness);
  const compacted = compactOwnerWalState(decodeOwnerWalState(proposal));
  // Owner compares P against the compacted state for metadata, then stores its
  // JSON bytes. This matters for a stored restoreGeneration of -0 becoming 0;
  // payloadJson contents are strings and must never undergo that normalization.
  const serialized = decodeOwnerWalState(JSON.parse(JSON.stringify(compacted)));
  requireWal(equal(serialized, next.working), 'action-compaction');
  const changed = OWNER_WAL_FIELDS.filter(
    (key) =>
      !previous ||
      !Object.hasOwn(previous.stored, key) ||
      !equal(previous.stored[key], compacted[key])
  ).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  requireWal(equal(changed, delta.changedFields), 'changed-fields');
  for (const key of OWNER_WAL_COLLECTIONS)
    requireWal(
      equal(delta.collectionSizes[key], {
        previous: size(previous?.stored ?? null, key),
        next: size(next.stored, key),
      }),
      `collection-${key}`
    );
  return freeze<ValidatedOwnerWalImages>({
    kind: 'validated-owner-wal-images',
    custodyVerified: false,
    native: structuredClone(native),
    previous: previous ? { kind: 'retained', image: previous.summary } : { kind: 'absent' },
    next: { ...next.summary, schemaVersion: 3 },
  });
}

/** Only byte/revision continuity. The caller still proves that both belong to the same WAL
 * lineage, including across shards; neither matching bytes nor revision establishes custody. */
export function verifyOwnerWalImageContinuity(
  before: ValidatedOwnerWalImages,
  after: ValidatedOwnerWalImages
): void {
  requireWal(
    after.previous.kind === 'retained' &&
      before.next.sha256 === after.previous.image.sha256 &&
      before.next.revision === after.previous.image.revision &&
      before.next.byteSize === after.previous.image.byteSize,
    'lineage-gap'
  );
}
