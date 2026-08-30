import { createHash } from 'node:crypto';

import {
  HOSTED_PRODUCER_PROVENANCE_CONTRACT,
  HOSTED_PRODUCER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_PRODUCER_PROVENANCE_ENV,
  HOSTED_PRODUCER_PROVENANCE_VERSION,
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
