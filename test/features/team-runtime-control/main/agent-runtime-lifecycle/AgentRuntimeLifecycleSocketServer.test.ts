import {
  type AgentRuntimeLifecycleListenerSecurityBinding,
  type AgentRuntimeLifecycleSocketConnection,
  AgentRuntimeLifecycleSocketServer,
} from '@features/team-runtime-control/main/adapters/input/agent-runtime-lifecycle/AgentRuntimeLifecycleSocketServer';
import { createAgentRuntimeLifecycleAcl } from '@features/team-runtime-control/main/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeLifecycleRequest } from '@features/team-runtime-control/contracts/agent-runtime-lifecycle-acl';
import type { DispatchAgentRuntimeLifecycleEffect } from '@features/team-runtime-control/core/application/agent-runtime-lifecycle/DispatchAgentRuntimeLifecycleEffect';

const filesystemMocks = vi.hoisted(() => ({
  fstat: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: { ...actual, fstat: filesystemMocks.fstat },
    fstat: filesystemMocks.fstat,
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: {
      ...actual,
      lstat: filesystemMocks.lstat,
      realpath: filesystemMocks.realpath,
    },
    lstat: filesystemMocks.lstat,
    realpath: filesystemMocks.realpath,
  };
});

const BINDING: AgentRuntimeLifecycleListenerSecurityBinding = Object.freeze({
  kind: 'agent-runtime-lifecycle-listener-security-binding/v1',
  bootId: 'boot:test',
  socketPath: '/run/agent-teams-runtime/agent-runtime-lifecycle-test.sock',
  trustedParentDirectoryPath: '/run/agent-teams-runtime',
  expectedParentOwnerUid: 0,
  expectedParentOwnerGid: 0,
  expectedOwnerUid: 1_000,
  expectedOwnerGid: 1_000,
  expectedPeerUid: 1_000,
  expectedPeerGid: 1_000,
  maximumConnections: 2,
  maximumInflight: 1,
  idleTimeoutMs: 30,
  readTimeoutMs: 10,
  dispatchTimeoutMs: 10,
  writeTimeoutMs: 10,
});

class FakeConnection implements AgentRuntimeLifecycleSocketConnection {
  private dataListener: (chunk: Uint8Array) => void = () => undefined;
  private closeListener: () => void = () => undefined;
  readonly peerCredentials = {
    source: 'kernel_peer_credentials' as const,
    uid: BINDING.expectedPeerUid,
    gid: BINDING.expectedPeerGid,
  };
  readonly writes: string[] = [];
  closed = false;
  writeFailure: Error | null = null;
  writeNeverSettles = false;

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListener = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }
  async write(frame: string): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;
    if (this.writeNeverSettles) await new Promise<void>(() => undefined);
    this.writes.push(frame);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeListener();
  }
  emit(value: string): void {
    this.dataListener(new TextEncoder().encode(value));
  }
}

function validFrame(requestId: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId,
    callerLease: {
      kind: 'agent-runtime-lifecycle-caller-lease/v1',
      bootId: 'boot:test',
      leaseId: 'lease:test',
      authority: 'external_lifecycle_orchestrator',
      callerId: 'external-orchestrator',
      token: 'caller_token_abcdefghijklmnopqrstuvwxyz012345',
      issuedAtIso: '2026-08-07T00:59:00.000Z',
      expiresAtIso: '2026-08-07T01:02:00.000Z',
    },
    operationId: `operation:${requestId}`,
    effectLease: {
      token: `effect_${requestId.replaceAll(':', '_')}_abcdefghijklmnopqrstuvwxyz012345`,
      fence: 1,
      ownerId: `launch-team-cancellation:${requestId}`,
      claimedAtIso: '2026-08-07T00:59:30.000Z',
      expiresAtIso: '2026-08-07T01:01:30.000Z',
    },
    plan: {},
    laneId: 'lane:test',
    effect: 'preflight',
  });
}

function socketStats(overrides: Record<string, unknown> = {}) {
  return {
    dev: 9,
    ino: 27,
    uid: BINDING.expectedOwnerUid,
    gid: BINDING.expectedOwnerGid,
    mode: 0o140600,
    isSocket: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

function directoryStats(overrides: Record<string, unknown> = {}) {
  return {
    dev: 9,
    ino: 26,
    uid: BINDING.expectedParentOwnerUid,
    gid: BINDING.expectedParentOwnerGid,
    mode: 0o40555,
    isDirectory: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

function harness(
  binding: AgentRuntimeLifecycleListenerSecurityBinding = BINDING,
  filesystemOverrides: {
    readonly lstat?: (path: string) => Promise<unknown>;
    readonly fstat?: (fd: number) => Promise<unknown>;
    readonly realpath?: (path: string) => Promise<string>;
  } = {}
) {
  filesystemMocks.lstat.mockReset();
  filesystemMocks.fstat.mockReset();
  filesystemMocks.realpath.mockReset();
  filesystemMocks.lstat.mockImplementation(
    filesystemOverrides.lstat ??
      (async (path: string) => (path === binding.socketPath ? socketStats() : directoryStats()))
  );
  filesystemMocks.realpath.mockImplementation(
    filesystemOverrides.realpath ?? (async (path: string) => path)
  );
  filesystemMocks.fstat.mockImplementation(
    (fd: number, callback: (error: Error | null, stats?: unknown) => void) => {
      void (
        filesystemOverrides.fstat?.(fd) ??
        Promise.resolve(fd === 19 ? directoryStats() : socketStats())
      ).then(
        (stats) => callback(null, stats),
        (error: Error) => callback(error)
      );
    }
  );
  let accept: ((connection: AgentRuntimeLifecycleSocketConnection) => void) | undefined;
  let parentDirectoryLocked = false;
  const attackerFrames: string[] = [];
  const listener = {
    securityBinding: binding,
    onConnection: vi.fn((callback: (connection: AgentRuntimeLifecycleSocketConnection) => void) => {
      accept = callback;
    }),
    start: vi.fn().mockImplementation(async () => {
      parentDirectoryLocked = true;
      return {
        socketFd: 17,
        boundAddress: {
          source: 'kernel_getsockname' as const,
          family: 'unix' as const,
          path: `${binding.socketPath}.staged`,
        },
        publishedPathIdentity: {
          source: 'linux_o_path_before_atomic_publish_in_locked_parent' as const,
          socketNodeFd: 18,
          parentDirectoryFd: 19,
          stagedPath: `${binding.socketPath}.staged`,
          path: binding.socketPath,
          parentDirectoryPath: binding.trustedParentDirectoryPath,
        },
      };
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    attemptPathReplacement: vi.fn(() => !parentDirectoryLocked),
    deliverToReplacement: vi.fn((frame: string) => attackerFrames.push(frame)),
  };
  const dispatch = {
    execute: vi.fn(async (request: { requestId: string; effect: 'preflight' }) => ({
      protocolVersion: 1 as const,
      requestId: request.requestId,
      effect: request.effect,
      status: 'completed' as const,
      outcome: { status: 'ready' as const, readiness: {} as never },
    })),
  } as unknown as DispatchAgentRuntimeLifecycleEffect;
  const server = new AgentRuntimeLifecycleSocketServer({ listener, dispatch });
  return {
    server,
    listener,
    dispatch,
    filesystem: filesystemMocks,
    attackerFrames,
    accept: () => accept,
  };
}

async function flush(milliseconds = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('AgentRuntimeLifecycleSocketServer', () => {
  it('requires bounded Unix listener expectations rather than a caller-provided proof', () => {
    for (const securityBinding of [
      undefined,
      { ...BINDING, socketPath: '/tmp/../tmp/runtime.sock' },
      { ...BINDING, trustedParentDirectoryPath: '/tmp' },
      { ...BINDING, expectedParentOwnerUid: BINDING.expectedPeerUid },
      { ...BINDING, socketPath: `/${'x'.repeat(108)}` },
      { ...BINDING, socketPath: '/tmp/bad\0path.sock' },
      { ...BINDING, expectedPeerUid: 2_000 },
      { ...BINDING, expectedPeerGid: 2_000 },
      { ...BINDING, maximumConnections: 0 },
      { ...BINDING, maximumInflight: 3 },
      { ...BINDING, readTimeoutMs: 0 },
      { ...BINDING, idleTimeoutMs: 30_001 },
    ]) {
      expect(
        () =>
          new AgentRuntimeLifecycleSocketServer({
            listener: { securityBinding } as never,
            dispatch: {} as DispatchAgentRuntimeLifecycleEffect,
          })
      ).toThrow('agent-runtime-lifecycle-listener-not-machine-only');
    }
  });

  it('composition rejects a missing or boot-mismatched listener binding', () => {
    const deps = {
      bootId: 'boot:test',
      callerLease: {
        kind: 'agent-runtime-lifecycle-caller-lease/v1' as const,
        bootId: 'boot:test',
        leaseId: 'lease:test',
        authority: 'external_lifecycle_orchestrator' as const,
        callerId: 'external-orchestrator',
        token: 'caller_token_abcdefghijklmnopqrstuvwxyz012345',
        issuedAtIso: '2026-08-07T00:59:00.000Z',
        expiresAtIso: '2026-08-07T01:02:00.000Z',
      },
      registry: {} as never,
      listener: harness({ ...BINDING, bootId: 'boot:other' }).listener,
      cancellationFactory: { create: vi.fn() } as never,
    };
    expect(() => createAgentRuntimeLifecycleAcl(deps)).toThrow(
      'agent-runtime-lifecycle-listener-security-binding-mismatch'
    );
    expect(() =>
      createAgentRuntimeLifecycleAcl({ ...deps, listener: { securityBinding: undefined } as never })
    ).toThrow('agent-runtime-lifecycle-listener-security-binding-mismatch');
    expect(() =>
      createAgentRuntimeLifecycleAcl({ ...deps, listener: harness().listener })
    ).not.toThrow();
    expect(() =>
      createAgentRuntimeLifecycleAcl({
        ...deps,
        listener: harness().listener,
        cancellationFactory: undefined as never,
      })
    ).toThrow('agent-runtime-lifecycle-cancellation-authority-missing');
  });

  it('rejects an invalid caller token before invoking the authoritative cancellation lookup', async () => {
    const cancellationLookup = vi.fn();
    const expected = JSON.parse(validFrame('request:expected')) as AgentRuntimeLifecycleRequest;
    const transport = harness();
    const acl = createAgentRuntimeLifecycleAcl({
      bootId: 'boot:test',
      callerLease: expected.callerLease,
      registry: { resolve: vi.fn() } as never,
      listener: transport.listener,
      cancellationFactory: { create: cancellationLookup },
      clock: { nowEpochMs: () => Date.parse('2026-08-07T01:00:00.000Z') },
    });
    const parsed = JSON.parse(validFrame('request:invalid-token')) as AgentRuntimeLifecycleRequest;
    const presented = {
      ...parsed,
      callerLease: {
        ...parsed.callerLease,
        token: 'different_token_abcdefghijklmnopqrstuvwxyz012345',
      },
    } as AgentRuntimeLifecycleRequest;

    await acl.start();
    const connection = new FakeConnection();
    transport.accept()?.(connection);
    connection.emit(`${JSON.stringify(presented)}\n`);
    await flush();
    expect(connection.writes).toHaveLength(1);
    expect(JSON.parse(connection.writes[0])).toMatchObject({
      status: 'rejected',
      reason: 'unauthenticated',
    });
    expect(cancellationLookup).not.toHaveBeenCalled();
  });

  it('verifies post-bind lstat/fstat provenance and removes a rejected listener', async () => {
    for (const filesystem of [
      { lstat: vi.fn().mockResolvedValue(socketStats({ isSymbolicLink: () => true })) },
      { lstat: vi.fn().mockResolvedValue(socketStats({ mode: 0o140660 })) },
      { lstat: vi.fn().mockResolvedValue(socketStats({ isSocket: () => false })) },
      { lstat: vi.fn().mockResolvedValue(socketStats({ uid: 2_000 })) },
      { lstat: vi.fn().mockResolvedValue(socketStats({ gid: 2_000 })) },
      { fstat: vi.fn().mockResolvedValue(socketStats({ uid: 2_000 })) },
      { fstat: vi.fn().mockResolvedValue(socketStats({ isSocket: () => false })) },
      { realpath: vi.fn().mockResolvedValue('/tmp/different.sock') },
    ]) {
      const test = harness(BINDING, filesystem);
      await expect(test.server.start()).rejects.toThrow(
        'agent-runtime-lifecycle-listener-post-bind-proof-invalid'
      );
      expect(test.listener.start).toHaveBeenCalledOnce();
      expect(test.listener.stop).toHaveBeenCalledOnce();
    }
  });

  it('requires a retained, trusted, non-writable parent directory', async () => {
    for (const parentStats of [
      directoryStats({ uid: BINDING.expectedPeerUid }),
      directoryStats({ gid: 2_000 }),
      directoryStats({ mode: 0o40755 }),
      directoryStats({ mode: 0o40444 }),
      directoryStats({ isDirectory: () => false }),
      directoryStats({ isSymbolicLink: () => true }),
    ]) {
      const test = harness(BINDING, {
        lstat: vi.fn(async (path) =>
          path === BINDING.trustedParentDirectoryPath ? parentStats : socketStats()
        ),
        fstat: vi.fn(async (fd) => (fd === 19 ? parentStats : socketStats())),
      });
      await expect(test.server.start()).rejects.toThrow(
        'agent-runtime-lifecycle-listener-post-bind-proof-invalid'
      );
      expect(test.listener.stop).toHaveBeenCalledOnce();
    }
  });

  it('rejects a replaceable or changing ancestor of the trusted parent', async () => {
    for (const ancestorStats of [
      directoryStats({ uid: BINDING.expectedPeerUid }),
      directoryStats({ mode: 0o40775 }),
      directoryStats({ mode: 0o40757 }),
    ]) {
      const test = harness(BINDING, {
        lstat: vi.fn(async (path) =>
          path === '/run'
            ? ancestorStats
            : path === BINDING.socketPath
              ? socketStats()
              : directoryStats()
        ),
      });
      await expect(test.server.start()).rejects.toThrow(
        'agent-runtime-lifecycle-listener-post-bind-proof-invalid'
      );
    }

    let runObservation = 0;
    const changingAncestor = harness(BINDING, {
      lstat: vi.fn(async (path) => {
        if (path === BINDING.socketPath) return socketStats();
        if (path !== '/run') return directoryStats();
        runObservation += 1;
        return directoryStats({ ino: runObservation === 1 ? 40 : 41 });
      }),
    });
    await expect(changingAncestor.server.start()).rejects.toThrow(
      'agent-runtime-lifecycle-listener-post-bind-proof-invalid'
    );
  });

  it('binds authorization to the kernel AF_UNIX address and stable pathname identity', async () => {
    const descriptorHasDifferentSocketInode = harness(BINDING, {
      fstat: vi.fn(async (fd) =>
        fd === 17
          ? socketStats({ dev: 81, ino: 9001 })
          : fd === 19
            ? directoryStats()
            : socketStats()
      ),
    });
    await expect(descriptorHasDifferentSocketInode.server.start()).resolves.toBeUndefined();

    const wrongAddress = harness();
    vi.mocked(wrongAddress.listener.start).mockResolvedValueOnce({
      socketFd: 17,
      boundAddress: {
        source: 'kernel_getsockname',
        family: 'unix',
        path: BINDING.socketPath,
      },
      publishedPathIdentity: {
        source: 'linux_o_path_before_atomic_publish_in_locked_parent',
        socketNodeFd: 18,
        parentDirectoryFd: 19,
        stagedPath: `${BINDING.socketPath}.staged`,
        path: BINDING.socketPath,
        parentDirectoryPath: BINDING.trustedParentDirectoryPath,
      },
    });
    await expect(wrongAddress.server.start()).rejects.toThrow(
      'agent-runtime-lifecycle-listener-bound-address-invalid'
    );
    expect(wrongAddress.listener.stop).toHaveBeenCalledOnce();

    let socketObservation = 0;
    const pathnameSwap = harness(BINDING, {
      lstat: vi.fn(async (path) => {
        if (path !== BINDING.socketPath) return directoryStats();
        socketObservation += 1;
        return socketObservation === 1 ? socketStats() : socketStats({ ino: 28 });
      }),
    });
    await expect(pathnameSwap.server.start()).rejects.toThrow(
      'agent-runtime-lifecycle-listener-post-bind-proof-invalid'
    );
    expect(pathnameSwap.listener.stop).toHaveBeenCalledOnce();
  });

  it('rejects a stable pathname replacement after bind but before the first observation', async () => {
    const originalSocketNode = socketStats({ dev: 9, ino: 27 });
    const attackerSocketNode = socketStats({ dev: 9, ino: 28 });
    const test = harness(BINDING, {
      lstat: vi.fn().mockResolvedValue(attackerSocketNode),
      fstat: vi.fn(async (fd) =>
        fd === 18 ? originalSocketNode : fd === 19 ? directoryStats() : socketStats()
      ),
    });

    await expect(test.server.start()).rejects.toThrow(
      'agent-runtime-lifecycle-listener-post-bind-proof-invalid'
    );
    expect(test.filesystem.lstat).toHaveBeenCalledTimes(4);
    expect(test.listener.stop).toHaveBeenCalledOnce();
  });

  it('prevents a live pathname replacement from receiving the caller token', async () => {
    const test = harness();
    await test.server.start();
    const tokenFrame = validFrame('request:replacement-attempt');

    const replaced = test.listener.attemptPathReplacement();
    if (replaced) test.listener.deliverToReplacement(tokenFrame);

    expect(replaced).toBe(false);
    expect(test.attackerFrames).toEqual([]);
    expect(test.dispatch.execute).not.toHaveBeenCalled();
  });

  it('rejects peer UID, GID, and credential-source mismatch', async () => {
    for (const mutate of [
      (credentials: { uid: number; gid: number; source: string }) => (credentials.uid = 2_000),
      (credentials: { uid: number; gid: number; source: string }) => (credentials.gid = 2_000),
      (credentials: { uid: number; gid: number; source: string }) =>
        (credentials.source = 'userspace_claim'),
    ]) {
      const test = harness();
      await test.server.start();
      const connection = new FakeConnection();
      mutate(connection.peerCredentials as never);
      test.accept()?.(connection);
      expect(connection.closed).toBe(true);
      expect(test.dispatch.execute).not.toHaveBeenCalled();
    }
  });

  it('bounds aggregate unauthenticated connections and inflight dispatch', async () => {
    const test = harness();
    vi.mocked(test.dispatch.execute).mockImplementation(() => new Promise<never>(() => undefined));
    await test.server.start();
    const first = new FakeConnection();
    const second = new FakeConnection();
    const saturated = new FakeConnection();
    test.accept()?.(first);
    test.accept()?.(second);
    test.accept()?.(saturated);
    expect(saturated.closed).toBe(true);

    first.emit(`${validFrame('request:inflight')}\n`);
    second.emit(`${validFrame('request:backpressure')}\n`);
    expect(test.dispatch.execute).toHaveBeenCalledOnce();
    expect(second.closed).toBe(true);
  });

  it('retains inflight capacity after timeout until the real dispatch settles', async () => {
    const test = harness();
    let settleDispatch: (() => void) | undefined;
    vi.mocked(test.dispatch.execute).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleDispatch = () =>
            resolve({
              protocolVersion: 1,
              requestId: 'request:stalled',
              effect: 'preflight',
              status: 'completed',
              outcome: { status: 'ready', readiness: {} as never },
            });
        })
    );
    await test.server.start();

    const stalled = new FakeConnection();
    test.accept()?.(stalled);
    stalled.emit(`${validFrame('request:stalled')}\n`);
    await flush(BINDING.dispatchTimeoutMs + 5);
    expect(stalled.closed).toBe(true);

    const adversarial = new FakeConnection();
    test.accept()?.(adversarial);
    adversarial.emit(`${validFrame('request:after-timeout')}\n`);
    expect(adversarial.closed).toBe(true);
    expect(test.dispatch.execute).toHaveBeenCalledOnce();

    settleDispatch?.();
    await flush();
    const afterSettlement = new FakeConnection();
    test.accept()?.(afterSettlement);
    afterSettlement.emit(`${validFrame('request:after-settlement')}\n`);
    await flush();
    expect(test.dispatch.execute).toHaveBeenCalledTimes(2);
    expect(afterSettlement.writes).toHaveLength(1);
    expect(afterSettlement.closed).toBe(true);
  });

  it('serializes a concurrent start race and proves the bound descriptor once', async () => {
    const test = harness();
    let finishBind: ((value: Awaited<ReturnType<typeof test.listener.start>>) => void) | undefined;
    vi.mocked(test.listener.start).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBind = resolve;
        })
    );
    const first = test.server.start();
    const second = test.server.start();
    await flush();
    expect(test.listener.start).toHaveBeenCalledOnce();
    finishBind?.({
      socketFd: 17,
      boundAddress: {
        source: 'kernel_getsockname',
        family: 'unix',
        path: `${BINDING.socketPath}.staged`,
      },
      publishedPathIdentity: {
        source: 'linux_o_path_before_atomic_publish_in_locked_parent',
        socketNodeFd: 18,
        parentDirectoryFd: 19,
        stagedPath: `${BINDING.socketPath}.staged`,
        path: BINDING.socketPath,
        parentDirectoryPath: BINDING.trustedParentDirectoryPath,
      },
    });
    await Promise.all([first, second]);
    expect(test.filesystem.lstat).toHaveBeenCalledTimes(10);
    expect(test.listener.onConnection).toHaveBeenCalledOnce();
  });

  it('serializes stop/start and concurrent stops without stale teardown', async () => {
    const test = harness();
    await test.server.start();
    let finishStop: (() => void) | undefined;
    vi.mocked(test.listener.stop).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        })
    );

    const firstStop = test.server.stop();
    const restart = test.server.start();
    const secondStop = test.server.stop();
    await flush();
    expect(test.listener.stop).toHaveBeenCalledOnce();
    expect(test.listener.start).toHaveBeenCalledOnce();
    finishStop?.();
    await Promise.all([firstStop, restart, secondStop]);

    expect(test.listener.start).toHaveBeenCalledTimes(2);
    expect(test.listener.stop).toHaveBeenCalledTimes(2);
  });

  it('surfaces failed cleanup and requires a successful stop before restart', async () => {
    const test = harness(BINDING, {
      realpath: vi.fn().mockResolvedValue('/tmp/different.sock'),
    });
    vi.mocked(test.listener.stop)
      .mockRejectedValueOnce(new Error('unlink-failed'))
      .mockResolvedValueOnce(undefined);

    await expect(test.server.start()).rejects.toMatchObject({
      message: 'agent-runtime-lifecycle-listener-post-bind-cleanup-failed',
      errors: [expect.any(TypeError), expect.objectContaining({ message: 'unlink-failed' })],
    });
    await expect(test.server.start()).rejects.toThrow(
      'agent-runtime-lifecycle-listener-cleanup-required'
    );
    await expect(test.server.stop()).resolves.toBeUndefined();
    expect(test.listener.stop).toHaveBeenCalledTimes(2);
  });

  it('does not swallow a direct stop failure or restart an uncertain listener', async () => {
    const test = harness();
    await test.server.start();
    vi.mocked(test.listener.stop)
      .mockRejectedValueOnce(new Error('close-failed'))
      .mockResolvedValueOnce(undefined);

    await expect(test.server.stop()).rejects.toThrow('close-failed');
    await expect(test.server.start()).rejects.toThrow(
      'agent-runtime-lifecycle-listener-cleanup-required'
    );
    await expect(test.server.stop()).resolves.toBeUndefined();
    expect(test.listener.start).toHaveBeenCalledOnce();
    expect(test.listener.stop).toHaveBeenCalledTimes(2);
  });

  it('accepts one partial frame, writes one response, and closes', async () => {
    const test = harness();
    await test.server.start();
    const connection = new FakeConnection();
    test.accept()?.(connection);
    const frame = validFrame('request:first');
    connection.emit(frame.slice(0, 25));
    connection.emit(`${frame.slice(25)}\n`);
    await flush();
    expect(test.dispatch.execute).toHaveBeenCalledOnce();
    expect(connection.writes).toHaveLength(1);
    expect(connection.writes[0]).toMatch(/\n$/);
    expect(connection.closed).toBe(true);
  });

  it('closes without dispatch on pipelined or extra-delimiter input', async () => {
    const test = harness();
    await test.server.start();
    const connection = new FakeConnection();
    test.accept()?.(connection);
    connection.emit(`${validFrame('request:first')}\n${validFrame('request:second')}\n`);
    await flush();
    expect(connection.closed).toBe(true);
    expect(test.dispatch.execute).not.toHaveBeenCalled();
    expect(connection.writes).toHaveLength(0);
  });

  it('bounds overlong and partial frames and closes after read timeout', async () => {
    const test = harness();
    await test.server.start();
    const overlong = new FakeConnection();
    test.accept()?.(overlong);
    overlong.emit('x'.repeat(1024 * 1024 + 1));
    await flush();
    expect(overlong.closed).toBe(true);
    expect(overlong.writes[0]).toContain('invalid_request');

    const partial = new FakeConnection();
    test.accept()?.(partial);
    partial.emit(validFrame('request:partial').slice(0, 20));
    await flush(BINDING.readTimeoutMs + 5);
    expect(partial.closed).toBe(true);
    expect(test.dispatch.execute).not.toHaveBeenCalled();
  });

  it('closes idle, dispatch-stalled, and write-stalled connections', async () => {
    const idleTest = harness();
    await idleTest.server.start();
    const idle = new FakeConnection();
    idleTest.accept()?.(idle);
    await flush(BINDING.idleTimeoutMs + 5);
    expect(idle.closed).toBe(true);

    const dispatchTest = harness();
    vi.mocked(dispatchTest.dispatch.execute).mockImplementationOnce(
      () => new Promise<never>(() => undefined)
    );
    await dispatchTest.server.start();
    const dispatchStalled = new FakeConnection();
    dispatchTest.accept()?.(dispatchStalled);
    dispatchStalled.emit(`${validFrame('request:dispatch-stalled')}\n`);
    await flush(BINDING.dispatchTimeoutMs + 5);
    expect(dispatchStalled.closed).toBe(true);

    const writeTest = harness();
    await writeTest.server.start();
    const writeStalled = new FakeConnection();
    writeStalled.writeNeverSettles = true;
    writeTest.accept()?.(writeStalled);
    writeStalled.emit(`${validFrame('request:write-stalled')}\n`);
    await flush(BINDING.writeTimeoutMs + 5);
    expect(writeStalled.closed).toBe(true);
  });

  it('fails closed on write failure and has idempotent start-stop lifecycle', async () => {
    const test = harness();
    await test.server.start();
    await test.server.start();
    const connection = new FakeConnection();
    connection.writeFailure = new Error('peer-gone');
    test.accept()?.(connection);
    connection.emit(`${validFrame('request:write-failure')}\n`);
    await flush();
    expect(connection.closed).toBe(true);
    await test.server.stop();
    await test.server.stop();
    expect(test.listener.start).toHaveBeenCalledOnce();
    expect(test.listener.stop).toHaveBeenCalledOnce();
  });
});
