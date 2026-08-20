import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createOrchestratorLifecycleReadinessProof,
  type OrchestratorSocketIdentity,
  parseOrchestratorLifecycleOwnerProofKey,
} from '@features/team-lifecycle/main/application/ExecuteHostedLifecycleCommand';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOrchestratorLifecycleReadinessRequestProof,
  HostedLifecycleOrchestratorReadiness,
} from '../../../../src/main/composition/hosted/hostedLifecycleOrchestratorReadiness';
import { HostedLifecycleOwnerBindingConsumedError } from '../../../../src/main/composition/hosted/hostedLifecycleOwnerHighWater';
import { HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT } from '../../../../src/main/composition/hosted/hostedLifecycleOwnerHighWaterBinding';

import type { Socket } from 'node:net';

afterEach(() => vi.useRealTimers());

const OWNER_PROOF_KEY = parseOrchestratorLifecycleOwnerProofKey('cd'.repeat(32));
const MALICIOUS_PROOF_KEY = parseOrchestratorLifecycleOwnerProofKey('ab'.repeat(32));
const CHALLENGE = '12'.repeat(32);

function fakeOwner() {
  let identity: OrchestratorSocketIdentity = Object.freeze({
    device: '253',
    inode: '7001',
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    mode: 0o600,
  });
  let readyAfterAttempt = 1;
  let attempts = 0;
  let sessions = 0;
  let forcedSessionId: string | undefined;
  let forcedAuthority = 'owner-authority_readiness-test';
  let forcedGeneration: number | undefined;
  let proofKey = OWNER_PROOF_KEY;
  let mutateNextResponseWire = false;
  let postReadyAction: 'close' | 'extra-frame' | null = null;
  const ownerSockets = new Set<FakeSocket>();
  let identityError: Error | undefined;
  const requests: Record<string, unknown>[] = [];
  const bindings: Record<string, unknown>[] = [];

  class FakeSocket extends EventEmitter {
    destroyed = false;

    constructor() {
      super();
      ownerSockets.add(this);
      queueMicrotask(() => this.emit('connect'));
    }

    write(chunk: string): boolean {
      const request = JSON.parse(chunk.trim()) as Record<string, unknown>;
      requests.push(request);
      attempts += 1;
      if (attempts < readyAfterAttempt) {
        queueMicrotask(() => this.destroy());
        return true;
      }
      sessions += 1;
      const ownerBinding = {
        ownerAuthority: forcedAuthority,
        ownerGeneration: forcedGeneration ?? sessions,
        ownerSessionId:
          forcedSessionId ?? `owner-session_readiness-test-${sessions.toString().padStart(4, '0')}`,
        socketIdentity: identity,
      };
      bindings.push(ownerBinding);
      const unsignedResponse = {
        schemaVersion: 2,
        kind: 'ready',
        capability: 'hosted-lifecycle-command',
        challenge: request.challenge,
        bootstrapDigest: (request.bootstrapBinding as Record<string, unknown>).bootstrapDigest,
        ownerBinding,
      };
      queueMicrotask(() => {
        const signedResponse = `${JSON.stringify({
          ...unsignedResponse,
          ownerProof: createOrchestratorLifecycleReadinessProof(proofKey, unsignedResponse),
        })}\n`;
        this.emit(
          'data',
          Buffer.from(mutateNextResponseWire ? ` ${signedResponse}` : signedResponse)
        );
        mutateNextResponseWire = false;
        const action = postReadyAction;
        postReadyAction = null;
        if (action === 'extra-frame') {
          queueMicrotask(() => this.emit('data', Buffer.from('{"unexpected":true}\n')));
        } else if (action === 'close') {
          queueMicrotask(() => this.destroy());
        }
      });
      return true;
    }

    destroy(): this {
      if (this.destroyed) return this;
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
      return this;
    }
  }

  return {
    bindings,
    requests,
    liveSocketCount: () => [...ownerSockets].filter((socket) => !socket.destroyed).length,
    connect: () => new FakeSocket() as unknown as Socket,
    inspectSocketIdentity: async () => {
      if (identityError !== undefined) throw identityError;
      return identity;
    },
    expectedBinding: () => ({
      ownerAuthority: forcedAuthority,
      ownerGeneration: forcedGeneration ?? sessions + 1,
      ownerSessionId:
        forcedSessionId ??
        `owner-session_readiness-test-${(sessions + 1).toString().padStart(4, '0')}`,
      socketIdentity: identity,
    }),
    lose: () => {
      for (const socket of ownerSockets) socket.destroy();
    },
    rejectIdentity: () => {
      identityError = new Error('hosted-lifecycle-orchestrator-socket-identity-invalid');
    },
    replaceSocket: () => {
      identity = Object.freeze({ ...identity, inode: '7002' });
      identityError = undefined;
    },
    restoreOriginalSocketIdentity: () => {
      identity = Object.freeze({ ...identity, inode: '7001' });
      identityError = undefined;
    },
    recoverOnAttempt: (attempt: number) => {
      readyAfterAttempt = attempt;
    },
    forceSessionId: (sessionId: string | undefined) => {
      forcedSessionId = sessionId;
    },
    forceOwner: (authority: string, generation?: number) => {
      forcedAuthority = authority;
      forcedGeneration = generation;
    },
    forceProofKey: (key: typeof OWNER_PROOF_KEY) => {
      proofKey = key;
    },
    mutateNextWireWithoutResigning: () => {
      mutateNextResponseWire = true;
    },
    afterNextReady: (action: 'close' | 'extra-frame') => {
      postReadyAction = action;
    },
  };
}

function options(owner: ReturnType<typeof fakeOwner>, onOwnerLoss = vi.fn()) {
  return {
    socketPath: '/tmp/hosted-lifecycle-owner-readiness.sock',
    expectedUid: process.getuid?.() ?? 0,
    expectedGid: process.getgid?.() ?? 0,
    expectedMode: 0o600,
    ownerHighWaterPath: '/tmp/hosted-lifecycle-owner-readiness.high-water.json',
    advanceOwnerHighWater: async () => undefined,
    handshakeTimeoutMs: 100,
    onOwnerLoss,
    trustAnchor: OWNER_PROOF_KEY,
    expectedOwnerBinding: owner.expectedBinding(),
    bootstrapBinding: {
      deploymentId: 'deployment_readiness-test',
      bootId: 'boot_readiness-test',
      workspaceId: `workspace_${'a'.repeat(32)}`,
      mountGeneration: 1,
      bootstrapDigest: '11'.repeat(32),
      ownerArtifactDigest: `sha256:${'22'.repeat(32)}`,
      proofKeyId: createHash('sha256').update(Buffer.from(OWNER_PROOF_KEY, 'hex')).digest('hex'),
    },
    generateChallenge: () => CHALLENGE,
    connect: owner.connect,
    inspectSocketIdentity: owner.inspectSocketIdentity,
  };
}

describe('HostedLifecycleOrchestratorReadiness', () => {
  it('matches independent raw-32-byte mutual-readiness golden vectors', () => {
    const key = parseOrchestratorLifecycleOwnerProofKey(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    );
    const request =
      '{"schemaVersion":2,"operation":"readiness","capability":"hosted-lifecycle-command","socketIdentity":{"device":"253","inode":"7001","uid":1000,"gid":1000,"mode":384},"challenge":"1212121212121212121212121212121212121212121212121212121212121212","bootstrapBinding":{"deploymentId":"deployment_golden","bootId":"boot_golden","workspaceId":"workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mountGeneration":7,"bootstrapDigest":"1111111111111111111111111111111111111111111111111111111111111111","ownerArtifactDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","proofKeyId":"630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"},"expectedOwnerBinding":{"ownerAuthority":"owner-authority_golden-vector","ownerGeneration":41,"ownerSessionId":"owner-session_golden-vector-0001","socketIdentity":{"device":"253","inode":"7001","uid":1000,"gid":1000,"mode":384}}}';
    const response =
      '{"schemaVersion":2,"kind":"ready","capability":"hosted-lifecycle-command","challenge":"1212121212121212121212121212121212121212121212121212121212121212","bootstrapDigest":"1111111111111111111111111111111111111111111111111111111111111111","ownerBinding":{"ownerAuthority":"owner-authority_golden-vector","ownerGeneration":41,"ownerSessionId":"owner-session_golden-vector-0001","socketIdentity":{"device":"253","inode":"7001","uid":1000,"gid":1000,"mode":384}}}';

    expect(createOrchestratorLifecycleReadinessRequestProof(key, request)).toBe(
      '36fa206ae60f126add109619c408389d14d05cf1d44de7fc6e3c4eb6e3b208bb'
    );
    expect(createOrchestratorLifecycleReadinessProof(key, response)).toBe(
      'c7059f3ffcbf29080eb57b9e504236577137d63eb384029d1087be6f980d5e1e'
    );
  });

  it('binds exact schema-v2 authority/session/descriptor readiness and revokes it on loss', async () => {
    const owner = fakeOwner();
    const onOwnerLoss = vi.fn();
    const readiness = await HostedLifecycleOrchestratorReadiness.connect(
      options(owner, onOwnerLoss)
    );

    expect(readiness.currentBinding()).toEqual({
      ownerAuthority: 'owner-authority_readiness-test',
      ownerGeneration: 1,
      ownerSessionId: 'owner-session_readiness-test-0001',
      socketIdentity: {
        device: '253',
        inode: '7001',
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        mode: 0o600,
      },
    });
    const expectedRequestEnvelope = {
      schemaVersion: 2,
      operation: 'readiness',
      capability: 'hosted-lifecycle-command',
      socketIdentity: {
        device: '253',
        inode: '7001',
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        mode: 0o600,
      },
      challenge: CHALLENGE,
      bootstrapBinding: {
        deploymentId: 'deployment_readiness-test',
        bootId: 'boot_readiness-test',
        workspaceId: `workspace_${'a'.repeat(32)}`,
        mountGeneration: 1,
        bootstrapDigest: '11'.repeat(32),
        ownerArtifactDigest: `sha256:${'22'.repeat(32)}`,
        proofKeyId: createHash('sha256').update(Buffer.from(OWNER_PROOF_KEY, 'hex')).digest('hex'),
      },
      expectedOwnerBinding: {
        ownerAuthority: 'owner-authority_readiness-test',
        ownerGeneration: 1,
        ownerSessionId: 'owner-session_readiness-test-0001',
        socketIdentity: {
          device: '253',
          inode: '7001',
          uid: process.getuid?.() ?? 0,
          gid: process.getgid?.() ?? 0,
          mode: 0o600,
        },
      },
    };
    expect(owner.requests).toEqual([
      {
        ...expectedRequestEnvelope,
        controllerProof: createOrchestratorLifecycleReadinessRequestProof(
          OWNER_PROOF_KEY,
          expectedRequestEnvelope
        ),
      },
    ]);
    owner.lose();
    await vi.waitFor(() => expect(readiness.isReady()).toBe(false));
    expect(onOwnerLoss).toHaveBeenCalledOnce();
    readiness.close();
  });

  it('degrades mutation readiness on initial invalid socket identity without aborting startup', async () => {
    const owner = fakeOwner();
    owner.rejectIdentity();
    const readiness = await HostedLifecycleOrchestratorReadiness.connect(options(owner));
    expect(readiness.isReady()).toBe(false);
    expect(owner.requests).toEqual([]);
    readiness.close();
  });

  it('authenticates the exact readiness wire bytes instead of a reserialized object', async () => {
    const owner = fakeOwner();
    owner.mutateNextWireWithoutResigning();
    const readiness = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner),
      retryBackoffMs: [60_000],
    });
    expect(readiness.currentBinding()).toBeNull();
    readiness.close();
  });

  it('rejects unsafe paths and unbounded handshake/backoff configuration', async () => {
    const owner = fakeOwner();
    await expect(
      HostedLifecycleOrchestratorReadiness.connect({
        ...options(owner),
        socketPath: 'relative.sock',
      })
    ).rejects.toThrow('hosted-lifecycle-orchestrator-socket-path-invalid');
    await expect(
      HostedLifecycleOrchestratorReadiness.connect({
        ...options(owner),
        retryBackoffMs: [60_001],
      })
    ).rejects.toThrow('hosted-lifecycle-orchestrator-retry-backoff-invalid');
  });

  it('requires a complete readiness restart before admitting a descriptor-bound successor', async () => {
    const owner = fakeOwner();
    const onOwnerLoss = vi.fn();
    const readiness = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner, onOwnerLoss),
      retryBackoffMs: [1],
    });
    owner.replaceSocket();
    readiness.invalidate();

    await vi.waitFor(() => expect(onOwnerLoss).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(readiness.currentBinding()).toBeNull();
    expect(owner.requests).toHaveLength(1);
    readiness.close();

    const restarted = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner),
      retryBackoffMs: [60_000],
    });
    expect(restarted.currentBinding()).toMatchObject({
      ownerGeneration: 2,
      ownerSessionId: 'owner-session_readiness-test-0002',
      socketIdentity: { inode: '7002' },
    });
    restarted.close();
  });

  it.each(['extra-frame', 'close'] as const)(
    'never acquires readiness when a delayed handshake %s lands during lease transfer',
    async (action) => {
      const owner = fakeOwner();
      const onOwnerAcquired = vi.fn();
      owner.afterNextReady(action);
      const readiness = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(owner),
        retryBackoffMs: [60_000],
        onOwnerAcquired,
      });

      await vi.waitFor(() => expect(owner.bindings).toHaveLength(1));
      expect(readiness.currentBinding()).toBeNull();
      expect(onOwnerAcquired).not.toHaveBeenCalled();
      expect(owner.requests).toHaveLength(1);
      readiness.close();
    }
  );

  it('fails fatally when the authenticated owner disappears during durable admission', async () => {
    const owner = fakeOwner();
    const onOwnerLoss = vi.fn();
    let markHighWaterEntered: (() => void) | undefined;
    const highWaterEntered = new Promise<void>((resolve) => {
      markHighWaterEntered = resolve;
    });
    let allowHighWater: (() => void) | undefined;
    const highWaterAllowed = new Promise<void>((resolve) => {
      allowHighWater = resolve;
    });
    const connecting = HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner, onOwnerLoss),
      advanceOwnerHighWater: async () => {
        markHighWaterEntered?.();
        await highWaterAllowed;
      },
      retryBackoffMs: [60_000],
    });

    await highWaterEntered;
    owner.lose();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    allowHighWater?.();

    await expect(connecting).rejects.toThrow('hosted-lifecycle-orchestrator-handshake-unavailable');
    expect(onOwnerLoss).toHaveBeenCalledOnce();
    expect(owner.requests).toHaveLength(1);
  });

  it('disposes the unpublished owner transport when cleanup closes during durable admission', async () => {
    const owner = fakeOwner();
    const onOwnerAcquired = vi.fn();
    let markHighWaterEntered: (() => void) | undefined;
    const highWaterEntered = new Promise<void>((resolve) => {
      markHighWaterEntered = resolve;
    });
    let allowHighWater: (() => void) | undefined;
    const highWaterAllowed = new Promise<void>((resolve) => {
      allowHighWater = resolve;
    });
    let created: HostedLifecycleOrchestratorReadiness | undefined;
    const connecting = HostedLifecycleOrchestratorReadiness.connect(
      {
        ...options(owner),
        advanceOwnerHighWater: async () => {
          markHighWaterEntered?.();
          await highWaterAllowed;
        },
        onOwnerAcquired,
      },
      (readiness) => {
        created = readiness;
      }
    );

    await highWaterEntered;
    expect(owner.liveSocketCount()).toBe(1);
    created?.close();
    allowHighWater?.();

    const readiness = await connecting;
    expect(readiness.isReady()).toBe(false);
    expect(readiness.currentBinding()).toBeNull();
    expect(owner.liveSocketCount()).toBe(0);
    expect(onOwnerAcquired).not.toHaveBeenCalled();
    readiness.close();
  });

  it('rejects a malicious successor after restart even when its expected descriptor matches', async () => {
    const owner = fakeOwner();
    const first = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner),
      retryBackoffMs: [60_000],
    });
    expect(first.isReady()).toBe(true);
    first.close();

    owner.replaceSocket();
    owner.forceOwner('owner-authority_malicious-i2', 2);
    owner.forceProofKey(MALICIOUS_PROOF_KEY);
    const malicious = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner),
      retryBackoffMs: [60_000],
    });
    expect(owner.bindings[1]).toMatchObject({
      ownerAuthority: 'owner-authority_malicious-i2',
      ownerGeneration: 2,
      socketIdentity: { device: '253', inode: '7002' },
    });
    expect(malicious.currentBinding()).toBeNull();
    malicious.close();
  });

  it('continues bounded initial admission attempts beyond the old retry horizon', async () => {
    vi.useFakeTimers();
    const owner = fakeOwner();
    owner.recoverOnAttempt(23);
    const readiness = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner),
      retryBackoffMs: [1_000],
    });
    await vi.advanceTimersByTimeAsync(22_000);

    expect(readiness.currentBinding()).toMatchObject({
      ownerGeneration: 1,
      ownerSessionId: 'owner-session_readiness-test-0001',
    });
    expect(owner.requests).toHaveLength(23);
    readiness.close();
  });

  it('never attempts an in-process session replacement after authenticated owner loss', async () => {
    const owner = fakeOwner();
    const onOwnerLoss = vi.fn();
    const readiness = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner, onOwnerLoss),
      retryBackoffMs: [1],
    });
    owner.forceSessionId('owner-session_readiness-test-replacement');
    owner.lose();
    await vi.waitFor(() => expect(onOwnerLoss).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(owner.requests).toHaveLength(1);
    expect(readiness.currentBinding()).toBeNull();
    readiness.close();
  });

  it('admits a monotonic successor only after closing the lost readiness instance', async () => {
    const owner = fakeOwner();
    owner.forceOwner('owner-authority_alternating-a', 100);
    const readiness = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner),
      retryBackoffMs: [1],
    });

    owner.forceOwner('owner-authority_alternating-a', 101);
    owner.lose();
    await vi.waitFor(() => expect(readiness.currentBinding()).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(owner.requests).toHaveLength(1);
    expect(readiness.currentBinding()).toBeNull();
    readiness.close();

    const restarted = await HostedLifecycleOrchestratorReadiness.connect({
      ...options(owner),
      retryBackoffMs: [60_000],
    });
    expect(restarted.currentBinding()).toMatchObject({
      ownerAuthority: 'owner-authority_alternating-a',
      ownerGeneration: 101,
      ownerSessionId: 'owner-session_readiness-test-0002',
    });
    restarted.close();
  });

  const itLinux = process.platform === 'linux' ? it : it.skip;

  itLinux('fail-stops when a delayed retry discovers an exact consumed binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-delayed-consumed-binding-'));
    const highWaterPath = join(root, 'owner-high-water');
    const authority = 'owner-authority_delayed-consumed';
    const session = 'owner-session_delayed-consumed-0009';
    try {
      await mkdir(highWaterPath, { mode: 0o700 });
      const firstOwner = fakeOwner();
      firstOwner.forceOwner(authority, 9);
      firstOwner.forceSessionId(session);
      const first = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(firstOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      first.close();

      const replayedOwner = fakeOwner();
      replayedOwner.forceOwner(authority, 9);
      replayedOwner.forceSessionId(session);
      replayedOwner.recoverOnAttempt(2);
      const onFatalOwnerLoss = vi.fn();
      const replayed = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(replayedOwner, onFatalOwnerLoss),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [1],
      });

      await vi.waitFor(() => expect(onFatalOwnerLoss).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(replayedOwner.requests).toHaveLength(2);
      expect(replayedOwner.liveSocketCount()).toBe(0);
      expect(replayed.isReady()).toBe(false);
      expect(onFatalOwnerLoss).toHaveBeenCalledOnce();
      replayed.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux('persists owner-generation high water across readiness process replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-'));
    const highWaterPath = join(root, 'owner-high-water');
    try {
      await mkdir(highWaterPath, { mode: 0o700 });
      const firstOwner = fakeOwner();
      firstOwner.forceOwner('owner-authority_restart-safe', 9);
      const first = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(firstOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      expect(first.currentBinding()?.ownerGeneration).toBe(9);
      first.close();

      const changedAuthority = fakeOwner();
      changedAuthority.forceOwner('owner-authority_restart-replacement', 10);
      const changed = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(changedAuthority),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
      });
      expect(changed.currentBinding()).toBeNull();
      await expect(
        readdir(join(highWaterPath, 'owner-authority_restart-replacement'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      changed.close();

      const replacementOwner = fakeOwner();
      replacementOwner.forceOwner('owner-authority_restart-safe', 9);
      await expect(
        HostedLifecycleOrchestratorReadiness.connect({
          ...options(replacementOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
        })
      ).rejects.toBeInstanceOf(HostedLifecycleOwnerBindingConsumedError);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(replacementOwner.requests).toHaveLength(1);
      expect(replacementOwner.liveSocketCount()).toBe(0);

      const higherGenerationSameSession = fakeOwner();
      higherGenerationSameSession.forceOwner('owner-authority_restart-safe', 10);
      await expect(
        HostedLifecycleOrchestratorReadiness.connect({
          ...options(higherGenerationSameSession),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
        })
      ).rejects.toThrow('hosted-lifecycle-orchestrator-session-replayed');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(higherGenerationSameSession.requests).toHaveLength(1);
      expect(higherGenerationSameSession.liveSocketCount()).toBe(0);
      await expect(
        readFile(join(highWaterPath, 'owner-authority_restart-safe', '10'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });

      const freshSuccessor = fakeOwner();
      freshSuccessor.forceOwner('owner-authority_restart-safe', 10);
      freshSuccessor.forceSessionId('owner-session_restart-safe-0010');
      const restarted = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(freshSuccessor),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      expect(restarted.currentBinding()).toMatchObject({
        ownerAuthority: 'owner-authority_restart-safe',
        ownerGeneration: 10,
        ownerSessionId: 'owner-session_restart-safe-0010',
      });
      restarted.close();

      await writeFile(
        join(highWaterPath, 'owner-authority_restart-safe', '10'),
        '{"generation":10,"generation":11}\n',
        'utf8'
      );
      const corruptOwner = fakeOwner();
      corruptOwner.forceOwner('owner-authority_restart-safe', 11);
      corruptOwner.forceSessionId('owner-session_restart-safe-0011');
      const corrupt = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(corruptOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
      });
      expect(corrupt.currentBinding()).toBeNull();
      corrupt.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux(
    'burns a session-only partial publication before generation-marker recovery',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-partial-session-'));
      const highWaterPath = join(root, 'owner-high-water');
      const authority = 'owner-authority_partial-publication';
      const authorityPath = join(highWaterPath, authority);
      const burnedSession = 'owner-session_partial-publication-0007';
      const freshSession = 'owner-session_partial-publication-0008';
      const sessionMarker = `session-${createHash('sha256').update(burnedSession).digest('hex')}`;
      try {
        await mkdir(authorityPath, { recursive: true, mode: 0o700 });
        await writeFile(
          join(highWaterPath, '.owner-authority'),
          `${JSON.stringify({ ownerAuthority: authority })}\n`,
          { mode: 0o600 }
        );
        await writeFile(
          join(authorityPath, sessionMarker),
          `${JSON.stringify({ ownerSessionId: burnedSession, generation: 7 })}\n`,
          { mode: 0o600 }
        );

        const sameGeneration = fakeOwner();
        sameGeneration.forceOwner(authority, 7);
        sameGeneration.forceSessionId(freshSession);
        const rejectedGeneration = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(sameGeneration),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
        });
        expect(rejectedGeneration.currentBinding()).toBeNull();
        rejectedGeneration.close();

        const replayedSession = fakeOwner();
        replayedSession.forceOwner(authority, 8);
        replayedSession.forceSessionId(burnedSession);
        await expect(
          HostedLifecycleOrchestratorReadiness.connect({
            ...options(replayedSession),
            ownerHighWaterPath: highWaterPath,
            advanceOwnerHighWater: undefined,
            retryBackoffMs: [60_000],
          })
        ).rejects.toThrow('hosted-lifecycle-orchestrator-session-replayed');
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(replayedSession.requests).toHaveLength(1);
        expect(replayedSession.liveSocketCount()).toBe(0);

        const recoveredOwner = fakeOwner();
        recoveredOwner.forceOwner(authority, 8);
        recoveredOwner.forceSessionId(freshSession);
        const recovered = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(recoveredOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
        });
        expect(recovered.currentBinding()).toMatchObject({
          ownerAuthority: authority,
          ownerGeneration: 8,
          ownerSessionId: freshSession,
        });
        expect(await readdir(authorityPath)).toEqual(expect.arrayContaining([sessionMarker, '8']));
        recovered.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  itLinux.each(['session', 'generation'] as const)(
    'recovers an exact fresh-successor %s publication interrupted after its durable link',
    async (markerKind) => {
      const root = await mkdtemp(
        join(tmpdir(), `hosted-lifecycle-high-water-${markerKind}-pending-recovery-`)
      );
      const highWaterPath = join(root, 'owner-high-water');
      const authority = 'owner-authority_pending-successor';
      const interruptedSession = 'owner-session_pending-successor-0002';
      const freshSession = 'owner-session_pending-successor-0003';
      await mkdir(highWaterPath, { mode: 0o700 });
      try {
        const firstOwner = fakeOwner();
        firstOwner.forceOwner(authority, 1);
        const first = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(firstOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
        });
        expect(first.currentBinding()?.ownerGeneration).toBe(1);
        first.close();

        let interruptedOnce = false;
        const interruptPublication = async (): Promise<void> => {
          if (interruptedOnce) return;
          interruptedOnce = true;
          throw new Error('synthetic-readiness-process-crash');
        };
        const successor = fakeOwner();
        successor.forceOwner(authority, 2);
        successor.forceSessionId(interruptedSession);
        const interrupted = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(successor),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          ownerHighWaterTestHooks:
            markerKind === 'session'
              ? { afterSessionMarkerParentSynced: interruptPublication }
              : { afterMarkerParentSynced: interruptPublication },
          retryBackoffMs: [60_000],
        });
        expect(interrupted.currentBinding()).toBeNull();
        expect(interruptedOnce).toBe(true);
        expect(await readdir(join(highWaterPath, authority))).toEqual(
          expect.arrayContaining([expect.stringMatching(/^\.pending-[0-9a-f]{64}$/)])
        );
        interrupted.close();

        const restartedSuccessor = fakeOwner();
        restartedSuccessor.forceOwner(authority, 3);
        restartedSuccessor.forceSessionId(freshSession);
        const recovered = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(restartedSuccessor),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
        });
        expect(recovered.currentBinding()).toMatchObject({
          ownerAuthority: authority,
          ownerGeneration: 3,
          ownerSessionId: freshSession,
        });
        expect(await readdir(join(highWaterPath, authority))).toEqual(
          expect.not.arrayContaining([expect.stringMatching(/^\.pending-/)])
        );
        recovered.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  itLinux.each(['malformed-payload', 'foreign-digest'] as const)(
    'fails closed and preserves adversarial %s pending residue',
    async (residueKind) => {
      const root = await mkdtemp(join(tmpdir(), `hosted-lifecycle-high-water-${residueKind}-`));
      const highWaterPath = join(root, 'owner-high-water');
      const authority = 'owner-authority_pending-residue';
      await mkdir(highWaterPath, { mode: 0o700 });
      try {
        const firstOwner = fakeOwner();
        firstOwner.forceOwner(authority, 1);
        const first = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(firstOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
        });
        expect(first.currentBinding()?.ownerGeneration).toBe(1);
        first.close();

        const pendingName = `.pending-${residueKind === 'malformed-payload' ? 'e' : 'f'.repeat(64)}`;
        const normalizedPendingName =
          residueKind === 'malformed-payload' ? `.pending-${'e'.repeat(64)}` : pendingName;
        const residue =
          residueKind === 'malformed-payload'
            ? '{not-json\n'
            : `${JSON.stringify({
                ownerSessionId: 'owner-session_pending-residue-0002',
                generation: 2,
              })}\n`;
        const residuePath = join(highWaterPath, authority, normalizedPendingName);
        await writeFile(residuePath, residue, { mode: 0o600 });

        const nextOwner = fakeOwner();
        nextOwner.forceOwner(authority, 2);
        nextOwner.forceSessionId('owner-session_pending-residue-fresh-0002');
        const rejected = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(nextOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
        });
        expect(rejected.currentBinding()).toBeNull();
        expect(await readFile(residuePath, 'utf8')).toBe(residue);
        await expect(readFile(join(highWaterPath, authority, '2'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        rejected.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  itLinux.each([
    HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT,
    Number.MAX_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER,
  ])(
    'rejects exhausted owner generation %s before mutating durable high water',
    async (generation) => {
      const root = await mkdtemp(
        join(tmpdir(), 'hosted-lifecycle-high-water-terminal-generation-')
      );
      const highWaterPath = join(root, 'owner-high-water');
      await mkdir(highWaterPath, { mode: 0o700 });
      try {
        const owner = fakeOwner();
        owner.forceOwner('owner-authority_terminal-generation', generation);
        await expect(
          HostedLifecycleOrchestratorReadiness.connect({
            ...options(owner),
            ownerHighWaterPath: highWaterPath,
            advanceOwnerHighWater: undefined,
            retryBackoffMs: [60_000],
          })
        ).rejects.toThrow('orchestrator-lifecycle-owner-binding-invalid');
        expect(await readdir(highWaterPath)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  itLinux('durably publishes the session claim before exposing its generation marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-ordering-'));
    const highWaterPath = join(root, 'owner-high-water');
    const authority = 'owner-authority_ordering';
    await mkdir(highWaterPath, { mode: 0o700 });
    try {
      const owner = fakeOwner();
      owner.forceOwner(authority, 17);
      owner.forceSessionId('owner-session_ordering-0017');
      const observed = vi.fn();
      const readiness = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(owner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        ownerHighWaterTestHooks: {
          afterSessionMarkerParentSynced: async (sessionMarkerPath) => {
            const entries = await readdir(join(highWaterPath, authority));
            expect(entries).toContain(
              sessionMarkerPath.slice(sessionMarkerPath.lastIndexOf('/') + 1)
            );
            expect(entries).not.toContain('17');
            observed();
          },
        },
      });

      expect(readiness.currentBinding()?.ownerGeneration).toBe(17);
      expect(observed).toHaveBeenCalledOnce();
      expect(await readdir(join(highWaterPath, authority))).toEqual(
        expect.arrayContaining([
          '17',
          `session-${createHash('sha256').update('owner-session_ordering-0017').digest('hex')}`,
        ])
      );
      readiness.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux(
    'serializes concurrent admissions and rejects a lower generation after a higher one',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-session-race-'));
      const highWaterPath = join(root, 'owner-high-water');
      await mkdir(highWaterPath, { mode: 0o700 });
      let markHighAdmissionEntered: (() => void) | undefined;
      const highAdmissionEntered = new Promise<void>((resolve) => {
        markHighAdmissionEntered = resolve;
      });
      let allowHighAdmission: (() => void) | undefined;
      const highAdmissionAllowed = new Promise<void>((resolve) => {
        allowHighAdmission = resolve;
      });
      try {
        const highOwner = fakeOwner();
        const lowOwner = fakeOwner();
        highOwner.forceOwner('owner-authority_session-race', 12);
        lowOwner.forceOwner('owner-authority_session-race', 11);
        lowOwner.forceSessionId('owner-session_readiness-race-0002');
        const highPromise = HostedLifecycleOrchestratorReadiness.connect({
          ...options(highOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          ownerHighWaterTestHooks: {
            afterAuthorityOpened: async () => {
              markHighAdmissionEntered?.();
              await highAdmissionAllowed;
            },
          },
          retryBackoffMs: [60_000],
        });
        await highAdmissionEntered;
        const lowPromise = HostedLifecycleOrchestratorReadiness.connect({
          ...options(lowOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
        });
        allowHighAdmission?.();
        const [high, low] = await Promise.all([highPromise, lowPromise]);
        expect(high.currentBinding()?.ownerGeneration).toBe(12);
        expect(low.currentBinding()).toBeNull();
        expect(await readdir(join(highWaterPath, 'owner-authority_session-race'))).toHaveLength(2);
        high.close();
        low.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  itLinux('parent-fsyncs an existing authority directory during recovery admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-parent-sync-'));
    const highWaterPath = join(root, 'owner-high-water');
    await mkdir(highWaterPath, { mode: 0o700 });
    try {
      const firstOwner = fakeOwner();
      firstOwner.forceOwner('owner-authority_parent-sync', 1);
      const first = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(firstOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      expect(first.isReady()).toBe(true);
      first.close();

      const observed = vi.fn();
      const secondOwner = fakeOwner();
      secondOwner.forceOwner('owner-authority_parent-sync', 2);
      secondOwner.forceSessionId('owner-session_parent-sync-0002');
      const second = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(secondOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        ownerHighWaterTestHooks: { afterAuthorityParentSynced: observed },
      });
      expect(second.isReady()).toBe(true);
      expect(observed).toHaveBeenCalledWith(
        expect.stringMatching(/\/owner-authority_parent-sync$/)
      );
      second.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux('recovers a stale admission lock left by a crashed readiness process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-stale-lock-'));
    const highWaterPath = join(root, 'owner-high-water');
    const authorityPath = join(highWaterPath, 'owner-authority_stale-lock');
    const lockPath = join(authorityPath, '.admission-lock');
    await mkdir(authorityPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(highWaterPath, '.owner-authority'),
      `${JSON.stringify({ ownerAuthority: 'owner-authority_stale-lock' })}\n`,
      { mode: 0o600 }
    );
    await mkdir(lockPath, { mode: 0o700 });
    await utimes(lockPath, new Date(0), new Date(0));
    try {
      const owner = fakeOwner();
      owner.forceOwner('owner-authority_stale-lock', 4);
      const readiness = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(owner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      expect(readiness.currentBinding()?.ownerGeneration).toBe(4);
      expect(await readdir(authorityPath)).not.toContain('.admission-lock');
      readiness.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux('fails closed when the durable owner-authority pin has another hard link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-authority-link-'));
    const highWaterPath = join(root, 'owner-high-water');
    const authority = 'owner-authority_authority-link';
    await mkdir(highWaterPath, { mode: 0o700 });
    try {
      const firstOwner = fakeOwner();
      firstOwner.forceOwner(authority, 1);
      const first = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(firstOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      expect(first.currentBinding()?.ownerGeneration).toBe(1);
      first.close();

      await link(join(highWaterPath, '.owner-authority'), join(root, 'authority-pin-hard-link'));
      const nextOwner = fakeOwner();
      nextOwner.forceOwner(authority, 2);
      nextOwner.forceSessionId('owner-session_authority-link-0002');
      const next = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(nextOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
      });

      expect(next.currentBinding()).toBeNull();
      await expect(readFile(join(highWaterPath, authority, '2'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      next.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux('validates the authority layout before recovering a pending missing pin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-pending-pin-'));
    const highWaterPath = join(root, 'owner-high-water');
    const authority = 'owner-authority_pending-pin';
    const payload = `${JSON.stringify({ ownerAuthority: authority })}\n`;
    const pendingName = `.pending-${createHash('sha256')
      .update(`.owner-authority\u0000${payload}`, 'utf8')
      .digest('hex')}`;
    const foreignAuthorityPath = join(highWaterPath, 'owner-authority_foreign-namespace');
    await mkdir(highWaterPath, { mode: 0o700 });
    await writeFile(join(highWaterPath, pendingName), payload, { mode: 0o600 });
    await mkdir(foreignAuthorityPath, { mode: 0o700 });
    try {
      const owner = fakeOwner();
      owner.forceOwner(authority, 1);
      const readiness = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(owner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
      });

      expect(readiness.currentBinding()).toBeNull();
      await expect(readFile(join(highWaterPath, '.owner-authority'), 'utf8')).rejects.toMatchObject(
        { code: 'ENOENT' }
      );
      expect(await readFile(join(highWaterPath, pendingName), 'utf8')).toBe(payload);
      await expect(readdir(join(highWaterPath, authority))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      readiness.close();

      await rm(foreignAuthorityPath, { recursive: true });
      const recoveryOwner = fakeOwner();
      recoveryOwner.forceOwner(authority, 1);
      const recovered = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(recoveryOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      expect(recovered.currentBinding()?.ownerGeneration).toBe(1);
      expect(await readFile(join(highWaterPath, '.owner-authority'), 'utf8')).toBe(payload);
      await expect(readFile(join(highWaterPath, pendingName), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      recovered.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux('poisons an existing authority namespace when its durable pin is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-missing-pin-'));
    const highWaterPath = join(root, 'owner-high-water');
    const originalAuthority = 'owner-authority_missing-pin-original';
    await mkdir(highWaterPath, { mode: 0o700 });
    try {
      const firstOwner = fakeOwner();
      firstOwner.forceOwner(originalAuthority, 5);
      const first = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(firstOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      expect(first.currentBinding()?.ownerGeneration).toBe(5);
      first.close();
      await unlink(join(highWaterPath, '.owner-authority'));

      const changedOwner = fakeOwner();
      changedOwner.forceOwner('owner-authority_missing-pin-replacement', 6);
      changedOwner.forceSessionId('owner-session_missing-pin-replacement');
      const changed = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(changedOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
      });
      expect(changed.currentBinding()).toBeNull();
      await expect(readFile(join(highWaterPath, '.owner-authority'), 'utf8')).rejects.toMatchObject(
        {
          code: 'ENOENT',
        }
      );
      changed.close();

      const sameAuthority = fakeOwner();
      sameAuthority.forceOwner(originalAuthority, 6);
      sameAuthority.forceSessionId('owner-session_missing-pin-same-authority');
      const rejected = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(sameAuthority),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
      });
      expect(rejected.currentBinding()).toBeNull();
      await expect(
        readFile(join(highWaterPath, originalAuthority, '6'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(highWaterPath, '.owner-authority'), 'utf8')).rejects.toMatchObject(
        { code: 'ENOENT' }
      );
      rejected.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux(
    'keeps a corrupt authority pin fail-closed after the corrupt file is removed',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-corrupt-pin-'));
      const highWaterPath = join(root, 'owner-high-water');
      const authority = 'owner-authority_corrupt-pin';
      await mkdir(highWaterPath, { mode: 0o700 });
      try {
        const firstOwner = fakeOwner();
        firstOwner.forceOwner(authority, 4);
        const first = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(firstOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
        });
        expect(first.currentBinding()?.ownerGeneration).toBe(4);
        first.close();

        const pinPath = join(highWaterPath, '.owner-authority');
        await writeFile(
          pinPath,
          `${JSON.stringify({ ownerAuthority: authority, injected: true })}\n`,
          {
            mode: 0o600,
          }
        );
        const corruptCandidate = fakeOwner();
        corruptCandidate.forceOwner(authority, 5);
        corruptCandidate.forceSessionId('owner-session_corrupt-pin-0005');
        const corrupt = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(corruptCandidate),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
        });
        expect(corrupt.currentBinding()).toBeNull();
        corrupt.close();

        await unlink(pinPath);
        const missingCandidate = fakeOwner();
        missingCandidate.forceOwner(authority, 5);
        missingCandidate.forceSessionId('owner-session_corrupt-pin-retry-0005');
        const missing = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(missingCandidate),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
        });
        expect(missing.currentBinding()).toBeNull();
        await expect(readFile(join(highWaterPath, authority, '5'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        missing.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  itLinux.each(['generation', 'session'] as const)(
    'fails closed when an existing %s marker has another hard link',
    async (markerKind) => {
      const root = await mkdtemp(join(tmpdir(), `hosted-lifecycle-high-water-${markerKind}-link-`));
      const highWaterPath = join(root, 'owner-high-water');
      const authority = 'owner-authority_binding-marker-link';
      await mkdir(highWaterPath, { mode: 0o700 });
      try {
        const firstOwner = fakeOwner();
        firstOwner.forceOwner(authority, 1);
        const first = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(firstOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
        });
        expect(first.currentBinding()?.ownerGeneration).toBe(1);
        first.close();

        const authorityPath = join(highWaterPath, authority);
        const markerName =
          markerKind === 'generation'
            ? '1'
            : (await readdir(authorityPath)).find((name) => name.startsWith('session-'))!;
        await link(join(authorityPath, markerName), join(root, `${markerKind}-marker-hard-link`));
        const nextOwner = fakeOwner();
        nextOwner.forceOwner(authority, 2);
        nextOwner.forceSessionId('owner-session_binding-marker-link-0002');
        const next = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(nextOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
        });

        expect(next.currentBinding()).toBeNull();
        await expect(readFile(join(authorityPath, '2'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        next.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  itLinux('rejects an oversized marker before attempting to parse it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-marker-size-'));
    const highWaterPath = join(root, 'owner-high-water');
    const authority = 'owner-authority_marker-size';
    await mkdir(highWaterPath, { mode: 0o700 });
    try {
      const firstOwner = fakeOwner();
      firstOwner.forceOwner(authority, 1);
      const first = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(firstOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
      });
      expect(first.currentBinding()?.ownerGeneration).toBe(1);
      first.close();

      await writeFile(join(highWaterPath, authority, '1'), 'x'.repeat(4_096), 'utf8');
      const nextOwner = fakeOwner();
      nextOwner.forceOwner(authority, 2);
      nextOwner.forceSessionId('owner-session_marker-size-0002');
      const next = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(nextOwner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
      });

      expect(next.currentBinding()).toBeNull();
      await expect(readFile(join(highWaterPath, authority, '2'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      next.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux('fails closed instead of following a renamed private high-water root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-root-race-'));
    const highWaterPath = join(root, 'owner-high-water');
    const detachedPath = join(root, 'owner-high-water-detached');
    await mkdir(highWaterPath, { mode: 0o700 });
    try {
      const owner = fakeOwner();
      owner.forceOwner('owner-authority_root-race', 7);
      const readiness = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(owner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
        ownerHighWaterTestHooks: {
          afterRootOpened: async () => {
            await rename(highWaterPath, detachedPath);
            await mkdir(highWaterPath, { mode: 0o700 });
          },
        },
      });

      expect(readiness.currentBinding()).toBeNull();
      expect(await readdir(highWaterPath)).toEqual([]);
      expect(await readdir(detachedPath)).toEqual([]);
      readiness.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux(
    'rejects a same-name marker replacement after opening the durable descriptor',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-file-race-'));
      const highWaterPath = join(root, 'owner-high-water');
      const authority = 'owner-authority_marker-race';
      await mkdir(highWaterPath, { mode: 0o700 });
      try {
        const firstOwner = fakeOwner();
        firstOwner.forceOwner(authority, 9);
        const first = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(firstOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
        });
        expect(first.currentBinding()?.ownerGeneration).toBe(9);
        first.close();

        const markerPath = join(highWaterPath, authority, '9');
        const original = await readFile(markerPath, 'utf8');
        const replacementOwner = fakeOwner();
        replacementOwner.forceOwner(authority, 10);
        let substituted = false;
        const replacement = await HostedLifecycleOrchestratorReadiness.connect({
          ...options(replacementOwner),
          ownerHighWaterPath: highWaterPath,
          advanceOwnerHighWater: undefined,
          retryBackoffMs: [60_000],
          ownerHighWaterTestHooks: {
            afterExistingMarkerOpened: async (stableMarkerPath) => {
              if (substituted) return;
              substituted = true;
              await rename(stableMarkerPath, `${stableMarkerPath}.detached`);
              await writeFile(stableMarkerPath, original, { mode: 0o600 });
            },
          },
        });

        expect(replacement.currentBinding()).toBeNull();
        await expect(readFile(join(highWaterPath, authority, '10'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        replacement.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  itLinux('does not accept a replacement for the fsynced new generation marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-high-water-publish-race-'));
    const highWaterPath = join(root, 'owner-high-water');
    await mkdir(highWaterPath, { mode: 0o700 });
    try {
      const owner = fakeOwner();
      owner.forceOwner('owner-authority_publish-race', 12);
      const readiness = await HostedLifecycleOrchestratorReadiness.connect({
        ...options(owner),
        ownerHighWaterPath: highWaterPath,
        advanceOwnerHighWater: undefined,
        retryBackoffMs: [60_000],
        ownerHighWaterTestHooks: {
          afterMarkerParentSynced: async (stableMarkerPath) => {
            const marker = await readFile(stableMarkerPath, 'utf8');
            await rename(stableMarkerPath, `${stableMarkerPath}.detached`);
            await writeFile(stableMarkerPath, marker, { mode: 0o600 });
          },
        },
      });

      expect(readiness.currentBinding()).toBeNull();
      readiness.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
