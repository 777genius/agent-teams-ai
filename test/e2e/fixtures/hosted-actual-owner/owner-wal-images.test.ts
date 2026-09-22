import { describe, expect, it } from 'vitest';

import {
  decodeOwnerWalState,
  OWNER_WAL_MAX_BYTES,
} from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-image-state';
import {
  verifyOwnerWalImageContinuity,
  verifyOwnerWalImages,
} from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-images';

import {
  ACK_AT,
  ackWitness,
  admission,
  binding,
  claimWitness,
  delivery,
  digest,
  emptyState,
  hex,
  image,
  ingress,
  jsonImage,
  leased,
  legacy,
  nextState,
  pair,
  payloadExpiry,
  request,
  route,
  state,
} from './owner-wal-images.fixtures';

import type {
  OwnerWalDelivery,
  OwnerWalIngress,
} from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-image-state';
import type {
  OwnerWalImageVerificationInput,
  OwnerWalMutationWitness,
} from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-images';
import type { HostedOwnerMutation } from '../../../../src/features/hosted-producer-provenance/contracts';

const admissionMutation = { kind: 'admission-reconciled', outcome: 'published' } as const;
const ingressMutation = { kind: 'ingress-admitted', outcome: 'admitted' } as const;
const quarantineMutation = { kind: 'binding-quarantined', outcome: 'quarantined' } as const;
const ackMutation = { kind: 'ingress-acknowledged', outcome: 'acknowledged' } as const;
const startMutation = { kind: 'delivery-started', outcome: 'started' } as const;
const completedMutation = {
  kind: 'delivery-settled',
  phase: 'completed',
  outcome: 'delivered',
} as const;
const rejectedResults = [
  'stale_generation',
  'expired',
  'wrong_lane',
  'self_approval',
  'unavailable',
] as const;
function startCase(decision: 'allow' | 'deny' | 'timeout' = 'allow') {
  const p = state(),
    req = request(p.ingress[0], decision),
    d = delivery(p.ingress[0], req);
  const n = nextState(p, { deliveries: [d] });
  return {
    p,
    n,
    req,
    d,
    input: pair(jsonImage(p), n, startMutation, { kind: 'delivery-started', request: req }),
  };
}
function admittedCase() {
  const p = emptyState(),
    record = ingress(),
    n = nextState(p, { ingress: [record], bindings: [binding(record)] });
  return {
    p,
    n,
    record,
    input: pair(jsonImage(p), n, ingressMutation, { kind: 'ingress-admitted', record }),
  };
}
function recreated(record: OwnerWalIngress, n = 9000): OwnerWalIngress {
  return {
    ...ingress(n),
    commandId: record.commandId,
    effectRef: record.effectRef,
    authority: record.authority,
  };
}
function claimMutation(records: OwnerWalIngress[]): HostedOwnerMutation {
  return {
    kind: 'ingress-lease-claimed',
    outcome: 'claimed',
    claims: records.map((r) => ({ outboxId: r.outboxId, ...r.lease! })),
  };
}
function changeNextBytes(input: ReturnType<typeof pair>, source: string): ReturnType<typeof pair> {
  const next = image(Buffer.from(source));
  return {
    ...input,
    next,
    native: {
      ...input.native,
      wal: { byteSize: next.byteSize, sha256: next.sha256 },
      stateDelta: { ...input.native.stateDelta, nextStateSha256: next.sha256 },
    },
  };
}
function accepts(input: OwnerWalImageVerificationInput) {
  const result = verifyOwnerWalImages(input);
  expect(result.kind).toBe('validated-owner-wal-images');
  expect(result.custodyVerified).toBe(false);
  expect(result.next.sha256).toBe(digest(input.next.bytes));
  return result;
}

describe('r744 P2-A exact stored P, migrated M, compacted N', () => {
  it('validates initial absence and all eleven fields, without granting custody or publication authority', () => {
    const n = emptyState(),
      input = pair(null, n, admissionMutation, admission(n));
    const result = accepts(input);
    expect(input.native.stateDelta.changedFields).toEqual([
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
    ]);
    expect(result.previous).toEqual({ kind: 'absent' });
    expect(Object.keys(result)).toEqual(['kind', 'custodyVerified', 'native', 'previous', 'next']);
    expect(Object.isFrozen(result.native.stateDelta.collectionSizes)).toBe(true);
    Object.assign(input.native.wal, { sha256: hex(6) });
    expect(result.native.wal.sha256).toBe(result.next.sha256);
  });

  it.each([1, 2] as const)(
    'migrates complete WAL%s into reconciliation, using stored counts and opaque legacy history',
    (version) => {
      const { stored, reconciled } = legacy(version);
      const raw = image(Buffer.from(` \n${JSON.stringify(stored, null, 2)}\r\n`));
      const input = pair(raw, reconciled, admissionMutation, admission(reconciled));
      const result = accepts(input),
        m = decodeOwnerWalState(stored);
      expect(m.revision).toBe(7);
      expect(m.routes).toEqual([]);
      expect(m.actorMembers).toEqual({});
      expect(m.ingress).toEqual([]);
      expect(m.retiredIngress).toHaveLength(2);
      expect(m.deliveries).toHaveLength(2);
      expect(m.bindings).toHaveLength(3);
      expect(decodeOwnerWalState(m)).toEqual(m);
      expect(
        m.bindings.every((b) => b.effectRef === null && b.bindingDigest === null && b.quarantined)
      ).toBe(true);
      expect(m.retiredIngress.map((r) => r.effectRef)).toEqual([
        stored.ingress[0].effectRef,
        stored.retiredIngress[0].effectRef,
      ]);
      expect(result.previous).toEqual({
        kind: 'retained',
        image: { byteSize: raw.byteSize, sha256: raw.sha256, revision: 7, schemaVersion: version },
      });
      expect(input.native.stateDelta.collectionSizes).toEqual({
        actorMembers: { previous: 2, next: 2 },
        bindings: { previous: 0, next: 3 },
        deliveries: { previous: 2, next: 2 },
        ingress: { previous: 2, next: 0 },
        retiredIngress: { previous: 1, next: 2 },
        routes: { previous: 1, next: 1 },
      });
      expect(input.native.stateDelta.changedFields).toEqual(
        version === 2
          ? ['bindings', 'ingress', 'retiredIngress', 'revision', 'schemaVersion']
          : ['bindings', 'ingress', 'retiredIngress', 'revision', 'routes', 'schemaVersion']
      );
      expect(() =>
        verifyOwnerWalImages({
          ...input,
          native: {
            ...input.native,
            stateDelta: { ...input.native.stateDelta, previousStateSha256: jsonImage(m).sha256 },
          },
        })
      ).toThrow('native-image-binding');
      expect(() =>
        verifyOwnerWalImages({
          ...input,
          native: {
            ...input.native,
            stateDelta: {
              ...input.native.stateDelta,
              collectionSizes: {
                ...input.native.stateDelta.collectionSizes,
                ingress: { previous: 0, next: 0 },
              },
            },
          },
        })
      ).toThrow('collection-ingress');
    }
  );

  it('keeps missing legacy bindings distinct from stored empty bindings, including zero tuples', () => {
    const { stored, reconciled } = legacy(2);
    stored.ingress = [];
    stored.retiredIngress = [];
    stored.deliveries = [];
    reconciled.retiredIngress = [];
    reconciled.bindings = [];
    reconciled.deliveries = [];
    const input = pair(jsonImage(stored), reconciled, admissionMutation, admission(reconciled));
    accepts(input);
    expect(input.native.stateDelta.collectionSizes.bindings).toEqual({ previous: 0, next: 0 });
    expect(input.native.stateDelta.changedFields).toEqual([
      'bindings',
      'revision',
      'schemaVersion',
    ]);
  });

  it.each(['started', 'completed', 'rejected'] as const)(
    'preserves legacy %s evidence and unstarted tuples without reconstructing delivery requests',
    (phase) => {
      const { stored, reconciled } = legacy(2);
      stored.deliveries[0].phase = phase;
      stored.deliveries[0].result =
        phase === 'started' ? null : phase === 'completed' ? 'delivered' : 'unavailable';
      accepts(pair(jsonImage(stored), reconciled, admissionMutation, admission(reconciled)));
      expect(reconciled.deliveries[0].payloadFingerprint).toBe('f'.repeat(64));
      expect(reconciled.bindings).toHaveLength(3); // includes the second, never-started record
      const req = request(stored.ingress[0]);
      expect(() =>
        verifyOwnerWalImages(
          pair(jsonImage(reconciled), nextState(reconciled, {}), startMutation, {
            kind: 'delivery-started',
            request: req,
          })
        )
      ).toThrow('delivery-request-binding');
    }
  );

  it('does not turn a same-empty-admission legacy read into a migration publication', () => {
    const { stored, reconciled } = legacy(2);
    stored.routes = [];
    stored.actorMembers = {};
    stored.ingress = [];
    stored.retiredIngress = [];
    stored.deliveries = [];
    Object.assign(reconciled, {
      routes: [],
      actorMembers: {},
      retiredIngress: [],
      deliveries: [],
      bindings: [],
    });
    expect(decodeOwnerWalState(stored).schemaVersion).toBe(3);
    expect(stored.schemaVersion).toBe(2);
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(stored), reconciled, admissionMutation, admission(reconciled))
      )
    ).toThrow('admission-noop');
  });

  it('uses revoked history own authority and forbids schema2 v2 masquerades, missing tombstones, and reconstructed D/B', () => {
    const { stored, reconciled } = legacy(2);
    expect(stored.retiredIngress[0].authority.credentialId).toBe('credential_old');
    accepts(pair(jsonImage(stored), reconciled, admissionMutation, admission(reconciled)));
    for (const key of ['ingress', 'retiredIngress'] as const) {
      const bad = structuredClone(stored);
      bad[key][0].outboxVersion = 2;
      expect(() => decodeOwnerWalState(bad)).toThrow('outbox-version');
    }
    const missing = structuredClone(reconciled);
    missing.bindings.pop();
    expect(() => decodeOwnerWalState(missing)).toThrow('legacy-binding');
    const invented = structuredClone(reconciled);
    invented.bindings[0] = binding(stored.ingress[0]);
    expect(() => decodeOwnerWalState(invented)).toThrow('legacy-binding');
    const omittedDiscarded = structuredClone(reconciled);
    omittedDiscarded.bindings.splice(1, 1);
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(stored), omittedDiscarded, admissionMutation, admission(reconciled))
      )
    ).toThrow('action-compaction');
    const old = legacy(1).stored;
    old.retiredIngress[0].authority.credentialId = 'credential_rotated';
    expect(() => decodeOwnerWalState(old)).toThrow('legacy-route');
  });

  it('retains exact whitespace, key order, UTF-8 and final LF in hashes, but rejects nonserialized N', () => {
    const { p, n, input } = admittedCase();
    const reordered = Object.fromEntries(Object.entries(p).reverse());
    const raw = image(Buffer.from(`\t${JSON.stringify(reordered, null, 1)}\r\n `));
    accepts(pair(raw, n, ingressMutation, input.witness));
    const bom = image(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(p))])
    );
    accepts({
      ...input,
      previous: { kind: 'retained', image: bom },
      native: {
        ...input.native,
        stateDelta: { ...input.native.stateDelta, previousStateSha256: bom.sha256 },
      },
    });
    const wrongRawHash = { ...raw, sha256: jsonImage(p).sha256 };
    expect(() =>
      verifyOwnerWalImages({ ...input, previous: { kind: 'retained', image: wrongRawHash } })
    ).toThrow('image-hash');
    for (const source of [
      JSON.stringify(n),
      `${JSON.stringify(n)}\n\n`,
      `${JSON.stringify(n, null, 2)}\n`,
      `${JSON.stringify(Object.fromEntries(Object.entries(n).reverse()))}\n`,
      JSON.stringify(n).replace('"revision":2', '"revision":2.0') + '\n',
      JSON.stringify(n).replace('"revision":2', '"revision":2e0') + '\n',
    ]) {
      expect(() => verifyOwnerWalImages(changeNextBytes(input, source))).toThrow(
        'next-serialization'
      );
    }
    const record = {
      ...ingress(),
      payloadJson: ingress().payloadJson.replace('Run tests', 'Run Ω tests'),
    };
    const unicode = pair(
      jsonImage(p),
      nextState(p, { ingress: [record], bindings: [binding(record)] }),
      ingressMutation,
      { kind: 'ingress-admitted', record }
    );
    accepts(unicode);
    expect(unicode.next.byteSize).toBeGreaterThan(
      Buffer.from(unicode.next.bytes).toString('utf8').length
    );
    expect(() =>
      verifyOwnerWalImages({
        ...unicode,
        next: {
          ...unicode.next,
          byteSize: Buffer.from(unicode.next.bytes).toString('utf8').length,
        },
      })
    ).toThrow('image-bytes');
  });

  it('accepts legacy numeric spelling only as exact P bytes; rejects unsafe numeric domains', () => {
    const { stored, reconciled } = legacy(2);
    const raw = image(
      Buffer.from(JSON.stringify(stored).replace('"revision":7', '"revision":7e0'))
    );
    accepts(pair(raw, reconciled, admissionMutation, admission(reconciled)));
    for (const revision of [0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(() => decodeOwnerWalState({ ...state(), revision })).toThrow();
    }
    const p = state();
    p.revision = Number.MAX_SAFE_INTEGER;
    const req = request(p.ingress[0]);
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(p), { ...p, deliveries: [delivery(p.ingress[0], req)] }, startMutation, {
          kind: 'delivery-started',
          request: req,
        })
      )
    ).toThrow();
  });

  it.each([1, 2] as const)(
    'preserves Owner-accepted expiresAtMs number tokens through WAL%s migration and reconciliation',
    (version) => {
      for (const token of ['-0', '-0e0', '0', '0e0', '1.0', '9007199254740991']) {
        const { stored, reconciled } = legacy(version);
        stored.ingress[0] = payloadExpiry(stored.ingress[0], token);
        stored.retiredIngress[0] = payloadExpiry(stored.retiredIngress[0], token);
        reconciled.retiredIngress = [stored.ingress[0], stored.retiredIngress[0]];
        stored.deliveries = stored.deliveries.map((d) => {
          const record = reconciled.retiredIngress.find((r) => r.outboxId === d.outboxId)!;
          return { ...d, payloadFingerprint: delivery(record).payloadFingerprint };
        });
        reconciled.deliveries = stored.deliveries;
        const raw = image(Buffer.from(` \n${JSON.stringify(stored, null, 2)}\r\n`));
        const input = pair(raw, reconciled, admissionMutation, admission(reconciled));
        const m = decodeOwnerWalState(JSON.parse(Buffer.from(raw.bytes).toString('utf8')));
        expect(m.retiredIngress.map((r) => r.payloadJson)).toEqual(
          reconciled.retiredIngress.map((r) => r.payloadJson)
        );
        expect(m.retiredIngress[0].payloadJson).toContain(`"expiresAtMs":${token}`);
        accepts(input);
        expect(input.native.stateDelta.previousStateSha256).toBe(digest(raw.bytes));
        expect(input.native.stateDelta.collectionSizes.retiredIngress).toEqual({
          previous: 1,
          next: 2,
        });
        const normalized = structuredClone(reconciled);
        normalized.retiredIngress[0].payloadJson = JSON.stringify(
          JSON.parse(normalized.retiredIngress[0].payloadJson)
        );
        if (normalized.retiredIngress[0].payloadJson !== stored.ingress[0].payloadJson) {
          expect(() =>
            verifyOwnerWalImages(pair(raw, normalized, admissionMutation, admission(reconciled)))
          ).toThrow('action-compaction');
        }
      }
    }
  );

  it('accepts the same stored numeric domain in modern active and retired ingress', () => {
    for (const token of ['-0', '-0e0', '0', '1', '9007199254740991']) {
      const p = state(2);
      p.ingress = p.ingress.map((r) => payloadExpiry(r, token));
      p.retiredIngress = [p.ingress.pop()!];
      p.deliveries = [
        { ...delivery(p.retiredIngress[0]), phase: 'completed', result: 'delivered' },
      ];
      const n = nextState(p, { admissionDigest: hex(99) });
      accepts(pair(jsonImage(p), n, admissionMutation, admission(n)));
      expect(decodeOwnerWalState(p).ingress[0].payloadJson).toBe(p.ingress[0].payloadJson);
      expect(decodeOwnerWalState(p).retiredIngress[0].payloadJson).toBe(
        p.retiredIngress[0].payloadJson
      );
    }
    for (const version of [1, 2, 3] as const) {
      for (const token of ['-1', '0.5', '9007199254740992', '1e309', '"0"', 'false']) {
        const p = version === 3 ? state() : legacy(version).stored;
        p.ingress[0] = payloadExpiry(p.ingress[0], token);
        expect(() => decodeOwnerWalState(p)).toThrow('integer');
      }
    }
  });

  it('matches stored restoreGeneration -0 and Owner metadata before outer JSON normalizes it', () => {
    const p = state();
    p.routes[0].scope.restoreGeneration = -0;
    const raw = image(
      Buffer.from(JSON.stringify(p).replace('"restoreGeneration":0', '"restoreGeneration":-0'))
    );
    const m = decodeOwnerWalState(JSON.parse(Buffer.from(raw.bytes).toString('utf8')));
    expect(Object.is(m.routes[0].scope.restoreGeneration, -0)).toBe(true);
    const req = request(m.ingress[0]);
    const n = nextState(m, { deliveries: [delivery(m.ingress[0], req)] });
    const input = pair(raw, n, startMutation, { kind: 'delivery-started', request: req });
    expect(input.native.stateDelta.changedFields).toEqual(['deliveries', 'revision']);
    expect(Buffer.from(input.next.bytes).toString('utf8')).toContain('"restoreGeneration":0');
    accepts(input);
    for (const restoreGeneration of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      const invalid = state();
      invalid.routes[0].scope.restoreGeneration = restoreGeneration;
      expect(() => decodeOwnerWalState(invalid)).toThrow('integer');
    }
  });
});

describe('complete stored schema rejection, before trusting deltas', () => {
  it.each([
    ['malformed UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['truncated JSON', Buffer.from('{"schemaVersion":3')],
    ['trailing JSON', Buffer.from('{} {}')],
    ['synthetic wal-record', Buffer.from('{"kind":"wal-record","fsynced":true}')],
    ['two-field legacy', Buffer.from('{"revision":1,"ingress":[]}')],
    ['zero bytes', Buffer.alloc(0)],
  ] as const)('rejects %s', (_label, raw) => {
    expect(() =>
      verifyOwnerWalImages({
        ...startCase().input,
        previous: { kind: 'retained', image: image(raw) },
      })
    ).toThrow();
  });

  it('rejects escaped duplicate keys at every JSON boundary', () => {
    const source = JSON.stringify(state());
    const duplicates = [
      source.replace('"revision":1', '"revision":1,"revis\\u0069on":1'),
      source.replace('"routeId":"route_1"', '"routeId":"route_1","routeId":"route_1"'),
      source.replace('"quarantined":false', '"quarantined":false,"quarantined":false'),
    ];
    for (const raw of duplicates)
      expect(() =>
        verifyOwnerWalImages({
          ...startCase().input,
          previous: { kind: 'retained', image: image(Buffer.from(raw)) },
        })
      ).toThrow('json-duplicate-key');
    const payload = state();
    payload.ingress[0].payloadJson = payload.ingress[0].payloadJson.replace(
      '"preview":null',
      '"preview":null,"preview":null'
    );
    expect(() => decodeOwnerWalState(payload)).toThrow('json-duplicate-key');
  });

  it('requires every stored collection, permitting absent bindings only in legacy schemas', () => {
    for (const version of [1, 2, 3] as const) {
      const s = version === 3 ? state() : legacy(version).stored;
      for (const key of ['routes', 'actorMembers', 'ingress', 'retiredIngress', 'deliveries']) {
        const missing = { ...s };
        Reflect.deleteProperty(missing, key);
        expect(() => decodeOwnerWalState(missing)).toThrow('keys');
        expect(() => decodeOwnerWalState({ ...s, [key]: null })).toThrow();
      }
    }
    for (const bindings of [null, {}, undefined])
      expect(() => decodeOwnerWalState({ ...state(), bindings })).toThrow();
    expect(() => decodeOwnerWalState({ ...legacy(2).stored, bindings: [] })).toThrow('keys');
    const missing = { ...state() };
    Reflect.deleteProperty(missing, 'bindings');
    expect(() => decodeOwnerWalState(missing)).toThrow('keys');
  });

  it('closes every nested schema, checks real route/artifact/actor links and delivery identities', () => {
    const fixtures = [state(), startCase().n];
    for (const p of fixtures) {
      p.ingress[0] = leased(p.ingress[0]);
      for (const pick of [
        () => p,
        () => p.routes[0],
        () => p.routes[0].authority,
        () => p.routes[0].scope,
        () => p.routes[0].openCodeBinding,
        () => p.writerFence,
        () => p.ingress[0],
        () => p.ingress[0].lease!,
        () => p.bindings[0],
        ...(p.deliveries.length ? [() => p.deliveries[0]] : []),
      ]) {
        Object.assign(pick(), { unexpected: 1 });
        expect(() => decodeOwnerWalState(p)).toThrow('keys');
        Reflect.deleteProperty(pick(), 'unexpected');
      }
    }
    const actor = state();
    actor.actorMembers.actor_owner = `member_${'9'.repeat(32)}`;
    expect(() => decodeOwnerWalState(actor)).toThrow('route-scope');
    const artifact = state();
    delete artifact.routes[0].openCodeBinding.openCodeArtifactDigest;
    expect(() => decodeOwnerWalState(artifact)).toThrow('keys');
    const authority = state();
    authority.ingress[0].authority.credentialGeneration++;
    expect(() => decodeOwnerWalState(authority)).toThrow('ingress-route');
    const badDelivery = startCase().n;
    badDelivery.deliveries[0].effectRef = `effect:${hex(8)}`;
    expect(() => decodeOwnerWalState(badDelivery)).toThrow('delivery-binding');
    const duplicate = state();
    duplicate.retiredIngress.push(duplicate.ingress[0]);
    expect(() => decodeOwnerWalState(duplicate)).toThrow('duplicate-identity');
    const duplicateRoute = state();
    duplicateRoute.routes.push({ ...duplicateRoute.routes[0], routeId: 'route_other' });
    expect(() => decodeOwnerWalState(duplicateRoute)).toThrow('duplicate-identity');
  });

  it('validates payload string exactly and rejects encoded/private paths and wrong payload bindings', () => {
    for (const summary of [
      'look ../private/key',
      'prefix% %2e%2e%2fprivate%2fkey',
      'inspect %252e%252e%255cprivate%255ckey',
      'inspect C:\\private\\key',
      'inspect /custom-root/key',
      'inspect src/private',
      'line\nbreak',
      'x'.repeat(2049),
    ]) {
      const p = state(),
        body = JSON.parse(p.ingress[0].payloadJson);
      body.summary = summary;
      p.ingress[0].payloadJson = JSON.stringify(body);
      expect(() => decodeOwnerWalState(p)).toThrow();
    }
    const p = state();
    p.ingress[0].payloadJson = p.ingress[0].payloadJson.replace(
      'Run tests',
      'See https://example.test/help'
    );
    expect(() => decodeOwnerWalState(p)).not.toThrow();
    for (const patch of [
      { extra: 1 },
      { deliveryRef: 'delivery_ref_wrong' },
      { preview: {} },
      { expiresAtMs: -1 },
      { category: 'secret' },
    ]) {
      const bad = state();
      bad.ingress[0].payloadJson = JSON.stringify({
        ...JSON.parse(bad.ingress[0].payloadJson),
        ...patch,
      });
      expect(() => decodeOwnerWalState(bad)).toThrow();
    }
    const started = startCase();
    const modified = structuredClone(started.n);
    modified.ingress[0].payloadJson += ' ';
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(started.p), modified, startMutation, started.input.witness)
      )
    ).toThrow('action-compaction');
  });

  it('enforces B uniqueness, exposure uniqueness, tombstone exclusion and exact prefixes', () => {
    const p = state(),
      r = p.ingress[0];
    const distinct = state();
    distinct.bindings.push({
      ...binding(r),
      runId: `run_${'9'.repeat(32)}`,
      bindingDigest: hex(9),
    });
    expect(() => decodeOwnerWalState(distinct)).not.toThrow(); // same D, distinct run/B is valid
    for (const extra of [
      { ...binding(r), bindingDigest: hex(8) },
      { ...binding(r), runId: `run_${'8'.repeat(32)}` },
      { ...binding(r, true), effectRef: null, bindingDigest: null },
      { ...binding(r, true), effectRef: null },
    ]) {
      expect(() => decodeOwnerWalState({ ...p, bindings: [...p.bindings, extra] })).toThrow();
    }
    for (const outboxId of [`${'x'.repeat(26)}${hex(1)}`, `runtime_permission:effect:${hex(2)}`]) {
      const bad = state();
      bad.ingress[0].outboxId = outboxId;
      expect(() => decodeOwnerWalState(bad)).toThrow();
    }
    const missing = state();
    missing.bindings = [];
    expect(() => decodeOwnerWalState(missing)).toThrow('private-binding');
  });
});

describe('all twelve honest mutation alternatives and nonpublication boundaries', () => {
  it('admits one ingress/binding pair and rejects reordered or unrelated state changes', () => {
    const { input } = admittedCase();
    accepts(input);
    const p = state(),
      record = ingress(2),
      witness: OwnerWalMutationWitness = { kind: 'ingress-admitted', record };
    const n = nextState(p, {
      ingress: [...p.ingress, record],
      bindings: [...p.bindings, binding(record)],
    });
    accepts(pair(jsonImage(p), n, ingressMutation, witness));
    const reordered = { ...n, ingress: [...n.ingress].reverse() };
    expect(() =>
      verifyOwnerWalImages(pair(jsonImage(p), reordered, ingressMutation, witness))
    ).toThrow('action-compaction');
    const modified = {
      ...n,
      actorMembers: { ...n.actorMembers, actor_extra: `member_${'7'.repeat(32)}` },
    };
    expect(() =>
      verifyOwnerWalImages(pair(jsonImage(p), modified, ingressMutation, witness))
    ).toThrow('action-compaction');
  });

  it('admits the same semantic D with distinct B and complete authority in another run', () => {
    const p = state(),
      second = route();
    second.routeId = 'route_2';
    second.authority.sessionId = 'session_2';
    second.authority.runId = `run_${'9'.repeat(32)}`;
    p.routes.push(second);
    const record = {
      ...ingress(2, second),
      commandId: p.ingress[0].commandId,
      effectRef: p.ingress[0].effectRef,
    };
    accepts(
      pair(
        jsonImage(p),
        nextState(p, {
          ingress: [...p.ingress, record],
          bindings: [...p.bindings, binding(record)],
        }),
        ingressMutation,
        { kind: 'ingress-admitted', record }
      )
    );
  });

  it('reconciles exact route survival/retirement without resurrecting or deleting durable records', () => {
    const p = state(3);
    p.deliveries = [delivery(p.ingress[0])];
    const n = nextState(p, {
      admissionDigest: hex(99),
      routes: [],
      actorMembers: {},
      ingress: [],
      retiredIngress: [p.ingress[0]],
    });
    accepts(pair(jsonImage(p), n, admissionMutation, admission(n)));
    const bad = { ...n, retiredIngress: [p.ingress[1]] };
    expect(() =>
      verifyOwnerWalImages(pair(jsonImage(p), bad, admissionMutation, admission(n)))
    ).toThrow('delivery-binding');
    const surviving = nextState(p, { admissionDigest: hex(100) });
    accepts(pair(jsonImage(p), surviving, admissionMutation, admission(surviving)));
    expect(() =>
      verifyOwnerWalImages(pair(jsonImage(p), nextState(p, {}), admissionMutation, admission(p)))
    ).toThrow('admission-noop');
  });

  it('quarantines only under same tuple/semantic or a legacy tombstone and never replays a publication', () => {
    const p = state(),
      record = recreated(p.ingress[0]);
    const n = nextState(p, { bindings: [...p.bindings, binding(record, true)] });
    accepts(pair(jsonImage(p), n, quarantineMutation, { kind: 'binding-quarantined', record }));
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(p), n, ingressMutation, { kind: 'ingress-admitted', record })
      )
    ).toThrow('observation-predecessor');
    const noPrior = emptyState();
    expect(() =>
      verifyOwnerWalImages(
        pair(
          jsonImage(noPrior),
          nextState(noPrior, { bindings: [binding(record, true)] }),
          quarantineMutation,
          { kind: 'binding-quarantined', record }
        )
      )
    ).toThrow('observation-predecessor');
    for (const badRecord of [
      { ...record, commandId: 'different_request' },
      { ...record, effectRef: `effect:${hex(66)}` },
    ]) {
      expect(() =>
        verifyOwnerWalImages(
          pair(
            jsonImage(p),
            nextState(p, { bindings: [...p.bindings, binding(badRecord, true)] }),
            quarantineMutation,
            { kind: 'binding-quarantined', record: badRecord }
          )
        )
      ).toThrow('observation-predecessor');
    }
    const tombstone = emptyState();
    tombstone.bindings = [{ ...binding(record, true), effectRef: null, bindingDigest: null }];
    const q = nextState(tombstone, { bindings: [...tombstone.bindings, binding(record, true)] });
    accepts(
      pair(jsonImage(tombstone), q, quarantineMutation, { kind: 'binding-quarantined', record })
    );
    const repeat = nextState(n, {});
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(n), repeat, ingressMutation, { kind: 'ingress-admitted', record })
      )
    ).toThrow('binding-replay');
    const compacted = emptyState();
    compacted.bindings = p.bindings;
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(compacted), nextState(compacted, {}), ingressMutation, {
          kind: 'ingress-admitted',
          record: p.ingress[0],
        })
      )
    ).toThrow('binding-replay');
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(p), nextState(p, {}), ingressMutation, {
          kind: 'ingress-admitted',
          record: { ...p.ingress[0], payloadJson: p.ingress[0].payloadJson + ' ' },
        })
      )
    ).toThrow('ingress-conflict');
  });

  it('claims the ordered prefix, excludes reused live leases, and validates exact generations/order', () => {
    const p = state(3);
    p.ingress[0] = leased(p.ingress[0]);
    const changed = p.ingress.slice(1).map((r) => leased(r));
    const n = nextState(p, { ingress: [p.ingress[0], ...changed] });
    const mutation = claimMutation(changed),
      witness = claimWitness();
    const input = pair(jsonImage(p), n, mutation, witness);
    accepts(input);
    expect(() =>
      verifyOwnerWalImages({
        ...input,
        native: { ...input.native, mutation: claimMutation(n.ingress) },
      })
    ).toThrow('changed-claims');
    expect(() =>
      verifyOwnerWalImages({
        ...input,
        native: { ...input.native, mutation: claimMutation([...changed].reverse()) },
      })
    ).toThrow('changed-claims');
    const skipped = structuredClone(n);
    Object.assign(skipped.ingress[1].lease!, { generation: 3 });
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(p), skipped, claimMutation(skipped.ingress.slice(1)), witness)
      )
    ).toThrow('changed-claims');
    const blocked = structuredClone(p);
    Object.assign(blocked.ingress[0].lease!, { ownerId: 'other_owner' });
    expect(() => verifyOwnerWalImages(pair(jsonImage(blocked), n, mutation, witness))).toThrow(
      'changed-claims'
    );
    const bounded = { ...witness, maximumAggregateBytes: 2 };
    expect(() => verifyOwnerWalImages(pair(jsonImage(p), n, mutation, bounded))).toThrow(
      'changed-claims'
    );
    const one = { ...witness, request: { ...witness.request, limit: 1 } };
    expect(() => verifyOwnerWalImages(pair(jsonImage(p), n, mutation, one))).toThrow(
      'changed-claims'
    );
    expect(() =>
      verifyOwnerWalImages({
        ...input,
        witness: { ...witness, request: { ...witness.request, limit: 101 } },
      })
    ).toThrow('integer');
  });

  it('reclaims expired leases and forbids live replacement or generation overflow', () => {
    const p = state();
    p.ingress[0] = leased(p.ingress[0]);
    const witness = { ...claimWitness(), claimedAtIso: '2026-08-13T10:01:01.000Z' };
    const r = {
      ...p.ingress[0],
      lease: {
        ...p.ingress[0].lease!,
        generation: 2,
        claimedAtIso: witness.claimedAtIso,
        leaseExpiresAtIso: '2026-08-13T10:02:01.000Z',
      },
    };
    accepts(pair(jsonImage(p), nextState(p, { ingress: [r] }), claimMutation([r]), witness));
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(p), nextState(p, { ingress: [r] }), claimMutation([r]), claimWitness())
      )
    ).toThrow('changed-claims');
    Object.assign(p.ingress[0].lease!, { generation: Number.MAX_SAFE_INTEGER });
    expect(() =>
      verifyOwnerWalImages(
        pair(jsonImage(p), nextState(p, { ingress: [r] }), claimMutation([r]), witness)
      )
    ).toThrow('integer');
  });

  it('acknowledges exactly one live matching lease and rejects expiry, tokens and replay', () => {
    const p = state();
    p.ingress[0] = leased(p.ingress[0]);
    const witness = ackWitness(p.ingress[0]),
      n = nextState(p, { ingress: [{ ...p.ingress[0], acknowledgedAtIso: ACK_AT }] });
    const input = pair(jsonImage(p), n, ackMutation, witness);
    accepts(input);
    for (const patch of [
      { generation: 2 },
      { ownerId: 'other' },
      { leaseToken: 'wrong' },
      { outboxId: ingress(99).outboxId },
    ]) {
      expect(() =>
        verifyOwnerWalImages({
          ...input,
          witness: { ...witness, request: { ...witness.request, ...patch } },
        })
      ).toThrow('ack-lease-or-replay');
    }
    expect(() =>
      verifyOwnerWalImages({
        ...input,
        witness: { ...witness, acknowledgedAtIso: p.ingress[0].lease!.leaseExpiresAtIso },
      })
    ).toThrow('ack-lease-or-replay');
    expect(() =>
      verifyOwnerWalImages(pair(jsonImage(n), nextState(n, {}), ackMutation, witness))
    ).toThrow('ack-lease-or-replay');
  });

  it.each(['allow', 'deny', 'timeout'] as const)(
    'validates start and completed/delivered for %s, never a fabricated terminal',
    (decision) => {
      const { n, req, d, input } = startCase(decision),
        first = accepts(input);
      const terminal: OwnerWalDelivery = { ...d, phase: 'completed', result: 'delivered' };
      const next = nextState(n, { deliveries: [terminal] });
      const settled = pair(jsonImage(n), next, completedMutation, {
        kind: 'delivery-settled',
        request: req,
        delivery: terminal,
      });
      const second = accepts(settled);
      verifyOwnerWalImageContinuity(first, second);
      const noStart = state();
      expect(() =>
        verifyOwnerWalImages(
          pair(
            jsonImage(noStart),
            nextState(noStart, { deliveries: [terminal] }),
            completedMutation,
            settled.witness
          )
        )
      ).toThrow('completed-without-start');
      expect(() =>
        verifyOwnerWalImages(
          pair(jsonImage(next), nextState(next, {}), completedMutation, settled.witness)
        )
      ).toThrow('settlement-predecessor-or-replay');
      expect(() =>
        verifyOwnerWalImages(pair(jsonImage(n), nextState(n, {}), startMutation, input.witness))
      ).toThrow('duplicate-identity');
    }
  );

  it.each(rejectedResults)(
    'checks actual Service reachability for rejected/%s insertion and started transition',
    (outcome) => {
      const { p, n, req, d } = startCase();
      const directRequest = {
        ...req,
        principal:
          outcome === 'self_approval' || outcome === 'unavailable'
            ? {
                kind: 'operator' as const,
                actorId: outcome === 'self_approval' ? 'actor_owner' : 'actor_missing',
              }
            : req.principal,
      };
      if (outcome === 'expired') {
        p.ingress[0] = payloadExpiry(p.ingress[0], '0');
      }
      const terminal: OwnerWalDelivery = {
        ...delivery(p.ingress[0], directRequest),
        phase: 'rejected',
        result: outcome,
      };
      const mutation = { kind: 'delivery-settled', phase: 'rejected', outcome } as const;
      const witness: OwnerWalMutationWitness = {
        kind: 'delivery-settled',
        request: directRequest,
        delivery: terminal,
      };
      const direct = pair(
        jsonImage(p),
        nextState(p, { deliveries: [terminal] }),
        mutation,
        witness
      );
      if (outcome === 'stale_generation' || outcome === 'wrong_lane') {
        // Stale binding returns without publication; exact binding rules out wrong_lane.
        expect(() => verifyOwnerWalImages(direct)).toThrow('direct-rejection-precondition');
      } else accepts(direct);
      const settled: OwnerWalDelivery = { ...d, phase: 'rejected', result: outcome };
      const settledWitness: OwnerWalMutationWitness = {
        kind: 'delivery-settled',
        request: req,
        delivery: settled,
      };
      const transition = pair(
        jsonImage(n),
        nextState(n, { deliveries: [settled] }),
        mutation,
        settledWitness
      );
      if (outcome === 'stale_generation' || outcome === 'unavailable') accepts(transition);
      else expect(() => verifyOwnerWalImages(transition)).toThrow('started-settlement-outcome');
      expect(() =>
        verifyOwnerWalImages(
          pair(
            jsonImage(n),
            nextState(n, { deliveries: [settled] }),
            completedMutation,
            settledWitness
          )
        )
      ).toThrow('settlement-witness');
    }
  );

  it.each(['allow', 'deny'] as const)(
    'rejects coherent self/unmapped %s starts and requires the matching direct rejection',
    (decision) => {
      for (const actorId of ['actor_owner', 'actor_alias', 'actor_missing']) {
        const p = state();
        p.actorMembers.actor_alias = p.routes[0].authority.deliveryOwnerId;
        const req = {
          ...request(p.ingress[0], decision),
          principal: { kind: 'operator' as const, actorId },
        };
        const d = delivery(p.ingress[0], req);
        const input = pair(jsonImage(p), nextState(p, { deliveries: [d] }), startMutation, {
          kind: 'delivery-started',
          request: req,
        });
        expect(d.payloadFingerprint).toBe(digest(JSON.stringify(req)));
        expect(input.native.wal.sha256).toBe(digest(input.next.bytes));
        expect(input.native.stateDelta.changedFields).toEqual(['deliveries', 'revision']);
        expect(() => verifyOwnerWalImages(input)).toThrow('delivery-start-actor');
        const expected = actorId === 'actor_missing' ? 'unavailable' : 'self_approval';
        for (const outcome of rejectedResults) {
          const terminal: OwnerWalDelivery = { ...d, phase: 'rejected', result: outcome };
          const direct = pair(
            jsonImage(p),
            nextState(p, { deliveries: [terminal] }),
            { kind: 'delivery-settled', phase: 'rejected', outcome },
            { kind: 'delivery-settled', request: req, delivery: terminal }
          );
          if (outcome === expected) accepts(direct);
          else expect(() => verifyOwnerWalImages(direct)).toThrow('direct-rejection-precondition');
        }
      }
    }
  );

  it('uses member equality and preserves timeout system principals and expiry precedence', () => {
    const p = state();
    delete p.actorMembers.actor_operator;
    p.actorMembers.actor_reviewer = `member_${'9'.repeat(32)}`;
    for (const decision of ['allow', 'deny', 'timeout'] as const) {
      const original = request(p.ingress[0], decision);
      const req = {
        ...original,
        principal:
          decision === 'timeout'
            ? original.principal
            : { kind: 'operator' as const, actorId: 'actor_reviewer' },
      };
      const d = delivery(p.ingress[0], req);
      accepts(
        pair(jsonImage(p), nextState(p, { deliveries: [d] }), startMutation, {
          kind: 'delivery-started',
          request: req,
        })
      );
      const invalidPrincipal = {
        ...req,
        principal:
          decision === 'timeout'
            ? { kind: 'operator' as const, actorId: 'actor_reviewer' }
            : { kind: 'system_timeout' as const },
      };
      expect(() =>
        verifyOwnerWalImages(
          pair(
            jsonImage(p),
            nextState(p, { deliveries: [delivery(p.ingress[0], invalidPrincipal)] }),
            startMutation,
            { kind: 'delivery-started', request: invalidPrincipal }
          )
        )
      ).toThrow('principal');
      for (const outcome of ['self_approval', 'unavailable', 'expired'] as const) {
        const terminal: OwnerWalDelivery = { ...d, phase: 'rejected', result: outcome };
        expect(() =>
          verifyOwnerWalImages(
            pair(
              jsonImage(p),
              nextState(p, { deliveries: [terminal] }),
              { kind: 'delivery-settled', phase: 'rejected', outcome },
              { kind: 'delivery-settled', request: req, delivery: terminal }
            )
          )
        ).toThrow('direct-rejection-precondition');
      }
    }
    // Expiry runs before actor mapping, and also applies to system_timeout.
    p.ingress[0] = payloadExpiry(p.ingress[0], '-0');
    for (const principal of [
      { kind: 'operator', actorId: 'actor_owner' },
      { kind: 'operator', actorId: 'actor_missing' },
      { kind: 'system_timeout' },
    ] as const) {
      const req = {
        ...request(p.ingress[0], principal.kind === 'operator' ? 'deny' : 'timeout'),
        principal,
      };
      const terminal: OwnerWalDelivery = {
        ...delivery(p.ingress[0], req),
        phase: 'rejected',
        result: 'expired',
      };
      accepts(
        pair(
          jsonImage(p),
          nextState(p, { deliveries: [terminal] }),
          { kind: 'delivery-settled', phase: 'rejected', outcome: 'expired' },
          { kind: 'delivery-settled', request: req, delivery: terminal }
        )
      );
    }
  });

  it('joins the original delivery request, D generation and B delivery; checks all durable delivery identity fields', () => {
    const { input, p, n, req } = startCase();
    for (const patch of [
      { approvalId: `approval_${'a'.repeat(32)}` },
      { approvalGeneration: `generation_runtime-permission-${hex(1)}` },
      { partition: { ...req.partition, runId: `run_${'9'.repeat(32)}` } },
      { requestId: 'wrong' },
      { providerDeliveryId: 'different' },
      { reconciliationRef: 'approval-reconciliation_other' },
      { decision: 'deny' as const },
    ]) {
      expect(() =>
        verifyOwnerWalImages({
          ...input,
          witness: { kind: 'delivery-started', request: { ...req, ...patch } },
        })
      ).toThrow();
    }
    const reordered = Object.fromEntries(Object.entries(req).reverse()) as typeof req;
    accepts({ ...input, witness: { kind: 'delivery-started', request: reordered } });
    for (const field of [
      'providerDeliveryId',
      'reconciliationRef',
      'deliveryRef',
      'payloadFingerprint',
      'outboxId',
      'effectRef',
    ] as const) {
      const bad = structuredClone(n);
      bad.deliveries[0][field] = field === 'payloadFingerprint' ? hex(7) : 'wrong';
      expect(() =>
        verifyOwnerWalImages(pair(jsonImage(p), bad, startMutation, input.witness))
      ).toThrow();
    }
  });
});

describe('exact compaction, including erased acknowledgement and terminal targets', () => {
  it('validates an acknowledgement erased at the 2048 boundary only with its actual witness', () => {
    const p = state(2049);
    p.ingress = p.ingress.map((r, i) => leased(r, i > 0));
    const n = nextState(p, { ingress: p.ingress.slice(1) });
    const input = pair(jsonImage(p), n, ackMutation, ackWitness(p.ingress[0]));
    accepts(input);
    expect(input.native.stateDelta.collectionSizes.ingress).toEqual({ previous: 2049, next: 2048 });
    expect(n.bindings).toHaveLength(2049);
    expect(() =>
      verifyOwnerWalImages({ ...input, witness: { kind: 'ingress-acknowledged' } as never })
    ).toThrow('keys');
    const wrong = { ...ackWitness(p.ingress[0]), acknowledgedAtIso: '2026-08-13T09:59:59.000Z' };
    expect(() => verifyOwnerWalImages({ ...input, witness: wrong })).toThrow('ack-lease-or-replay');
    const retained = nextState(p, {
      ingress: [{ ...p.ingress[0], acknowledgedAtIso: ACK_AT }, ...p.ingress.slice(1)],
    });
    expect(() =>
      verifyOwnerWalImages(pair(jsonImage(p), retained, ackMutation, input.witness))
    ).toThrow('action-compaction');
  });

  it.each(['delivered', 'unavailable'] as const)(
    'requires actual %s result even when the terminal delivery is compacted away',
    (result) => {
      const p = state(2049),
        req = request(p.ingress[0]);
      p.deliveries = p.ingress.map((r, i) =>
        i === 0 ? delivery(r) : { ...delivery(r), phase: 'completed', result: 'delivered' }
      );
      const terminal: OwnerWalDelivery = {
        ...p.deliveries[0],
        phase: result === 'delivered' ? 'completed' : 'rejected',
        result,
      };
      const mutation: HostedOwnerMutation =
        result === 'delivered'
          ? completedMutation
          : { kind: 'delivery-settled', phase: 'rejected', outcome: result };
      const n = nextState(p, { deliveries: p.deliveries.slice(1) });
      const input = pair(jsonImage(p), n, mutation, {
        kind: 'delivery-settled',
        request: req,
        delivery: terminal,
      });
      accepts(input);
      expect(n.ingress).toHaveLength(2049); // pending ingress is never discarded with its terminal delivery
      expect(() =>
        verifyOwnerWalImages({
          ...input,
          witness: { kind: 'delivery-settled', request: req } as never,
        })
      ).toThrow('keys');
      expect(() =>
        verifyOwnerWalImages({
          ...input,
          witness: {
            kind: 'delivery-settled',
            request: req,
            delivery: { ...terminal, reconciliationRef: 'approval-reconciliation_wrong' },
          },
        })
      ).toThrow('settlement-witness');
    }
  );

  it('includes compaction deltas on quarantine and claim and preserves all bindings', () => {
    const p = state(2050);
    p.ingress = p.ingress.map((r, i) => (i === 2049 ? r : leased(r, true)));
    const observed = recreated(p.ingress[0]);
    const q = nextState(p, {
      ingress: p.ingress.slice(1),
      bindings: [...p.bindings, binding(observed, true)],
    });
    const input = pair(jsonImage(p), q, quarantineMutation, {
      kind: 'binding-quarantined',
      record: observed,
    });
    accepts(input);
    expect(input.native.stateDelta.changedFields).toEqual(['bindings', 'ingress', 'revision']);
    const claimed = leased(p.ingress[2049]),
      n = nextState(p, { ingress: [...p.ingress.slice(1, -1), claimed] });
    accepts(pair(jsonImage(p), n, claimMutation([claimed]), claimWitness()));
    const deletedBinding = { ...q, bindings: q.bindings.slice(1) };
    expect(() =>
      verifyOwnerWalImages(pair(jsonImage(p), deletedBinding, quarantineMutation, input.witness))
    ).toThrow();
  });

  it('applies the 24 MiB pass exactly, protecting started and terminal legacy evidence', () => {
    const p = state(195);
    p.ingress = p.ingress.map((r) => ({
      ...leased(r, true),
      payloadJson: `${r.payloadJson}${' '.repeat(130 * 1024)}`,
    }));
    p.deliveries = [delivery(p.ingress[0])];
    const old = legacy(2).reconciled,
      legacyRecord = old.retiredIngress[1];
    p.retiredIngress = [legacyRecord];
    p.deliveries.push(old.deliveries[1]);
    // This legacy tuple must be distinct from every modern exposure.
    legacyRecord.authority = { ...legacyRecord.authority, runId: `run_${'f'.repeat(32)}` };
    p.bindings.push({ ...binding(legacyRecord, true), effectRef: null, bindingDigest: null });
    const observed = recreated(p.ingress[1]);
    const n = nextState(p, {
      ingress: [p.ingress[0]],
      bindings: [...p.bindings, binding(observed, true)],
    });
    accepts(
      pair(jsonImage(p), n, quarantineMutation, { kind: 'binding-quarantined', record: observed })
    );
    expect(n.retiredIngress).toHaveLength(1);
    expect(n.deliveries).toHaveLength(2);
    const active = structuredClone(p);
    active.ingress = active.ingress.map((r) => ({ ...r, acknowledgedAtIso: null }));
    expect(() =>
      verifyOwnerWalImages(
        pair(
          jsonImage(active),
          nextState(active, { bindings: [...active.bindings, binding(observed, true)] }),
          quarantineMutation,
          { kind: 'binding-quarantined', record: observed }
        )
      )
    ).toThrow('active-budget');
  });
});

describe('native/image metadata and pure continuity fail closed', () => {
  it('distinguishes unavailable, empty, and a retained predecessor from an absence assertion', () => {
    const { input } = startCase();
    expect(() => verifyOwnerWalImages({ ...input, previous: { kind: 'unavailable' } })).toThrow(
      'predecessor-unavailable'
    );
    expect(() =>
      verifyOwnerWalImages({
        ...input,
        previous: { kind: 'retained', image: image(Buffer.alloc(0)) },
      })
    ).toThrow('integer');
    expect(() => verifyOwnerWalImages({ ...input, previous: { kind: 'absent' } })).toThrow(
      'revision'
    );
    const n = emptyState();
    expect(() =>
      verifyOwnerWalImages({
        ...pair(null, n, admissionMutation, admission(n)),
        previous: { kind: 'absent', fsynced: true } as never,
      })
    ).toThrow('keys');
  });

  it('rejects schema-open native values, missing/extra counts, wrong revisions/fence and all dishonest variants', () => {
    const { input } = startCase(),
      native = input.native;
    const invalid: unknown[] = [
      { ...native, extra: true },
      { ...native, revision: native.revision + 1 },
      { ...native, revision: -0 },
      { ...native, fence: { ...native.fence, dev: '01' } },
      { ...native, fence: { ...native.fence, ino: '9' } },
      { ...native, stateDelta: { ...native.stateDelta, previousRevision: 0 } },
      { ...native, stateDelta: { ...native.stateDelta, previousRevision: -0 } },
      { ...native, stateDelta: { ...native.stateDelta, nextRevision: -0 } },
      { ...native, stateDelta: { ...native.stateDelta, previousStateSha256: null } },
      { ...native, wal: { ...native.wal, byteSize: native.wal.byteSize + 1 } },
      { ...native, wal: { ...native.wal, byteSize: -0 } },
    ];
    for (const mutation of [
      { kind: 'migration', outcome: 'published' },
      { kind: 'replay', outcome: 'published' },
      { kind: 'conflict', outcome: 'published' },
      { kind: 'operator_required', outcome: 'published' },
      { kind: 'binding-quarantined', outcome: 'admitted' },
      { kind: 'delivery-settled', phase: 'completed', outcome: 'unavailable' },
    ]) {
      invalid.push({ ...native, mutation });
    }
    for (const key of [
      'actorMembers',
      'bindings',
      'deliveries',
      'ingress',
      'retiredIngress',
      'routes',
    ] as const) {
      const sizes = { ...native.stateDelta.collectionSizes };
      Reflect.deleteProperty(sizes, key);
      invalid.push({ ...native, stateDelta: { ...native.stateDelta, collectionSizes: sizes } });
      for (const side of ['previous', 'next'] as const) {
        invalid.push({
          ...native,
          stateDelta: {
            ...native.stateDelta,
            collectionSizes: {
              ...native.stateDelta.collectionSizes,
              [key]: { ...native.stateDelta.collectionSizes[key], [side]: -0 },
            },
          },
        });
      }
      invalid.push({
        ...native,
        stateDelta: {
          ...native.stateDelta,
          collectionSizes: {
            ...native.stateDelta.collectionSizes,
            [key]: {
              ...native.stateDelta.collectionSizes[key],
              next: native.stateDelta.collectionSizes[key].next + 1,
            },
          },
        },
      });
    }
    for (const changedFields of [
      ['revision'],
      ['deliveries', 'revision', 'revision'],
      ['revision', 'deliveries'],
      ['bindings', 'deliveries', 'revision'],
    ]) {
      invalid.push({ ...native, stateDelta: { ...native.stateDelta, changedFields } });
    }
    for (const bad of invalid)
      expect(() => verifyOwnerWalImages({ ...input, native: bad })).toThrow();
  });

  it('rejects same-size byte substitution and out-of-bound images, even with apparently valid metadata', () => {
    const { input } = startCase();
    const bytes = Buffer.from(input.next.bytes);
    bytes[bytes.indexOf('Run tests')] = 'F'.charCodeAt(0);
    expect(() => verifyOwnerWalImages({ ...input, next: { ...input.next, bytes } })).toThrow(
      'image-hash'
    );
    const oversize = { bytes: Buffer.alloc(2), byteSize: OWNER_WAL_MAX_BYTES + 1, sha256: hex(7) };
    expect(() => verifyOwnerWalImages({ ...input, next: oversize })).toThrow('integer');
    const complete = accepts(input);
    const other = startCase();
    other.p.admissionDigest = hex(99);
    other.n.admissionDigest = hex(99);
    const unrelated = accepts(
      pair(jsonImage(other.p), other.n, startMutation, other.input.witness)
    );
    expect(() => verifyOwnerWalImageContinuity(complete, unrelated)).toThrow('lineage-gap');
  });

  it('rejects substituted P fences even with coherent N/native metadata', () => {
    const { p, n, input } = startCase();
    const changed = {
      ...n,
      writerFence: { generation: `approval-writer-fence_${'b'.repeat(32)}`, dev: '22', ino: '33' },
    };
    const replacement = pair(jsonImage(p), changed, startMutation, input.witness);
    accepts(input);
    expect(() => verifyOwnerWalImages(replacement)).toThrow('fence');
    expect(replacement.native.stateDelta.changedFields).toEqual([
      'deliveries',
      'revision',
      'writerFence',
    ]);
    expect(() =>
      verifyOwnerWalImages({
        ...replacement,
        native: { ...replacement.native, fence: p.writerFence },
      })
    ).toThrow('fence');
    // Matching fences remain valid without claiming the acquiring process's custody.
    const sameFence = pair(
      jsonImage({ ...p, writerFence: changed.writerFence }),
      changed,
      startMutation,
      input.witness
    );
    accepts(sameFence);
    expect(sameFence.native.stateDelta.changedFields).toEqual(['deliveries', 'revision']);
    for (const field of ['generation', 'dev', 'ino'] as const) {
      const mismatched = {
        ...p,
        writerFence: { ...p.writerFence, [field]: changed.writerFence[field] },
      };
      expect(() =>
        verifyOwnerWalImages(pair(jsonImage(mismatched), n, startMutation, input.witness))
      ).toThrow('fence');
    }
    for (const version of [1, 2] as const) {
      const { stored, reconciled } = legacy(version);
      const changedLegacy = { ...reconciled, writerFence: changed.writerFence };
      expect(() =>
        verifyOwnerWalImages(
          pair(jsonImage(stored), changedLegacy, admissionMutation, admission(changedLegacy))
        )
      ).toThrow('fence');
    }
  });

  it('rejects missing/oversized operation objects, cycles and accessors before semantic decoding', () => {
    const { input } = startCase();
    expect(() => verifyOwnerWalImages({ ...input, witness: undefined as never })).toThrow(
      'input-object'
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => verifyOwnerWalImages({ ...input, native: cycle })).toThrow('input-object');
    const large = { ...input.native, ignored: 'x'.repeat(65_537) };
    expect(() => verifyOwnerWalImages({ ...input, native: large })).toThrow('input-size');
    const accessor = Object.defineProperty({}, 'request', {
      enumerable: true,
      get: () => {
        throw new Error('must-not-run');
      },
    });
    expect(() => verifyOwnerWalImages({ ...input, witness: accessor as never })).toThrow(
      'object-properties'
    );
  });
});
