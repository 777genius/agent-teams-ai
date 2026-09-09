import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  HostedOwnerLeaseClaim,
  HostedOwnerWalNative,
} from '../../../src/features/hosted-producer-provenance/contracts';

/** Pure storage vocabulary, pinned to r744's accepted WAL1/2/3 decoder contract.
 * No Owner runtime, filesystem, FFI, or executable-authority dependencies belong here. */
export type OwnerWalLease = Omit<HostedOwnerLeaseClaim, 'outboxId'>;
export type OwnerWalFence = HostedOwnerWalNative['fence'];
export interface OwnerWalAuthority {
  deploymentId: string;
  teamId: string;
  runId: string;
  planGeneration: number;
  laneId: string;
  providerId: 'opencode';
  credentialGeneration: number;
  credentialId: string;
  sessionId: string;
  runtimeInstanceId: string;
  deliveryOwnerId: string;
}
export interface OwnerWalRoute {
  routeId: string;
  authority: OwnerWalAuthority;
  memberName: string;
  scope: {
    principalId: string;
    workspaceId: string;
    teamId: string;
    authorityGeneration: string;
    restoreGeneration: number;
  };
  openCodeBinding: {
    toolApprovalMode: 'manual';
    planGeneration: number;
    credentialGeneration: number;
    credentialId: string;
    runtimeInstanceId: string;
    deliveryOwnerId: string;
    openCodeArtifactDigest?: string;
    sessionRecordFingerprint: string;
    liveEffectFingerprint: string;
  };
}
export interface OwnerWalIngress {
  outboxVersion: 1 | 2;
  outboxId: string;
  commandId: string;
  effectRef: string;
  deliveryRef: string;
  authority: OwnerWalAuthority;
  payloadJson: string;
  observedAtIso: string;
  acceptedAtIso: string;
  lease: OwnerWalLease | null;
  acknowledgedAtIso: string | null;
}
export interface OwnerWalBinding {
  teamId: string;
  runId: string;
  requestId: string;
  effectRef: string | null;
  bindingDigest: string | null;
  quarantined: boolean;
}
export interface OwnerWalDelivery {
  providerDeliveryId: string;
  reconciliationRef: string;
  deliveryRef: string;
  payloadFingerprint: string;
  outboxId: string;
  effectRef: string;
  phase: 'started' | 'completed' | 'rejected';
  result:
    | 'delivered'
    | 'stale_generation'
    | 'expired'
    | 'wrong_lane'
    | 'self_approval'
    | 'unavailable'
    | null;
}
export interface OwnerWalState {
  schemaVersion: 3;
  revision: number;
  admissionGeneration: string;
  admissionDigest: string;
  routes: OwnerWalRoute[];
  actorMembers: Record<string, string>;
  ingress: OwnerWalIngress[];
  retiredIngress: OwnerWalIngress[];
  bindings: OwnerWalBinding[];
  deliveries: OwnerWalDelivery[];
  writerFence: OwnerWalFence;
}
export const OWNER_WAL_MAX_BYTES = 32 * 1024 * 1024;
export const OWNER_WAL_TARGET_BYTES = 24 * 1024 * 1024;
export const OWNER_WAL_COLLECTIONS = [
  'actorMembers',
  'bindings',
  'deliveries',
  'ingress',
  'retiredIngress',
  'routes',
] as const;
export const OWNER_WAL_FIELDS = [
  'schemaVersion',
  'revision',
  'admissionGeneration',
  'admissionDigest',
  'routes',
  'actorMembers',
  'ingress',
  'retiredIngress',
  'bindings',
  'deliveries',
  'writerFence',
] as const;
export const HASH = /^[0-9a-f]{64}$/u;
export const EFFECT = /^effect:[0-9a-f]{64}$/u;
export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
export const ACTOR = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/u;
const TEAM = /^team_[0-9a-f]{32}$/u;
const RUN = /^run_[0-9a-f]{32}$/u;
const MEMBER = /^member_[0-9a-f]{32}$/u;
export const equal = isDeepStrictEqual;
export const hash = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');
export function requireWal(condition: unknown, code: string): asserts condition {
  if (!condition) throw new TypeError(`owner-wal-images:${code}`);
}
export function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  requireWal(value !== null && typeof value === 'object' && !Array.isArray(value), 'object');
  requireWal(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'object-prototype'
  );
  const result = value as Record<string, unknown>;
  const own = Reflect.ownKeys(result);
  requireWal(
    own.every(
      (key) =>
        typeof key === 'string' &&
        Object.getOwnPropertyDescriptor(result, key)?.enumerable &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(result, key)!, 'value')
    ),
    'object-properties'
  );
  if (keys)
    requireWal(
      own.length === keys.length && keys.every((key) => Object.hasOwn(result, key)),
      'keys'
    );
  return result;
}
export function array(value: unknown): unknown[] {
  requireWal(
    Array.isArray(value) &&
      value.length <= OWNER_WAL_MAX_BYTES / 2 &&
      Reflect.ownKeys(value).length === value.length + 1,
    'array'
  );
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, i);
    requireWal(property?.enumerable && Object.hasOwn(property, 'value'), 'array');
  }
  return value;
}
export function text(value: unknown, pattern = ID): string {
  requireWal(typeof value === 'string' && pattern.test(value), 'string');
  return value;
}
export function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  requireWal(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      !Object.is(value, -0) &&
      value >= minimum &&
      value <= maximum,
    'integer'
  );
  return value;
}
// Owner's stored nonnegative integers admit -0. Keep its sign in M; only outer
// JSON serialization normalizes it, while embedded payloadJson stays byte-exact.
function storedNonnegativeInteger(value: unknown): number {
  return Object.is(value, -0) ? -0 : integer(value);
}
export function iso(value: unknown): string {
  requireWal(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value,
    'timestamp'
  );
  return value;
}

/** Validate JSON tokens before JSON.parse can erase duplicate (including escaped) keys.
 * Whitespace/key order and legacy number spelling are intentionally retained in P.
 * All storage schemas have shallow, closed structures; depth 32 is a decoding work bound. */
export function parseOwnerWalJson(source: string): unknown {
  let offset = 0;
  const token = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
  const space = () => {
    while (' \t\r\n'.includes(source[offset] ?? '\0')) offset++;
  };
  const scalar = (): string => {
    if (source[offset] === '"') {
      const start = offset++;
      while (offset < source.length) {
        const c = source[offset++];
        if (c === '"') return source.slice(start, offset);
        requireWal(c.charCodeAt(0) >= 32, 'json-string');
        if (c !== '\\') continue;
        const escaped = source[offset++];
        if (escaped === 'u') {
          requireWal(/^[0-9a-fA-F]{4}$/u.test(source.slice(offset, offset + 4)), 'json-escape');
          offset += 4;
        } else requireWal(escaped !== undefined && '"\\/bfnrt'.includes(escaped), 'json-escape');
      }
      requireWal(false, 'json-string');
    }
    token.lastIndex = offset;
    const match = token.exec(source);
    requireWal(match, 'json-token');
    offset = token.lastIndex;
    return match[0];
  };
  const value = (depth: number): void => {
    requireWal(depth <= 32, 'json-depth');
    space();
    const opening = source[offset];
    if (opening !== '{' && opening !== '[') {
      scalar();
      return;
    }
    offset++;
    space();
    const closing = opening === '{' ? '}' : ']';
    const keys = new Set<string>();
    if (source[offset] === closing) {
      offset++;
      return;
    }
    for (;;) {
      space();
      if (opening === '{') {
        const raw = scalar();
        requireWal(raw.startsWith('"'), 'json-key');
        const key: string = JSON.parse(raw);
        requireWal(!keys.has(key), 'json-duplicate-key');
        keys.add(key);
        space();
        requireWal(source[offset++] === ':', 'json-colon');
      }
      value(depth + 1);
      space();
      if (source[offset] === closing) {
        offset++;
        return;
      }
      requireWal(source[offset++] === ',', 'json-delimiter');
    }
  };
  value(0);
  space();
  requireWal(offset === source.length, 'json-trailing');
  return JSON.parse(source);
}

export function decodeOwnerWalFence(value: unknown): OwnerWalFence {
  const fence = object(value, ['generation', 'dev', 'ino']);
  // Old storage accepts decimal digit strings; native publication requires canonical decimals.
  return {
    generation: text(fence.generation, /^approval-writer-fence_[0-9a-f]{32}$/u),
    dev: text(fence.dev, /^\d+$/u),
    ino: text(fence.ino, /^\d+$/u),
  };
}
function authority(value: unknown, retired: boolean): OwnerWalAuthority {
  const a = object(value, [
    'deploymentId',
    'teamId',
    'runId',
    'planGeneration',
    'laneId',
    'providerId',
    'credentialGeneration',
    'credentialId',
    'sessionId',
    'runtimeInstanceId',
    'deliveryOwnerId',
  ]);
  requireWal(a.providerId === 'opencode', 'provider');
  return {
    deploymentId: text(
      a.deploymentId,
      retired ? /^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/u : ID
    ),
    teamId: text(a.teamId, TEAM),
    runId: text(a.runId, RUN),
    planGeneration: integer(a.planGeneration, 1),
    laneId: text(a.laneId, retired ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u : ID),
    providerId: 'opencode',
    credentialGeneration: integer(a.credentialGeneration, 1),
    credentialId: text(a.credentialId),
    sessionId: text(a.sessionId),
    runtimeInstanceId: text(a.runtimeInstanceId),
    deliveryOwnerId: text(a.deliveryOwnerId, MEMBER),
  };
}
export function decodeOwnerWalRoute(
  value: unknown,
  actors: Record<string, string>,
  legacy = false
): OwnerWalRoute {
  const r = object(value, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding']);
  const a = authority(r.authority, false);
  const s = object(r.scope, [
    'principalId',
    'workspaceId',
    'teamId',
    'authorityGeneration',
    'restoreGeneration',
  ]);
  const bindingKeys = [
    'toolApprovalMode',
    'planGeneration',
    'credentialGeneration',
    'credentialId',
    'runtimeInstanceId',
    'deliveryOwnerId',
    'sessionRecordFingerprint',
    'liveEffectFingerprint',
  ];
  const b = object(
    r.openCodeBinding,
    legacy ? bindingKeys : [...bindingKeys, 'openCodeArtifactDigest']
  );
  requireWal(
    Object.hasOwn(actors, String(s.principalId)) &&
      actors[String(s.principalId)] === a.deliveryOwnerId &&
      s.teamId === a.teamId &&
      b.toolApprovalMode === 'manual',
    'route-scope'
  );
  for (const key of [
    'planGeneration',
    'credentialGeneration',
    'credentialId',
    'runtimeInstanceId',
    'deliveryOwnerId',
  ] as const) {
    requireWal(b[key] === a[key], 'route-binding');
  }
  return {
    routeId: text(r.routeId),
    authority: a,
    memberName: text(r.memberName),
    scope: {
      principalId: text(s.principalId, ACTOR),
      workspaceId: text(s.workspaceId),
      teamId: a.teamId,
      authorityGeneration: text(
        s.authorityGeneration,
        /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u
      ),
      restoreGeneration: storedNonnegativeInteger(s.restoreGeneration),
    },
    openCodeBinding: {
      toolApprovalMode: 'manual',
      planGeneration: a.planGeneration,
      credentialGeneration: a.credentialGeneration,
      credentialId: a.credentialId,
      runtimeInstanceId: a.runtimeInstanceId,
      deliveryOwnerId: a.deliveryOwnerId,
      // v1's absent artifact is never replaced with a fabricated executable identity.
      ...(legacy
        ? {}
        : { openCodeArtifactDigest: text(b.openCodeArtifactDigest, /^sha256:[0-9a-f]{64}$/u) }),
      sessionRecordFingerprint: text(b.sessionRecordFingerprint, HASH),
      liveEffectFingerprint: text(b.liveEffectFingerprint, HASH),
    },
  };
}

/** Local WAL summary grammar, including encoded/Unicode path forms. No redaction:
 * a prohibited summary rejects the image; its retained bytes never get rewritten. */
function validateSummary(value: unknown): void {
  requireWal(
    typeof value === 'string' &&
      Buffer.byteLength(value) <= 2048 &&
      !value.includes('\n') &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    'summary'
  );
  const boundary = String.raw`(?:^|[\s"'\x60()\[\]{}<>,;=:])`;
  const tail = String.raw`(?=$|[\s"'\x60()\[\]{}<>,;])`;
  const path = new RegExp(
    boundary +
      String.raw`(?:` +
      [
        String.raw`(?:cwd|file):(?:/{0,3}|\\+)[^\s"'\x60]*`,
        String.raw`/[^\s"'\x60]*`,
        String.raw`[A-Za-z]:[\\/][^\s"'\x60]*`,
        String.raw`(?:\\\\[?.]\\|\\(?:\?\?|Device|GLOBALROOT)\\)[^\s"'\x60]+`,
        String.raw`\\\\[^\\\s"'\x60]+\\[^\\\s"'\x60]+(?:\\[^\s"'\x60]*)*`,
        String.raw`~(?:[A-Za-z0-9._-]+)?[\\/][^\s"'\x60]*`,
        String.raw`(?:\.\.[\\/])+[^\s"'\x60]*`,
        String.raw`[^\s"'\x60\\/]+[\\/](?:\.\.[\\/])+[^\s"'\x60]*`,
        String.raw`(?:\.?[A-Za-z0-9_~@+-][^\s"'\x60\\/:]*[\\/])+[^\s"'\x60\\/:]+`,
      ].join('|') +
      ')' +
      tail,
    'u'
  );
  let current = value;
  let work = 0;
  for (let i = 0; i < 256; i++) {
    current = current
      .normalize('NFKC')
      .replace(/[\u2215\u2044\u29f8\uff0f]/gu, '/')
      .replace(/[\u2216\u29f5\ufe68\uff3c]/gu, '\\');
    work += current.length;
    requireWal(current.length <= 256 * 1024 && work <= 2 * 1024 * 1024, 'summary-work');
    requireWal(
      !path.test(current.replace(/https?:\/\/[^\s"'\x60()\[\]{}<>,;]+/giu, 'web-url')),
      'summary-path'
    );
    const decoded = current.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (run) => decodeURIComponent(run));
    if (decoded === current) return;
    current = decoded;
  }
  requireWal(false, 'summary-work');
}
export function decodeOwnerWalLease(value: unknown): OwnerWalLease {
  const l = object(value, [
    'generation',
    'ownerId',
    'leaseToken',
    'claimedAtIso',
    'leaseExpiresAtIso',
  ]);
  const claimedAtIso = iso(l.claimedAtIso),
    leaseExpiresAtIso = iso(l.leaseExpiresAtIso);
  requireWal(Date.parse(leaseExpiresAtIso) > Date.parse(claimedAtIso), 'lease-duration');
  return {
    generation: integer(l.generation, 1),
    ownerId: text(l.ownerId),
    leaseToken: text(l.leaseToken),
    claimedAtIso,
    leaseExpiresAtIso,
  };
}
export function decodeOwnerWalIngress(
  value: unknown,
  routes: readonly OwnerWalRoute[] | null,
  version?: 1 | 2
): OwnerWalIngress {
  const r = object(value, [
    'outboxVersion',
    'outboxId',
    'commandId',
    'effectRef',
    'deliveryRef',
    'authority',
    'payloadJson',
    'observedAtIso',
    'acceptedAtIso',
    'lease',
    'acknowledgedAtIso',
  ]);
  requireWal(r.outboxVersion === 1 || r.outboxVersion === 2, 'outbox-version');
  if (version !== undefined) requireWal(r.outboxVersion === version, 'outbox-version');
  const a = authority(r.authority, routes === null || version === 1);
  if (routes)
    requireWal(
      routes.some((route) => equal(route.authority, a)),
      'ingress-route'
    );
  const effectRef = text(r.effectRef, EFFECT);
  const outboxId = text(r.outboxId, /^runtime_permission:effect:[0-9a-f]{64}$/u);
  const deliveryRef = text(r.deliveryRef, /^delivery_ref_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u);
  if (r.outboxVersion === 1)
    requireWal(outboxId === `runtime_permission:${effectRef}`, 'legacy-outbox');
  else
    requireWal(
      deliveryRef ===
        `delivery_ref_opencode-${outboxId.slice('runtime_permission:effect:'.length)}`,
      'private-outbox'
    );
  requireWal(
    typeof r.payloadJson === 'string' && Buffer.byteLength(r.payloadJson) <= 136 * 1024,
    'payload-size'
  );
  const p = object(parseOwnerWalJson(r.payloadJson), [
    'schemaVersion',
    'deliveryRef',
    'category',
    'summary',
    'expiresAtMs',
    'preview',
  ]);
  requireWal(
    p.schemaVersion === 1 &&
      p.deliveryRef === deliveryRef &&
      p.preview === null &&
      ['file_change', 'command', 'network', 'other'].includes(String(p.category)),
    'payload'
  );
  validateSummary(p.summary);
  if (p.expiresAtMs !== null) storedNonnegativeInteger(p.expiresAtMs);
  const observedAtIso = iso(r.observedAtIso),
    acceptedAtIso = iso(r.acceptedAtIso);
  requireWal(Date.parse(acceptedAtIso) >= Date.parse(observedAtIso), 'accepted-time');
  const lease = r.lease === null ? null : decodeOwnerWalLease(r.lease);
  const acknowledgedAtIso = r.acknowledgedAtIso === null ? null : iso(r.acknowledgedAtIso);
  if (acknowledgedAtIso !== null)
    requireWal(lease && Date.parse(acknowledgedAtIso) >= Date.parse(acceptedAtIso), 'ack-time');
  return {
    outboxVersion: r.outboxVersion,
    outboxId,
    commandId: text(r.commandId),
    effectRef,
    deliveryRef,
    authority: a,
    payloadJson: r.payloadJson,
    observedAtIso,
    acceptedAtIso,
    lease,
    acknowledgedAtIso,
  };
}
export function decodeOwnerWalBinding(value: unknown): OwnerWalBinding {
  const b = object(value, [
    'teamId',
    'runId',
    'requestId',
    'effectRef',
    'bindingDigest',
    'quarantined',
  ]);
  requireWal(typeof b.quarantined === 'boolean', 'quarantine');
  const effectRef = b.effectRef === null ? null : text(b.effectRef, EFFECT);
  const bindingDigest = b.bindingDigest === null ? null : text(b.bindingDigest, HASH);
  requireWal(
    (effectRef !== null && bindingDigest !== null) ||
      (effectRef === null && bindingDigest === null && b.quarantined),
    'tombstone'
  );
  return {
    teamId: text(b.teamId, TEAM),
    runId: text(b.runId, RUN),
    requestId: text(b.requestId),
    effectRef,
    bindingDigest,
    quarantined: b.quarantined,
  };
}
export function decodeOwnerWalDelivery(
  value: unknown,
  records: readonly OwnerWalIngress[]
): OwnerWalDelivery {
  const d = object(value, [
    'providerDeliveryId',
    'reconciliationRef',
    'deliveryRef',
    'payloadFingerprint',
    'outboxId',
    'effectRef',
    'phase',
    'result',
  ]);
  const record = records.find((r) => r.outboxId === d.outboxId);
  requireWal(
    record && record.deliveryRef === d.deliveryRef && record.effectRef === d.effectRef,
    'delivery-binding'
  );
  requireWal(
    d.phase === 'started' || d.phase === 'completed' || d.phase === 'rejected',
    'delivery-phase'
  );
  requireWal(
    d.result === null ||
      d.result === 'delivered' ||
      d.result === 'stale_generation' ||
      d.result === 'expired' ||
      d.result === 'wrong_lane' ||
      d.result === 'self_approval' ||
      d.result === 'unavailable',
    'delivery-result'
  );
  requireWal(
    d.phase === 'started'
      ? d.result === null
      : d.phase === 'completed'
        ? d.result === 'delivered'
        : d.result !== null && d.result !== 'delivered',
    'delivery-outcome'
  );
  return {
    providerDeliveryId: text(d.providerDeliveryId),
    reconciliationRef: text(
      d.reconciliationRef,
      /^approval-reconciliation_[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u
    ),
    deliveryRef: record.deliveryRef,
    payloadFingerprint: text(d.payloadFingerprint, HASH),
    outboxId: record.outboxId,
    effectRef: record.effectRef,
    phase: d.phase,
    result: d.result,
  };
}
export const bindingTuple = (b: Pick<OwnerWalBinding, 'teamId' | 'runId' | 'requestId'>): string =>
  [b.teamId, b.runId, b.requestId].join('\0');
export function ingressBinding(r: OwnerWalIngress, quarantined: boolean): OwnerWalBinding {
  const legacy = r.outboxVersion === 1; // Composite legacy effects cannot supply D or B.
  return {
    teamId: r.authority.teamId,
    runId: r.authority.runId,
    requestId: r.commandId,
    effectRef: legacy ? null : r.effectRef,
    bindingDigest: legacy ? null : r.outboxId.slice('runtime_permission:effect:'.length),
    quarantined: legacy || quarantined,
  };
}
function unique(values: readonly unknown[]): void {
  requireWal(new Set(values).size === values.length, 'duplicate-identity');
}

/** Returns M, never a replacement for the stored representation used in P's delta. */
export function decodeOwnerWalState(value: unknown): OwnerWalState {
  const s = object(value);
  const version = integer(s.schemaVersion, 1, 3);
  object(s, version === 3 ? OWNER_WAL_FIELDS : OWNER_WAL_FIELDS.filter((k) => k !== 'bindings'));
  const actors = object(s.actorMembers);
  const actorMembers: Record<string, string> = {};
  for (const [actor, member] of Object.entries(actors))
    actorMembers[text(actor, ACTOR)] = text(member, MEMBER);
  const routes = array(s.routes).map((r) => decodeOwnerWalRoute(r, actorMembers, version === 1));
  if (version !== 1) {
    unique(routes.map((r) => r.routeId));
    unique(routes.map((r) => r.authority.sessionId));
  }
  const ingress = array(s.ingress).map((r) =>
    decodeOwnerWalIngress(
      r,
      version === 1 ? null : routes,
      version === 1 ? undefined : version === 2 ? 1 : 2
    )
  );
  const retiredIngress = array(s.retiredIngress).map((r) =>
    decodeOwnerWalIngress(r, null, version === 2 ? 1 : undefined)
  );
  const all = [...ingress, ...retiredIngress];
  if (version === 1)
    requireWal(
      all.every((r) => routes.some((route) => equal(route.authority, r.authority))),
      'legacy-route'
    );
  const deliveries = array(s.deliveries).map((d) => decodeOwnerWalDelivery(d, all));
  unique(all.map((r) => r.outboxId));
  unique(all.map((r) => r.deliveryRef));
  for (const key of ['providerDeliveryId', 'reconciliationRef', 'deliveryRef', 'outboxId'] as const)
    unique(deliveries.map((d) => d[key]));
  if (version === 2) unique(deliveries.map((d) => d.effectRef));
  const common = {
    revision: integer(s.revision, 1),
    admissionGeneration: text(
      s.admissionGeneration,
      /^approval-admission-generation_[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/u
    ),
    admissionDigest: text(s.admissionDigest, HASH),
    writerFence: decodeOwnerWalFence(s.writerFence),
  };
  if (version !== 3) {
    const referenced = new Set(deliveries.map((d) => d.outboxId));
    const tombstones = new Map<string, OwnerWalBinding>();
    for (const record of all) {
      const tombstone = { ...ingressBinding(record, true), effectRef: null, bindingDigest: null };
      tombstones.set(bindingTuple(tombstone), tombstone);
    }
    const migrated: OwnerWalState = {
      schemaVersion: 3,
      ...common,
      routes: [],
      actorMembers: {},
      ingress: [],
      retiredIngress: all.filter((r) => referenced.has(r.outboxId)),
      bindings: [...tombstones.values()],
      deliveries,
    };
    // r744 preserves the distinct compatibility paths: v2 revalidates M, v1 does not.
    return version === 2 ? decodeOwnerWalState(migrated) : migrated;
  }
  const bindings = array(s.bindings).map(decodeOwnerWalBinding);
  const exposed = new Map<string, OwnerWalBinding>();
  const tombstones = new Set<string>();
  unique(
    bindings.map((b) =>
      JSON.stringify([b.teamId, b.runId, b.requestId, b.effectRef, b.bindingDigest])
    )
  );
  unique(bindings.filter((b) => b.bindingDigest !== null).map((b) => b.bindingDigest));
  for (const b of bindings) {
    if (b.effectRef === null) tombstones.add(bindingTuple(b));
    if (!b.quarantined) {
      const key = `${bindingTuple(b)}\0${b.effectRef}`;
      requireWal(!exposed.has(key), 'duplicate-exposure');
      exposed.set(key, b);
    }
  }
  requireWal(
    [...exposed.values()].every((b) => !tombstones.has(bindingTuple(b))),
    'tombstone-exposure'
  );
  for (const r of all) {
    const b = ingressBinding(r, false),
      tuple = bindingTuple(b);
    if (r.outboxVersion === 1) requireWal(tombstones.has(tuple), 'legacy-binding');
    else requireWal(equal(exposed.get(`${tuple}\0${r.effectRef}`), b), 'private-binding');
  }
  requireWal(
    ingress.every((r) => !tombstones.has(bindingTuple(ingressBinding(r, false)))),
    'tombstone-ingress'
  );
  return {
    schemaVersion: 3,
    revision: common.revision,
    admissionGeneration: common.admissionGeneration,
    admissionDigest: common.admissionDigest,
    routes,
    actorMembers,
    ingress,
    retiredIngress,
    bindings,
    deliveries,
    writerFence: common.writerFence,
  };
}

/** The two exact r744 compaction passes. Bindings and legacy/started delivery evidence
 * survive both. Byte budget excludes the later serialization LF, as in Owner. */
export function compactOwnerWalState(state: OwnerWalState): OwnerWalState {
  const legacyOutbox = new Set(
    state.retiredIngress.filter((r) => r.outboxVersion === 1).map((r) => r.outboxId)
  );
  const legacy = new Set(
    state.deliveries.filter((d) => legacyOutbox.has(d.outboxId)).map((d) => d.outboxId)
  );
  const terminal = new Set(
    state.deliveries
      .filter((d) => d.phase !== 'started')
      .slice(-2048)
      .map((d) => d.outboxId)
  );
  const active = new Set(
    state.deliveries.filter((d) => d.phase === 'started').map((d) => d.outboxId)
  );
  const ack = state.ingress
    .filter((r) => r.acknowledgedAtIso !== null)
    .slice(-2048)
    .map((r) => r.outboxId);
  const retained = new Set([...terminal, ...active, ...legacy, ...ack]);
  let result = {
    ...state,
    ingress: state.ingress.filter((r) => r.acknowledgedAtIso === null || retained.has(r.outboxId)),
    retiredIngress: state.retiredIngress.filter((r) => retained.has(r.outboxId)),
    deliveries: state.deliveries.filter(
      (d) => d.phase === 'started' || terminal.has(d.outboxId) || legacy.has(d.outboxId)
    ),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > OWNER_WAL_TARGET_BYTES) {
    result = {
      ...result,
      ingress: result.ingress.filter((r) => r.acknowledgedAtIso === null || active.has(r.outboxId)),
      retiredIngress: result.retiredIngress.filter(
        (r) => active.has(r.outboxId) || legacy.has(r.outboxId)
      ),
      deliveries: result.deliveries.filter((d) => d.phase === 'started' || legacy.has(d.outboxId)),
    };
    requireWal(
      Buffer.byteLength(JSON.stringify(result)) <= OWNER_WAL_TARGET_BYTES,
      'active-budget'
    );
  }
  return result;
}
