import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { resolve } from 'node:path';

import {
  assertHostedApprovalTransitionPeerCredentials,
  assertHostedApprovalTransitionSocketIdentity,
  HostedApprovalRuntimeOwnerLeaseClient,
  type HostedApprovalTransitionFileSystem,
  type HostedApprovalTransitionPeerCredentials,
  readHostedApprovalProcessStartIdentity,
  writeHostedApprovalTransitionFrameBeforeDeadline,
} from '@main/composition/hosted/HostedApprovalRuntimeOwnerLeaseClient';
import { HostedApprovalRuntimeProjectionSource } from '@main/composition/hosted/HostedApprovalRuntimeProjectionSource';
import { createHostedApprovalTransitionProof } from '@main/composition/hosted/hostedApprovalTransitionWire';
import { describe, expect, it } from 'vitest';

const contract = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      'test/main/composition/hosted/fixtures/hostedApprovalTransitionWire.v1.contract.json'
    ),
    'utf8'
  )
) as {
  goldenVectors: {
    testOnlyKeyHex: string;
    vectors: Array<{ id: string; canonicalUnsigned?: string }>;
  };
};
const key = Buffer.from(contract.goldenVectors.testOnlyKeyHex, 'hex');
const unsigned = (id: string) =>
  contract.goldenVectors.vectors.find((item) => item.id === id)!.canonicalUnsigned!;
const acquireFixture = JSON.parse(unsigned('P01-acquire-request'));
const binding = JSON.parse(unsigned('P02-acquire-response')).payload.binding;

interface ParsedRequest {
  schemaVersion: 1;
  transitionId: string;
  operation: 'acquire' | 'consume' | 'assert' | 'release';
  sequence: number;
  deadlineAtMs: number;
  payload: Record<string, unknown>;
}

function parseRequest(frame: Uint8Array): { request: ParsedRequest; requestDigest: string } {
  const body = Buffer.from(frame).toString('utf8').slice(0, -1);
  const suffix = /,"ownerProof":"[0-9a-f]{64}"\}$/u.exec(body)!;
  const canonicalUnsigned = `${body.slice(0, suffix.index)}}`;
  return {
    request: JSON.parse(canonicalUnsigned),
    requestDigest: createHash('sha256').update(canonicalUnsigned).digest('hex'),
  };
}

function response(request: ParsedRequest, requestDigest: string, payload: unknown): Uint8Array {
  const canonicalUnsigned = JSON.stringify({
    schemaVersion: 1,
    transitionId: request.transitionId,
    operation: request.operation,
    sequence: request.sequence,
    requestDigest,
    payload,
  });
  const proof = createHostedApprovalTransitionProof(key, 'response', canonicalUnsigned);
  return Buffer.from(`${canonicalUnsigned.slice(0, -1)},"ownerProof":"${proof}"}\n`);
}

function signedError(
  request: ParsedRequest,
  requestDigest: string,
  error: Record<string, unknown>
): Uint8Array {
  const canonicalUnsigned = JSON.stringify({
    schemaVersion: 1,
    transitionId: request.transitionId,
    operation: request.operation,
    sequence: request.sequence,
    requestDigest,
    error,
  });
  const proof = createHostedApprovalTransitionProof(key, 'response', canonicalUnsigned);
  return Buffer.from(`${canonicalUnsigned.slice(0, -1)},"ownerProof":"${proof}"}\n`);
}

function harness(
  exchange: (request: ParsedRequest, digest: string, frame: Uint8Array) => Promise<Uint8Array>,
  clock: Readonly<{
    now?: () => number;
    monotonicNow?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  }> = {}
) {
  let artifact = acquireFixture.payload.productProjection
    .expectedInstalledArtifactDigest as `sha256:${string}`;
  const projection = acquireFixture.payload.productProjection;
  const projectionSource = new HostedApprovalRuntimeProjectionSource({
    readStableAuthority: async () => structuredClone(projection.stableAuthority),
    readExpectedOwner: async () => structuredClone(projection.expectedOwner),
    readInstalledArtifactDigest: async () => artifact,
    readClientProcessIdentity: async () => structuredClone(projection.clientProcessIdentity),
  });
  const client = new HostedApprovalRuntimeOwnerLeaseClient({
    projectionSource,
    bootstrapSecret: key,
    inspectPeerCredentials: async () => {
      throw new Error('test seam must bypass socket');
    },
    randomTransitionId: () => acquireFixture.transitionId,
    ...clock,
    exchangeVerifiedFrame: async (_owner, frame) => {
      const parsed = parseRequest(frame);
      return exchange(parsed.request, parsed.requestDigest, frame);
    },
  });
  return {
    client,
    setArtifact(value: `sha256:${string}`) {
      artifact = value;
    },
  };
}

function nativeExchangeHarness(options: {
  inspectPeerCredentials: (socket: Socket) => Promise<HostedApprovalTransitionPeerCredentials>;
  connect?: (path: string) => Socket;
  fileSystem?: HostedApprovalTransitionFileSystem;
  monotonicNow?: () => number;
  operationBudgetMs?: Readonly<Record<'acquire' | 'consume' | 'assert' | 'release', number>>;
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
}) {
  const projection = structuredClone(acquireFixture.payload.productProjection);
  const effectiveUid = process.geteuid?.() ?? projection.expectedOwner.socketIdentity.uid;
  projection.expectedOwner.socketPath = '/private/owner.sock';
  projection.expectedOwner.socketIdentity.uid = effectiveUid;
  const projectionSource = new HostedApprovalRuntimeProjectionSource({
    readStableAuthority: async () => structuredClone(projection.stableAuthority),
    readExpectedOwner: async () => structuredClone(projection.expectedOwner),
    readInstalledArtifactDigest: async () => projection.expectedInstalledArtifactDigest,
    readClientProcessIdentity: async () => structuredClone(projection.clientProcessIdentity),
  });
  const parentStat = {
    dev: 10n,
    ino: 30n,
    uid: BigInt(effectiveUid),
    mode: 0o700n,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  const socketStat = {
    dev: BigInt(projection.expectedOwner.socketIdentity.device),
    ino: BigInt(projection.expectedOwner.socketIdentity.inode),
    uid: BigInt(effectiveUid),
    gid: BigInt(projection.expectedOwner.socketIdentity.gid),
    mode: 0o600n,
    isSocket: () => true,
    isSymbolicLink: () => false,
  };
  const handle = {
    stat: async () => parentStat,
    close: async () => undefined,
  };
  const fileSystem =
    options.fileSystem ??
    ({
      realpath: async (path: string) => path,
      lstat: async (path: string) => (path === '/private' ? parentStat : socketStat),
      open: async () => handle,
    } as unknown as HostedApprovalTransitionFileSystem);
  const client = new HostedApprovalRuntimeOwnerLeaseClient({
    projectionSource,
    bootstrapSecret: key,
    inspectPeerCredentials: options.inspectPeerCredentials,
    connect:
      options.connect ??
      (() => {
        const socket = new Socket();
        setImmediate(() => socket.emit('connect'));
        return socket;
      }),
    fileSystem,
    monotonicNow: options.monotonicNow,
    operationBudgetMs: options.operationBudgetMs,
    readProcessStartIdentity:
      options.readProcessStartIdentity ??
      (async () => projection.expectedOwner.processIdentity.startIdentity),
    randomTransitionId: () => acquireFixture.transitionId,
  });
  return { client, projection, parentStat };
}

function success(request: ParsedRequest, digest: string): Uint8Array {
  const common = {
    leaseId: 'approval-transition-lease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    generation: 11,
  };
  if (request.operation === 'acquire') {
    return response(request, digest, {
      status: 'acquired',
      ...common,
      expiresAtMs: 1_700_000_010_000,
      projectionDigest: request.payload.projectionDigest,
      bindingDigest: createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
      binding,
    });
  }
  if (request.operation === 'consume') {
    return response(request, digest, {
      status: 'consumed',
      ...common,
      pinnedExpiresAtMs: 1_700_000_030_000,
      bindingDigest: request.payload.bindingDigest,
      binding,
    });
  }
  if (request.operation === 'assert') {
    return response(request, digest, {
      status: 'asserted',
      ...common,
      current: true,
      reason: null,
    });
  }
  return response(request, digest, {
    status: 'released',
    ...common,
    releasedAtMs: 1_700_000_007_500,
  });
}

describe('HostedApprovalRuntimeOwnerLeaseClient', () => {
  it('does not write when identity probes exhaust the monotonic request budget', () => {
    const writes: Uint8Array[] = [];
    const socket = { write: (frame: Uint8Array) => (writes.push(frame), true) };
    expect(() =>
      writeHostedApprovalTransitionFrameBeforeDeadline(
        socket,
        Buffer.from('request'),
        100,
        () => 100
      )
    ).toThrow(/request-timeout/u);
    expect(writes).toEqual([]);

    writeHostedApprovalTransitionFrameBeforeDeadline(socket, Buffer.from('request'), 100, () => 99);
    expect(writes).toHaveLength(1);
  });

  it('keeps the socket error path installed while a peer probe is pending', async () => {
    const sockets: Socket[] = [];
    const listenerCounts: number[] = [];
    const { client } = nativeExchangeHarness({
      connect: () => {
        const socket = new Socket();
        sockets.push(socket);
        setImmediate(() => socket.emit('connect'));
        return socket;
      },
      inspectPeerCredentials: async (socket) => {
        listenerCounts.push(socket.listenerCount('error'));
        queueMicrotask(() => socket.emit('error', new Error('peer-reset-during-identity-probe')));
        return new Promise(() => undefined);
      },
    });

    await expect(
      client.acquireTransitionEvidence('team-a', {
        state: 'provisioning',
        ownerGeneration: 7,
      })
    ).rejects.toThrow(/peer-reset-during-identity-probe/u);
    expect(listenerCounts).toEqual([1, 1]);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(sockets.every((socket) => socket.listenerCount('error') === 0)).toBe(true);
  });

  it('bounds a never-settling peer probe by the original operation deadline', async () => {
    const started = performance.now();
    const { client } = nativeExchangeHarness({
      inspectPeerCredentials: async () => new Promise(() => undefined),
      operationBudgetMs: { acquire: 30, consume: 30, assert: 30, release: 30 },
    });

    await expect(
      client.acquireTransitionEvidence('team-a', {
        state: 'provisioning',
        ownerGeneration: 7,
      })
    ).rejects.toThrow(/request-timeout|deadline-exceeded/u);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('does not re-anchor the deadline after a scheduler pause before write', async () => {
    let monotonic = 0;
    let processChecks = 0;
    const writes: Uint8Array[] = [];
    const { client, projection } = nativeExchangeHarness({
      monotonicNow: () => monotonic,
      operationBudgetMs: { acquire: 100, consume: 100, assert: 100, release: 100 },
      connect: () => {
        const socket = new Socket();
        socket.write = ((frame: Uint8Array) => {
          writes.push(frame);
          return true;
        }) as typeof socket.write;
        setImmediate(() => socket.emit('connect'));
        return socket;
      },
      inspectPeerCredentials: async () => ({
        source: 'kernel_peer_credentials',
        pid: projection.expectedOwner.processIdentity.pid,
        uid: projection.expectedOwner.socketIdentity.uid,
        gid: projection.expectedOwner.socketIdentity.gid,
      }),
      readProcessStartIdentity: async () => {
        processChecks += 1;
        if (processChecks === 2) monotonic = 120;
        return projection.expectedOwner.processIdentity.startIdentity;
      },
    });

    await expect(
      client.acquireTransitionEvidence('team-a', {
        state: 'provisioning',
        ownerGeneration: 7,
      })
    ).rejects.toThrow(/request-timeout|deadline-exceeded/u);
    expect(writes).toEqual([]);
  });

  it('closes a pinned parent handle exactly once when stat rejects', async () => {
    let closes = 0;
    const effectiveUid = process.geteuid?.() ?? 1000;
    const parentStat = {
      dev: 10n,
      ino: 30n,
      uid: BigInt(effectiveUid),
      mode: 0o700n,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    };
    const fileSystem = {
      realpath: async (path: string) => path,
      lstat: async () => parentStat,
      open: async () => ({
        stat: async () => {
          throw new Error('stat-rejected');
        },
        close: async () => {
          closes += 1;
        },
      }),
    } as unknown as HostedApprovalTransitionFileSystem;
    const { client } = nativeExchangeHarness({
      fileSystem,
      inspectPeerCredentials: async () => new Promise(() => undefined),
    });

    await expect(
      client.acquireTransitionEvidence('team-a', {
        state: 'provisioning',
        ownerGeneration: 7,
      })
    ).rejects.toThrow(/identity-check-unavailable/u);
    expect(closes).toBe(1);
  });

  it.runIf(process.platform === 'linux')(
    'derives the exact Linux process-start identity',
    async () => {
      const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/u);
      const expected = `start_${createHash('sha256')
        .update(String(process.pid))
        .update('\0')
        .update(`proc:${fields[19]}`)
        .digest('hex')}`;
      await expect(readHostedApprovalProcessStartIdentity(process.pid)).resolves.toBe(expected);
    }
  );

  it('rejects socket, peer PID, and process-owner substitution evidence', () => {
    const owner = acquireFixture.payload.productProjection.expectedOwner;
    const socket = {
      ...owner.socketIdentity,
      mode: 384,
      socket: true,
      symbolicLink: false,
    };
    expect(() => assertHostedApprovalTransitionSocketIdentity(socket, owner, 1000)).not.toThrow();
    expect(() =>
      assertHostedApprovalTransitionSocketIdentity({ ...socket, inode: '21' }, owner, 1000)
    ).toThrow(/socket-identity-mismatch/u);
    expect(() =>
      assertHostedApprovalTransitionSocketIdentity({ ...socket, symbolicLink: true }, owner, 1000)
    ).toThrow(/socket-identity-mismatch/u);
    expect(() =>
      assertHostedApprovalTransitionPeerCredentials(
        { source: 'kernel_peer_credentials', pid: 2346, uid: 1000, gid: 1000 },
        owner
      )
    ).toThrow(/peer-identity-mismatch/u);
  });

  it('runs acquire/consume/assert/release with ordered, authenticated single-use requests', async () => {
    const operations: string[] = [];
    let pinBusy = true;
    const { client } = harness(async (request, digest) => {
      operations.push(`${request.operation}:${request.sequence}`);
      if (request.operation === 'consume' && pinBusy) {
        pinBusy = false;
        return signedError(request, digest, {
          code: 'PIN_BUSY',
          message: 'another transition holds the team pin',
          retryable: true,
          retryScope: 'same_operation',
          retryAfterMs: 25,
        });
      }
      return success(request, digest);
    });
    const evidence = await client.acquireTransitionEvidence('team-a', {
      state: 'provisioning',
      ownerGeneration: 7,
    });
    expect(Object.isFrozen(evidence!.lease.binding.routes[0]!.authority)).toBe(true);
    const pin = await evidence!.lease.consume();
    await expect(pin!.assertCurrent()).resolves.toBe(true);
    await pin!.release();
    await pin!.release();
    expect(operations).toEqual(['acquire:1', 'consume:2', 'consume:3', 'assert:4', 'release:5']);
    client.close();
    await expect(pin!.assertCurrent()).resolves.toBe(false);
    await expect(
      client.acquireTransitionEvidence('team-a', { state: 'provisioning', ownerGeneration: 7 })
    ).rejects.toThrow(/closed/u);
  });

  it('uses the exact operation deadline ceilings and advances sequence after a signed retry', async () => {
    let wall = 1_700_000_000_000;
    const requests: ParsedRequest[] = [];
    let pinBusy = true;
    const { client } = harness(
      async (request, digest) => {
        requests.push(request);
        if (request.operation === 'consume' && pinBusy) {
          pinBusy = false;
          return signedError(request, digest, {
            code: 'PIN_BUSY',
            message: 'another transition holds the team pin',
            retryable: true,
            retryScope: 'same_operation',
            retryAfterMs: 25,
          });
        }
        return success(request, digest);
      },
      {
        now: () => wall,
        monotonicNow: () => 0,
        wait: async (milliseconds) => {
          wall += milliseconds;
        },
      }
    );
    const evidence = await client.acquireTransitionEvidence('team-a', {
      state: 'provisioning',
      ownerGeneration: 7,
    });
    const pin = await evidence!.lease.consume();
    await pin!.assertCurrent();
    await pin!.release();
    expect(
      requests.map(({ operation, sequence, deadlineAtMs }) => ({
        operation,
        sequence,
        deadlineAtMs,
      }))
    ).toEqual([
      { operation: 'acquire', sequence: 1, deadlineAtMs: 1_700_000_005_000 },
      { operation: 'consume', sequence: 2, deadlineAtMs: 1_700_000_005_000 },
      { operation: 'consume', sequence: 3, deadlineAtMs: 1_700_000_005_025 },
      { operation: 'assert', sequence: 4, deadlineAtMs: 1_700_000_002_025 },
      { operation: 'release', sequence: 5, deadlineAtMs: 1_700_000_005_025 },
    ]);
  });

  it('replays byte-identical request bytes after a lost response', async () => {
    const frames: Buffer[] = [];
    const { client } = harness(async (request, digest, frame) => {
      frames.push(Buffer.from(frame));
      if (frames.length === 1) throw new Error('simulated disconnect');
      return success(request, digest);
    });
    await expect(
      client.acquireTransitionEvidence('team-a', { state: 'provisioning', ownerGeneration: 7 })
    ).resolves.not.toBeNull();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual(frames[0]);
  });

  it('detects local projection drift and releases the acquired remote lease', async () => {
    const operations: string[] = [];
    const control = harness(async (request, digest) => {
      operations.push(request.operation);
      const result = success(request, digest);
      if (request.operation === 'acquire') control.setArtifact(`sha256:${'b'.repeat(64)}`);
      return result;
    });
    await expect(
      control.client.acquireTransitionEvidence('team-a', {
        state: 'provisioning',
        ownerGeneration: 7,
      })
    ).resolves.toBeNull();
    expect(operations).toEqual(['acquire', 'release']);
  });

  it('pins a stale assertion as terminal and performs only the release lookup afterward', async () => {
    const operations: string[] = [];
    const { client } = harness(async (request, digest) => {
      operations.push(request.operation);
      if (request.operation === 'assert') {
        return response(request, digest, {
          status: 'asserted',
          leaseId: request.payload.leaseId,
          generation: request.payload.generation,
          current: false,
          reason: 'process_changed',
        });
      }
      return success(request, digest);
    });
    const evidence = await client.acquireTransitionEvidence('team-a', {
      state: 'provisioning',
      ownerGeneration: 7,
    });
    const pin = await evidence!.lease.consume();
    await expect(pin!.assertCurrent()).resolves.toBe(false);
    await expect(pin!.assertCurrent()).resolves.toBe(false);
    await pin!.release();
    expect(operations).toEqual(['acquire', 'consume', 'assert', 'release']);
  });

  it('advances the retained sequence before cleanup after a signed terminal error', async () => {
    const operations: string[] = [];
    const { client } = harness(async (request, digest) => {
      operations.push(`${request.operation}:${request.sequence}`);
      if (request.operation === 'assert') {
        return signedError(request, digest, {
          code: 'BINDING_DRIFT',
          message: 'authoritative binding changed',
          retryable: true,
          retryScope: 'new_transition',
          retryAfterMs: null,
        });
      }
      return success(request, digest);
    });
    const evidence = await client.acquireTransitionEvidence('team-a', {
      state: 'provisioning',
      ownerGeneration: 7,
    });
    const pin = await evidence!.lease.consume();
    await expect(pin!.assertCurrent()).rejects.toThrow(/binding_drift/u);
    await pin!.release();
    expect(operations).toEqual(['acquire:1', 'consume:2', 'assert:3', 'release:4']);
  });
});
