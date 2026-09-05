import type {
  HostedOwnerLeaseClaim,
  HostedOwnerMutation,
  HostedOwnerWalNative,
} from '@features/hosted-producer-provenance/contracts';

const HEX_64 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const WRITER_FENCE = /^approval-writer-fence_[0-9a-f]{32}$/u;
const ISO_MILLIS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const COLLECTION_KEYS = Object.freeze([
  'actorMembers',
  'bindings',
  'deliveries',
  'ingress',
  'retiredIngress',
  'routes',
] as const);
const OWNER_STATE_FIELDS = Object.freeze([
  'actorMembers',
  'admissionDigest',
  'admissionGeneration',
  'bindings',
  'deliveries',
  'ingress',
  'retiredIngress',
  'revision',
  'routes',
  'schemaVersion',
  'writerFence',
] as const);

function fail(): never {
  throw new TypeError('producer-provenance-native-owner-wal');
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const item = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(item);
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(item, key))
  ) {
    fail();
  }
  return item;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
}

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value >= 1;
}

function parseClaim(value: unknown): HostedOwnerLeaseClaim {
  const claim = exactObject(value, [
    'claimedAtIso',
    'generation',
    'leaseExpiresAtIso',
    'leaseToken',
    'outboxId',
    'ownerId',
  ]);
  if (
    typeof claim.claimedAtIso !== 'string' ||
    !ISO_MILLIS.test(claim.claimedAtIso) ||
    !positiveSafeInteger(claim.generation) ||
    typeof claim.leaseExpiresAtIso !== 'string' ||
    !ISO_MILLIS.test(claim.leaseExpiresAtIso) ||
    typeof claim.leaseToken !== 'string' ||
    !SAFE_ID.test(claim.leaseToken) ||
    typeof claim.outboxId !== 'string' ||
    !SAFE_ID.test(claim.outboxId) ||
    typeof claim.ownerId !== 'string' ||
    !SAFE_ID.test(claim.ownerId)
  ) {
    fail();
  }
  return claim as unknown as HostedOwnerLeaseClaim;
}

function parseMutation(value: unknown): HostedOwnerMutation {
  const mutation = exactObject(
    value,
    (value as { kind?: unknown })?.kind === 'ingress-lease-claimed'
      ? ['claims', 'kind', 'outcome']
      : (value as { kind?: unknown })?.kind === 'delivery-settled'
        ? ['kind', 'outcome', 'phase']
        : ['kind', 'outcome']
  );
  const simple = {
    'admission-reconciled': 'published',
    'binding-quarantined': 'quarantined',
    'delivery-started': 'started',
    'ingress-acknowledged': 'acknowledged',
    'ingress-admitted': 'admitted',
  } as const;
  if (
    typeof mutation.kind === 'string' &&
    typeof mutation.outcome === 'string' &&
    Object.prototype.hasOwnProperty.call(simple, mutation.kind) &&
    simple[mutation.kind as keyof typeof simple] === mutation.outcome
  ) {
    return mutation as unknown as HostedOwnerMutation;
  }
  if (
    mutation.kind === 'ingress-lease-claimed' &&
    mutation.outcome === 'claimed' &&
    Array.isArray(mutation.claims) &&
    mutation.claims.length > 0
  ) {
    for (let index = 0; index < mutation.claims.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(mutation.claims, index)) fail();
      parseClaim(mutation.claims[index]);
    }
    return mutation as unknown as HostedOwnerMutation;
  }
  if (
    mutation.kind === 'delivery-settled' &&
    ((mutation.phase === 'completed' && mutation.outcome === 'delivered') ||
      (mutation.phase === 'rejected' &&
        ['stale_generation', 'expired', 'wrong_lane', 'self_approval', 'unavailable'].includes(
          mutation.outcome as string
        )))
  ) {
    return mutation as unknown as HostedOwnerMutation;
  }
  return fail();
}

function unsignedUtf8Compare(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

/** Strict shape/domain validation only. Exact P/M/N image semantics remain a P2 obligation. */
export function parseHostedOwnerWalNative(value: unknown): HostedOwnerWalNative {
  const native = exactObject(value, ['fence', 'mutation', 'revision', 'stateDelta', 'wal']);
  const fence = exactObject(native.fence, ['dev', 'generation', 'ino']);
  const wal = exactObject(native.wal, ['byteSize', 'sha256']);
  const delta = exactObject(native.stateDelta, [
    'changedFields',
    'collectionSizes',
    'nextRevision',
    'nextStateSha256',
    'previousRevision',
    'previousStateSha256',
  ]);
  const collectionSizes = exactObject(delta.collectionSizes, COLLECTION_KEYS);
  for (const key of COLLECTION_KEYS) {
    const pair = exactObject(collectionSizes[key], ['next', 'previous']);
    if (!nonNegativeSafeInteger(pair.previous) || !nonNegativeSafeInteger(pair.next)) fail();
  }
  if (!Array.isArray(delta.changedFields) || delta.changedFields.length === 0) fail();
  for (let index = 0; index < delta.changedFields.length; index += 1) {
    const field = delta.changedFields[index];
    if (!(OWNER_STATE_FIELDS as readonly unknown[]).includes(field)) fail();
    if (
      index > 0 &&
      unsignedUtf8Compare(delta.changedFields[index - 1] as string, field as string) >= 0
    ) {
      fail();
    }
  }
  if (!delta.changedFields.includes('revision')) fail();
  const previousRevision = delta.previousRevision;
  const previousHash = delta.previousStateSha256;
  const absent = previousRevision === null && previousHash === null;
  if (
    (!absent && (!nonNegativeSafeInteger(previousRevision) || typeof previousHash !== 'string')) ||
    (previousRevision === null) !== (previousHash === null) ||
    (typeof previousHash === 'string' && !HEX_64.test(previousHash)) ||
    !positiveSafeInteger(delta.nextRevision) ||
    !positiveSafeInteger(native.revision) ||
    delta.nextRevision !== native.revision ||
    (absent ? delta.nextRevision !== 1 : delta.nextRevision !== (previousRevision as number) + 1) ||
    typeof delta.nextStateSha256 !== 'string' ||
    !HEX_64.test(delta.nextStateSha256) ||
    !positiveSafeInteger(wal.byteSize) ||
    typeof wal.sha256 !== 'string' ||
    !HEX_64.test(wal.sha256) ||
    wal.sha256 !== delta.nextStateSha256 ||
    typeof fence.dev !== 'string' ||
    !DECIMAL.test(fence.dev) ||
    typeof fence.generation !== 'string' ||
    !WRITER_FENCE.test(fence.generation) ||
    typeof fence.ino !== 'string' ||
    !DECIMAL.test(fence.ino)
  ) {
    fail();
  }
  if (absent) {
    if (delta.changedFields.length !== OWNER_STATE_FIELDS.length) fail();
    for (const key of COLLECTION_KEYS) {
      if ((collectionSizes[key] as Record<string, unknown>).previous !== 0) fail();
    }
  }
  const mutation = parseMutation(native.mutation);
  if (mutation.kind === 'binding-quarantined') {
    const bindings = collectionSizes.bindings as Record<string, unknown>;
    if (
      !delta.changedFields.includes('bindings') ||
      bindings.next !== (bindings.previous as number) + 1
    ) {
      fail();
    }
  }
  return native as unknown as HostedOwnerWalNative;
}
