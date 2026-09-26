import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  type HostedAuthenticatedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access';
import { parseHostedLifecycleRunReservation } from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  createOrchestratorLifecycleOwnerProof,
  parseOrchestratorLifecycleOwnerProofKey,
} from '@features/team-lifecycle/main/application/ExecuteHostedLifecycleCommand';
import { HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS } from '@features/team-lifecycle/main/hosted';
import {
  createHostedApplication,
  HOSTED_READINESS_DIMENSIONS,
} from '@main/composition/hosted/application';
import { readHostedLifecycleOrchestratorTrustAnchor } from '@main/standalone';
import {
  createQueryContext,
  parseAuthorizedScope,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  createOptionalTeamLifecycleCommandComposition,
  createTeamLifecycleCommandComposition,
} from '../../../../src/main/composition/hosted/teamLifecycleCommandComposition';

import type {
  HostedLifecycleAuthorityEpoch,
  HostedLifecycleCurrentAuthority,
  HostedLifecycleCurrentAuthorityGateway,
  HostedLifecycleCurrentRun,
  HostedLifecycleRunReservationGateway,
} from '@features/internal-storage/contracts';
import type { Socket } from 'node:net';

const DEPLOYMENT_ID = 'deployment_lifecycle-command-composition';
const BOOT_ID = 'boot_lifecycle-command-composition';
const TEAM_ID = `team_${'a'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
const PUBLIC_WORKSPACE_ID = `workspace_${'d'.repeat(32)}`;
const RUN_ID = `run_${'c'.repeat(32)}`;
const COMMAND_ID = 'lifecycle-command_composition-0001';
const IDEMPOTENCY_KEY = 'idempotency_composition-0001';
const REVISION = 'revision_composition';
const NEXT_REVISION = 'revision_composition-next';
const USER_ID = parseUserId('user_lifecycle-command-composition');
const SESSION_ID = parseHostedSessionId('session_lifecycle-command-composition');
const SOCKET_IDENTITY = Object.freeze({
  device: '253',
  inode: '9002',
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
  mode: 0o600,
});
const OWNER_BINDING = Object.freeze({
  ownerAuthority: 'owner-authority_lifecycle-command-composition',
  ownerGeneration: 7,
  ownerSessionId: 'owner-session_lifecycle-command-composition-0001',
  socketIdentity: SOCKET_IDENTITY,
});
const OWNER_PROOF_KEY = parseOrchestratorLifecycleOwnerProofKey('ef'.repeat(32));
const BOOTSTRAP_BINDING = Object.freeze({
  deploymentId: DEPLOYMENT_ID,
  bootId: BOOT_ID,
  workspaceId: WORKSPACE_ID,
  mountGeneration: 3,
  bootstrapDigest: '12'.repeat(32),
  ownerArtifactDigest: `sha256:${'34'.repeat(32)}`,
  proofKeyId: 'b9c61610704cb9b9ea441aa8afe5d7d8e852a30f918001cda5c19951ffb62aad',
});
const OWNER_EFFECT_FENCE = Object.freeze({
  grantRevision: 'cd'.repeat(32),
  identityChecksum: 'ab'.repeat(32),
});

const PLAN_SHA = 'ab'.repeat(32);
const PLAN_GENERATION = `plan-generation_${PLAN_SHA}`;

function reservationStorage(): HostedLifecycleRunReservationGateway {
  let stored: ReturnType<typeof parseHostedLifecycleRunReservation> | null = null;
  const aliases = new Map<string, string>();
  return {
    currentPlanGeneration: async () => PLAN_GENERATION,
    lookupByResource: async (claim) =>
      stored &&
      stored.deploymentId === claim.deploymentId &&
      stored.bootId === claim.bootId &&
      stored.teamId === claim.teamId &&
      stored.expectedRevision === claim.expectedRevision
        ? stored
        : null,
    reserve: async (input) => {
      if (stored && stored.expectedRevision === input.expectedRevision)
        return { kind: 'idempotent_replay', reservation: stored };
      const nextRunId = stored ? `run_${'e'.repeat(32)}` : RUN_ID;
      const { deadlineAtMs: ignored, ...binding } = input;
      void ignored;
      stored = parseHostedLifecycleRunReservation({
        ...binding,
        runId: nextRunId,
        promotionOperationId: `promotion_${'a'.repeat(32)}`,
        planSha256: PLAN_SHA,
        rosterBindingSha256: 'cd'.repeat(32),
        createdAtMs: 1,
      });
      return { kind: 'reserved', reservation: stored };
    },
    claimAlias: async (claim) => {
      if (
        !stored ||
        claim.runId !== stored.runId ||
        claim.teamId !== stored.teamId ||
        claim.expectedRevision !== stored.expectedRevision
      )
        return { kind: 'conflict' };
      const commandKey = `command:${claim.commandId}`;
      const idempotencyKey = `idempotency:${claim.deploymentId}:${claim.actorId}:${claim.idempotencyKey}`;
      const byCommand = aliases.get(commandKey);
      const byIdempotency = aliases.get(idempotencyKey);
      if (byCommand || byIdempotency)
        return byCommand === claim.runId && byIdempotency === claim.runId
          ? { kind: 'idempotent_replay' }
          : { kind: 'conflict' };
      aliases.set(commandKey, claim.runId);
      aliases.set(idempotencyKey, claim.runId);
      return { kind: 'claimed' };
    },
    activateReservedRun: async () => 'activated',
    lookupCurrentAuthority: async () => null,
    setCurrentAuthority: async () => ({ kind: 'applied', revision: 1 }),
    lookup: async (runId) => (stored?.runId === runId ? stored : null),
  };
}

function currentRunStorage() {
  let binding: HostedLifecycleAuthorityEpoch | null = null;
  let state: 'eligible' | 'cleanup_pending' | 'retired' = 'eligible';
  let authorityState: 'active' | 'retired' = 'active';
  let runId = RUN_ID;
  const same = (candidate: HostedLifecycleAuthorityEpoch) =>
    binding !== null &&
    candidate.deploymentId === binding.deploymentId &&
    candidate.bootId === binding.bootId &&
    candidate.ownerAuthority === binding.ownerAuthority &&
    candidate.ownerGeneration === binding.ownerGeneration &&
    candidate.ownerSessionId === binding.ownerSessionId &&
    candidate.restoreGeneration === binding.restoreGeneration &&
    candidate.mountGeneration === binding.mountGeneration;
  const row = () =>
    binding && { ...binding, runId: runId as never, teamId: TEAM_ID as never, state };
  const gateway: HostedLifecycleCurrentAuthorityGateway = {
    lookupAuthority: async () => binding && { ...binding, revision: 1, state: authorityState },
    lookupRun: async (requested) => (requested === runId ? row() : null),
    lookupTeamRun: async () => (state === 'retired' ? null : row()),
    setCurrentAuthority: async () => ({ kind: 'idempotent_replay', revision: 1 }),
    retireAuthority: async ({ binding: expected }) => {
      if (!same(expected)) return { kind: 'conflict' };
      authorityState = 'retired';
      if (state === 'eligible') state = 'cleanup_pending';
      return { kind: 'applied', revision: 2 };
    },
    activateReservedRun: async () => 'conflict',
    retireRun: async ({ binding: expected, runId: requested }) => {
      if (!same(expected) || requested !== runId || authorityState !== 'active') return 'conflict';
      if (state === 'retired') return 'already_retired';
      if (state === 'cleanup_pending') return 'already_pending';
      state = 'cleanup_pending';
      return 'cleanup_pending';
    },
    confirmRunRetired: async ({ binding: expected, runId: requested }) => {
      if (!same(expected) || requested !== runId || authorityState !== 'active') return 'conflict';
      if (state === 'retired') return 'already_retired';
      if (state !== 'cleanup_pending') return 'conflict';
      state = 'retired';
      return 'retired';
    },
    retireMember: async () => 'conflict',
  };
  return {
    gateway,
    activate: (next: HostedLifecycleAuthorityEpoch, id = RUN_ID) => {
      binding = next;
      runId = id;
      state = 'eligible';
      authorityState = 'active';
    },
    state: () => state,
  };
}

/** One run published by an earlier Owner generation, as left behind by a restart. */
function supersededRunStorage() {
  let authority: HostedLifecycleCurrentAuthority | null = null;
  let run: HostedLifecycleCurrentRun | null = null;
  const epochKey = (epoch: HostedLifecycleAuthorityEpoch) =>
    [
      epoch.deploymentId,
      epoch.bootId,
      epoch.ownerAuthority,
      epoch.ownerGeneration,
      epoch.ownerSessionId,
      epoch.restoreGeneration,
      epoch.mountGeneration,
    ].join('|');
  const gateway: HostedLifecycleCurrentAuthorityGateway = {
    lookupAuthority: async () => authority,
    lookupRun: async (requested) => (run?.runId === requested ? run : null),
    lookupTeamRun: async () => (run?.state === 'retired' ? null : run),
    setCurrentAuthority: async ({ binding, expectedRevision }) => {
      if (
        !authority ||
        expectedRevision !== authority.revision ||
        binding.ownerGeneration <= authority.ownerGeneration
      )
        return { kind: 'conflict' };
      if (run?.state === 'eligible') run = { ...run, state: 'cleanup_pending' };
      authority = { ...binding, revision: authority.revision + 1, state: 'active' };
      return { kind: 'applied', revision: authority.revision };
    },
    retireAuthority: async () => ({ kind: 'conflict' }),
    activateReservedRun: async () => 'conflict',
    retireRun: async () => 'conflict',
    confirmRunRetired: async ({ binding, runId }) => {
      if (
        !run ||
        !authority ||
        run.runId !== runId ||
        run.state !== 'cleanup_pending' ||
        run.ownerGeneration >= binding.ownerGeneration ||
        epochKey(authority) !== epochKey(binding)
      )
        return 'conflict';
      run = { ...run, state: 'retired' };
      return 'retired';
    },
    retireMember: async () => 'conflict',
  };
  return {
    gateway,
    publishPrior: (current: HostedLifecycleAuthorityEpoch, runId: string) => {
      const prior = { ...current, ownerGeneration: current.ownerGeneration - 1 };
      authority = { ...prior, revision: 1, state: 'active' };
      run = { ...prior, runId: runId as never, teamId: TEAM_ID as never, state: 'eligible' };
    },
    state: () => run?.state ?? null,
  };
}

function runtimeInstance() {
  return createRuntimeInstanceContext({
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
    appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
    workspaceRoots: [],
    tempRoot: { kind: 'temp', reference: 'isolated:temp' },
    logsRoot: { kind: 'logs', reference: 'isolated:logs' },
  });
}

function authenticated(
  permissions: readonly string[] = ['hosted.query', 'hosted.command'],
  publicWorkspaceId = WORKSPACE_ID
) {
  return Object.freeze({
    authenticatedPrincipalFor: () =>
      Object.freeze({
        principal: Object.freeze({
          userId: USER_ID,
          displayName: 'Lifecycle command member',
          role: 'member',
          permissions: Object.freeze([...permissions]),
          authenticationMethod: 'oidc',
          sessionId: SESSION_ID,
        }),
        authenticatedSessionId: SESSION_ID,
      }) as HostedAuthenticatedPrincipal,
    captureTeamWorkspaceGrantFence: async () =>
      Object.freeze({
        publicWorkspaceId,
        runtimeWorkspaceId: WORKSPACE_ID,
        ownerEffectFence: OWNER_EFFECT_FENCE,
        revalidate: async () => true,
      }),
  });
}

function launchBody() {
  return {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: REVISION,
  };
}

function authorization(request: Record<string, unknown>) {
  const payload = request.payload as Record<string, unknown>;
  const context = payload.context as Record<string, unknown>;
  const command = payload.command as Record<string, unknown>;
  return {
    grantId: `grant_${command.commandId}`,
    authorizationGeneration: `authorization-generation_${command.commandId}`,
    deploymentId: context.deploymentId,
    bootId: BOOT_ID,
    resourceRevision: command.expectedRevision,
    actorId: context.actorId,
    workspaceId: command.workspaceId,
    teamId: command.teamId,
    restoreGeneration: 7,
    mountGeneration: 3,
    ownerEffectFence: request.ownerEffectFence,
  };
}

function responseEnvelope(
  request: Record<string, unknown>,
  payload: unknown,
  resourceRevision?: unknown
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
    authority:
      resourceRevision === undefined
        ? (request.payload as Record<string, unknown>).authority
        : {
            ...((request.payload as Record<string, unknown>).authority as Record<string, unknown>),
            resourceRevision,
          },
    payload,
  };
  return {
    ...envelope,
    ownerProof: createOrchestratorLifecycleOwnerProof(OWNER_PROOF_KEY, 'response', envelope),
  };
}

async function centralApplication() {
  const application = createHostedApplication({
    components: [],
    readinessProbes: HOSTED_READINESS_DIMENSIONS.map((dimension) =>
      Object.freeze({
        id: `lifecycle-command-composition-${dimension}`,
        dimension,
        readiness: async () => ({ ready: true, reasons: [] }),
      })
    ),
    routeContributions: [
      Object.freeze({
        id: 'team-lifecycle.hosted-command.test.v1',
        facade: Object.freeze({}),
        routes: HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
      }),
    ],
  });
  await application.start();
  return application;
}

async function createAclServer(
  options: {
    readonly responseWorkspaceId?: string;
    readonly failFirstReplayLookup?: boolean;
    readonly initialPhase?: 'running' | 'idle';
    readonly terminalOutcome?: 'idle' | 'stopping' | 'ambiguous';
    readonly terminalActions?: readonly string[];
  } = {}
) {
  const requests: Record<string, unknown>[] = [];
  let ready = true;
  let onOwnerLoss: (() => void) | undefined;
  let failNextReplayLookup = options.failFirstReplayLookup === true;
  let terminalPhase: 'running' | 'idle' | 'stopping' = options.initialPhase ?? 'running';
  let currentRevision = REVISION;

  class FakeSocket extends EventEmitter {
    destroyed = false;

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
      try {
        const request = JSON.parse(chunk.trim()) as Record<string, unknown>;
        requests.push(request);
        queueMicrotask(() => {
          if (request.operation === 'replay_lookup' && failNextReplayLookup) {
            failNextReplayLookup = false;
            this.destroy();
            return;
          }
          const command = (request.payload as { command?: { action?: unknown } } | undefined)
            ?.command;
          if (
            request.operation === 'execute' &&
            (options.terminalActions ?? ['stop', 'cancel']).includes(String(command?.action))
          ) {
            if (options.terminalOutcome === 'ambiguous') {
              this.destroy();
              return;
            }
            terminalPhase = options.terminalOutcome ?? 'running';
            currentRevision = NEXT_REVISION;
          }
          respond(
            request,
            this as unknown as Socket,
            options.responseWorkspaceId,
            terminalPhase,
            currentRevision
          );
        });
      } catch {
        this.destroy();
      }
      return true;
    }

    end(chunk?: string): this {
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
    socketPath: '/tmp/hosted-lifecycle-command-composition.sock',
    requests,
    connect: () => new FakeSocket() as unknown as Socket,
    inspectSocketIdentity: async () => SOCKET_IDENTITY,
    connectReadiness: async (options: { readonly onOwnerLoss: () => void }) => {
      onOwnerLoss = options.onOwnerLoss;
      requests.push({ operation: 'readiness' });
      return {
        isReady: () => ready,
        currentBinding: () => (ready ? OWNER_BINDING : null),
        invalidate: () => {
          ready = false;
          onOwnerLoss?.();
        },
        close: () => {
          ready = false;
        },
      };
    },
    loseOwner: () => {
      ready = false;
      onOwnerLoss?.();
    },
    close: async () => undefined,
  });
}

function respond(
  request: Record<string, unknown>,
  socket: Socket,
  responseWorkspaceId = WORKSPACE_ID,
  terminalPhase: 'running' | 'idle' | 'stopping' = 'running',
  currentRevision = REVISION
): void {
  try {
    const operation = request.operation;
    const payload = request.payload as Record<string, unknown>;
    if (operation === 'admit_launch_plan') {
      const planRequest = payload.request as Record<string, unknown>;
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 1,
              kind: 'admitted',
              workspaceId: planRequest.workspaceId,
              teamId: planRequest.teamId,
              planGeneration: planRequest.expectedPlanGeneration,
            },
            null
          )
        )}\n`
      );
      return;
    }
    if (operation === 'authorize') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, {
            schemaVersion: 2,
            kind: 'authorized',
            authorization: authorization(request),
          })
        )}\n`
      );
      return;
    }
    if (operation === 'revalidate') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, {
            schemaVersion: 2,
            kind: 'valid',
            authorization: authorization(request),
          })
        )}\n`
      );
      return;
    }
    if (operation === 'control_state') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 1,
              kind: 'control_state',
              workspaceId: responseWorkspaceId,
              teamId: TEAM_ID,
              deploymentId: DEPLOYMENT_ID,
              bootId: BOOT_ID,
              runId: terminalPhase === 'idle' ? null : RUN_ID,
              resourceRevision: currentRevision,
              availableActions:
                terminalPhase === 'idle'
                  ? ['launch']
                  : terminalPhase === 'stopping'
                    ? []
                    : ['stop', 'recover'],
            },
            currentRevision
          )
        )}\n`
      );
      return;
    }
    if (operation === 'prepare_provisioning' || operation === 'get_provisioning_status') {
      const state = {
        schemaVersion: 1,
        kind: operation === 'prepare_provisioning' ? 'prepared' : 'provisioning_status',
        workspaceId: responseWorkspaceId,
        teamId: TEAM_ID,
        deploymentId: DEPLOYMENT_ID,
        bootId: BOOT_ID,
        runId: RUN_ID,
        resourceRevision: REVISION,
        availableActions: ['stop', 'recover'],
      };
      const projection =
        operation === 'prepare_provisioning'
          ? {
              ...state,
              lanes: [{ laneKey: 'lane_primary', backend: 'provisioning_cli', status: 'ready' }],
            }
          : {
              ...state,
              recentCommands: [
                {
                  action: 'launch',
                  commandId: COMMAND_ID,
                  result: {
                    schemaVersion: 1,
                    kind: 'accepted',
                    action: 'launch',
                    commandId: COMMAND_ID,
                    workspaceId: responseWorkspaceId,
                    teamId: TEAM_ID,
                    runId: RUN_ID,
                    resourceRevision: currentRevision,
                  },
                },
              ],
            };
      socket.end(`${JSON.stringify(responseEnvelope(request, projection, currentRevision))}\n`);
      return;
    }
    if (operation === 'release') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 2,
              kind: 'released',
              authorization: payload.authorization,
            },
            (payload.authorization as { resourceRevision: string }).resourceRevision
          )
        )}\n`
      );
      return;
    }
    if (operation === 'replay_lookup') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, {
            schemaVersion: 2,
            kind: 'not_started',
            durableCommand: payload.durableCommand,
          })
        )}\n`
      );
      return;
    }
    socket.end(
      `${JSON.stringify(
        responseEnvelope(request, {
          schemaVersion: 2,
          kind: 'settled',
          durableCommand: payload.durableCommand,
          authorization: authorization(request),
          result: {
            schemaVersion: 1,
            kind: 'accepted',
            action: (payload.command as Record<string, unknown>).action,
            commandId: (payload.command as Record<string, unknown>).commandId,
            workspaceId: responseWorkspaceId,
            teamId: TEAM_ID,
            runId:
              (payload.command as { action: string; runId?: string }).action === 'launch'
                ? ((payload.runReservation as { runId?: string } | undefined)?.runId ?? RUN_ID)
                : (payload.command as { runId: string }).runId,
            resourceRevision: authorization(request).resourceRevision,
          },
        })
      )}\n`
    );
  } catch {
    socket.destroy();
  }
}

describe('team lifecycle command hosted composition', () => {
  it('settles a run left by an earlier Owner generation through a terminal recover', async () => {
    const acl = await createAclServer({
      terminalOutcome: 'idle',
      terminalActions: ['stop', 'cancel', 'recover'],
    });
    const application = await centralApplication();
    const reservations = reservationStorage();
    const current = supersededRunStorage();
    const activate = reservations.activateReservedRun;
    reservations.activateReservedRun = async (input) => {
      const result = await activate(input);
      if (result === 'activated') current.publishPrior(input.binding, input.runId);
      return result;
    };
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
      now: () => 1,
      runReservations: () => reservations,
      currentAuthority: () => current.gateway,
    });
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      const launch = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: launchBody(),
      });
      expect(launch.json()).toMatchObject({ kind: 'accepted', runId: RUN_ID });
      expect(current.state()).toBe('eligible');
      const recover = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/recover',
        payload: {
          ...launchBody(),
          runId: RUN_ID,
          commandId: 'lifecycle-command_composition-recover',
          idempotencyKey: 'idempotency_composition-recover',
        },
      });
      expect(recover.json()).toMatchObject({ kind: 'accepted', action: 'recover' });
      expect(current.state()).toBe('retired');
    } finally {
      composition.close();
      await app.close();
      await application.stop();
      await acl.close();
    }
  });

  it.each(['owner_loss', 'expired_deadline', 'composition_closed'] as const)(
    'fails closed on %s while the final browser projection awaits grant revalidation',
    async (interruption) => {
      const acl = await createAclServer();
      const application = await centralApplication();
      let nowMs = 1;
      let revalidations = 0;
      let enterFinalRevalidation: (() => void) | undefined;
      let releaseFinalRevalidation: (() => void) | undefined;
      const finalRevalidationEntered = new Promise<void>((resolve) => {
        enterFinalRevalidation = resolve;
      });
      const finalRevalidation = new Promise<boolean>((resolve) => {
        releaseFinalRevalidation = () => resolve(true);
      });
      const composition = await createTeamLifecycleCommandComposition({
        authentication: {
          ...authenticated(['hosted.query'], PUBLIC_WORKSPACE_ID),
          captureTeamWorkspaceGrantFence: async () =>
            Object.freeze({
              publicWorkspaceId: PUBLIC_WORKSPACE_ID,
              runtimeWorkspaceId: WORKSPACE_ID,
              ownerEffectFence: OWNER_EFFECT_FENCE,
              revalidate: async () => {
                revalidations += 1;
                if (revalidations !== 6) return true;
                enterFinalRevalidation?.();
                return finalRevalidation;
              },
            }),
        },
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorSocketPath: acl.socketPath,
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        orchestratorExpectedOwnerBinding: OWNER_BINDING,
        orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
        orchestratorConnect: acl.connect,
        orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
        connectReadiness: acl.connectReadiness,
        restoreGeneration: 7,
        mountGeneration: 3,
        routeAdmissionBinding: application,
        now: () => nowMs,
      });
      const app = Fastify();
      composition.register(app);
      await app.ready();
      try {
        const pending = app.inject({
          method: 'POST',
          url: '/api/hosted/v1/team-lifecycle/control-state',
          payload: { schemaVersion: 1, workspaceId: PUBLIC_WORKSPACE_ID, teamId: TEAM_ID },
        });
        await finalRevalidationEntered;
        expect(acl.requests.at(-1)?.operation).toBe('control_state');
        if (interruption === 'owner_loss') acl.loseOwner();
        else if (interruption === 'expired_deadline') nowMs = 1_000_000_000;
        else composition.close();
        releaseFinalRevalidation?.();
        const response = await pending;
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          schemaVersion: 1,
          kind: 'unavailable',
          retryAfterMs: null,
        });
      } finally {
        composition.close();
        await app.close();
        await application.stop();
        await acl.close();
      }
    }
  );

  it('maps only a grant-bound public workspace into signed Owner control state and projects it back', async () => {
    const acl = await createAclServer();
    const application = await centralApplication();
    const granted = authenticated(['hosted.query'], PUBLIC_WORKSPACE_ID);
    let grantCurrent = true;
    const composition = await createTeamLifecycleCommandComposition({
      authentication: {
        ...granted,
        captureTeamWorkspaceGrantFence: async () =>
          Object.freeze({
            ...(await granted.captureTeamWorkspaceGrantFence()),
            revalidate: async () => grantCurrent,
          }),
      },
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
      now: () => 1,
    });
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      const publicResponse = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/control-state',
        payload: { schemaVersion: 1, workspaceId: PUBLIC_WORKSPACE_ID, teamId: TEAM_ID },
      });
      expect(publicResponse.statusCode).toBe(200);
      expect(publicResponse.json()).toMatchObject({
        kind: 'control_state',
        workspaceId: PUBLIC_WORKSPACE_ID,
      });
      expect(acl.requests[1]).toMatchObject({
        payload: {
          request: { workspaceId: WORKSPACE_ID },
          authority: { workspaceId: WORKSPACE_ID, ownerEffectFence: OWNER_EFFECT_FENCE },
        },
      });
      for (const [path, kind] of [
        ['prepare', 'prepared'],
        ['progress', 'provisioning_status'],
      ] as const) {
        const projected = await app.inject({
          method: 'POST',
          url: `/api/hosted/v1/team-lifecycle/${path}`,
          payload: { schemaVersion: 1, workspaceId: PUBLIC_WORKSPACE_ID, teamId: TEAM_ID },
        });
        expect(projected.statusCode, path).toBe(200);
        expect(projected.json()).toMatchObject({ kind, workspaceId: PUBLIC_WORKSPACE_ID });
        if (kind === 'provisioning_status') {
          expect(projected.json().recentCommands[0].result.workspaceId).toBe(PUBLIC_WORKSPACE_ID);
        }
      }
      const runtimeResponse = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/control-state',
        payload: { schemaVersion: 1, workspaceId: WORKSPACE_ID, teamId: TEAM_ID },
      });
      expect(runtimeResponse.statusCode).toBe(503);
      expect(acl.requests).toHaveLength(4);
      grantCurrent = false;
      const stale = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/control-state',
        payload: { schemaVersion: 1, workspaceId: PUBLIC_WORKSPACE_ID, teamId: TEAM_ID },
      });
      expect(stale.statusCode).toBe(503);
      expect(acl.requests).toHaveLength(4);
    } finally {
      composition.close();
      await app.close();
      await application.stop();
      await acl.close();
    }
  });

  it('signs runtime scope for commands, projects receipts, and rejects a signed wrong-scope response', async () => {
    const acl = await createAclServer();
    const application = await centralApplication();
    const runReservations = reservationStorage();
    const current = currentRunStorage();
    const activate = runReservations.activateReservedRun;
    runReservations.activateReservedRun = async (input) => {
      const result = await activate(input);
      if (result === 'activated') current.activate(input.binding, input.runId);
      return result;
    };
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(undefined, PUBLIC_WORKSPACE_ID),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
      now: () => 1,
      runReservations: () => runReservations,
      currentAuthority: () => current.gateway,
    });
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: { ...launchBody(), workspaceId: PUBLIC_WORKSPACE_ID },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ kind: 'accepted', workspaceId: PUBLIC_WORKSPACE_ID });
      for (const signed of acl.requests.slice(1)) {
        const payload = signed.payload as Record<string, unknown>;
        expect((payload.authority as Record<string, unknown>).workspaceId).toBe(WORKSPACE_ID);
      }
      expect((acl.requests[1].payload as Record<string, unknown>).command).toMatchObject({
        workspaceId: WORKSPACE_ID,
      });
      expect(acl.requests.find((signed) => signed.operation === 'execute')).toMatchObject({
        payload: { durableCommand: { resource: { workspaceId: WORKSPACE_ID } } },
      });
    } finally {
      composition.close();
      await app.close();
      await application.stop();
      await acl.close();
    }

    const wrongAcl = await createAclServer({ responseWorkspaceId: PUBLIC_WORKSPACE_ID });
    const wrongApplication = await centralApplication();
    const wrongComposition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(['hosted.query'], PUBLIC_WORKSPACE_ID),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: wrongAcl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: wrongAcl.connect,
      orchestratorInspectSocketIdentity: wrongAcl.inspectSocketIdentity,
      connectReadiness: wrongAcl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: wrongApplication,
      now: () => 1,
    });
    const wrongApp = Fastify();
    wrongComposition.register(wrongApp);
    await wrongApp.ready();
    try {
      const wrong = await wrongApp.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/control-state',
        payload: { schemaVersion: 1, workspaceId: PUBLIC_WORKSPACE_ID, teamId: TEAM_ID },
      });
      expect(wrong.statusCode).toBe(503);
      expect(wrong.json()).toEqual({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null });
    } finally {
      wrongComposition.close();
      await wrongApp.close();
      await wrongApplication.stop();
      await wrongAcl.close();
    }
  });
  it('keeps a refused runtime-creating action away from the Owner ACL', async () => {
    const acl = await createAclServer();
    const application = await centralApplication();
    const admitLifecycleAction = vi.fn((action: string) => Promise.resolve(action !== 'launch'));
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
      admitLifecycleAction,
      now: () => 1,
      runReservations: () => reservationStorage(),
    });
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: launchBody(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        kind: 'unavailable',
        retryAfterMs: null,
      });
      expect(admitLifecycleAction).toHaveBeenCalledWith('launch');
      expect(acl.requests.map(({ operation }) => operation)).toEqual(['readiness']);
    } finally {
      composition.close();
      await app.close();
      await application.stop();
      await acl.close();
    }
  });

  it('admits a published draft with its scoped promotion fence before canonical team attribution exists', async () => {
    const acl = await createAclServer();
    const application = await centralApplication();
    const canonicalFence = vi.fn(async () => null);
    const composition = await createTeamLifecycleCommandComposition({
      authentication: {
        ...authenticated(),
        captureTeamWorkspaceGrantFence: canonicalFence,
      },
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
      now: () => 1,
    });
    const context = createQueryContext({
      actorId: 'actor_promotion-admission-0001',
      sessionId: SESSION_ID,
      deploymentId: DEPLOYMENT_ID,
      bootId: BOOT_ID,
      requestId: 'request_promotion-admission-0001',
      authorizedScope: parseAuthorizedScope('scope_team-configuration'),
      deadlineAtMs: 100_000,
      signal: new AbortController().signal,
    });
    const request = {
      workspaceId: parseWorkspaceId(WORKSPACE_ID),
      teamId: parseTeamId(TEAM_ID),
      workspaceRoot: '/private/test-root',
      expectedPlanGeneration: `plan-generation_${'f'.repeat(64)}`,
    };
    const promotionFence = {
      actorId: context.actorId,
      sessionId: context.sessionId,
      userId: USER_ID,
      authenticatedSessionId: SESSION_ID,
      workspaceId: request.workspaceId,
      teamId: request.teamId,
      ownerEffectFence: OWNER_EFFECT_FENCE,
      revalidate: vi.fn(async () => true),
    };
    try {
      await expect(
        composition.admitPromotionPlan(request, context, {}, promotionFence)
      ).resolves.toEqual({ kind: 'admitted', planGeneration: request.expectedPlanGeneration });
      expect(canonicalFence).not.toHaveBeenCalled();
      expect(promotionFence.revalidate).toHaveBeenCalled();
      expect(acl.requests.map((item) => item.operation)).toEqual([
        'readiness',
        'admit_launch_plan',
      ]);
      const signed = acl.requests[1] as Record<string, unknown>;
      expect(signed.payload).toMatchObject({
        request: { schemaVersion: 1, ...request },
        authority: { ownerEffectFence: OWNER_EFFECT_FENCE },
      });
      await expect(
        composition.admitPromotionPlan(
          { ...request, teamId: parseTeamId(`team_${'e'.repeat(32)}`) },
          context,
          {},
          promotionFence
        )
      ).resolves.toEqual({ kind: 'unavailable' });
      promotionFence.revalidate.mockResolvedValue(false);
      await expect(
        composition.admitPromotionPlan(request, context, {}, promotionFence)
      ).resolves.toEqual({ kind: 'unavailable' });
      expect(acl.requests).toHaveLength(2);
    } finally {
      composition.close();
      await application.stop();
      await acl.close();
    }
  });

  it('does not require the trust anchor when standalone startup has no lifecycle runtime', () => {
    expect(readHostedLifecycleOrchestratorTrustAnchor(null, {})).toBeNull();
  });

  it('does not compose a lifecycle command route without an admitted runtime instance', async () => {
    await expect(
      createOptionalTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: null,
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        restoreGeneration: 7,
        mountGeneration: null,
      })
    ).resolves.toBeNull();
  });

  it('stays unmounted until the central HostedApplication route admission is supplied', async () => {
    await expect(
      createOptionalTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorSocketPath: '/tmp/hosted-lifecycle-command-not-opened.sock',
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        restoreGeneration: 7,
        mountGeneration: 3,
      })
    ).resolves.toBeNull();

    await expect(
      createTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorSocketPath: '/tmp/hosted-lifecycle-command-not-opened.sock',
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        restoreGeneration: 7,
        mountGeneration: 3,
      })
    ).rejects.toThrow('hosted-lifecycle-command-authoritative-admission-required');
  });

  it('registers readiness cleanup before awaiting a deferred owner connection', async () => {
    const application = await centralApplication();
    const closeReadiness = vi.fn();
    const readiness = {
      isReady: () => false,
      currentBinding: () => null,
      invalidate: vi.fn(),
      close: closeReadiness,
    };
    let resolveReadiness: ((value: typeof readiness) => void) | undefined;
    const deferredReadiness = new Promise<typeof readiness>((resolve) => {
      resolveReadiness = resolve;
    });
    let registeredCleanup: (() => void) | undefined;
    const order: string[] = [];

    try {
      const pending = createTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorSocketPath: '/tmp/hosted-lifecycle-command-deferred-readiness.sock',
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        orchestratorExpectedOwnerBinding: OWNER_BINDING,
        orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
        connectReadiness: async () => {
          order.push('connect');
          return deferredReadiness;
        },
        registerReadinessCleanup: (cleanup) => {
          order.push(cleanup === null ? 'clear' : 'register');
          if (cleanup !== null && registeredCleanup === undefined) registeredCleanup = cleanup;
        },
        restoreGeneration: 7,
        mountGeneration: 3,
        routeAdmissionBinding: application,
      });

      expect(order).toEqual(['register', 'connect']);
      expect(registeredCleanup).toEqual(expect.any(Function));
      registeredCleanup?.();
      resolveReadiness?.(readiness);

      await expect(pending).rejects.toThrow('hosted-lifecycle-command-composition-unavailable');
      expect(closeReadiness).toHaveBeenCalled();
      expect(order.at(-1)).toBe('clear');
    } finally {
      await application.stop();
    }
  });

  it('mounts one authenticated ACL-only contribution, carries its command scope, and closes cleanly', async () => {
    const acl = await createAclServer();
    const application = await centralApplication();
    const runReservations = reservationStorage();
    const current = currentRunStorage();
    const activate = runReservations.activateReservedRun;
    runReservations.activateReservedRun = async (input) => {
      const result = await activate(input);
      if (result === 'activated') current.activate(input.binding, input.runId);
      return result;
    };
    const onFatalOwnerLoss = vi.fn();
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
      runReservations: () => runReservations,
      currentAuthority: () => current.gateway,
      onFatalOwnerLoss,
      now: () => 1,
    });
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      expect(composition.isReady()).toBe(true);
      const response = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: launchBody(),
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ kind: 'accepted', action: 'launch' });
      expect(acl.requests.map((request) => request.operation)).toEqual([
        'readiness',
        'authorize',
        'revalidate',
        'replay_lookup',
        'execute',
        'revalidate',
        'release',
      ]);
      expect(acl.requests[1]).toMatchObject({
        schemaVersion: 2,
        ownerBinding: OWNER_BINDING,
        payload: {
          context: {
            deploymentId: DEPLOYMENT_ID,
            bootId: BOOT_ID,
            authorizedScope: 'scope_hosted-lifecycle-command',
          },
        },
      });

      acl.loseOwner();
      expect(composition.isReady()).toBe(false);
      expect(onFatalOwnerLoss).toHaveBeenCalledOnce();
      expect(onFatalOwnerLoss).toHaveBeenCalledWith(
        new Error('hosted-lifecycle-orchestrator-owner-lost'),
        OWNER_BINDING
      );
      await vi.waitFor(async () => {
        const unavailable = await app.inject({
          method: 'POST',
          url: '/api/hosted/v1/team-lifecycle/launch',
          payload: launchBody(),
        });
        expect(unavailable.statusCode).toBe(503);
      });
      composition.close();
      const closed = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: launchBody(),
      });
      expect(closed.statusCode).toBe(503);
      expect(acl.requests).toHaveLength(7);
    } finally {
      composition.close();
      await app.close();
      await application.stop();
      await acl.close();
    }
  });

  it.each(['idle', 'running'] as const)(
    'reuses the immutable Product run after a pre-execute Owner read failure while Owner is %s',
    async (initialPhase) => {
      const acl = await createAclServer({ failFirstReplayLookup: true, initialPhase });
      const application = await centralApplication();
      const runReservations = reservationStorage();
      const current = currentRunStorage();
      const activate = runReservations.activateReservedRun;
      runReservations.activateReservedRun = async (input) => {
        const result = await activate(input);
        if (result === 'activated') current.activate(input.binding, input.runId);
        return result;
      };
      const initialAuth = authenticated();
      let activeSession = SESSION_ID;
      const composition = await createTeamLifecycleCommandComposition({
        authentication: {
          ...initialAuth,
          authenticatedPrincipalFor: () => {
            const value = initialAuth.authenticatedPrincipalFor();
            return Object.freeze({
              ...value,
              authenticatedSessionId: activeSession,
              principal: Object.freeze({ ...value.principal, sessionId: activeSession }),
            });
          },
        },
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorSocketPath: acl.socketPath,
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        orchestratorExpectedOwnerBinding: OWNER_BINDING,
        orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
        orchestratorConnect: acl.connect,
        orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
        connectReadiness: acl.connectReadiness,
        restoreGeneration: 7,
        mountGeneration: 3,
        routeAdmissionBinding: application,
        runReservations: () => runReservations,
        currentAuthority: () => current.gateway,
        now: () => 1,
      });
      const app = Fastify();
      composition.register(app);
      await app.ready();
      try {
        const first = await app.inject({
          method: 'POST',
          url: '/api/hosted/v1/team-lifecycle/launch',
          payload: launchBody(),
        });
        expect(first.statusCode).toBe(503);
        expect(current.state()).toBe('eligible');
        expect(acl.requests.map(({ operation }) => operation)).toEqual([
          'readiness',
          'authorize',
          'revalidate',
          'replay_lookup',
          'release',
        ]);
        const retryId = 'lifecycle-command_composition-0002';
        const retryBody = {
          ...launchBody(),
          commandId: retryId,
          idempotencyKey: 'idempotency_composition-0002',
        };
        const claimAlias = runReservations.claimAlias;
        runReservations.claimAlias = async () => ({ kind: 'conflict' });
        const denied = await app.inject({
          method: 'POST',
          url: '/api/hosted/v1/team-lifecycle/launch',
          payload: retryBody,
        });
        expect(denied.statusCode).toBe(409);
        expect(denied.json()).toMatchObject({ kind: 'operator_required', commandId: retryId });
        expect(current.state()).toBe('eligible');
        expect(acl.requests).toHaveLength(5);
        runReservations.claimAlias = claimAlias;
        const second = await app.inject({
          method: 'POST',
          url: '/api/hosted/v1/team-lifecycle/launch',
          payload: retryBody,
        });
        expect(second.statusCode).toBe(200);
        expect(second.json()).toMatchObject({
          kind: 'idempotent_replay',
          commandId: retryId,
          runId: RUN_ID,
        });
        expect(current.state()).toBe('eligible');
        const retryRequests = acl.requests.slice(5);
        expect(retryRequests.map(({ operation }) => operation)).toEqual([
          'authorize',
          'revalidate',
          'replay_lookup',
          'execute',
          'revalidate',
          'release',
        ]);
        expect(
          retryRequests
            .filter(({ operation }) => operation === 'authorize' || operation === 'execute')
            .every(
              (request) =>
                ((request.payload as Record<string, unknown>).command as Record<string, unknown>)
                  .commandId === COMMAND_ID
            )
        ).toBe(true);
        expect(
          (
            (
              retryRequests.find(({ operation }) => operation === 'execute')!.payload as Record<
                string,
                unknown
              >
            ).runReservation as Record<string, unknown>
          ).runId
        ).toBe(RUN_ID);
        activeSession = parseHostedSessionId('session_lifecycle-command-composition-other');
        const ownerRequests = acl.requests.length;
        const changedSession = await app.inject({
          method: 'POST',
          url: '/api/hosted/v1/team-lifecycle/launch',
          payload: {
            ...launchBody(),
            commandId: 'lifecycle-command_composition-0003',
            idempotencyKey: 'idempotency_composition-0003',
          },
        });
        expect(changedSession.statusCode).toBe(409);
        expect(changedSession.json()).toMatchObject({ kind: 'operator_required' });
        expect(acl.requests).toHaveLength(ownerRequests);
      } finally {
        composition.close();
        await app.close();
        await application.stop();
        await acl.close();
      }
    }
  );

  it('rejects deployment mismatch and lacks a command route when the authenticated role lacks permission', async () => {
    await expect(
      createTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: 'deployment_lifecycle-command-other',
        orchestratorSocketPath: '/tmp/hosted-lifecycle-command-invalid.sock',
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        restoreGeneration: 7,
        mountGeneration: 3,
      })
    ).rejects.toThrow('hosted-lifecycle-command-deployment-binding-invalid');

    const acl = await createAclServer();
    const application = await centralApplication();
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(['hosted.query']),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
      now: () => 1,
    });
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: launchBody(),
      });
      const controlState = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/control-state',
        payload: { schemaVersion: 1, workspaceId: WORKSPACE_ID, teamId: TEAM_ID },
      });
      expect(response.statusCode).toBe(503);
      expect(controlState.statusCode).toBe(200);
      expect(controlState.json()).toMatchObject({
        kind: 'control_state',
        deploymentId: DEPLOYMENT_ID,
        bootId: BOOT_ID,
      });
      expect(acl.requests.map((request) => request.operation)).toEqual([
        'readiness',
        'control_state',
      ]);
      expect(acl.requests[1]).toMatchObject({
        payload: { context: { authorizedScope: 'scope_hosted-lifecycle-control-state' } },
      });
    } finally {
      composition.close();
      await app.close();
      await application.stop();
      await acl.close();
    }
  });

  it('keeps standalone lifecycle routes conditional and supplies the authoritative route binding', async () => {
    const source = await readFile(resolve('src/main/standalone.ts'), 'utf8');
    const shutdown = source.slice(source.indexOf('async function shutdown'));

    expect(source.match(/createOptionalTeamLifecycleCommandComposition\(\{/g)).toHaveLength(1);
    expect(source).toContain('authentication: hostedAccessFeature.http');
    expect(source).toContain('runtimeInstance: hostedDiagnosticsRuntimeInstance');
    expect(source).toContain('expectedDeploymentId: hostedAccessFeature.deploymentId');
    expect(source).toContain('hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET');
    expect(source).toContain(
      'hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT'
    );
    expect(source).toContain('await createOptionalTeamLifecycleCommandComposition({');
    const compositionCall = source.slice(
      source.indexOf('await createOptionalTeamLifecycleCommandComposition({'),
      source.indexOf('const hostedTeamTaskBoardRoutes')
    );
    const optionalRuntimeGate = source.slice(
      source.lastIndexOf(
        'hostedLifecycleCommands =',
        source.indexOf('await createOptionalTeamLifecycleCommandComposition({')
      ),
      source.indexOf('await createOptionalTeamLifecycleCommandComposition({')
    );
    expect(optionalRuntimeGate).toContain('hostedDiagnosticsRuntimeInstance === null');
    expect(optionalRuntimeGate).toContain('? null');
    expect(optionalRuntimeGate).not.toContain('readHostedLifecycleOrchestratorTrustAnchor');
    expect(source).toContain('readHostedLifecycleOrchestratorTrustAnchor(');
    expect(source).toContain('hostedBootstrapEnvironment');
    expect(source).toContain('stage=startup_before_http outcome=started code=none');
    expect(source).toContain('stage=lifecycle_composition outcome=started code=none');
    expect(source).toContain('stage=lifecycle_composition outcome=failed code=unavailable');
    expect(source).toContain("'composition_created'");
    expect(source).not.toContain("'ready'}`");
    expect(compositionCall).toContain('routeAdmissionBinding: hostedRouteAdmissionBinding');
    expect(compositionCall).toContain('restoreGeneration: hostedAccessFeature.restoreGeneration');
    expect(compositionCall).toContain('orchestratorTrustAnchor: lifecycleTrustAnchor');
    expect(compositionCall).toContain('admitLifecycleAction: runtimeCreationAdmission.admit');
    expect(source).toContain('hostedLifecycleCommandRoutes: hostedLifecycleCommands');
    expect(shutdown.indexOf('hostedLifecycleCommands?.close()')).toBeLessThan(
      shutdown.indexOf('httpServer.stop()')
    );
  });
});
