import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  parseOrchestratorLifecycleOwnerBinding,
  parseOrchestratorLifecycleOwnerProofKey,
} from '@features/team-lifecycle/main/application/ExecuteHostedLifecycleCommand';
import {
  type HostedLifecycleCommand,
  OrchestratorLifecycleCommandClient,
  parseHostedLifecycleCommand,
} from '@features/team-lifecycle/main/hosted';
import {
  createQueryContext,
  parseAuthorizedScope,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import { HostedLifecycleOrchestratorReadiness } from '../../../../src/main/composition/hosted/hostedLifecycleOrchestratorReadiness';

import type { Socket } from 'node:net';

// The same bytes live in agent_teams_orchestrator docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '3c823d960067add34992e115aa07c4931ec223de625613ee9d12ffcb19eaf159';
const GOLDEN_PATH = resolve('docs/hosted-lifecycle-wire-golden.json');
const FORMAT = 'agent-teams.hosted-lifecycle-wire-golden/v1';
const PROOF_DOMAIN = 'agent-teams.hosted-lifecycle.owner-proof/v1';
const PROOF_KEY_HEX = '6d'.repeat(32);
const PROOF_KEY = parseOrchestratorLifecycleOwnerProofKey(PROOF_KEY_HEX);

const TEAM_ID = parseTeamId(`team_${'a4'.repeat(16)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b5'.repeat(16)}`);
const RUN_ID = `run_${'c6'.repeat(16)}`;
const REVISION = parseRevision('revision_golden-lifecycle');
const RESTORE_GENERATION = 2;
const MOUNT_GENERATION = 3;
const SOCKET_IDENTITY = Object.freeze({
  device: '253',
  inode: '7002',
  uid: 1000,
  gid: 1000,
  mode: 0o600,
});
const OWNER_BINDING = parseOrchestratorLifecycleOwnerBinding({
  ownerAuthority: 'owner-authority_golden-lifecycle',
  ownerGeneration: 5,
  ownerSessionId: 'owner-session_golden-lifecycle-0005',
  socketIdentity: SOCKET_IDENTITY,
});
/** The Owner's stable authority from its signed bootstrap; Product never sends the root hash. */
const OWNER_AUTHORITY = Object.freeze({
  deploymentId: 'deployment_golden-lifecycle',
  bootId: 'boot_golden-lifecycle',
  restoreGeneration: RESTORE_GENERATION,
  workspaceId: WORKSPACE_ID,
  mountBinding: { mountGeneration: MOUNT_GENERATION, declaredRootHash: 'f1'.repeat(32) },
  teamId: TEAM_ID,
});
const BOOTSTRAP_BINDING = Object.freeze({
  deploymentId: OWNER_AUTHORITY.deploymentId,
  bootId: OWNER_AUTHORITY.bootId,
  workspaceId: WORKSPACE_ID,
  mountGeneration: MOUNT_GENERATION,
  bootstrapDigest: 'd7'.repeat(32),
  ownerArtifactDigest: `sha256:${'e8'.repeat(32)}`,
  proofKeyId: createHash('sha256').update(Buffer.from(PROOF_KEY_HEX, 'hex')).digest('hex'),
});
const OWNER_EFFECT_FENCE = Object.freeze({
  grantRevision: '7f'.repeat(32),
  identityChecksum: '8e'.repeat(32),
});
const CHALLENGE = 'c9'.repeat(32);
/** A fixed clock keeps the signed request deadline reproducible. */
const NOW_MS = 1_790_000_000_000;
// Neither path is ever opened: connect and socket inspection are replaced below.
const SOCKET_PATH = join(tmpdir(), 'hosted-lifecycle-golden.sock');
const AUTHORIZATION = Object.freeze({
  grantId: 'grant_golden-lifecycle-0001',
  authorizationGeneration: 'authorization-generation_golden-lifecycle-0001',
  deploymentId: OWNER_AUTHORITY.deploymentId,
  bootId: OWNER_AUTHORITY.bootId,
  resourceRevision: REVISION,
  actorId: 'actor_golden-lifecycle',
  workspaceId: WORKSPACE_ID,
  teamId: TEAM_ID,
  restoreGeneration: RESTORE_GENERATION,
  mountGeneration: MOUNT_GENERATION,
  ownerEffectFence: OWNER_EFFECT_FENCE,
});

type Json = Record<string, unknown>;
interface OwnerResult {
  payload: Json;
  resourceRevision: string | null;
}

function proof(direction: string, serializedUnsignedEnvelope: string): string {
  return createHmac('sha256', Buffer.from(PROOF_KEY_HEX, 'hex'))
    .update(`${PROOF_DOMAIN}\u0000${direction}\u0000${serializedUnsignedEnvelope}`)
    .digest('hex');
}

/** Signs a response the way the Owner does: `JSON.stringify` of the unsigned envelope. */
function ownerLine(unsigned: Json, direction: string): string {
  return `${JSON.stringify({ ...unsigned, ownerProof: proof(direction, JSON.stringify(unsigned)) })}\n`;
}

/**
 * The Owner's lifecycle response envelope, in the Owner's key order. The authority is the
 * Owner-decoded request authority with the resource revision the Owner port reported.
 */
function ownerLifecycleResponse(request: Json, result: OwnerResult): string {
  const provenance = request.provenance as { from: Json; to: Json; target: Json };
  const authority = (request.payload as Json).authority as Json;
  const fence = request.ownerEffectFence as Json;
  const ownerEffectFence = {
    grantRevision: fence.grantRevision,
    identityChecksum: fence.identityChecksum,
  };
  return ownerLine(
    {
      schemaVersion: 2,
      exchangeId: request.exchangeId,
      operation: request.operation,
      provenance: { from: provenance.to, to: provenance.from, target: provenance.target },
      ownerBinding: OWNER_BINDING,
      ownerEffectFence,
      authority: {
        actorId: authority.actorId,
        workspaceId: authority.workspaceId,
        teamId: authority.teamId,
        deploymentId: authority.deploymentId,
        restoreGeneration: authority.restoreGeneration,
        mountGeneration: authority.mountGeneration,
        bootId: authority.bootId,
        resourceRevision: result.resourceRevision,
        ownerEffectFence: {
          grantRevision: (authority.ownerEffectFence as Json).grantRevision,
          identityChecksum: (authority.ownerEffectFence as Json).identityChecksum,
        },
      },
      payload: result.payload,
    },
    'response'
  );
}

/** One exchange per socket, as the Owner broker serves it: one request line, one response line. */
class GoldenOwnerSocket extends EventEmitter {
  destroyed = false;
  requestLine: string | null = null;
  responseLine: string | null = null;

  constructor(
    private readonly respond: (requestLine: string) => string,
    private readonly asBuffer: boolean
  ) {
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
    this.requestLine = chunk;
    this.responseLine = this.respond(chunk);
    const response = this.responseLine;
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.emit('data', this.asBuffer ? Buffer.from(response, 'utf8') : response);
      if (!this.asBuffer) this.emit('end');
    });
    return true;
  }

  end(chunk?: string): this {
    if (chunk !== undefined) this.write(chunk);
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
}

function context() {
  return createQueryContext({
    actorId: 'actor_golden-lifecycle',
    sessionId: 'session_golden-lifecycle',
    deploymentId: OWNER_AUTHORITY.deploymentId,
    bootId: OWNER_AUTHORITY.bootId,
    requestId: 'request_golden-lifecycle',
    authorizedScope: parseAuthorizedScope('scope_golden-lifecycle'),
    deadlineAtMs: NOW_MS + 10_000,
    signal: new AbortController().signal,
  });
}

function stopCommand(): HostedLifecycleCommand {
  const parsed = parseHostedLifecycleCommand('stop', {
    schemaVersion: 1,
    commandId: 'lifecycle-command_golden-lifecycle-stop',
    idempotencyKey: 'idempotency_golden-lifecycle-stop',
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: REVISION,
    runId: RUN_ID,
  });
  if (!parsed.ok) throw new Error('golden stop command is invalid');
  return parsed.value;
}

function readySocket(): GoldenOwnerSocket {
  return new GoldenOwnerSocket((requestLine) => {
    const request = JSON.parse(requestLine) as Json;
    return ownerLine(
      {
        schemaVersion: 2,
        kind: 'ready',
        capability: 'hosted-lifecycle-command',
        challenge: request.challenge,
        bootstrapDigest: (request.bootstrapBinding as Json).bootstrapDigest,
        ownerBinding: OWNER_BINDING,
      },
      'readiness'
    );
  }, true);
}

async function readinessCase() {
  const sockets: GoldenOwnerSocket[] = [];
  const readiness = await HostedLifecycleOrchestratorReadiness.connect({
    socketPath: SOCKET_PATH,
    expectedUid: SOCKET_IDENTITY.uid,
    expectedGid: SOCKET_IDENTITY.gid,
    expectedMode: SOCKET_IDENTITY.mode,
    ownerHighWaterPath: join(tmpdir(), 'hosted-lifecycle-golden-high-water'),
    advanceOwnerHighWater: () => Promise.resolve(),
    onOwnerLoss: () => undefined,
    trustAnchor: PROOF_KEY,
    expectedOwnerBinding: OWNER_BINDING,
    bootstrapBinding: BOOTSTRAP_BINDING,
    inspectSocketIdentity: () => Promise.resolve(SOCKET_IDENTITY),
    generateChallenge: () => CHALLENGE,
    retryBackoffMs: [60_000],
    connect: () => {
      const socket = readySocket();
      sockets.push(socket);
      return socket as unknown as Socket;
    },
  });
  try {
    expect(readiness.currentBinding()).toEqual(OWNER_BINDING);
  } finally {
    readiness.close();
  }
  const [socket] = sockets;
  if (sockets.length !== 1 || !socket.requestLine || !socket.responseLine) {
    throw new Error('readiness: expected exactly one exchange');
  }
  return { requestLine: socket.requestLine, responseLine: socket.responseLine };
}

async function lifecycleCases() {
  const cases: Json[] = [];
  let exchange = 0;
  const results = new Map<string, (request: Json) => OwnerResult>();
  const client = new OrchestratorLifecycleCommandClient({
    socketPath: SOCKET_PATH,
    restoreGeneration: RESTORE_GENERATION,
    mountGeneration: MOUNT_GENERATION,
    now: () => NOW_MS,
    ownerBinding: () => OWNER_BINDING,
    ownerProofKey: () => PROOF_KEY,
    inspectSocketIdentity: () => Promise.resolve(SOCKET_IDENTITY),
    generateExchangeId: () => `lifecycle-request_${(++exchange).toString(16).padStart(32, '0')}`,
    grantFenceForContext: () => ({
      ownerEffectFence: OWNER_EFFECT_FENCE,
      revalidate: () => Promise.resolve(true),
    }),
    connect: () =>
      new GoldenOwnerSocket((requestLine) => {
        const request = JSON.parse(requestLine) as Json;
        const operation = request.operation as string;
        const result = results.get(operation)?.(request);
        if (!result) throw new Error(`golden: unexpected ${operation}`);
        const responseLine = ownerLifecycleResponse(request, result);
        cases.push({ name: operation, operation, requestLine, ownerResult: result, responseLine });
        return responseLine;
      }, false) as unknown as Socket,
  });

  const scope = { schemaVersion: 1 as const, workspaceId: WORKSPACE_ID, teamId: TEAM_ID };
  const projection = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    deploymentId: OWNER_AUTHORITY.deploymentId,
    bootId: OWNER_AUTHORITY.bootId,
    runId: RUN_ID,
    resourceRevision: REVISION,
    availableActions: ['stop'],
  };
  const durableCommand = (request: Json) => (request.payload as Json).durableCommand;
  results.set('control_state', () => ({
    payload: { ...projection, kind: 'control_state' },
    resourceRevision: REVISION,
  }));
  results.set('get_provisioning_status', () => ({
    payload: { ...projection, kind: 'provisioning_status', recentCommands: [] },
    resourceRevision: REVISION,
  }));
  results.set('authorize', () => ({
    payload: { schemaVersion: 2, kind: 'authorized', authorization: AUTHORIZATION },
    resourceRevision: REVISION,
  }));
  results.set('replay_lookup', (request) => ({
    payload: { schemaVersion: 2, kind: 'not_started', durableCommand: durableCommand(request) },
    resourceRevision: REVISION,
  }));
  results.set('execute', (request) => ({
    payload: {
      schemaVersion: 2,
      kind: 'settled',
      durableCommand: durableCommand(request),
      result: {
        schemaVersion: 1,
        kind: 'accepted',
        action: 'stop',
        commandId: 'lifecycle-command_golden-lifecycle-stop',
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ID,
        runId: RUN_ID,
        resourceRevision: REVISION,
      },
      authorization: AUTHORIZATION,
    },
    resourceRevision: REVISION,
  }));

  try {
    expect(await client.getControlState(scope, context())).toMatchObject({
      kind: 'control_state',
      runId: RUN_ID,
    });
    expect(await client.getProvisioningStatus(scope, context())).toMatchObject({
      kind: 'provisioning_status',
      recentCommands: [],
    });
    const command = stopCommand();
    const authorized = await client.authorize(command, context());
    if (authorized.kind !== 'authorized') throw new Error('golden: stop was not authorized');
    expect(await client.execute(command, authorized.authorization, context())).toMatchObject({
      kind: 'result',
      result: { kind: 'accepted', runId: RUN_ID },
    });
  } finally {
    client.close();
  }
  return cases;
}

async function generate() {
  return {
    format: FORMAT,
    source: 'agent-teams-ai test/main/composition/hosted/hostedLifecycleWire.golden.test.ts',
    proofDomain: PROOF_DOMAIN,
    proofKeyHex: PROOF_KEY_HEX,
    ownerAuthority: OWNER_AUTHORITY,
    ownerBinding: OWNER_BINDING,
    bootstrapBinding: BOOTSTRAP_BINDING,
    readiness: await readinessCase(),
    cases: await lifecycleCases(),
  };
}

describe('hosted lifecycle wire cross-repository golden', () => {
  it('is exactly what Product signs, sends, and accepts for readiness and lifecycle commands', async () => {
    const serialized = `${JSON.stringify(await generate(), null, 2)}\n`;
    if (process.env.HOSTED_LIFECYCLE_WIRE_GOLDEN_WRITE === '1') {
      writeFileSync(GOLDEN_PATH, serialized);
    }
    const raw = readFileSync(GOLDEN_PATH);
    expect(raw.toString('utf8')).toBe(serialized);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256);
  });
});
