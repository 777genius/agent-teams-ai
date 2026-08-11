import { EventEmitter } from 'node:events';

import {
  createOrchestratorLifecycleOwnerProof,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorSocketIdentity,
  parseOrchestratorLifecycleOwnerProofKey,
  parseStrictOrchestratorJsonFrame,
} from '@features/team-lifecycle/main/application/ExecuteHostedLifecycleCommand';
import {
  ExecuteHostedLifecycleCommand,
  type HostedLifecycleCommand,
  OrchestratorLifecycleCommandClient as RawOrchestratorLifecycleCommandClient,
  type OrchestratorLifecycleCommandClientOptions,
  parseHostedLifecycleCommand,
} from '@features/team-lifecycle/main/hosted';
import { createQueryContext, parseRevision } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { Socket } from 'node:net';

const TEAM_ID = `team_${'a'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
const RUN_ID = `run_${'c'.repeat(32)}`;
const COMMAND_ID = 'lifecycle-command_socket-0001';
const IDEMPOTENCY_KEY = 'idempotency_socket-0001';
const REVISION = parseRevision('revision_socket');
const POST_COMMIT_REVISION = parseRevision('revision_socket-after');
const EXECUTION_CONFLICT_MISMATCH_REVISION = parseRevision('revision_execution-conflict-mismatch');
const RESTORE_GENERATION = 7;
const MOUNT_GENERATION = 1;
const SOCKET_IDENTITY = Object.freeze({
  device: '253',
  inode: '9001',
  uid: 0,
  gid: 0,
  mode: 0o600,
});
const OWNER_BINDING = Object.freeze({
  ownerAuthority: 'owner-authority_lifecycle-command-socket',
  ownerGeneration: 11,
  ownerSessionId: 'owner-session_lifecycle-command-socket-0001',
  socketIdentity: SOCKET_IDENTITY,
});
const REBOUND_OWNER_BINDING = Object.freeze({
  ...OWNER_BINDING,
  ownerGeneration: OWNER_BINDING.ownerGeneration + 1,
  ownerSessionId: 'owner-session_lifecycle-command-socket-0002',
});
const OWNER_PROOF_KEY = parseOrchestratorLifecycleOwnerProofKey('ab'.repeat(32));
const OWNER_EFFECT_FENCE = Object.freeze({
  grantRevision: 'cd'.repeat(32),
  identityChecksum: 'ef'.repeat(32),
});
const VALID_GRANT_FENCE = Object.freeze({
  ownerEffectFence: OWNER_EFFECT_FENCE,
  revalidate: async () => true,
});

class OrchestratorLifecycleCommandClient extends RawOrchestratorLifecycleCommandClient {
  constructor(options: OrchestratorLifecycleCommandClientOptions) {
    super({ grantFenceForContext: () => VALID_GRANT_FENCE, ...options });
  }
}

function ownerProof(direction: 'request' | 'response', envelope: Record<string, unknown>): string {
  return createOrchestratorLifecycleOwnerProof(OWNER_PROOF_KEY, direction, envelope);
}

function command(): HostedLifecycleCommand {
  const parsed = parseHostedLifecycleCommand('launch', {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: REVISION,
  });
  if (!parsed.ok) throw new Error('hosted-lifecycle-socket-command-fixture-invalid');
  return parsed.value;
}

function context(deadlineAtMs = Date.now() + 10_000) {
  return createQueryContext({
    actorId: 'actor_lifecycle-command-socket',
    sessionId: 'session_lifecycle-command-socket',
    deploymentId: 'deployment_lifecycle-command-socket',
    bootId: 'boot_lifecycle-command-socket',
    requestId: 'request_lifecycle-command-socket',
    authorizedScope: 'scope_lifecycle-command-socket',
    deadlineAtMs,
    signal: new AbortController().signal,
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function authorizationWire(resourceRevision = REVISION) {
  return {
    grantId: 'grant_lifecycle-command-socket-0001',
    authorizationGeneration: 'authorization-generation_lifecycle-command-socket-0001',
    deploymentId: 'deployment_lifecycle-command-socket',
    bootId: 'boot_lifecycle-command-socket',
    resourceRevision,
    actorId: 'actor_lifecycle-command-socket',
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    restoreGeneration: RESTORE_GENERATION,
    mountGeneration: MOUNT_GENERATION,
    ownerEffectFence: OWNER_EFFECT_FENCE,
  };
}

function responseEnvelope(
  request: Record<string, unknown>,
  payload: unknown,
  resourceRevision: unknown,
  authorityOverrides: Readonly<Record<string, unknown>> = {}
) {
  const requestProvenance = request.provenance as {
    readonly from: unknown;
    readonly to: unknown;
    readonly target: unknown;
  };
  const envelope = {
    schemaVersion: 2,
    exchangeId: request.exchangeId,
    operation: request.operation,
    provenance: {
      from: requestProvenance.to,
      to: requestProvenance.from,
      target: requestProvenance.target,
    },
    ownerBinding: OWNER_BINDING,
    ownerEffectFence: request.ownerEffectFence,
    authority: {
      actorId: 'actor_lifecycle-command-socket',
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      deploymentId: 'deployment_lifecycle-command-socket',
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      bootId: 'boot_lifecycle-command-socket',
      resourceRevision,
      ownerEffectFence: request.ownerEffectFence,
      ...authorityOverrides,
    },
    payload,
  };
  return { ...envelope, ownerProof: ownerProof('response', envelope) };
}

function requestDurableCommand(request: Record<string, unknown>): Record<string, unknown> {
  const payload = request.payload as Record<string, unknown>;
  return payload.durableCommand as Record<string, unknown>;
}

function durableStatePayload(
  request: Record<string, unknown>,
  kind: 'not_started' | 'started' | 'operator_required' | 'idempotency_mismatch'
) {
  return {
    schemaVersion: 2,
    kind,
    durableCommand: requestDurableCommand(request),
  };
}

function durableSettlementPayload(
  request: Record<string, unknown>,
  result: Record<string, unknown>,
  authorization: Record<string, unknown> = authorizationWire()
) {
  return {
    schemaVersion: 2,
    kind: 'settled',
    durableCommand: requestDurableCommand(request),
    authorization,
    result,
  };
}

function lifecycleReceipt(
  kind: 'accepted' | 'idempotent_replay',
  resourceRevision = REVISION
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind,
    action: 'launch',
    commandId: COMMAND_ID,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    runId: RUN_ID,
    resourceRevision,
  };
}

async function createFakeUnixSocket(
  respond: (request: Record<string, unknown>, socket: Socket) => void
) {
  const requests: Record<string, unknown>[] = [];
  let requestHalfCloses = 0;
  let requestWrites = 0;
  class FakeSocket extends EventEmitter {
    destroyed = false;
    private requestHalfClosed = false;

    constructor() {
      super();
      queueMicrotask(() => this.emit('connect'));
    }

    setEncoding(): this {
      return this;
    }

    setTimeout(): this {
      return this;
    }

    write(chunk: string): boolean {
      requestWrites += 1;
      this.acceptRequest(chunk);
      return true;
    }

    private acceptRequest(chunk: string): void {
      try {
        const request = JSON.parse(chunk.trim()) as Record<string, unknown>;
        requests.push(request);
        queueMicrotask(() => respond(request, this as unknown as Socket));
      } catch {
        this.destroy();
      }
    }

    end(chunk?: string): this {
      if (!this.requestHalfClosed) {
        this.requestHalfClosed = true;
        requestHalfCloses += 1;
        if (chunk === undefined) this.destroy();
        else this.acceptRequest(chunk);
        return this;
      }
      if (chunk !== undefined && !this.destroyed) this.emit('data', chunk);
      if (!this.destroyed) {
        this.emit('end');
        this.destroy();
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

  return Object.freeze({
    socketPath: '/tmp/hosted-lifecycle-command-test.sock',
    connect: () => new FakeSocket() as unknown as Socket,
    inspectSocketIdentity: async () => SOCKET_IDENTITY,
    requests,
    get requestHalfCloses() {
      return requestHalfCloses;
    },
    get requestWrites() {
      return requestWrites;
    },
    close: async () => undefined,
  });
}

describe('OrchestratorLifecycleCommandClient', () => {
  it('rejects duplicate JSON keys and additional protocol frames', () => {
    expect(() => parseStrictOrchestratorJsonFrame('{"kind":"ok","kind":"forged"}\n')).toThrow(
      'orchestrator-lifecycle-json-frame-invalid'
    );
    expect(() => parseStrictOrchestratorJsonFrame('{}\n{}\n')).toThrow(
      'orchestrator-lifecycle-json-frame-invalid'
    );
  });
  it('authenticates exact response wire bytes instead of a reserialized object', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      const response = responseEnvelope(
        request,
        { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
        REVISION
      );
      socket.end(` ${JSON.stringify(response)}\n`);
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    await expect(client.authorize(command(), context())).rejects.toThrow(
      'orchestrator-lifecycle-owner-proof-invalid'
    );
    client.close();
  });

  it.each(['from', 'to', 'target', 'owner-effect-fence'] as const)(
    'rejects a validly signed response whose %s does not echo the request',
    async (forgery) => {
      const onOwnerMismatch = vi.fn();
      const fake = await createFakeUnixSocket((request, socket) => {
        const response = responseEnvelope(
          request,
          { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
          REVISION
        );
        const { ownerProof: _discardedProof, ...unsignedResponse } = response;
        const responseProvenance = unsignedResponse.provenance as {
          from: Record<string, unknown>;
          to: Record<string, unknown>;
          target: Record<string, unknown>;
        };
        const forgedUnsigned =
          forgery === 'owner-effect-fence'
            ? {
                ...unsignedResponse,
                ownerEffectFence: {
                  ...OWNER_EFFECT_FENCE,
                  identityChecksum: '11'.repeat(32),
                },
              }
            : {
                ...unsignedResponse,
                provenance: {
                  ...responseProvenance,
                  ...(forgery === 'from'
                    ? {
                        from: {
                          ...responseProvenance.from,
                          ownerSessionId: 'owner-session_forged-provenance-0001',
                        },
                      }
                    : forgery === 'to'
                      ? {
                          to: {
                            ...responseProvenance.to,
                            sessionId: 'session_forged-provenance',
                          },
                        }
                      : {
                          target: {
                            ...responseProvenance.target,
                            teamId: `team_${'f'.repeat(32)}`,
                          },
                        }),
                },
              };
        socket.end(
          `${JSON.stringify({
            ...forgedUnsigned,
            ownerProof: ownerProof('response', forgedUnsigned),
          })}\n`
        );
      });
      const client = new OrchestratorLifecycleCommandClient({
        socketPath: fake.socketPath,
        restoreGeneration: RESTORE_GENERATION,
        mountGeneration: MOUNT_GENERATION,
        ownerBinding: () => OWNER_BINDING,
        ownerProofKey: () => OWNER_PROOF_KEY,
        onOwnerMismatch,
        inspectSocketIdentity: fake.inspectSocketIdentity,
        connect: fake.connect,
      });

      await expect(client.authorize(command(), context())).rejects.toThrow(
        'orchestrator-lifecycle-response-provenance-invalid'
      );
      expect(onOwnerMismatch).toHaveBeenCalledOnce();
      client.close();
    }
  );

  it('does not open or write a command request after its deadline', async () => {
    const fake = await createFakeUnixSocket(() => {
      throw new Error('expired-request-must-not-connect');
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
      now: () => 100,
    });
    await expect(client.authorize(command(), context(100))).rejects.toThrow(
      'orchestrator-lifecycle-request-deadline-exceeded'
    );
    expect(fake.requests).toEqual([]);
    expect(fake.requestHalfCloses).toBe(0);
    client.close();
  });
  it('does not write after the exact grant identity changes during socket admission', async () => {
    let checks = 0;
    let currentFence = OWNER_EFFECT_FENCE;
    const fake = await createFakeUnixSocket(() => {
      throw new Error('changed-grant-fence-must-not-reach-owner');
    });
    const grantFence = {
      get ownerEffectFence() {
        return currentFence;
      },
      revalidate: async () => {
        checks += 1;
        if (checks === 2) {
          currentFence = Object.freeze({
            ...OWNER_EFFECT_FENCE,
            identityChecksum: '12'.repeat(32),
          });
        }
        return true;
      },
    };
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      grantFenceForContext: () => grantFence,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });

    await expect(client.authorize(command(), context())).rejects.toThrow(
      'orchestrator-lifecycle-grant-fence-changed'
    );
    expect(fake.requests).toEqual([]);
    expect(fake.requestWrites).toBe(0);
    client.close();
  });
  it('queries control state and validates response authority on success and negative results', async () => {
    let responseIndex = 0;
    const fake = await createFakeUnixSocket((request, socket) => {
      responseIndex += 1;
      const payload =
        responseIndex === 1
          ? {
              schemaVersion: 1,
              kind: 'control_state',
              workspaceId: WORKSPACE_ID,
              teamId: TEAM_ID,
              deploymentId: 'deployment_lifecycle-command-socket',
              bootId: 'boot_lifecycle-command-socket',
              runId: RUN_ID,
              resourceRevision: REVISION,
              availableActions: ['stop', 'recover'],
            }
          : responseIndex === 2
            ? { schemaVersion: 1, kind: 'not_found' }
            : { schemaVersion: 1, kind: 'unavailable', retryAfterMs: 250 };
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, payload, responseIndex === 1 ? REVISION : null)
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const request = {
      schemaVersion: 1 as const,
      workspaceId: command().workspaceId,
      teamId: command().teamId,
    };
    try {
      await expect(client.getControlState(request, context())).resolves.toMatchObject({
        kind: 'control_state',
        deploymentId: 'deployment_lifecycle-command-socket',
        bootId: 'boot_lifecycle-command-socket',
      });
      await expect(client.getControlState(request, context())).resolves.toEqual({
        schemaVersion: 1,
        kind: 'not_found',
      });
      await expect(client.getControlState(request, context())).resolves.toEqual({
        schemaVersion: 1,
        kind: 'unavailable',
        retryAfterMs: 250,
      });
      expect(fake.requests).toHaveLength(3);
      expect(fake.requests[0]).toMatchObject({
        operation: 'control_state',
        payload: {
          authority: {
            deploymentId: 'deployment_lifecycle-command-socket',
            resourceRevision: null,
          },
        },
      });
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('rejects a deployment-mismatched response authority even for an unavailable result', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'unavailable', retryAfterMs: null },
            null,
            { deploymentId: 'deployment_lifecycle-command-other' }
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      await expect(client.authorize(command(), context())).rejects.toThrow(
        'orchestrator-lifecycle-response-invalid'
      );
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('accepts a conflict only when response authority echoes deployment and revision', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 2,
              kind: 'conflict',
              reason: 'stale_revision',
              currentRevision: REVISION,
            },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      await expect(client.authorize(command(), context())).resolves.toEqual({
        kind: 'conflict',
        reason: 'stale_revision',
        currentRevision: REVISION,
      });
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('parses an authoritative operator-required admission without retaining a grant', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, { schemaVersion: 2, kind: 'operator_required' }, null)
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      await expect(client.authorize(command(), context())).resolves.toEqual({
        kind: 'operator_required',
      });
      expect(fake.requests.map((request) => request.operation)).toEqual(['authorize']);
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('parses authoritative operator-required revalidation and closes local grant use', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      const response =
        request.operation === 'authorize'
          ? responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          : responseEnvelope(request, { schemaVersion: 2, kind: 'operator_required' }, null);
      socket.end(`${JSON.stringify(response)}\n`);
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const target = command();
    const requestContext = context();
    try {
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;
      await expect(
        client.revalidate(target, authorized.authorization, requestContext)
      ).resolves.toEqual({ kind: 'operator_required' });
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toEqual({ kind: 'unavailable', retryAfterMs: null });
      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'revalidate',
      ]);
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('uses a bounded fake Unix socket protocol and serializes no browser secret or AbortSignal', async () => {
    const target = command();
    const fake = await createFakeUnixSocket((request, socket) => {
      const operation = request.operation;
      if (operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (operation === 'revalidate') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'valid', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (operation === 'replay_lookup') {
        socket.end(
          `${JSON.stringify(responseEnvelope(request, durableStatePayload(request, 'not_started'), REVISION))}\n`
        );
        return;
      }
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              ...durableSettlementPayload(
                request,
                {
                  schemaVersion: 1,
                  kind: 'accepted',
                  action: 'launch',
                  commandId: COMMAND_ID,
                  workspaceId: WORKSPACE_ID,
                  teamId: TEAM_ID,
                  runId: RUN_ID,
                  resourceRevision: POST_COMMIT_REVISION,
                },
                authorizationWire(POST_COMMIT_REVISION)
              ),
            },
            POST_COMMIT_REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const requestContext = context();
    try {
      const authorized = await client.authorize(target, requestContext);
      expect(authorized).toMatchObject({ kind: 'authorized' });
      if (authorized.kind !== 'authorized') return;
      await expect(
        client.revalidate(target, authorized.authorization, requestContext)
      ).resolves.toMatchObject({
        kind: 'valid',
      });
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toMatchObject({
        kind: 'result',
        result: { kind: 'accepted' },
        authorization: { resourceRevision: POST_COMMIT_REVISION },
      });

      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'revalidate',
        'replay_lookup',
        'execute',
      ]);
      expect(fake.requests[0]).toMatchObject({
        schemaVersion: 2,
        exchangeId: expect.stringMatching(/^lifecycle-request_[0-9a-f]{32}$/),
        provenance: {
          from: {
            kind: 'controller',
            deploymentId: requestContext.deploymentId,
            bootId: requestContext.bootId,
            actorId: requestContext.actorId,
            sessionId: requestContext.sessionId,
          },
          to: {
            kind: 'owner',
            ownerAuthority: OWNER_BINDING.ownerAuthority,
            ownerGeneration: OWNER_BINDING.ownerGeneration,
            ownerSessionId: OWNER_BINDING.ownerSessionId,
          },
          target: {
            capability: 'hosted-lifecycle-command',
            workspaceId: WORKSPACE_ID,
            teamId: TEAM_ID,
          },
        },
        ownerBinding: OWNER_BINDING,
        ownerEffectFence: OWNER_EFFECT_FENCE,
        payload: {
          command: target,
          context: {
            actorId: requestContext.actorId,
            sessionId: requestContext.sessionId,
            deploymentId: requestContext.deploymentId,
            bootId: requestContext.bootId,
            requestId: requestContext.requestId,
            authorizedScope: requestContext.authorizedScope,
          },
          authority: {
            actorId: requestContext.actorId,
            workspaceId: target.workspaceId,
            teamId: target.teamId,
            deploymentId: requestContext.deploymentId,
            restoreGeneration: RESTORE_GENERATION,
            bootId: requestContext.bootId,
            resourceRevision: target.expectedRevision,
            ownerEffectFence: OWNER_EFFECT_FENCE,
          },
        },
      });
      const { ownerProof: requestProof, ...unsignedRequest } = fake.requests[0]!;
      expect(Object.keys(fake.requests[0]!).sort()).toEqual([
        'exchangeId',
        'operation',
        'ownerBinding',
        'ownerEffectFence',
        'ownerProof',
        'payload',
        'provenance',
        'schemaVersion',
      ]);
      expect(requestProof).toBe(ownerProof('request', unsignedRequest));
      expect(fake.requests[1]).toMatchObject({
        payload: {
          authorization: {
            deploymentId: requestContext.deploymentId,
            restoreGeneration: RESTORE_GENERATION,
          },
        },
      });
      expect(fake.requests[2]).toMatchObject({
        operation: 'replay_lookup',
        payload: {
          durableCommand: {
            schemaVersion: 1,
            commandFingerprint: {
              algorithm: 'sha256',
              version: 1,
              digest: 'd1224c51d2c8b5e4a0da0c29f2394e363a0f23819bcdb9276ea7fee5ff92f17c',
            },
            idempotency: {
              deploymentId: requestContext.deploymentId,
              actorId: requestContext.actorId,
              action: 'launch',
              idempotencyKey: IDEMPOTENCY_KEY,
            },
            resource: {
              bootId: requestContext.bootId,
              workspaceId: WORKSPACE_ID,
              teamId: TEAM_ID,
              runId: null,
              expectedRevision: REVISION,
              restoreGeneration: RESTORE_GENERATION,
              mountGeneration: MOUNT_GENERATION,
              ownerEffectFence: OWNER_EFFECT_FENCE,
            },
          },
        },
      });
      expect((fake.requests[2]!.payload as Record<string, unknown>).durableCommand).toEqual(
        (fake.requests[3]!.payload as Record<string, unknown>).durableCommand
      );
      const wire = JSON.stringify(fake.requests);
      expect(wire).not.toContain('signal');
      expect(wire).not.toContain('sessionSecret');
      expect(wire).not.toContain('csrf');
      expect(fake.requestHalfCloses).toBe(4);
      expect(fake.requestWrites).toBe(0);
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('suppresses a settled lifecycle DB result when its durable grant changes after the owner effect', async () => {
    const durableCoordinationRows: string[] = [];
    const grantFence = {
      ownerEffectFence: OWNER_EFFECT_FENCE,
      revalidate: vi.fn(async () => durableCoordinationRows.length === 0),
    };
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (request.operation === 'replay_lookup') {
        socket.end(
          `${JSON.stringify(responseEnvelope(request, durableStatePayload(request, 'not_started'), REVISION))}\n`
        );
        return;
      }
      durableCoordinationRows.push(COMMAND_ID);
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            durableSettlementPayload(
              request,
              lifecycleReceipt('accepted', POST_COMMIT_REVISION),
              authorizationWire(POST_COMMIT_REVISION)
            ),
            POST_COMMIT_REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
      grantFenceForContext: () => grantFence,
    });
    try {
      const target = command();
      const requestContext = context();
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;

      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toEqual({ kind: 'operator_required' });
      expect(durableCoordinationRows).toEqual([COMMAND_ID]);
      expect(fake.requests.map(({ operation }) => operation)).toEqual([
        'authorize',
        'replay_lookup',
        'execute',
      ]);
      expect(grantFence.revalidate).toHaveBeenCalled();
      expect(grantFence.revalidate.mock.calls.every((call) => call.length === 0)).toBe(true);
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('suppresses a settled lifecycle result when grant revocation races the final socket inspection', async () => {
    const durableCoordinationRows: string[] = [];
    const finalSocketInspection = deferred<OrchestratorSocketIdentity>();
    let postEffectInspections = 0;
    let grantCurrent = true;
    const grantFence = {
      ownerEffectFence: OWNER_EFFECT_FENCE,
      revalidate: vi.fn(async () => grantCurrent),
    };
    const inspectSocketIdentity = vi.fn(() => {
      if (durableCoordinationRows.length === 0) return Promise.resolve(SOCKET_IDENTITY);
      postEffectInspections += 1;
      return postEffectInspections === 2
        ? finalSocketInspection.promise
        : Promise.resolve(SOCKET_IDENTITY);
    });
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (request.operation === 'replay_lookup') {
        socket.end(
          `${JSON.stringify(responseEnvelope(request, durableStatePayload(request, 'not_started'), REVISION))}\n`
        );
        return;
      }
      durableCoordinationRows.push(COMMAND_ID);
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            durableSettlementPayload(
              request,
              lifecycleReceipt('accepted', POST_COMMIT_REVISION),
              authorizationWire(POST_COMMIT_REVISION)
            ),
            POST_COMMIT_REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity,
      connect: fake.connect,
      grantFenceForContext: () => grantFence,
    });
    try {
      const target = command();
      const requestContext = context();
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;
      const result = client.execute(target, authorized.authorization, requestContext);
      await vi.waitFor(() => expect(postEffectInspections).toBe(2));

      grantCurrent = false;
      finalSocketInspection.resolve(SOCKET_IDENTITY);

      await expect(result).resolves.toEqual({ kind: 'operator_required' });
      expect(durableCoordinationRows).toEqual([COMMAND_ID]);
      expect(fake.requests.map(({ operation }) => operation)).toEqual([
        'authorize',
        'replay_lookup',
        'execute',
      ]);
      expect(grantFence.revalidate).toHaveBeenLastCalledWith();
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('suppresses a settled lifecycle result when the admitted owner rebinds after the durable effect', async () => {
    const durableCoordinationRows: string[] = [];
    let currentOwner: OrchestratorLifecycleOwnerBinding = OWNER_BINDING;
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (request.operation === 'replay_lookup') {
        socket.end(
          `${JSON.stringify(responseEnvelope(request, durableStatePayload(request, 'not_started'), REVISION))}\n`
        );
        return;
      }
      durableCoordinationRows.push(COMMAND_ID);
      const response = responseEnvelope(
        request,
        durableSettlementPayload(
          request,
          lifecycleReceipt('accepted', POST_COMMIT_REVISION),
          authorizationWire(POST_COMMIT_REVISION)
        ),
        POST_COMMIT_REVISION
      );
      currentOwner = REBOUND_OWNER_BINDING;
      socket.end(`${JSON.stringify(response)}\n`);
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => currentOwner,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      const target = command();
      const requestContext = context();
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;

      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toEqual({ kind: 'operator_required' });
      expect(currentOwner).toBe(REBOUND_OWNER_BINDING);
      expect(durableCoordinationRows).toEqual([COMMAND_ID]);
      expect(fake.requests.map(({ operation }) => operation)).toEqual([
        'authorize',
        'replay_lookup',
        'execute',
      ]);
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('returns a durable replay without sending execute', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (request.operation !== 'replay_lookup') throw new Error('execute-must-not-run');
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            durableSettlementPayload(request, lifecycleReceipt('idempotent_replay')),
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      const target = command();
      const requestContext = context();
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toMatchObject({ kind: 'result', result: { kind: 'idempotent_replay' } });
      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'replay_lookup',
      ]);
    } finally {
      client.close();
    }
  });

  it('looks up after response loss and preflights a later retry without executing twice', async () => {
    let lookupCount = 0;
    let executeCount = 0;
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (request.operation === 'replay_lookup') {
        lookupCount += 1;
        const payload =
          lookupCount === 1
            ? durableStatePayload(request, 'not_started')
            : lookupCount === 2
              ? durableStatePayload(request, 'started')
              : durableSettlementPayload(request, lifecycleReceipt('idempotent_replay'));
        socket.end(`${JSON.stringify(responseEnvelope(request, payload, REVISION))}\n`);
        return;
      }
      executeCount += 1;
      // The owner durably settled the command, but its response was lost with the connection.
      socket.destroy();
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      const target = command();
      const requestContext = context();
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toEqual({ kind: 'started' });
      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'replay_lookup',
        'execute',
        'replay_lookup',
      ]);

      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toMatchObject({ kind: 'result', result: { kind: 'idempotent_replay' } });
      expect(executeCount).toBe(1);
      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'replay_lookup',
        'execute',
        'replay_lookup',
        'replay_lookup',
      ]);
    } finally {
      client.close();
    }
  });

  it.each(['started', 'operator_required'] as const)(
    'never executes a durable %s command',
    async (durableState) => {
      const fake = await createFakeUnixSocket((request, socket) => {
        if (request.operation === 'authorize') {
          socket.end(
            `${JSON.stringify(
              responseEnvelope(
                request,
                { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
                REVISION
              )
            )}\n`
          );
          return;
        }
        if (request.operation !== 'replay_lookup') throw new Error('execute-must-not-run');
        socket.end(
          `${JSON.stringify(
            responseEnvelope(request, durableStatePayload(request, durableState), REVISION)
          )}\n`
        );
      });
      const client = new OrchestratorLifecycleCommandClient({
        socketPath: fake.socketPath,
        restoreGeneration: RESTORE_GENERATION,
        mountGeneration: MOUNT_GENERATION,
        ownerBinding: () => OWNER_BINDING,
        ownerProofKey: () => OWNER_PROOF_KEY,
        inspectSocketIdentity: fake.inspectSocketIdentity,
        connect: fake.connect,
      });
      try {
        const target = command();
        const requestContext = context();
        const authorized = await client.authorize(target, requestContext);
        expect(authorized.kind).toBe('authorized');
        if (authorized.kind !== 'authorized') return;
        await expect(
          client.execute(target, authorized.authorization, requestContext)
        ).resolves.toEqual({ kind: durableState });
        expect(fake.requests.map((request) => request.operation)).toEqual([
          'authorize',
          'replay_lookup',
        ]);
      } finally {
        client.close();
      }
    }
  );

  it('preserves a durable idempotency mismatch as the typed public conflict', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      const payload =
        request.operation === 'authorize'
          ? { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() }
          : durableStatePayload(request, 'idempotency_mismatch');
      socket.end(`${JSON.stringify(responseEnvelope(request, payload, REVISION))}\n`);
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const target = command();
    const requestContext = context();
    const authorized = await client.authorize(target, requestContext);
    expect(authorized.kind).toBe('authorized');
    if (authorized.kind === 'authorized') {
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toMatchObject({
        kind: 'result',
        result: { kind: 'conflict', reason: 'idempotency_mismatch' },
      });
    }
    client.close();
  });

  it('rejects a signed replay outcome whose durable fingerprint was substituted', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      const durableCommand = requestDurableCommand(request);
      const commandFingerprint = durableCommand.commandFingerprint as Record<string, unknown>;
      const substituted = {
        ...durableCommand,
        commandFingerprint: { ...commandFingerprint, digest: '00'.repeat(32) },
      };
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'not_started', durableCommand: substituted },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      const target = command();
      const requestContext = context();
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).rejects.toThrow('orchestrator-lifecycle-response-invalid');
      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'replay_lookup',
      ]);
    } finally {
      client.close();
    }
  });

  it('rejects a complete frame followed by a delayed extra frame before clean EOF', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      const emitter = socket as unknown as EventEmitter;
      emitter.emit(
        'data',
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
      queueMicrotask(() => {
        emitter.emit('data', '{}\n');
        emitter.emit('end');
        socket.destroy();
      });
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    await expect(client.authorize(command(), context())).rejects.toThrow(
      'orchestrator-lifecycle-response-invalid'
    );
    client.close();
  });

  it('rejects a framed response when the peer closes without a clean readable handshake end', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      (socket as unknown as EventEmitter).emit(
        'data',
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
      socket.destroy();
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    await expect(client.authorize(command(), context())).rejects.toThrow(
      'orchestrator-lifecycle-response-incomplete'
    );
    client.close();
  });

  it('fails closed on an execution conflict whose nested revision mismatches settlement authority', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (request.operation === 'replay_lookup') {
        socket.end(
          `${JSON.stringify(responseEnvelope(request, durableStatePayload(request, 'not_started'), REVISION))}\n`
        );
        return;
      }
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              ...durableSettlementPayload(request, {
                schemaVersion: 1,
                kind: 'conflict',
                action: 'launch',
                commandId: COMMAND_ID,
                workspaceId: WORKSPACE_ID,
                teamId: TEAM_ID,
                reason: 'stale_revision',
                currentRevision: EXECUTION_CONFLICT_MISMATCH_REVISION,
              }),
            },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const target = command();
    const requestContext = context();
    try {
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toEqual({ kind: 'operator_required' });
      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'replay_lookup',
        'execute',
        'replay_lookup',
      ]);
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('rejects an invalid ACL response instead of accepting an unclassified result', async () => {
    const fake = await createFakeUnixSocket((_request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            _request,
            {
              schemaVersion: 2,
              kind: 'authorized',
              authorization: { ...authorizationWire(), privateValue: 'not-allowed' },
            },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      await expect(client.authorize(command(), context())).rejects.toThrow(
        'orchestrator-lifecycle-response-invalid'
      );
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('destroys an in-flight fake socket request when the composition closes', async () => {
    let releaseConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      releaseConnected = resolve;
    });
    const fake = await createFakeUnixSocket(() => {
      releaseConnected?.();
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      const pending = client.authorize(command(), context());
      await connected;
      client.close();
      await expect(pending).rejects.toThrow('orchestrator-lifecycle');
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('does not connect when ownership is lost during deferred socket inspection', async () => {
    let finishInspection: ((identity: typeof SOCKET_IDENTITY) => void) | undefined;
    const inspection = new Promise<typeof SOCKET_IDENTITY>((resolve) => {
      finishInspection = resolve;
    });
    const connect = vi.fn(() => {
      throw new Error('connect-must-not-run');
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: '/tmp/hosted-lifecycle-command-deferred-owner-loss.sock',
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: () => inspection,
      connect,
    });

    const pending = client.authorize(command(), context());
    client.ownerLost();
    finishInspection?.(SOCKET_IDENTITY);

    await expect(pending).rejects.toThrow('orchestrator-lifecycle-client-unavailable');
    expect(connect).not.toHaveBeenCalled();
    client.close();
  });

  it('does not connect when closed during deferred socket inspection', async () => {
    let finishInspection: ((identity: typeof SOCKET_IDENTITY) => void) | undefined;
    const inspection = new Promise<typeof SOCKET_IDENTITY>((resolve) => {
      finishInspection = resolve;
    });
    const connect = vi.fn(() => {
      throw new Error('connect-must-not-run');
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: '/tmp/hosted-lifecycle-command-deferred-close.sock',
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: () => inspection,
      connect,
    });

    const pending = client.authorize(command(), context());
    client.close();
    finishInspection?.(SOCKET_IDENTITY);

    await expect(pending).rejects.toThrow('orchestrator-lifecycle-client-unavailable');
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not accept or retain an authorization when ownership is lost during response inspection', async () => {
    let finishResponseInspection: ((identity: typeof SOCKET_IDENTITY) => void) | undefined;
    let responseInspectionStarted: (() => void) | undefined;
    const responseInspectionPending = new Promise<void>((resolve) => {
      responseInspectionStarted = resolve;
    });
    const responseInspection = new Promise<typeof SOCKET_IDENTITY>((resolve) => {
      finishResponseInspection = resolve;
    });
    let inspections = 0;
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: () => {
        inspections += 1;
        if (inspections === 1) return Promise.resolve(SOCKET_IDENTITY);
        responseInspectionStarted?.();
        return responseInspection;
      },
      connect: fake.connect,
    });

    const pending = client.authorize(command(), context());
    await responseInspectionPending;
    client.ownerLost();
    finishResponseInspection?.(SOCKET_IDENTITY);

    await expect(pending).rejects.toThrow('orchestrator-lifecycle-client-unavailable');
    await expect(
      client.execute(command(), authorizationWire() as never, context())
    ).resolves.toEqual({
      kind: 'unavailable',
      retryAfterMs: null,
    });
    expect(fake.requests).toHaveLength(1);
    client.close();
  });

  it('does not accept an authorization when ownership is lost during final grant revalidation', async () => {
    let finishFinalGrantCheck: ((current: boolean) => void) | undefined;
    let finalGrantCheckStarted: (() => void) | undefined;
    const finalGrantCheckPending = new Promise<void>((resolve) => {
      finalGrantCheckStarted = resolve;
    });
    const finalGrantCheck = new Promise<boolean>((resolve) => {
      finishFinalGrantCheck = resolve;
    });
    let checks = 0;
    const grantFence = {
      ownerEffectFence: OWNER_EFFECT_FENCE,
      revalidate: () => {
        checks += 1;
        if (checks !== 3) return Promise.resolve(true);
        finalGrantCheckStarted?.();
        return finalGrantCheck;
      },
    };
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      grantFenceForContext: () => grantFence,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });

    const pending = client.authorize(command(), context());
    await finalGrantCheckPending;
    client.ownerLost();
    finishFinalGrantCheck?.(true);

    await expect(pending).rejects.toThrow('orchestrator-lifecycle-client-unavailable');
    expect(checks).toBe(3);
    expect(fake.requests).toHaveLength(1);
    client.close();
  });

  it('does not accept an authorization when the socket path changes during final grant revalidation', async () => {
    let finishFinalGrantCheck: ((current: boolean) => void) | undefined;
    let finalGrantCheckStarted: (() => void) | undefined;
    const finalGrantCheckPending = new Promise<void>((resolve) => {
      finalGrantCheckStarted = resolve;
    });
    const finalGrantCheck = new Promise<boolean>((resolve) => {
      finishFinalGrantCheck = resolve;
    });
    let checks = 0;
    const grantFence = {
      ownerEffectFence: OWNER_EFFECT_FENCE,
      revalidate: () => {
        checks += 1;
        if (checks !== 3) return Promise.resolve(true);
        finalGrantCheckStarted?.();
        return finalGrantCheck;
      },
    };
    const replacedSocketIdentity = Object.freeze({ ...SOCKET_IDENTITY, inode: '9002' });
    let currentSocketIdentity: OrchestratorSocketIdentity = SOCKET_IDENTITY;
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
    });
    const onOwnerMismatch = vi.fn();
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      grantFenceForContext: () => grantFence,
      inspectSocketIdentity: () => Promise.resolve(currentSocketIdentity),
      onOwnerMismatch,
      connect: fake.connect,
    });

    const pending = client.authorize(command(), context());
    await finalGrantCheckPending;
    currentSocketIdentity = replacedSocketIdentity;
    finishFinalGrantCheck?.(true);

    await expect(pending).rejects.toThrow('orchestrator-lifecycle-socket-identity-changed');
    expect(checks).toBe(3);
    expect(onOwnerMismatch).toHaveBeenCalledOnce();
    expect(fake.requests).toHaveLength(1);
    client.close();
  });

  it('does not accept an authorization when closed during response inspection', async () => {
    let finishResponseInspection: ((identity: typeof SOCKET_IDENTITY) => void) | undefined;
    let responseInspectionStarted: (() => void) | undefined;
    const responseInspectionPending = new Promise<void>((resolve) => {
      responseInspectionStarted = resolve;
    });
    const responseInspection = new Promise<typeof SOCKET_IDENTITY>((resolve) => {
      finishResponseInspection = resolve;
    });
    let inspections = 0;
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: () => {
        inspections += 1;
        if (inspections === 1) return Promise.resolve(SOCKET_IDENTITY);
        responseInspectionStarted?.();
        return responseInspection;
      },
      connect: fake.connect,
    });

    const pending = client.authorize(command(), context());
    await responseInspectionPending;
    client.close();
    finishResponseInspection?.(SOCKET_IDENTITY);

    await expect(pending).rejects.toThrow('orchestrator-lifecycle-client-unavailable');
    expect(fake.requests).toHaveLength(1);
  });

  it('releases a stale-revision authorization without leaking an executable grant', async () => {
    const staleRevision = parseRevision('revision_socket-newer');
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              {
                schemaVersion: 2,
                kind: 'authorized',
                authorization: authorizationWire(staleRevision),
              },
              staleRevision
            )
          )}\n`
        );
        return;
      }
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 2,
              kind: 'released',
              authorization: authorizationWire(staleRevision),
            },
            staleRevision
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      const { action: _action, ...body } = command();
      await expect(
        new ExecuteHostedLifecycleCommand(client).execute('launch', body, context())
      ).resolves.toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
      expect(fake.requests.map((request) => request.operation)).toEqual(['authorize', 'release']);
      const issued = authorizationWire(staleRevision);
      await expect(client.execute(command(), issued as never, context())).resolves.toEqual({
        kind: 'unavailable',
        retryAfterMs: null,
      });
      expect(fake.requests).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  it('releases a precommit conflict without masking it or retaining an executable grant', async () => {
    const currentRevision = parseRevision('revision_socket-precommit-conflict');
    const fake = await createFakeUnixSocket((request, socket) => {
      const response =
        request.operation === 'authorize'
          ? responseEnvelope(
              request,
              { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          : request.operation === 'revalidate'
            ? responseEnvelope(
                request,
                {
                  schemaVersion: 2,
                  kind: 'conflict',
                  reason: 'stale_revision',
                  currentRevision,
                },
                currentRevision
              )
            : request.operation === 'release'
              ? responseEnvelope(
                  request,
                  {
                    schemaVersion: 2,
                    kind: 'released',
                    authorization: authorizationWire(),
                  },
                  REVISION
                )
              : (() => {
                  throw new Error(`unexpected lifecycle operation: ${request.operation}`);
                })();
      socket.end(`${JSON.stringify(response)}\n`);
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    try {
      const { action: _action, ...body } = command();
      await expect(
        new ExecuteHostedLifecycleCommand(client).execute('launch', body, context())
      ).resolves.toMatchObject({
        kind: 'conflict',
        reason: 'stale_revision',
        currentRevision,
      });
      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'revalidate',
        'release',
      ]);
      await expect(
        client.execute(command(), authorizationWire() as never, context())
      ).resolves.toEqual({ kind: 'unavailable', retryAfterMs: null });
      expect(fake.requests).toHaveLength(3);
    } finally {
      client.close();
    }
  });

  it('permanently invalidates an issuance when its acquired owner is lost', async () => {
    let currentOwner: OrchestratorLifecycleOwnerBinding = OWNER_BINDING;
    const fake = await createFakeUnixSocket((request, socket) => {
      const payload =
        request.operation === 'authorize'
          ? { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() }
          : { schemaVersion: 2, kind: 'released', authorization: authorizationWire() };
      socket.end(`${JSON.stringify(responseEnvelope(request, payload, REVISION))}\n`);
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => currentOwner,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const target = command();
    const requestContext = context();
    const authorized = await client.authorize(target, requestContext);
    expect(authorized.kind).toBe('authorized');
    if (authorized.kind !== 'authorized') return;
    currentOwner = Object.freeze({
      ...OWNER_BINDING,
      ownerGeneration: OWNER_BINDING.ownerGeneration + 1,
      ownerSessionId: 'owner-session_lifecycle-command-socket-0002',
    });
    client.ownerLost();
    await expect(client.release(target, authorized.authorization, requestContext)).rejects.toThrow(
      'orchestrator-lifecycle-release-authorization-unavailable'
    );
    expect(fake.requests).toHaveLength(1);

    currentOwner = OWNER_BINDING;
    await expect(client.release(target, authorized.authorization, requestContext)).rejects.toThrow(
      'orchestrator-lifecycle-release-authorization-unavailable'
    );
    expect(fake.requests).toHaveLength(1);
    client.close();
  });

  it('refuses to sign a release with a grant fence different from its authorization', async () => {
    let currentFence = OWNER_EFFECT_FENCE;
    const grantFence = {
      get ownerEffectFence() {
        return currentFence;
      },
      revalidate: async () => true,
    };
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      grantFenceForContext: () => grantFence,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const target = command();
    const requestContext = context();
    const authorized = await client.authorize(target, requestContext);
    expect(authorized.kind).toBe('authorized');
    if (authorized.kind !== 'authorized') return;
    currentFence = Object.freeze({
      ...OWNER_EFFECT_FENCE,
      grantRevision: '13'.repeat(32),
    });

    await expect(client.release(target, authorized.authorization, requestContext)).rejects.toThrow(
      'orchestrator-lifecycle-release-grant-fence-changed'
    );
    expect(fake.requests.map((request) => request.operation)).toEqual(['authorize']);
    client.close();
  });

  it('maps an explicit durable release ambiguity to operator_required', async () => {
    const staleRevision = parseRevision('revision_socket-release-operator');
    const fake = await createFakeUnixSocket((request, socket) => {
      const payload =
        request.operation === 'authorize'
          ? {
              schemaVersion: 2,
              kind: 'authorized',
              authorization: authorizationWire(staleRevision),
            }
          : {
              schemaVersion: 2,
              kind: 'operator_required',
              authorization: authorizationWire(staleRevision),
            };
      socket.end(`${JSON.stringify(responseEnvelope(request, payload, staleRevision))}\n`);
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const { action: _action, ...body } = command();
    await expect(
      new ExecuteHostedLifecycleCommand(client).execute('launch', body, context())
    ).resolves.toMatchObject({ kind: 'operator_required', commandId: COMMAND_ID });
    expect(fake.requests.map((request) => request.operation)).toEqual(['authorize', 'release']);
    client.close();
  });

  it('surfaces a changed authorization snapshot before any execute effect', async () => {
    const changed = {
      ...authorizationWire(),
      authorizationGeneration: 'authorization-generation_lifecycle-command-socket-0002',
    };
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            request.operation === 'authorize'
              ? { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() }
              : { schemaVersion: 2, kind: 'valid', authorization: changed },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const authorized = await client.authorize(command(), context());
    expect(authorized.kind).toBe('authorized');
    if (authorized.kind !== 'authorized') return;
    await expect(
      client.revalidate(command(), authorized.authorization, context())
    ).resolves.toEqual({
      kind: 'conflict',
      reason: 'authorization_changed',
      currentRevision: null,
    });
    await expect(
      client.execute(command(), authorized.authorization, context())
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(fake.requests.map((request) => request.operation)).toEqual(['authorize', 'revalidate']);
    client.close();
  });

  it('fails closed on every grant use when the socket pathname descriptor is replaced', async () => {
    let identity: OrchestratorSocketIdentity = SOCKET_IDENTITY;
    const onOwnerMismatch = vi.fn();
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      onOwnerMismatch,
      inspectSocketIdentity: async () => identity,
      connect: fake.connect,
    });
    const authorized = await client.authorize(command(), context());
    expect(authorized.kind).toBe('authorized');
    if (authorized.kind !== 'authorized') return;
    identity = Object.freeze({ ...SOCKET_IDENTITY, inode: '9009' });
    await expect(client.revalidate(command(), authorized.authorization, context())).rejects.toThrow(
      'orchestrator-lifecycle-socket-identity-changed'
    );
    expect(onOwnerMismatch).toHaveBeenCalledOnce();
    await expect(client.execute(command(), authorized.authorization, context())).resolves.toEqual({
      kind: 'unavailable',
      retryAfterMs: null,
    });
    expect(fake.requests).toHaveLength(1);
    client.close();
  });

  it('rejects I1 inspect -> I2 connect/echo -> restore I1 before response', async () => {
    let inspections = 0;
    const raceOrder: string[] = [];
    const onOwnerMismatch = vi.fn();
    const fake = await createFakeUnixSocket((request, socket) => {
      raceOrder.push('restore-I1', 'echo-from-I2');
      const response = responseEnvelope(
        request,
        { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
        REVISION
      );
      socket.end(
        `${JSON.stringify({
          ...response,
          // I2 can echo I1's exposed request proof but cannot mint a response-direction proof.
          ownerProof: request.ownerProof,
        })}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      onOwnerMismatch,
      inspectSocketIdentity: async () => {
        inspections += 1;
        raceOrder.push('inspect-I1');
        return SOCKET_IDENTITY;
      },
      connect: (options) => {
        raceOrder.push('connect-I2');
        void options;
        return fake.connect();
      },
    });

    await expect(client.authorize(command(), context())).rejects.toThrow(
      'orchestrator-lifecycle-owner-proof-invalid'
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ ownerBinding: OWNER_BINDING });
    expect(inspections).toBe(1);
    expect(raceOrder).toEqual(['inspect-I1', 'connect-I2', 'restore-I1', 'echo-from-I2']);
    expect(onOwnerMismatch).toHaveBeenCalledOnce();
    client.close();
  });

  it('bounds retention and prevents replay after deterministic local eviction', async () => {
    vi.useFakeTimers();
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 2, kind: 'authorized', authorization: authorizationWire() },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      mountGeneration: MOUNT_GENERATION,
      ownerBinding: () => OWNER_BINDING,
      ownerProofKey: () => OWNER_PROOF_KEY,
      inspectSocketIdentity: fake.inspectSocketIdentity,
      connect: fake.connect,
    });
    const authorized = await client.authorize(command(), context());
    expect(authorized.kind).toBe('authorized');
    if (authorized.kind !== 'authorized') return;
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(
      client.execute(command(), authorized.authorization, context())
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(fake.requests).toHaveLength(1);
    client.close();
    vi.useRealTimers();
  });
});
