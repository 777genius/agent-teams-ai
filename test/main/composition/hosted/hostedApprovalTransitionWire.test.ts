import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createHostedApprovalTransitionProof,
  decodeHostedApprovalTransitionResponse,
  encodeHostedApprovalTransitionRequest,
  HOSTED_APPROVAL_TRANSITION_CONTRACT_SHA256,
  type HostedApprovalTransitionOperation,
  type HostedApprovalTransitionRequest,
} from '@main/composition/hosted/hostedApprovalTransitionWire';
import { describe, expect, it } from 'vitest';

const fixtureBytes = readFileSync(
  resolve(
    process.cwd(),
    'test/main/composition/hosted/fixtures/hostedApprovalTransitionWire.v1.contract.json'
  )
);
const contract = JSON.parse(fixtureBytes.toString('utf8')) as FrozenContract;
const key = Buffer.from(contract.goldenVectors.testOnlyKeyHex, 'hex');

interface FrozenVector {
  readonly id: string;
  readonly direction: 'request' | 'response';
  readonly canonicalUnsigned?: string;
  readonly unsignedSha256?: string;
  readonly expectedHmacSha256?: string;
  readonly frameUtf8?: string;
  readonly frameHex?: string;
  readonly frameSha256?: string;
  readonly construction?: string;
}

interface FrozenContract {
  readonly contract: string;
  readonly version: number;
  readonly status: string;
  readonly goldenVectors: {
    readonly testOnlyKeyHex: string;
    readonly vectors: readonly FrozenVector[];
  };
}

function vector(id: string): FrozenVector {
  const found = contract.goldenVectors.vectors.find((item) => item.id === id);
  if (!found) throw new Error(`missing frozen vector ${id}`);
  return found;
}

function signedFrame(item: FrozenVector): Buffer {
  if (!item.canonicalUnsigned || !item.expectedHmacSha256)
    throw new Error(`unsigned vector required: ${item.id}`);
  return Buffer.from(
    `${item.canonicalUnsigned.slice(0, -1)},"ownerProof":"${item.expectedHmacSha256}"}\n`,
    'utf8'
  );
}

const acquireUnsigned = vector('P01-acquire-request').canonicalUnsigned!;
const acquireRequest = JSON.parse(acquireUnsigned) as HostedApprovalTransitionRequest<'acquire'>;
const projection = acquireRequest.payload.productProjection;

describe('HostedApprovalTransitionWire v1 frozen contract', () => {
  it('pins the byte-exact frozen artifact', () => {
    expect(contract).toMatchObject({
      contract: 'HostedApprovalTransitionWire',
      version: 1,
      status: 'frozen',
    });
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      HOSTED_APPROVAL_TRANSITION_CONTRACT_SHA256
    );
    expect(contract.goldenVectors.vectors.map(({ id }) => id)).toEqual([
      'P01-acquire-request',
      'P02-acquire-response',
      'P03-consume-request',
      'P04-assert-request',
      'P05-assert-current-response',
      'P06-release-request',
      'P07-release-response',
      'P08-pin-busy-error',
      'N01-wrong-top-level-key-order',
      'N02-duplicate-operation-key',
      'N03-proof-not-last',
      'N04-trailing-space-before-lf',
      'N05-invalid-utf8',
      'N06-bad-hmac',
      'N07-sequence-gap',
      'N08-generation-mismatch-error-response',
      'N09-process-identity-mismatch-error-response',
      'N10-expired-deadline-error-response',
      'N11-frame-over-8MiB',
      'N12-assert-stale-response',
    ]);
  });

  it.each(contract.goldenVectors.vectors.filter((item) => item.canonicalUnsigned))(
    'reproduces frozen digest and HMAC for $id',
    (item) => {
      expect(createHash('sha256').update(item.canonicalUnsigned!, 'utf8').digest('hex')).toBe(
        item.unsignedSha256
      );
      expect(
        createHostedApprovalTransitionProof(key, item.direction, item.canonicalUnsigned!)
      ).toBe(item.expectedHmacSha256);
    }
  );

  it.each(contract.goldenVectors.vectors.filter((item) => item.frameSha256))(
    'pins the exact constructed negative frame for $id',
    (item) => {
      const bytes = item.frameHex
        ? Buffer.from(item.frameHex, 'hex')
        : item.frameUtf8
          ? Buffer.from(item.frameUtf8, 'utf8')
          : signedFrame(item);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.frameSha256);
    }
  );

  it.each([
    'P01-acquire-request',
    'P03-consume-request',
    'P04-assert-request',
    'P06-release-request',
  ])('encodes the canonical request and proof for %s', (id) => {
    const item = vector(id);
    const request = JSON.parse(
      item.canonicalUnsigned!
    ) as HostedApprovalTransitionRequest<HostedApprovalTransitionOperation>;
    const encoded = encodeHostedApprovalTransitionRequest(request, key);
    expect(encoded.canonicalUnsigned).toBe(item.canonicalUnsigned);
    expect(encoded.requestDigest).toBe(item.unsignedSha256);
    expect(encoded.frame).toEqual(signedFrame(item));
  });

  it.each([
    [
      'P02-acquire-response',
      acquireRequest,
      '6867b6c04e2fdb841661bfde31a0b7d4c1f7aa13fb90a855c3e62613c16180ba',
    ],
    [
      'P05-assert-current-response',
      JSON.parse(vector('P04-assert-request').canonicalUnsigned!),
      '1edf7385360d70293c74af11c32c0103012f69a846c1127e166fec04611fa82a',
    ],
    [
      'P07-release-response',
      JSON.parse(vector('P06-release-request').canonicalUnsigned!),
      '6099ffb56cdf05ac79f56c0510c289a7ea5a4f90dd80f8f99608aa50ee7e6c75',
    ],
    [
      'P08-pin-busy-error',
      JSON.parse(vector('P03-consume-request').canonicalUnsigned!),
      '59aa1e3527d9eafc93b7e01472468cdfffd8a07e8119309dfc760bd90290ae57',
    ],
    [
      'N12-assert-stale-response',
      JSON.parse(vector('P04-assert-request').canonicalUnsigned!),
      '1edf7385360d70293c74af11c32c0103012f69a846c1127e166fec04611fa82a',
    ],
  ] as const)('authenticates and validates frozen response %s', (id, request, digest) => {
    const decoded = decodeHostedApprovalTransitionResponse(
      signedFrame(vector(id)),
      request,
      digest,
      key,
      projection
    );
    expect(decoded).toBeDefined();
  });

  it.each([
    [
      'N08-generation-mismatch-error-response',
      { ...JSON.parse(vector('P03-consume-request').canonicalUnsigned!), sequence: 3 },
      '0f4853a2267f67b0c1614a17db32fb6c21a67857eb34b6d7d1907577d0f3edf6',
      'GENERATION_MISMATCH',
    ],
    [
      'N09-process-identity-mismatch-error-response',
      acquireRequest,
      'db8dc40e988577144a1c8b9862126103f320e6cbdbcda69f1ae01afd2704d6d9',
      'PROCESS_IDENTITY_MISMATCH',
    ],
    [
      'N10-expired-deadline-error-response',
      acquireRequest,
      '6b6d031e071a6da85083268ea30a9f3e4ae1cee1e023f8a3627bbb17fb2f10f0',
      'DEADLINE_EXCEEDED',
    ],
  ] as const)('authenticates frozen signed error %s', (id, request, digest, code) => {
    const decoded = decodeHostedApprovalTransitionResponse(
      signedFrame(vector(id)),
      request,
      digest,
      key,
      projection
    );
    expect('error' in decoded && decoded.error.code).toBe(code);
  });

  it('rejects response substitution, noncanonical bytes, invalid UTF-8, and bad HMAC', () => {
    const good = signedFrame(vector('P05-assert-current-response'));
    const assertRequest = JSON.parse(vector('P04-assert-request').canonicalUnsigned!);
    expect(() =>
      decodeHostedApprovalTransitionResponse(
        good,
        { ...assertRequest, sequence: 4 },
        assertRequest.payload.bindingDigest,
        key,
        projection
      )
    ).toThrow(/substitution/u);
    for (const id of [
      'N03-proof-not-last',
      'N04-trailing-space-before-lf',
      'N05-invalid-utf8',
      'N06-bad-hmac',
    ]) {
      const item = vector(id);
      const bytes = item.frameHex
        ? Buffer.from(item.frameHex, 'hex')
        : Buffer.from(item.frameUtf8!, 'utf8');
      expect(() =>
        decodeHostedApprovalTransitionResponse(
          bytes,
          assertRequest,
          '1edf7385360d70293c74af11c32c0103012f69a846c1127e166fec04611fa82a',
          key,
          projection
        )
      ).toThrow();
    }
  });

  it('rejects a validly authenticated response with a duplicate nested key', () => {
    const item = vector('P05-assert-current-response');
    const duplicated = item.canonicalUnsigned!.replace(
      '"current":true,"reason":null',
      '"current":true,"current":true,"reason":null'
    );
    const proof = createHostedApprovalTransitionProof(key, 'response', duplicated);
    const frame = Buffer.from(`${duplicated.slice(0, -1)},"ownerProof":"${proof}"}\n`);
    expect(() =>
      decodeHostedApprovalTransitionResponse(
        frame,
        JSON.parse(vector('P04-assert-request').canonicalUnsigned!),
        vector('P04-assert-request').unsignedSha256!,
        key,
        projection
      )
    ).toThrow(/noncanonical/u);
  });

  it('rejects BOM, trailing JSON syntax, unsafe numbers, and unpaired surrogates', () => {
    const item = vector('P05-assert-current-response');
    const request = JSON.parse(
      vector('P04-assert-request').canonicalUnsigned!
    ) as HostedApprovalTransitionRequest<'assert'>;
    const decode = (frame: Uint8Array) =>
      decodeHostedApprovalTransitionResponse(
        frame,
        request,
        vector('P04-assert-request').unsignedSha256!,
        key,
        projection
      );
    expect(() =>
      decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), signedFrame(item)]))
    ).toThrow(/framing-invalid/u);

    for (const canonicalUnsigned of [
      `${item.canonicalUnsigned!.slice(0, -1)},}`,
      item.canonicalUnsigned!.replace('"generation":11', '"generation":9007199254740992'),
      item.canonicalUnsigned!.replace('"reason":null', '"reason":"\\ud800"'),
    ]) {
      const proof = createHostedApprovalTransitionProof(key, 'response', canonicalUnsigned);
      const frame = Buffer.from(
        `${canonicalUnsigned.slice(0, -1)},"ownerProof":"${proof}"}\n`,
        'utf8'
      );
      expect(() => decode(frame)).toThrow();
    }
  });

  it('rejects the frozen wrong-order request and 8 MiB plus one construction', () => {
    const wrongOrder = JSON.parse(
      vector('N01-wrong-top-level-key-order').canonicalUnsigned!
    ) as HostedApprovalTransitionRequest<'release'>;
    expect(() => encodeHostedApprovalTransitionRequest(wrongOrder, key)).toThrow(
      /request-invalid/u
    );

    const oversized = Buffer.alloc(8_388_609, 0x78);
    oversized[oversized.length - 1] = 0x0a;
    const assertRequest = JSON.parse(
      vector('P04-assert-request').canonicalUnsigned!
    ) as HostedApprovalTransitionRequest<'assert'>;
    expect(() =>
      decodeHostedApprovalTransitionResponse(
        oversized,
        assertRequest,
        vector('P04-assert-request').unsignedSha256!,
        key,
        projection
      )
    ).toThrow(/framing-invalid/u);
  });
});
