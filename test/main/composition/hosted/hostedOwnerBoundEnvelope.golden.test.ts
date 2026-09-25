import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  parseTeamIdentityRecord,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import {
  parseOrchestratorLifecycleOwnerBinding,
  parseOrchestratorLifecycleOwnerProofKey,
} from '@features/team-lifecycle/main/application/ExecuteHostedLifecycleCommand';
import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedClientMessageId,
  parseHostedMessageId,
} from '@features/team-message-delivery/main/hosted';
import {
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskIdempotencyKey,
} from '@features/team-task-board/main/hosted';
import {
  createQueryContext,
  parseAuthorizedScope,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import { mutationPayloadFingerprint } from '../../../../src/features/team-task-board/main/adapters/output/HostedTaskBoardMutationAuthorityAdapter';
import {
  hostedTaskBoardRevisionForContents,
  hostedTaskBoardSourceGeneration,
  hostedTaskBoardTaskId,
} from '../../../../src/main/composition/hosted/hostedTaskBoardKanbanState';
import { HostedTaskBoardOrchestratorAuthority } from '../../../../src/main/composition/hosted/hostedTaskBoardOrchestratorAuthority';
import { HostedTeamMessageOrchestratorAuthority } from '../../../../src/main/composition/hosted/hostedTeamMessageOrchestratorAuthority';

import type { HostedTaskMutationCommand } from '@features/team-task-board/main/hosted';
import type { Socket } from 'node:net';

// Deterministic exchange ids; every other crypto primitive stays real.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = (size: number) => Buffer.alloc(size, 0x5a);
  return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});

// The same bytes live in agent_teams_orchestrator docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '50bfcece70d6856df88df39eadc58b31944d251898651c820ab56a85a889ea1a';
const GOLDEN_PATH = resolve('docs/hosted-owner-bound-envelope-golden.json');
const FORMAT = 'agent-teams.hosted-owner-bound-envelope-golden/v1';
const PROOF_DOMAIN = 'agent-teams.hosted-team-message.owner-proof/v1';
const PROOF_KEY_HEX = '5c'.repeat(32);

const TEAM_ID = parseTeamId(`team_${'a1'.repeat(16)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b2'.repeat(16)}`);
const OWNER_BINDING = parseOrchestratorLifecycleOwnerBinding({
  ownerAuthority: 'owner-authority_golden-envelope',
  ownerGeneration: 4,
  ownerSessionId: 'owner-session_golden-envelope-0004',
  socketIdentity: { device: '253', inode: '7001', uid: 1000, gid: 1000, mode: 0o600 },
});
const TEAM_IDENTITY_FILE = `${JSON.stringify(
  {
    schemaVersion: 1,
    teamId: TEAM_ID,
    createdAt: '2026-09-25T00:00:00.000Z',
    originDeploymentId: 'deployment_golden-envelope',
  },
  null,
  2
)}\n`;
const IDENTITY_CHECKSUM = createHash('sha256').update(TEAM_IDENTITY_FILE, 'utf8').digest('hex');
const ACTIVE_IDENTITY: TeamIdentityRecord = parseTeamIdentityRecord({
  teamId: TEAM_ID,
  state: 'active',
  legacyKey: 'golden-envelope-team',
  directoryFingerprint: 'cd'.repeat(32),
  workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 1 },
  adoptionIntentId: `adoption_${'de'.repeat(16)}`,
  identityChecksum: IDENTITY_CHECKSUM,
  createdAt: '2026-09-25T00:00:00.000Z',
  activatedAt: '2026-09-25T00:00:01.000Z',
  tombstonedAt: null,
});
const GRANT_REVISION = '7e'.repeat(32);
const MESSAGE_ID = parseHostedMessageId(`message_${'c3'.repeat(16)}`);
const CLIENT_MESSAGE_ID = parseHostedClientMessageId('client_message_golden-envelope');

type Operation = 'task_mutate' | 'message_persist' | 'message_deliver';
type Json = Record<string, unknown>;

function proofInput(
  operation: Operation,
  direction: 'request' | 'response',
  envelope: Json
): string {
  return `${PROOF_DOMAIN}\u0000${operation}\u0000${direction}\u0000${JSON.stringify(envelope)}`;
}

function proof(input: string): string {
  return createHmac('sha256', Buffer.from(PROOF_KEY_HEX, 'hex')).update(input).digest('hex');
}

/** Captures Product's real request line and answers with the golden Owner response. */
class GoldenOwnerSocket extends EventEmitter {
  destroyed = false;
  request: Json | null = null;
  response: Json | null = null;

  constructor(private readonly payloadFor: (request: Json) => Json) {
    super();
    queueMicrotask(() => this.emit('connect'));
  }

  setEncoding(): this {
    return this;
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

  write(chunk: string): boolean {
    const request = JSON.parse(chunk.trim()) as Json;
    this.request = request;
    const unsigned = {
      schemaVersion: request.schemaVersion,
      exchangeId: request.exchangeId,
      operation: request.operation,
      ownerBinding: request.ownerBinding,
      authority: request.authority,
      payload: this.payloadFor(request),
    };
    this.response = {
      ...unsigned,
      ownerProof: proof(proofInput(request.operation as Operation, 'response', unsigned)),
    };
    queueMicrotask(() => {
      this.emit('data', `${JSON.stringify(this.response)}\n`);
      this.emit('end');
    });
    return true;
  }
}

function authorityWith(socket: () => GoldenOwnerSocket) {
  return new HostedTeamMessageOrchestratorAuthority({
    lease: {
      socketPath: join(tmpdir(), 'hosted-owner-bound-golden.sock'),
      currentBinding: () => OWNER_BINDING,
      invalidate: () => undefined,
    },
    ownerProofKey: parseOrchestratorLifecycleOwnerProofKey(PROOF_KEY_HEX),
    mountBinding: {
      workspaceId: WORKSPACE_ID,
      mountGeneration: 3,
      declaredRootHash: 'f0'.repeat(32),
    },
    teamIdentities: {
      listTeamIdentities: () => Promise.resolve(Object.freeze([ACTIVE_IDENTITY])),
      getTeamIdentity: (teamId) => Promise.resolve(teamId === TEAM_ID ? ACTIVE_IDENTITY : null),
    },
    restoreGeneration: 2,
    connect: (() => socket() as unknown as Socket) as never,
    inspectSocketIdentity: () => Promise.resolve(OWNER_BINDING.socketIdentity),
  });
}

function context() {
  const queryContext = createQueryContext({
    actorId: 'actor_golden-envelope',
    sessionId: 'session_golden-envelope',
    deploymentId: 'deployment_golden-envelope',
    bootId: 'boot_golden-envelope',
    requestId: 'request_golden-envelope',
    authorizedScope: parseAuthorizedScope('scope_golden-envelope'),
    deadlineAtMs: Date.now() + 10_000,
    signal: new AbortController().signal,
  });
  return queryContext;
}

function bindFence(authority: HostedTeamMessageOrchestratorAuthority) {
  const queryContext = context();
  authority.bindGrantFence(queryContext, {
    ownerEffectFence: { grantRevision: GRANT_REVISION, identityChecksum: IDENTITY_CHECKSUM },
    revalidate: () => Promise.resolve(true),
  });
  return queryContext;
}

const SOURCE_GENERATION_INPUT = {
  deploymentId: 'deployment_golden-envelope',
  bootId: 'boot_golden-envelope',
  workspaceId: WORKSPACE_ID,
  mountGeneration: 3,
  teamId: TEAM_ID,
  teamDirectory: ['2049', '18446744073709551557'],
  tasksDirectory: ['2049', '131074'],
} as const;

function directory(identity: readonly [string, string]) {
  return { identity: { device: BigInt(identity[0]), inode: BigInt(identity[1]) } } as never;
}

function formulas() {
  const sourceGeneration = hostedTaskBoardSourceGeneration({
    ...SOURCE_GENERATION_INPUT,
    teamDirectory: directory(SOURCE_GENERATION_INPUT.teamDirectory),
    tasksDirectory: directory(SOURCE_GENERATION_INPUT.tasksDirectory),
  });
  const revisionInput = {
    sourceGeneration,
    taskFiles: [
      { name: 'golden-2.json', text: '{"id":"golden-2","subject":"Second","status":"pending"}' },
      {
        name: 'golden-1.json',
        text: '{"id":"golden-1","subject":"Первая задача","status":"in_progress"}',
      },
    ],
    kanbanText: '{"teamName":"golden-envelope-team","reviewers":[],"tasks":{}}',
    rosterFiles: [
      { name: 'members.meta.json', text: '{"version":1,"members":[]}' },
      { name: 'config.json', text: null },
    ],
  };
  const taskIdInput = { teamId: TEAM_ID, rawTaskId: 'golden-1' };
  return {
    sourceGeneration: { input: SOURCE_GENERATION_INPUT, expected: sourceGeneration },
    revision: { input: revisionInput, expected: hostedTaskBoardRevisionForContents(revisionInput) },
    taskId: {
      input: taskIdInput,
      expected: hostedTaskBoardTaskId(taskIdInput.teamId, taskIdInput.rawTaskId),
    },
  };
}

function taskCommand(sourceGeneration: string): HostedTaskMutationCommand {
  return {
    schemaVersion: 1,
    kind: 'create_task',
    commandId: parseHostedTaskCommandId('command_golden-envelope-create'),
    idempotencyKey: parseHostedTaskIdempotencyKey('idempotency_golden-envelope-create'),
    teamId: TEAM_ID,
    expectedSourceGeneration: parseHostedTaskBoardSourceGeneration(sourceGeneration),
    expectedRevision: parseRevision(`revision_${'9b'.repeat(32)}`),
    subject: 'Golden envelope task',
    description: 'Created by the cross-repository golden.',
    status: 'pending',
    ownerId: null,
    column: 'todo',
    order: 0,
  };
}

/** Owner result schema, in the Owner's key order, as the Owner writer signs it. */
function committedTaskPayload(command: HostedTaskMutationCommand, fingerprint: string): Json {
  return {
    schemaVersion: 1,
    kind: 'committed',
    currentSourceGeneration: command.expectedSourceGeneration,
    payloadFingerprint: fingerprint,
    receipt: {
      schemaVersion: 1,
      outcome: 'committed',
      commandId: command.commandId,
      teamId: command.teamId,
      sourceGeneration: command.expectedSourceGeneration,
      revision: `revision_${'8a'.repeat(32)}`,
      affectedTaskIds: [hostedTaskBoardTaskId(TEAM_ID, 'golden-envelope-create')],
    },
    selfWriteEffects: [{ fileKey: 'golden-envelope-create', expectedChecksum: '6d'.repeat(32) }],
  };
}

async function capture(
  name: string,
  payloadFor: (request: Json) => Json,
  run: (authority: HostedTeamMessageOrchestratorAuthority) => Promise<unknown>
) {
  let socket: GoldenOwnerSocket | null = null;
  const result = await run(authorityWith(() => (socket = new GoldenOwnerSocket(payloadFor))));
  const captured = socket as GoldenOwnerSocket | null;
  if (!captured?.request || !captured.response) throw new Error(`${name}: no owner exchange`);
  const { ownerProof: requestProof, ...unsignedRequest } = captured.request;
  const { ownerProof: responseProof, ...unsignedResponse } = captured.response;
  const operation = unsignedRequest.operation as Operation;
  expect(requestProof).toBe(proof(proofInput(operation, 'request', unsignedRequest)));
  return {
    result,
    entry: {
      name,
      operation,
      request: {
        unsigned: unsignedRequest,
        proofInput: proofInput(operation, 'request', unsignedRequest),
        ownerProof: requestProof,
      },
      response: {
        unsigned: unsignedResponse,
        proofInput: proofInput(operation, 'response', unsignedResponse),
        ownerProof: responseProof,
      },
    },
  };
}

async function generate() {
  const shared = formulas();
  const command = taskCommand(shared.sourceGeneration.expected);
  const fingerprint = mutationPayloadFingerprint(command);
  const taskRequest = Object.freeze({ command, payloadFingerprint: fingerprint });

  const committed = await capture(
    'task_mutate_committed',
    () => committedTaskPayload(command, fingerprint),
    (authority) =>
      authority.exchangeOwnerMutation('task_mutate', taskRequest, TEAM_ID, bindFence(authority))
  );
  const selfWrites = {
    beginTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
    completeTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
    abortTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
  };
  const parsed = await new HostedTaskBoardOrchestratorAuthority(
    { exchangeOwnerMutation: vi.fn().mockResolvedValue(committed.result) } as never,
    selfWrites
  ).admitTaskMutation(taskRequest as never, context());
  expect(parsed.kind).toBe('committed');
  expect(selfWrites.completeTaskSelfWrite).toHaveBeenCalledOnce();

  const unavailable = await capture(
    'task_mutate_unavailable',
    () => ({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null }),
    (authority) =>
      authority.exchangeOwnerMutation('task_mutate', taskRequest, TEAM_ID, bindFence(authority))
  );
  expect(unavailable.result).toEqual({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null });

  const persistCommand = Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    teamId: TEAM_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    text: 'Golden envelope message',
  });
  const persisted = await capture(
    'message_persist_persisted',
    () => ({
      schemaVersion: 2,
      kind: 'persisted',
      receipt: {
        schemaVersion: 1,
        teamId: TEAM_ID,
        messageId: MESSAGE_ID,
        clientMessageId: CLIENT_MESSAGE_ID,
        persistence: 'durable',
      },
    }),
    (authority) => authority.persistMessage(persistCommand, bindFence(authority))
  );
  expect(persisted.result).toMatchObject({ kind: 'persisted' });

  const delivered = await capture(
    'message_deliver_delivered',
    () => ({ schemaVersion: 2, kind: 'delivered' }),
    (authority) =>
      authority.deliverPersistedMessage(
        {
          teamId: TEAM_ID,
          messageId: MESSAGE_ID,
          clientMessageId: CLIENT_MESSAGE_ID,
          text: persistCommand.text,
        },
        bindFence(authority)
      )
  );
  expect(delivered.result).toEqual({ kind: 'delivered' });

  return {
    format: FORMAT,
    source: 'agent-teams-ai test/main/composition/hosted/hostedOwnerBoundEnvelope.golden.test.ts',
    proofDomain: PROOF_DOMAIN,
    proofKeyHex: PROOF_KEY_HEX,
    teamIdentityFile: TEAM_IDENTITY_FILE,
    cases: [committed.entry, unavailable.entry, persisted.entry, delivered.entry],
    taskPayloadFingerprint: { command, expected: fingerprint },
    formulas: shared,
  };
}

describe('hosted owner-bound envelope cross-repository golden', () => {
  it('is exactly what Product signs, sends, and accepts', async () => {
    const serialized = `${JSON.stringify(await generate(), null, 2)}\n`;
    if (process.env.HOSTED_OWNER_BOUND_GOLDEN_WRITE === '1') writeFileSync(GOLDEN_PATH, serialized);
    const raw = readFileSync(GOLDEN_PATH);
    expect(raw.toString('utf8')).toBe(serialized);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256);
  });
});
