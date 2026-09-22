import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import {
  type OrchestratorLifecycleOwnerBinding,
  parseOrchestratorLifecycleOwnerBinding,
  parseOrchestratorLifecycleOwnerProofKey,
} from '@features/team-lifecycle/main/application/ExecuteHostedLifecycleCommand';
import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  type HostedMessageRuntimeDeliveryRequest,
  type HostedTeamMessageAuthorityPort,
  parseHostedClientMessageId,
  parseHostedMessageId,
  type SendHostedTeamMessageCommand,
} from '@features/team-message-delivery/main/hosted';
import {
  createQueryContext,
  parseAuthorizedScope,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import { AuthorizedHostedTeamMessageAuthority } from '../../../../src/features/team-message-delivery/main/composition/AuthorizedHostedTeamMessageAuthority';
import { HostedTeamMessageOrchestratorAuthority } from '../../../../src/main/composition/hosted/hostedTeamMessageOrchestratorAuthority';

import type { Socket } from 'node:net';

const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const FOREIGN_WORKSPACE_ID = parseWorkspaceId(`workspace_${'9'.repeat(32)}`);
const SOCKET_IDENTITY = Object.freeze({
  device: '253',
  inode: '7001',
  uid: 0,
  gid: 0,
  mode: 0o600,
});
const REPLACED_SOCKET_IDENTITY = Object.freeze({
  device: '253',
  inode: '7002',
  uid: 0,
  gid: 0,
  mode: 0o600,
});
const OWNER_BINDING = parseOrchestratorLifecycleOwnerBinding({
  ownerAuthority: 'owner-authority_message-test',
  ownerGeneration: 1,
  ownerSessionId: 'owner-session_message-test-0001',
  socketIdentity: SOCKET_IDENTITY,
});
const REBOUND_OWNER = parseOrchestratorLifecycleOwnerBinding({
  ...OWNER_BINDING,
  ownerGeneration: 2,
  ownerSessionId: 'owner-session_message-test-0002',
});
const OWNER_PROOF_KEY = parseOrchestratorLifecycleOwnerProofKey('ab'.repeat(32));
const MESSAGE_ID = parseHostedMessageId(`message_${'c'.repeat(32)}`);
const PROOF_DOMAIN = 'agent-teams.hosted-team-message.owner-proof/v1';
const ACTIVE_IDENTITY = parseTeamIdentityRecord({
  teamId: TEAM_ID,
  state: 'active',
  legacyKey: 'message-test-team',
  directoryFingerprint: 'cd'.repeat(32),
  workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 1 },
  adoptionIntentId: `adoption_${'de'.repeat(16)}`,
  identityChecksum: 'ef'.repeat(32),
  createdAt: '2026-08-09T00:00:00.000Z',
  activatedAt: '2026-08-09T00:00:01.000Z',
  tombstonedAt: null,
});
const REBOUND_TEAM_IDENTITY = parseTeamIdentityRecord({
  ...ACTIVE_IDENTITY,
  legacyKey: 'message-test-team-rebound',
  directoryFingerprint: 'ac'.repeat(32),
  adoptionIntentId: `adoption_${'ad'.repeat(16)}`,
  identityChecksum: 'ab'.repeat(32),
  createdAt: '2026-08-09T00:00:02.000Z',
  activatedAt: '2026-08-09T00:00:03.000Z',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function command(): SendHostedTeamMessageCommand {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    teamId: TEAM_ID,
    clientMessageId: parseHostedClientMessageId('client_message_authority-race-0001'),
    text: 'Do not cross an authority race.',
  });
}

function deliveryRequest(): HostedMessageRuntimeDeliveryRequest {
  return Object.freeze({
    teamId: TEAM_ID,
    messageId: MESSAGE_ID,
    clientMessageId: command().clientMessageId,
    text: command().text,
  });
}

function invoke(
  authority: HostedTeamMessageOrchestratorAuthority,
  operation: 'persist' | 'deliver',
  signal = new AbortController().signal,
  revalidate: () => Promise<boolean> = () => Promise.resolve(true)
) {
  const queryContext = context(signal);
  authority.bindGrantFence(queryContext, {
    ownerEffectFence: Object.freeze({
      grantRevision: '12'.repeat(32),
      identityChecksum: ACTIVE_IDENTITY.identityChecksum!,
    }),
    revalidate,
  });
  return operation === 'persist'
    ? authority.persistMessage(command(), queryContext)
    : authority.deliverPersistedMessage(deliveryRequest(), queryContext);
}

function invokeTaskMutation(
  authority: HostedTeamMessageOrchestratorAuthority,
  revalidate: () => Promise<boolean> = () => Promise.resolve(true)
) {
  const queryContext = context();
  authority.bindGrantFence(queryContext, {
    ownerEffectFence: Object.freeze({
      grantRevision: '12'.repeat(32),
      identityChecksum: ACTIVE_IDENTITY.identityChecksum!,
    }),
    revalidate,
  });
  return authority.exchangeOwnerMutation(
    'task_mutate',
    Object.freeze({ schemaVersion: 1, commandId: `command_${'91'.repeat(16)}` }),
    TEAM_ID,
    queryContext
  );
}

function rejectedResult(operation: 'persist' | 'deliver') {
  return operation === 'persist' ? { kind: 'unavailable' } : { kind: 'operator_required' };
}

function context(signal = new AbortController().signal) {
  return createQueryContext({
    actorId: 'actor_message-authority-test',
    sessionId: 'session_message-authority-test',
    deploymentId: 'deployment_message-authority-test',
    bootId: 'boot_message-authority-test',
    requestId: 'request_message-authority-test',
    authorizedScope: parseAuthorizedScope('scope_message-authority-test'),
    deadlineAtMs: Date.now() + 10_000,
    signal,
  });
}

class DestroyableFakeSocket extends EventEmitter {
  destroyed = false;
  endCalls = 0;

  setEncoding(): this {
    return this;
  }

  end(chunk?: string): this {
    this.endCalls += 1;
    if (chunk !== undefined) {
      (this as unknown as { write(value: string): boolean }).write(chunk);
    }
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

class FakeSocket extends DestroyableFakeSocket {
  readonly write = vi.fn(() => true);
}

class ValidResponseSocket extends DestroyableFakeSocket {
  lastRequest: Record<string, unknown> | null = null;
  ownerResponseEmitted = false;

  constructor(
    private readonly substituteOperation = false,
    private readonly substituteOwnerBinding?: unknown,
    private readonly completion: 'clean-end' | 'delayed-extra-frame' = 'clean-end',
    private readonly substituteOwnerEffectFence = false
  ) {
    super();
    queueMicrotask(() => this.emit('connect'));
  }

  setEncoding(): this {
    return this;
  }

  write(chunk: string): boolean {
    const request = JSON.parse(chunk.trim()) as Record<string, unknown>;
    this.lastRequest = request;
    const payload =
      request.operation === 'message_persist'
        ? {
            schemaVersion: 2,
            kind: 'persisted',
            receipt: {
              schemaVersion: 1,
              teamId: TEAM_ID,
              messageId: MESSAGE_ID,
              clientMessageId: command().clientMessageId,
              persistence: 'durable',
            },
          }
        : { schemaVersion: 2, kind: 'delivered' };
    let responseOperation = request.operation;
    if (this.substituteOperation) {
      responseOperation =
        request.operation === 'message_persist' ? 'message_deliver' : 'message_persist';
    }
    const requestAuthority = request.authority as Record<string, unknown>;
    const responseAuthority = this.substituteOwnerEffectFence
      ? {
          ...requestAuthority,
          ownerEffectFence: {
            ...(requestAuthority.ownerEffectFence as Record<string, unknown>),
            grantRevision: '34'.repeat(32),
          },
        }
      : request.authority;
    const unsignedResponse = {
      schemaVersion: 2,
      exchangeId: request.exchangeId,
      operation: responseOperation,
      ownerBinding: this.substituteOwnerBinding ?? request.ownerBinding,
      authority: responseAuthority,
      payload,
    };
    const ownerProof = createHmac('sha256', Buffer.from(OWNER_PROOF_KEY, 'hex'))
      .update(
        `${PROOF_DOMAIN}\u0000${String(request.operation)}\u0000response\u0000${JSON.stringify(unsignedResponse)}`
      )
      .digest('hex');
    queueMicrotask(() => {
      this.ownerResponseEmitted = true;
      this.emit('data', `${JSON.stringify({ ...unsignedResponse, ownerProof })}\n`);
      if (this.completion === 'clean-end') {
        this.emit('end');
        return;
      }
      queueMicrotask(() => {
        this.emit('data', '{}\n');
        this.emit('end');
      });
    });
    return true;
  }
}

function harness(
  inspectSocketIdentity: () => Promise<OrchestratorLifecycleOwnerBinding['socketIdentity']>,
  connectSocket: () => Socket = () => {
    throw new Error('unexpected-connect');
  },
  getTeamIdentity: () => Promise<TeamIdentityRecord | null> = () =>
    Promise.resolve(ACTIVE_IDENTITY),
  mountGeneration = 1
) {
  let binding: OrchestratorLifecycleOwnerBinding | null = OWNER_BINDING;
  const invalidate = vi.fn(() => {
    binding = null;
  });
  const connect = vi.fn(connectSocket);
  const inspect = vi.fn(inspectSocketIdentity);
  const teamIdentities: TeamIdentityReadGateway = {
    listTeamIdentities: () => Promise.resolve(Object.freeze([ACTIVE_IDENTITY])),
    getTeamIdentity: (teamId) => (teamId === TEAM_ID ? getTeamIdentity() : Promise.resolve(null)),
  };
  const authority = new HostedTeamMessageOrchestratorAuthority({
    lease: {
      socketPath: join(tmpdir(), 'hosted-team-message-authority.sock'),
      currentBinding: () => binding,
      invalidate,
    },
    ownerProofKey: OWNER_PROOF_KEY,
    mountBinding: {
      workspaceId: WORKSPACE_ID,
      mountGeneration,
      declaredRootHash: '12'.repeat(32),
    },
    teamIdentities,
    restoreGeneration: 1,
    connect,
    inspectSocketIdentity: inspect,
  });
  return {
    authority,
    connect,
    inspect,
    invalidate,
    rebind: () => {
      binding = REBOUND_OWNER;
    },
  };
}

function responseInspectionHarness(getTeamIdentity?: () => Promise<TeamIdentityRecord | null>) {
  let inspections = 0;
  const postResponseInspection = deferred<typeof SOCKET_IDENTITY>();
  const controlled = harness(
    () => {
      inspections += 1;
      return inspections <= 2 ? Promise.resolve(SOCKET_IDENTITY) : postResponseInspection.promise;
    },
    () => new ValidResponseSocket() as unknown as Socket,
    getTeamIdentity
  );
  return { ...controlled, postResponseInspection };
}

describe('HostedTeamMessageOrchestratorAuthority', () => {
  it.each(
    ([
      ['generation 1 startup', 1],
      ['trusted generation 2 restart', 2],
    ] as const).flatMap(([phase, mountGeneration]) =>
      (['persist', 'deliver', 'task_mutate'] as const).map(
        (operation) => [phase, mountGeneration, operation] as const
      )
    )
  )(
    '%s admits a stable generation-1 team identity at mount generation %i for %s',
    async (_phase, mountGeneration, operation) => {
      const sockets: ValidResponseSocket[] = [];
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => {
          const socket = new ValidResponseSocket();
          sockets.push(socket);
          return socket as unknown as Socket;
        },
        () => Promise.resolve(ACTIVE_IDENTITY),
        mountGeneration
      );

      const result =
        operation === 'task_mutate'
          ? invokeTaskMutation(controlled.authority)
          : invoke(controlled.authority, operation);
      await expect(result).resolves.toMatchObject(
        operation === 'persist' ? { kind: 'persisted' } : { kind: 'delivered' }
      );
      expect(sockets[0]?.lastRequest).toMatchObject({
        operation:
          operation === 'persist'
            ? 'message_persist'
            : operation === 'deliver'
              ? 'message_deliver'
              : 'task_mutate',
        authority: { mountBinding: { mountGeneration } },
      });
    }
  );

  it('fails closed before owner connection for message binding rollback, mismatch, and unbound replay', async () => {
    let identity = parseTeamIdentityRecord({
      ...ACTIVE_IDENTITY,
      workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 2 },
    });
    const controlled = harness(
      () => Promise.resolve(SOCKET_IDENTITY),
      () => new ValidResponseSocket() as unknown as Socket,
      () => Promise.resolve(identity),
      2
    );
    await expect(invoke(controlled.authority, 'persist')).resolves.toMatchObject({
      kind: 'persisted',
    });

    identity = parseTeamIdentityRecord({
      ...identity,
      workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 1 },
    });
    await expect(invoke(controlled.authority, 'persist')).resolves.toEqual({
      kind: 'unavailable',
    });

    identity = parseTeamIdentityRecord({
      ...identity,
      workspaceBinding: { workspaceId: FOREIGN_WORKSPACE_ID, generation: 2 },
    });
    await expect(invoke(controlled.authority, 'persist')).resolves.toEqual({
      kind: 'unavailable',
    });

    identity = parseTeamIdentityRecord({ ...identity, workspaceBinding: null });
    await expect(invoke(controlled.authority, 'persist')).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(controlled.connect).toHaveBeenCalledOnce();
  });

  it('requires an exact grant revision and canonical identity checksum before owner effects', async () => {
    const controlled = harness(
      () => Promise.resolve(SOCKET_IDENTITY),
      () => new ValidResponseSocket() as unknown as Socket
    );
    const missingContext = context();
    expect(() =>
      controlled.authority.bindGrantFence(missingContext, {
        revalidate: () => Promise.resolve(true),
      } as never)
    ).toThrow('hosted-team-message-grant-fence-invalid');

    const mismatchedContext = context();
    controlled.authority.bindGrantFence(mismatchedContext, {
      ownerEffectFence: {
        grantRevision: '12'.repeat(32),
        identityChecksum: 'ff'.repeat(32),
      },
      revalidate: () => Promise.resolve(true),
    });
    await expect(
      controlled.authority.persistMessage(command(), mismatchedContext)
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(controlled.connect).not.toHaveBeenCalled();
    expect(controlled.inspect).not.toHaveBeenCalled();
  });

  it('requires a live exact grant fence instead of a cached command principal', async () => {
    const source = {
      bindGrantFence: vi.fn(),
      readWindow: vi.fn(() => Promise.resolve({ kind: 'unavailable' as const })),
      persistMessage: vi.fn(() =>
        Promise.resolve({
          kind: 'persisted' as const,
          receipt: {
            schemaVersion: 1 as const,
            teamId: TEAM_ID,
            messageId: MESSAGE_ID,
            clientMessageId: command().clientMessageId,
            persistence: 'durable' as const,
          },
        })
      ),
      deliverPersistedMessage: vi.fn(() => Promise.resolve({ kind: 'delivered' as const })),
    } satisfies HostedTeamMessageAuthorityPort;
    const queryContext = context();
    const httpRequest = {};
    const requests = new WeakMap([[queryContext, httpRequest]]);
    const captureTeamWorkspaceGrantFence = vi.fn(() => Promise.resolve(null));
    const authority = new AuthorizedHostedTeamMessageAuthority(source, requests, {
      authenticatedPrincipalFor: () =>
        ({ principal: { permissions: ['hosted.command'] } }) as never,
      isHostedQueryAuthorized: () => Promise.resolve(true),
      isHostedTaskMutationAuthorized: () => Promise.resolve(true),
      isTeamWorkspaceAuthorized: () => Promise.resolve(true),
      captureTeamWorkspaceGrantFence,
    });

    await expect(authority.persistMessage(command(), queryContext)).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(
      authority.deliverPersistedMessage(deliveryRequest(), queryContext)
    ).resolves.toEqual({ kind: 'operator_required' });
    expect(captureTeamWorkspaceGrantFence).toHaveBeenCalledTimes(2);
    expect(captureTeamWorkspaceGrantFence).toHaveBeenNthCalledWith(
      1,
      httpRequest,
      TEAM_ID,
      'hosted.command'
    );
    expect(captureTeamWorkspaceGrantFence).toHaveBeenNthCalledWith(
      2,
      httpRequest,
      TEAM_ID,
      'hosted.command'
    );
    expect(source.bindGrantFence).not.toHaveBeenCalled();
    expect(source.persistMessage).not.toHaveBeenCalled();
    expect(source.deliverPersistedMessage).not.toHaveBeenCalled();
  });

  it.each(['persist', 'deliver'] as const)(
    'half-closes the %s request after its single authenticated frame',
    async (operation) => {
      const socket: { current?: ValidResponseSocket } = {};
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => {
          socket.current = new ValidResponseSocket();
          return socket.current as unknown as Socket;
        }
      );

      await expect(invoke(controlled.authority, operation)).resolves.toMatchObject(
        operation === 'persist' ? { kind: 'persisted' } : { kind: 'delivered' }
      );
      expect(socket.current?.endCalls).toBe(1);
      expect(socket.current?.lastRequest).toMatchObject({
        authority: {
          ownerEffectFence: {
            grantRevision: '12'.repeat(32),
            identityChecksum: ACTIVE_IDENTITY.identityChecksum,
          },
        },
      });
    }
  );

  it('suppresses a durable task result when grant revocation races the final socket inspection', async () => {
    const finalSocketInspection = deferred<typeof SOCKET_IDENTITY>();
    let inspections = 0;
    let grantCurrent = true;
    const revalidate = vi.fn(() => Promise.resolve(grantCurrent));
    const controlled = harness(
      () => {
        inspections += 1;
        return inspections <= 3 ? Promise.resolve(SOCKET_IDENTITY) : finalSocketInspection.promise;
      },
      () => new ValidResponseSocket() as unknown as Socket
    );
    const result = invokeTaskMutation(controlled.authority, revalidate);
    await vi.waitFor(() => expect(controlled.inspect).toHaveBeenCalledTimes(4));

    grantCurrent = false;
    finalSocketInspection.resolve(SOCKET_IDENTITY);

    await expect(result).rejects.toBeInstanceOf(Error);
    expect(revalidate).toHaveBeenCalledTimes(6);
    expect(controlled.invalidate).not.toHaveBeenCalled();
  });

  it('suppresses a shared task-exchange result when its exact grant is revoked after the durable owner effect', async () => {
    let socket: ValidResponseSocket | undefined;
    const revalidate = vi.fn(() => Promise.resolve(socket?.ownerResponseEmitted !== true));
    const controlled = harness(
      () => Promise.resolve(SOCKET_IDENTITY),
      () => {
        socket = new ValidResponseSocket();
        return socket as unknown as Socket;
      }
    );

    await expect(invokeTaskMutation(controlled.authority, revalidate)).rejects.toBeInstanceOf(
      Error
    );
    expect(socket?.ownerResponseEmitted).toBe(true);
    expect(socket?.lastRequest?.operation).toBe('task_mutate');
    expect(revalidate).toHaveBeenCalledTimes(4);
    expect(controlled.invalidate).not.toHaveBeenCalled();
  });

  it('suppresses a shared task-exchange result when durable team identity rebinds after the effect', async () => {
    let socket: ValidResponseSocket | undefined;
    const getTeamIdentity = vi.fn(() =>
      Promise.resolve(socket?.ownerResponseEmitted ? REBOUND_TEAM_IDENTITY : ACTIVE_IDENTITY)
    );
    const controlled = harness(
      () => Promise.resolve(SOCKET_IDENTITY),
      () => {
        socket = new ValidResponseSocket();
        return socket as unknown as Socket;
      },
      getTeamIdentity
    );

    await expect(invokeTaskMutation(controlled.authority)).rejects.toBeInstanceOf(Error);
    expect(socket?.ownerResponseEmitted).toBe(true);
    expect(socket?.lastRequest?.operation).toBe('task_mutate');
    expect(getTeamIdentity).toHaveBeenCalledTimes(2);
    expect(controlled.invalidate).not.toHaveBeenCalled();
  });

  it.each(['persist', 'deliver'] as const)(
    'rejects %s success when the exact grant is revoked after the durable owner effect',
    async (operation) => {
      let socket: ValidResponseSocket | undefined;
      const revalidate = vi.fn(() => Promise.resolve(socket?.ownerResponseEmitted !== true));
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => {
          socket = new ValidResponseSocket();
          return socket as unknown as Socket;
        }
      );

      await expect(
        invoke(controlled.authority, operation, new AbortController().signal, revalidate)
      ).resolves.toEqual(rejectedResult(operation));
      expect(socket?.ownerResponseEmitted).toBe(true);
      expect(revalidate).toHaveBeenCalledTimes(4);
      expect(controlled.invalidate).not.toHaveBeenCalled();
    }
  );

  it.each(['persist', 'deliver'] as const)(
    'rejects %s when the socket path changes during final post-effect grant revalidation',
    async (operation) => {
      const finalGrantCheck = deferred<boolean>();
      let grantChecks = 0;
      const revalidate = vi.fn(() => {
        grantChecks += 1;
        return grantChecks === 5 ? finalGrantCheck.promise : Promise.resolve(true);
      });
      let currentSocketIdentity: OrchestratorLifecycleOwnerBinding['socketIdentity'] =
        SOCKET_IDENTITY;
      const controlled = harness(
        () => Promise.resolve(currentSocketIdentity),
        () => new ValidResponseSocket() as unknown as Socket
      );
      const result = invoke(
        controlled.authority,
        operation,
        new AbortController().signal,
        revalidate
      );
      await vi.waitFor(() => expect(revalidate).toHaveBeenCalledTimes(5));

      currentSocketIdentity = REPLACED_SOCKET_IDENTITY;
      finalGrantCheck.resolve(true);

      await expect(result).resolves.toEqual(rejectedResult(operation));
      expect(controlled.inspect).toHaveBeenCalledTimes(4);
      expect(controlled.invalidate).toHaveBeenCalledOnce();
      expect(controlled.connect).toHaveBeenCalledOnce();
    }
  );

  it.each(['persist', 'deliver'] as const)(
    'rejects %s success when the team identity rebinds after the durable owner effect',
    async (operation) => {
      let socket: ValidResponseSocket | undefined;
      const getTeamIdentity = vi.fn(() =>
        Promise.resolve(socket?.ownerResponseEmitted ? REBOUND_TEAM_IDENTITY : ACTIVE_IDENTITY)
      );
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => {
          socket = new ValidResponseSocket();
          return socket as unknown as Socket;
        },
        getTeamIdentity
      );

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(socket?.ownerResponseEmitted).toBe(true);
      expect(getTeamIdentity).toHaveBeenCalledTimes(2);
      expect(controlled.invalidate).not.toHaveBeenCalled();
    }
  );

  it.each(['persist', 'deliver'] as const)(
    'rejects a valid %s frame followed by a delayed extra frame before clean EOF',
    async (operation) => {
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => new ValidResponseSocket(false, undefined, 'delayed-extra-frame') as unknown as Socket
      );

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.connect).toHaveBeenCalledOnce();
      expect(controlled.inspect).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['persist', 'deliver'] as const)(
    'rejects %s when the socket path is replaced while initial team identity is deferred',
    async (operation) => {
      const identity = deferred<TeamIdentityRecord | null>();
      const controlled = harness(
        () => Promise.resolve(REPLACED_SOCKET_IDENTITY),
        undefined,
        () => identity.promise
      );
      const result = invoke(controlled.authority, operation);

      identity.resolve(ACTIVE_IDENTITY);

      await expect(result).resolves.toEqual(rejectedResult(operation));
      expect(controlled.inspect).toHaveBeenCalledOnce();
      expect(controlled.connect).not.toHaveBeenCalled();
      expect(controlled.invalidate).toHaveBeenCalledOnce();
      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.inspect).toHaveBeenCalledOnce();
    }
  );

  it.each(
    (['persist', 'deliver'] as const).flatMap((operation) =>
      [
        ['symlink', new Error('orchestrator-lifecycle-socket-identity-invalid')],
        ['non-socket', new Error('orchestrator-lifecycle-socket-identity-invalid')],
        ['substitution', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })],
      ].map(([identityCase, error]) => [operation, identityCase, error] as const)
    )
  )(
    'invalidates the shared lifecycle lease before rejecting %s on %s identity inspection',
    async (operation, _identityCase, error) => {
      const controlled = harness(() => Promise.reject(error));

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.invalidate).toHaveBeenCalledOnce();
      expect(controlled.connect).not.toHaveBeenCalled();

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.inspect).toHaveBeenCalledOnce();
    }
  );

  it('does not connect when the request is aborted during deferred inode inspection', async () => {
    const inspection = deferred<typeof SOCKET_IDENTITY>();
    const controlled = harness(() => inspection.promise);
    const abort = new AbortController();
    const result = invoke(controlled.authority, 'persist', abort.signal);
    await vi.waitFor(() => expect(controlled.inspect).toHaveBeenCalledOnce());

    abort.abort();
    inspection.resolve(SOCKET_IDENTITY);

    await expect(result).resolves.toEqual({ kind: 'unavailable' });
    expect(controlled.connect).not.toHaveBeenCalled();
  });

  it('does not connect after close during deferred inode inspection', async () => {
    const inspection = deferred<typeof SOCKET_IDENTITY>();
    const controlled = harness(() => inspection.promise);
    const result = invoke(controlled.authority, 'persist');
    await vi.waitFor(() => expect(controlled.inspect).toHaveBeenCalledOnce());

    controlled.authority.close();
    inspection.resolve(SOCKET_IDENTITY);

    await expect(result).resolves.toEqual({ kind: 'unavailable' });
    expect(controlled.connect).not.toHaveBeenCalled();
  });

  it('invalidates and does not connect after owner rebind during deferred inode inspection', async () => {
    const inspection = deferred<typeof SOCKET_IDENTITY>();
    const controlled = harness(() => inspection.promise);
    const result = invoke(controlled.authority, 'persist');
    await vi.waitFor(() => expect(controlled.inspect).toHaveBeenCalledOnce());

    controlled.rebind();
    inspection.resolve(SOCKET_IDENTITY);

    await expect(result).resolves.toEqual({ kind: 'unavailable' });
    expect(controlled.invalidate).toHaveBeenCalledOnce();
    expect(controlled.connect).not.toHaveBeenCalled();
    await expect(controlled.authority.persistMessage(command(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(controlled.inspect).toHaveBeenCalledOnce();
  });

  it('destroys an active socket immediately on close', async () => {
    const socket = new FakeSocket();
    const controlled = harness(
      () => Promise.resolve(SOCKET_IDENTITY),
      () => socket as unknown as Socket
    );
    const result = invoke(controlled.authority, 'persist');
    await vi.waitFor(() => expect(controlled.connect).toHaveBeenCalledOnce());

    controlled.authority.close();

    expect(socket.destroyed).toBe(true);
    await expect(result).resolves.toEqual({ kind: 'unavailable' });
  });

  it('destroys an active socket before write when the owner rebinds', async () => {
    const socket = new FakeSocket();
    const controlled = harness(
      () => Promise.resolve(SOCKET_IDENTITY),
      () => socket as unknown as Socket
    );
    const result = invoke(controlled.authority, 'persist');
    await vi.waitFor(() => expect(controlled.connect).toHaveBeenCalledOnce());

    controlled.rebind();
    socket.emit('connect');

    expect(socket.destroyed).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    expect(controlled.invalidate).toHaveBeenCalledOnce();
    await expect(result).resolves.toEqual({ kind: 'unavailable' });
  });

  it.each(['close', 'abort', 'owner rebind'] as const)(
    'does not accept persistence when %s races the post-response inode inspection',
    async (race) => {
      const controlled = responseInspectionHarness();
      const abort = new AbortController();
      const result = invoke(controlled.authority, 'persist', abort.signal);
      await vi.waitFor(() => expect(controlled.inspect).toHaveBeenCalledTimes(3));

      if (race === 'close') controlled.authority.close();
      else if (race === 'abort') abort.abort();
      else controlled.rebind();
      controlled.postResponseInspection.resolve(SOCKET_IDENTITY);

      await expect(result).resolves.toEqual({ kind: 'unavailable' });
      if (race === 'owner rebind') expect(controlled.invalidate).toHaveBeenCalledOnce();
    }
  );

  it.each(['persist', 'deliver'] as const)(
    'rejects %s when the socket path is replaced while response team identity is deferred',
    async (operation) => {
      const responseIdentity = deferred<TeamIdentityRecord | null>();
      let identityReads = 0;
      let inspections = 0;
      const controlled = harness(
        () => {
          inspections += 1;
          return Promise.resolve(inspections <= 2 ? SOCKET_IDENTITY : REPLACED_SOCKET_IDENTITY);
        },
        () => new ValidResponseSocket() as unknown as Socket,
        () => {
          identityReads += 1;
          return identityReads === 1 ? Promise.resolve(ACTIVE_IDENTITY) : responseIdentity.promise;
        }
      );
      const result = invoke(controlled.authority, operation);
      await vi.waitFor(() => expect(identityReads).toBe(2));

      responseIdentity.resolve(ACTIVE_IDENTITY);

      await expect(result).resolves.toEqual(rejectedResult(operation));
      expect(controlled.inspect).toHaveBeenCalledTimes(3);
      expect(controlled.invalidate).toHaveBeenCalledOnce();
      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.connect).toHaveBeenCalledOnce();
    }
  );

  it.each(['persist', 'deliver'] as const)(
    'invalidates the shared lifecycle lease when the %s response substitutes the protocol operation',
    async (operation) => {
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => new ValidResponseSocket(true) as unknown as Socket
      );

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.invalidate).toHaveBeenCalledOnce();

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.connect).toHaveBeenCalledOnce();
    }
  );

  it.each(['persist', 'deliver'] as const)(
    'invalidates the shared lifecycle lease when the %s response substitutes the owner-effect fence',
    async (operation) => {
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => new ValidResponseSocket(false, undefined, 'clean-end', true) as unknown as Socket
      );

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.invalidate).toHaveBeenCalledOnce();
      expect(controlled.connect).toHaveBeenCalledOnce();
    }
  );

  it.each(['persist', 'deliver'] as const)(
    'invalidates the shared lifecycle lease when the %s response has a malformed substituted owner binding',
    async (operation) => {
      const malformedBinding = {
        ...OWNER_BINDING,
        socketIdentity: { device: '253' },
      };
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => new ValidResponseSocket(false, malformedBinding) as unknown as Socket
      );

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.invalidate).toHaveBeenCalledOnce();

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.connect).toHaveBeenCalledOnce();
    }
  );

  it.each(['close', 'abort', 'owner rebind'] as const)(
    'requires an operator when %s races delivery post-response inode inspection',
    async (race) => {
      const controlled = responseInspectionHarness();
      const abort = new AbortController();
      const result = invoke(controlled.authority, 'deliver', abort.signal);
      await vi.waitFor(() => expect(controlled.inspect).toHaveBeenCalledTimes(3));

      if (race === 'close') controlled.authority.close();
      else if (race === 'abort') abort.abort();
      else controlled.rebind();
      controlled.postResponseInspection.resolve(SOCKET_IDENTITY);

      await expect(result).resolves.toEqual({ kind: 'operator_required' });
      if (race === 'owner rebind') expect(controlled.invalidate).toHaveBeenCalledOnce();
    }
  );

  const invalidTeamIdentities = [
    [
      'tombstone',
      parseTeamIdentityRecord({
        ...ACTIVE_IDENTITY,
        state: 'tombstoned',
        tombstonedAt: '2026-08-09T00:00:02.000Z',
      }),
    ],
    [
      'same-generation workspace mismatch',
      parseTeamIdentityRecord({
        ...ACTIVE_IDENTITY,
        workspaceBinding: { workspaceId: FOREIGN_WORKSPACE_ID, generation: 1 },
      }),
    ],
    [
      'identity mismatch',
      parseTeamIdentityRecord({
        ...ACTIVE_IDENTITY,
        legacyKey: 'message-test-team-rebound',
      }),
    ],
    [
      'directory fingerprint mismatch',
      parseTeamIdentityRecord({
        ...ACTIVE_IDENTITY,
        directoryFingerprint: 'ac'.repeat(32),
      }),
    ],
    [
      'adoption intent mismatch',
      parseTeamIdentityRecord({
        ...ACTIVE_IDENTITY,
        adoptionIntentId: `adoption_${'ad'.repeat(16)}`,
      }),
    ],
    [
      'identity checksum mismatch',
      parseTeamIdentityRecord({
        ...ACTIVE_IDENTITY,
        identityChecksum: 'ab'.repeat(32),
      }),
    ],
  ] as const;

  it.each(
    invalidTeamIdentities.flatMap(([identityCase, invalidIdentity]) =>
      (['persist', 'deliver'] as const).map(
        (operation) => [identityCase, operation, invalidIdentity] as const
      )
    )
  )(
    'rejects only the %s during %s and keeps the lifecycle lease reusable',
    async (_identityCase, operation, invalidIdentity) => {
      let identityReads = 0;
      const controlled = harness(
        () => Promise.resolve(SOCKET_IDENTITY),
        () => new ValidResponseSocket() as unknown as Socket,
        () => {
          identityReads += 1;
          return Promise.resolve(identityReads === 2 ? invalidIdentity : ACTIVE_IDENTITY);
        }
      );

      await expect(invoke(controlled.authority, operation)).resolves.toEqual(
        rejectedResult(operation)
      );
      expect(controlled.invalidate).not.toHaveBeenCalled();

      await expect(invoke(controlled.authority, operation)).resolves.toMatchObject(
        operation === 'persist' ? { kind: 'persisted' } : { kind: 'delivered' }
      );
      expect(controlled.invalidate).not.toHaveBeenCalled();
      expect(controlled.connect).toHaveBeenCalledTimes(2);
    }
  );
});
