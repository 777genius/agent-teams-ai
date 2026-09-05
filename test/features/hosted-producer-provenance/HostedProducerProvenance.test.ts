import { createHash } from 'node:crypto';

import {
  HOSTED_PRODUCER_PROVENANCE_CONTRACT,
  HOSTED_PRODUCER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_PRODUCER_PROVENANCE_ENV,
  HOSTED_PRODUCER_PROVENANCE_VERSION,
  type HostedOwnerWalNative,
} from '@features/hosted-producer-provenance/contracts';
import {
  clearProductHostedProducerProvenance,
  currentProductHostedProducerProvenance,
  currentProductHostedProducerSseWriteEmitter,
  type HostedProducerProvenance,
  HostedProducerProvenanceFatalError,
  installProductHostedProducerProvenance,
} from '@features/hosted-producer-provenance/main/hosted';
import { resetProductHostedProducerProvenanceForTests } from '@features/hosted-producer-provenance/main/HostedProducerProvenanceRegistry';
import { parseHostedOwnerWalNative } from '@main/composition/hosted/hostedOwnerWalNativeValidator';
import {
  createBrowserHostedProducerProvenanceFromEnvironment,
  createHostedProducerProvenanceFromEnvironment,
  type HostedProducerProvenanceOperations,
  parseHostedProducerProvenanceContract,
} from '@main/composition/hosted/hostedProducerProvenanceComposition';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const CONTROLLER_NONCE = 'c'.repeat(64);
const RUN_ID = 'd'.repeat(64);
const STACK_MANIFEST_SHA256 = 'f'.repeat(64);
const PRODUCT_OPERATION = Object.freeze({
  actorId: 'actor_test',
  bootId: 'boot_test',
  deploymentId: 'deployment_test',
  ownerAuthority: 'owner-authority_test',
  ownerGeneration: 7,
  ownerSessionId: 'owner-session_test',
  requestId: 'request_test',
  sessionId: 'session_test',
});
type MutableOwnerNative = {
  [key: string]: unknown;
  fence: Record<string, unknown>;
  mutation: Record<string, unknown>;
  revision: unknown;
  stateDelta: {
    changedFields: string[];
    collectionSizes: Record<string, unknown>;
    nextRevision: unknown;
    nextStateSha256: unknown;
    previousRevision: unknown;
    previousStateSha256: unknown;
  };
};

afterEach(() => resetProductHostedProducerProvenanceForTests());

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('non-json-value');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function productContract(): string {
  return canonicalJson({
    activation: {
      controllerNonce: CONTROLLER_NONCE,
      runId: RUN_ID,
      stackManifestSha256: STACK_MANIFEST_SHA256,
    },
    contract: HOSTED_PRODUCER_PROVENANCE_CONTRACT,
    contractSha256: HOSTED_PRODUCER_PROVENANCE_CONTRACT_SHA256,
    expectedProducer: {
      artifactManifestSha256: DIGEST_A,
      executableSha256: DIGEST_A,
      implementationId: 'agent-teams.product.hosted-approval.v1',
      moduleSha256: DIGEST_B,
    },
    producerRole: 'product-producer',
    streams: {
      conditionalPostLedger: { device: '11', fd: 9, inode: '19' },
      productTimeline: { device: '12', fd: 10, inode: '20' },
    },
    version: HOSTED_PRODUCER_PROVENANCE_VERSION,
  });
}

function browserContract(): string {
  return canonicalJson({
    activation: {
      controllerNonce: CONTROLLER_NONCE,
      runId: RUN_ID,
      stackManifestSha256: STACK_MANIFEST_SHA256,
    },
    contract: HOSTED_PRODUCER_PROVENANCE_CONTRACT,
    contractSha256: HOSTED_PRODUCER_PROVENANCE_CONTRACT_SHA256,
    expectedProducer: {
      artifactManifestSha256: DIGEST_A,
      executableSha256: DIGEST_A,
      implementationId: 'agent-teams.product.browser-observer.v1',
      moduleSha256: DIGEST_B,
    },
    producerRole: 'browser',
    streams: {
      negativeResults: { device: '11', fd: 9, inode: '19' },
    },
    version: HOSTED_PRODUCER_PROVENANCE_VERSION,
  });
}

function ownerContract(): string {
  return canonicalJson({
    activation: {
      controllerNonce: CONTROLLER_NONCE,
      runId: RUN_ID,
      stackManifestSha256: STACK_MANIFEST_SHA256,
    },
    contract: HOSTED_PRODUCER_PROVENANCE_CONTRACT,
    contractSha256: HOSTED_PRODUCER_PROVENANCE_CONTRACT_SHA256,
    expectedProducer: {
      artifactManifestSha256: DIGEST_A,
      executableSha256: DIGEST_A,
      implementationId: 'agent-teams.orchestrator.hosted-approval-owner.v1',
      moduleSha256: DIGEST_B,
    },
    producerRole: 'owner',
    streams: { ownerWalTimeline: { device: '11', fd: 9, inode: '19' } },
    version: HOSTED_PRODUCER_PROVENANCE_VERSION,
  });
}

function quarantinedOwnerNative(): HostedOwnerWalNative {
  return {
    fence: {
      dev: '11',
      generation: `approval-writer-fence_${'1'.repeat(32)}`,
      ino: '19',
    },
    mutation: { kind: 'binding-quarantined', outcome: 'quarantined' },
    revision: 8,
    stateDelta: {
      changedFields: ['bindings', 'revision'],
      collectionSizes: {
        actorMembers: { previous: 2, next: 2 },
        bindings: { previous: 4, next: 5 },
        deliveries: { previous: 1, next: 1 },
        ingress: { previous: 3, next: 3 },
        retiredIngress: { previous: 1, next: 1 },
        routes: { previous: 2, next: 2 },
      },
      nextRevision: 8,
      nextStateSha256: DIGEST_B,
      previousRevision: 7,
      previousStateSha256: DIGEST_A,
    },
    wal: { byteSize: 4096, sha256: DIGEST_B },
  };
}

const INVALID_OWNER_NATIVE_MUTATIONS: Array<[string, (native: MutableOwnerNative) => void]> = [
  [
    'inherited mutation key',
    (native) => {
      native.mutation = { kind: '__proto__', outcome: Object.prototype };
    },
  ],
  [
    'sparse claims',
    (native) => {
      native.mutation = {
        kind: 'ingress-lease-claimed',
        outcome: 'claimed',
        claims: new Array(1),
      };
    },
  ],
  [
    'inherited claim index',
    (native) => {
      const claims = new Array(1);
      Object.setPrototypeOf(claims, {
        0: {
          claimedAtIso: '2026-09-05T00:00:00.000Z',
          generation: 1,
          leaseExpiresAtIso: '2026-09-05T00:01:00.000Z',
          leaseToken: 'lease_1',
          outboxId: 'outbox_1',
          ownerId: 'owner_1',
        },
        __proto__: Array.prototype,
      });
      native.mutation = { kind: 'ingress-lease-claimed', outcome: 'claimed', claims };
    },
  ],
  [
    'negative-zero count',
    (native) => {
      const bindings = native.stateDelta.collectionSizes.bindings as Record<string, unknown>;
      bindings.previous = -0;
      bindings.next = 1;
    },
  ],
];

function operations() {
  const bytes = new Map<number, number[]>([
    [9, []],
    [10, []],
  ]);
  let failSync = false;
  const implementation: HostedProducerProvenanceOperations = {
    deriveIdentity: vi.fn(() => ({
      pid: process.pid,
      startTicks: '1234',
      exeDevice: '1',
      exeInode: '2',
      exeSha256: DIGEST_A,
      moduleDevice: '3',
      moduleInode: '4',
      moduleSha256: DIGEST_B,
    })),
    descriptorIdentity: vi.fn((fd) => ({
      append: true,
      device: fd === 9 ? '11' : '12',
      inode: fd === 9 ? '19' : '20',
      mode: 0o600,
      nlink: '1',
      regularFile: true,
      size: '0',
      writeOnly: true,
    })),
    randomNonce: vi.fn(() => 'e'.repeat(64)),
    write: vi.fn((fd, source, offset) => {
      const amount = Math.min(7, source.byteLength - offset);
      bytes.get(fd)?.push(...source.subarray(offset, offset + amount));
      return amount;
    }),
    sync: vi.fn(() => {
      if (failSync) throw new Error('sync-failed');
    }),
    close: vi.fn(),
  };
  return {
    bytes,
    implementation,
    failNextSync: () => {
      failSync = true;
    },
  };
}

function lines(bytes: readonly number[]): Array<Record<string, unknown>> {
  return Buffer.from(bytes)
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('HostedProducerProvenance', () => {
  it('replaces the cleared SSE sentinel on reinstall and ignores stale cleanup', () => {
    const provenance = (name: string): HostedProducerProvenance => ({
      role: 'product-producer',
      controllerNonce: name.repeat(64),
      runId: name.repeat(64),
      emit: vi.fn(),
      bindInvalidation: vi.fn(),
      poison: vi.fn((reason: string) => {
        throw new Error(reason);
      }),
      close: vi.fn(),
    });
    const first = provenance('a');
    const second = provenance('b');
    const firstEmitter = vi.fn(() => true);
    const secondEmitter = vi.fn(() => true);

    installProductHostedProducerProvenance(first, firstEmitter);
    expect(currentProductHostedProducerSseWriteEmitter()).toBe(firstEmitter);
    clearProductHostedProducerProvenance(first);
    expect(() => currentProductHostedProducerSseWriteEmitter()).toThrow(
      'producer-provenance-product-sse-emitter-cleared'
    );

    installProductHostedProducerProvenance(second, secondEmitter);
    expect(currentProductHostedProducerSseWriteEmitter()).toBe(secondEmitter);
    clearProductHostedProducerProvenance(first);
    expect(currentProductHostedProducerSseWriteEmitter()).toBe(secondEmitter);
    clearProductHostedProducerProvenance(second);
    expect(() => currentProductHostedProducerSseWriteEmitter()).toThrow(
      HostedProducerProvenanceFatalError
    );
  });

  it('stays dormant when the exact environment contract is absent', () => {
    const harness = operations();
    expect(
      createHostedProducerProvenanceFromEnvironment(
        {},
        {
          role: 'product-producer',
          modulePath: '/product/module.js',
          operations: harness.implementation,
        }
      )
    ).toBeNull();
    expect(harness.implementation.deriveIdentity).not.toHaveBeenCalled();
  });

  it('rejects noncanonical contracts, role drift, digest drift, and descriptor drift', () => {
    const source = productContract();
    expect(() => parseHostedProducerProvenanceContract(` ${source}`, 'product-producer')).toThrow(
      'producer-provenance-contract-canonical'
    );
    expect(() => parseHostedProducerProvenanceContract(source, 'browser')).toThrow(
      'producer-provenance-contract'
    );
    for (const rejectedDigest of [
      '3f5ad01985ddc33b90bf3f6772288316674202a640be5bb6f4e1669319be529d',
      'acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498',
    ]) {
      const old = JSON.parse(source) as Record<string, unknown>;
      old.contractSha256 = rejectedDigest;
      expect(() =>
        parseHostedProducerProvenanceContract(canonicalJson(old), 'product-producer')
      ).toThrow('producer-provenance-contract');
    }

    const badIdentity = operations();
    const badIdentityOperations: HostedProducerProvenanceOperations = {
      ...badIdentity.implementation,
      deriveIdentity: () => ({
        pid: process.pid,
        startTicks: '1234',
        exeDevice: '1',
        exeInode: '2',
        exeSha256: DIGEST_A,
        moduleDevice: '3',
        moduleInode: '4',
        moduleSha256: 'f'.repeat(64),
      }),
    };
    expect(() =>
      createHostedProducerProvenanceFromEnvironment(
        { [HOSTED_PRODUCER_PROVENANCE_ENV]: source },
        {
          role: 'product-producer',
          modulePath: '/product/module.js',
          operations: badIdentityOperations,
        }
      )
    ).toThrow('producer-provenance-producer-identity');

    const badDescriptor = operations();
    const badDescriptorOperations: HostedProducerProvenanceOperations = {
      ...badDescriptor.implementation,
      descriptorIdentity: () => ({
        append: true,
        device: '999',
        inode: '19',
        mode: 0o600,
        nlink: '1',
        regularFile: true,
        size: '0',
        writeOnly: true,
      }),
    };
    expect(() =>
      createHostedProducerProvenanceFromEnvironment(
        { [HOSTED_PRODUCER_PROVENANCE_ENV]: source },
        {
          role: 'product-producer',
          modulePath: '/product/module.js',
          operations: badDescriptorOperations,
        }
      )
    ).toThrow('producer-provenance-descriptor-identity');
  });

  it('accepts the strict six-count quarantine shape and emits it only on the Owner stream', () => {
    const native = quarantinedOwnerNative();
    expect(parseHostedOwnerWalNative(native)).toBe(native);
    const positiveZeroNative = {
      ...native,
      stateDelta: {
        ...native.stateDelta,
        collectionSizes: {
          ...native.stateDelta.collectionSizes,
          bindings: { previous: 0, next: 1 },
        },
      },
    };
    expect(parseHostedOwnerWalNative(positiveZeroNative)).toBe(positiveZeroNative);
    const absent = JSON.parse(JSON.stringify(native)) as MutableOwnerNative;
    absent.mutation = { kind: 'admission-reconciled', outcome: 'published' };
    absent.revision = 1;
    absent.stateDelta.nextRevision = 1;
    absent.stateDelta.previousRevision = null;
    absent.stateDelta.previousStateSha256 = null;
    absent.stateDelta.changedFields = [
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
    ];
    for (const size of Object.values(absent.stateDelta.collectionSizes)) {
      (size as Record<string, unknown>).previous = 0;
      (size as Record<string, unknown>).next = 0;
    }
    expect(parseHostedOwnerWalNative(absent)).toBe(absent);
    const harness = operations();
    const provenance = createHostedProducerProvenanceFromEnvironment(
      { [HOSTED_PRODUCER_PROVENANCE_ENV]: ownerContract() },
      { role: 'owner', modulePath: '/owner/module.js', operations: harness.implementation }
    )!;
    provenance.emit('ownerWalTimeline', {
      recordType: 'owner-wal-published',
      operationNonce: '7'.repeat(64),
      native: positiveZeroNative,
    });
    provenance.close();
    expect(lines(harness.bytes.get(9) ?? []).map((line) => line.recordType)).toEqual([
      'producer-open',
      'owner-wal-published',
      'producer-close',
    ]);
  });

  it.each<[string, (native: MutableOwnerNative) => void]>([
    [
      'missing bindings count',
      (native: MutableOwnerNative) => delete native.stateDelta.collectionSizes.bindings,
    ],
    [
      'extra count',
      (native: MutableOwnerNative) =>
        (native.stateDelta.collectionSizes.quarantine = { previous: 0, next: 1 }),
    ],
    [
      'duplicate field',
      (native: MutableOwnerNative) => native.stateDelta.changedFields.push('revision'),
    ],
    [
      'noncanonical fields',
      (native: MutableOwnerNative) => native.stateDelta.changedFields.reverse(),
    ],
    [
      'unknown field',
      (native: MutableOwnerNative) => native.stateDelta.changedFields.splice(0, 1, 'quarantine'),
    ],
    [
      'fake mutation',
      (native: MutableOwnerNative) =>
        (native.mutation = { kind: 'migration', outcome: 'published' }),
    ],
    ...INVALID_OWNER_NATIVE_MUTATIONS,
    [
      'wrong quarantine pair',
      (native: MutableOwnerNative) => (native.mutation.outcome = 'admitted'),
    ],
    [
      'wrong settlement pair',
      (native: MutableOwnerNative) =>
        (native.mutation = { kind: 'delivery-settled', phase: 'completed', outcome: 'expired' }),
    ],
    ['bad fence', (native: MutableOwnerNative) => (native.fence.generation = 'owner_generation_1')],
    ['null fence identity', (native: MutableOwnerNative) => (native.fence.dev = null)],
    [
      'unpaired previous null',
      (native: MutableOwnerNative) => (native.stateDelta.previousRevision = null),
    ],
    [
      'absent with stored counts',
      (native: MutableOwnerNative) => {
        native.revision = 1;
        native.stateDelta.nextRevision = 1;
        native.stateDelta.previousRevision = null;
        native.stateDelta.previousStateSha256 = null;
        native.stateDelta.changedFields = [
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
        ];
      },
    ],
    ['wrong next revision', (native: MutableOwnerNative) => (native.stateDelta.nextRevision = 9)],
    ['wrong native revision', (native: MutableOwnerNative) => (native.revision = 9)],
    [
      'wrong next hash',
      (native: MutableOwnerNative) => (native.stateDelta.nextStateSha256 = DIGEST_A),
    ],
    [
      'missing revision delta',
      (native: MutableOwnerNative) => native.stateDelta.changedFields.pop(),
    ],
    ['extra native key', (native: MutableOwnerNative) => (native.debug = true)],
  ] as const)('rejects Owner native shape drift: %s', (_name, mutate) => {
    const native = JSON.parse(JSON.stringify(quarantinedOwnerNative()));
    mutate(native as MutableOwnerNative);
    expect(() => parseHostedOwnerWalNative(native)).toThrow('producer-provenance-native-owner-wal');
  });

  it.each<[string, (native: MutableOwnerNative) => void]>(INVALID_OWNER_NATIVE_MUTATIONS)(
    'rejects invalid Owner native before producer publication: %s',
    (_name, mutate) => {
      const native = JSON.parse(JSON.stringify(quarantinedOwnerNative())) as MutableOwnerNative;
      mutate(native);
      const harness = operations();
      const provenance = createHostedProducerProvenanceFromEnvironment(
        { [HOSTED_PRODUCER_PROVENANCE_ENV]: ownerContract() },
        { role: 'owner', modulePath: '/owner/module.js', operations: harness.implementation }
      )!;
      expect(() =>
        provenance.emit('ownerWalTimeline', {
          recordType: 'owner-wal-published',
          operationNonce: '7'.repeat(64),
          // Deliberately exercise the runtime guard through an invalid caller value.
          native: native as unknown as HostedOwnerWalNative,
        })
      ).toThrow(HostedProducerProvenanceFatalError);
      expect(lines(harness.bytes.get(9) ?? []).map((line) => line.recordType)).toEqual([
        'producer-open',
      ]);
    }
  );

  it('writes canonical bounded hash-chained lines with full-write, sync, and explicit close', () => {
    const harness = operations();
    const provenance = createHostedProducerProvenanceFromEnvironment(
      { [HOSTED_PRODUCER_PROVENANCE_ENV]: productContract() },
      {
        role: 'product-producer',
        modulePath: '/product/module.js',
        operations: harness.implementation,
      }
    );
    expect(provenance).not.toBeNull();
    provenance!.emit('conditionalPostLedger', {
      recordType: 'decision-compare-and-claim-verified',
      operationNonce: 'e'.repeat(64),
      native: Object.freeze({
        ...PRODUCT_OPERATION,
        approvalId: `approval_${'1'.repeat(32)}`,
        decision: 'allow',
        generationId: `generation_runtime-permission-${'9'.repeat(64)}`,
        idempotencyKeySha256: 'f'.repeat(64),
        outcome: 'committed',
        targetTeamId: `team_${'2'.repeat(32)}`,
        targetTeamRunId: `team-run_${'3'.repeat(32)}`,
      }),
    });
    provenance!.close();

    const ledger = lines(harness.bytes.get(9) ?? []);
    const timeline = lines(harness.bytes.get(10) ?? []);
    expect(ledger.map((line) => line.recordType)).toEqual([
      'producer-open',
      'decision-compare-and-claim-verified',
      'producer-close',
    ]);
    expect(timeline.map((line) => line.recordType)).toEqual(['producer-open', 'producer-close']);
    expect(ledger.map((line) => line.sequence)).toEqual([0, 1, 2]);
    expect(ledger[0]?.previousRecordSha256).toBeNull();
    const firstLine = Buffer.from(harness.bytes.get(9) ?? [])
      .toString('utf8')
      .split('\n')[0];
    expect(ledger[1]?.previousRecordSha256).toBe(
      createHash('sha256').update(`${firstLine}\n`).digest('hex')
    );
    expect(ledger[1]?.producer).toMatchObject({
      exeSha256: DIGEST_A,
      moduleSha256: DIGEST_B,
      pid: process.pid,
      role: 'product-producer',
    });
    expect(vi.mocked(harness.implementation.write).mock.calls.length).toBeGreaterThan(5);
    expect(harness.implementation.sync).toHaveBeenCalled();
    expect(harness.implementation.close).toHaveBeenCalledTimes(2);
  });

  it('binds the browser runner only to FD9 and emits hashes instead of request or response bodies', () => {
    const harness = operations();
    const environment = { [HOSTED_PRODUCER_PROVENANCE_ENV]: browserContract() };
    const provenance = createBrowserHostedProducerProvenanceFromEnvironment(environment, {
      modulePath: '/runner/spec.js',
      operations: harness.implementation,
    })!;
    expect(environment).not.toHaveProperty(HOSTED_PRODUCER_PROVENANCE_ENV);
    provenance.emit('negativeResults', {
      recordType: 'browser-negative-response-observed',
      operationNonce: '6'.repeat(64),
      native: {
        actorTeamId: `team_${'1'.repeat(32)}`,
        harnessRunId: RUN_ID,
        httpStatus: 403,
        processStartToken: '7'.repeat(64),
        observedOutcome: 'cross_team_list_rejected',
        requestBodySha256: '2'.repeat(64),
        requestFamily: 'approval-page',
        responseBodySha256: '3'.repeat(64),
        targetTeamId: `team_${'4'.repeat(32)}`,
        targetTeamRunId: `team-run_${'5'.repeat(32)}`,
      },
    });
    provenance.close();

    expect(harness.implementation.descriptorIdentity).toHaveBeenCalledWith(9);
    expect(harness.implementation.descriptorIdentity).toHaveBeenCalledTimes(1);
    expect(harness.bytes.get(10)).toEqual([]);
    const capture = Buffer.from(harness.bytes.get(9) ?? []).toString('utf8');
    expect(capture).not.toContain('"requestBody":');
    expect(capture).not.toContain('"responseBody":');
    expect(lines(harness.bytes.get(9) ?? []).map((line) => line.recordType)).toEqual([
      'producer-open',
      'browser-negative-response-observed',
      'producer-close',
    ]);
  });

  it('invalidates the hosted surface and rejects the semantic operation on capture failure', () => {
    const harness = operations();
    const provenance = createHostedProducerProvenanceFromEnvironment(
      { [HOSTED_PRODUCER_PROVENANCE_ENV]: productContract() },
      {
        role: 'product-producer',
        modulePath: '/product/module.js',
        operations: harness.implementation,
      }
    )!;
    installProductHostedProducerProvenance(provenance);
    const invalidate = vi.fn(() => provenance.close());
    provenance.bindInvalidation(invalidate);
    harness.failNextSync();

    expect(() =>
      provenance.emit('productTimeline', {
        recordType: 'approval-http-response-finalized',
        operationNonce: 'e'.repeat(64),
        native: {
          ...PRODUCT_OPERATION,
          method: 'POST',
          outcome: 'success',
          requestBodyBytes: 2,
          requestBodySha256: '1'.repeat(64),
          responseBodyBytes: 2,
          responseBodySha256: '2'.repeat(64),
          routeId: 'team-approvals.page.v1',
          status: 200,
        },
      })
    ).toThrow(HostedProducerProvenanceFatalError);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(harness.implementation.close).toHaveBeenCalledTimes(2);
    expect(() =>
      provenance.emit('productTimeline', {
        recordType: 'approval-http-response-finalized',
        operationNonce: 'e'.repeat(64),
        native: {
          ...PRODUCT_OPERATION,
          method: 'POST',
          outcome: 'success',
          requestBodyBytes: 2,
          requestBodySha256: '1'.repeat(64),
          responseBodyBytes: 2,
          responseBodySha256: '2'.repeat(64),
          routeId: 'team-approvals.page.v1',
          status: 200,
        },
      })
    ).toThrow(HostedProducerProvenanceFatalError);
    expect(() => currentProductHostedProducerProvenance()).toThrow(
      HostedProducerProvenanceFatalError
    );
    expect(() => clearProductHostedProducerProvenance(provenance)).toThrow(
      HostedProducerProvenanceFatalError
    );
  });
});
