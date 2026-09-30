import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createCompositeRuntimePlan,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  type RuntimeCancellation,
  type RuntimeCancellationId,
  type RuntimeExecutionBackendKind,
  type Sha256Hash,
} from '@features/team-runtime-control';
import {
  type LaneExecutionBackend,
  type LaneExecutionEffectLease,
  type LaneExecutionLaunchOutcome,
  type LaneExecutionMutationAuthority,
  type LaneExecutionMutationAuthorityRequest,
  type LaneExecutionObserveOutcome,
  type LaneExecutionPreflightDecision,
  type LaneExecutionProviderCapability,
  type LaneExecutionRecoverOutcome,
  type LaneExecutionRequest,
  type LaneExecutionScope,
  type LaneExecutionStopOutcome,
  type MutatingLaneExecutionRequest,
  parseLaneExecutionRef,
} from '@features/team-runtime-control/core/application/backends';
import {
  OpenCodeExecutionBackend,
  type OpenCodeExecutionCompatibilityPorts,
  type ProvisioningCliDeterministicExecutionPorts,
  ProvisioningCliExecutionBackend,
} from '@features/team-runtime-control/main/adapters/output/backends';
import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type { TeamProviderId } from '@shared/types';

interface FakeRegistryAdapter {
  readonly providerId: 'opencode';
}

interface MutableOutcomes {
  preflight: unknown;
  launch: unknown;
  observe: unknown;
  stop: unknown;
  recover: unknown;
}

interface ObservedMutationBinding {
  readonly kind: 'launch' | 'stop' | 'recover';
  readonly operationId: string;
  readonly effectLease: LaneExecutionEffectLease;
}

function hash(character: string): Sha256Hash {
  return `sha256:${character.repeat(64)}`;
}

function createScope(providerId: TeamProviderId): LaneExecutionScope {
  const backend: RuntimeExecutionBackendKind =
    providerId === 'opencode' ? 'opencode' : 'provisioning_cli';
  const laneId = parseLaneId('primary');
  const plan = createCompositeRuntimePlan({
    teamId: parseTeamId(`team_${providerId === 'opencode' ? '3'.repeat(32) : '4'.repeat(32)}`),
    runId: parseRunId(`run_${providerId === 'opencode' ? '5'.repeat(32) : '6'.repeat(32)}`),
    generation: 1,
    leadProviderId: providerId,
    lanePlanResult: planTeamRuntimeLanes({
      leadProviderId: providerId,
      members: [{ name: 'worker', providerId }],
    }),
    rosterGeneration: 1,
    memberBindings: [
      {
        memberId: parseMemberId(
          `member_${providerId === 'opencode' ? '7'.repeat(32) : '8'.repeat(32)}`
        ),
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('worker'),
        providerId,
        laneId,
        policy: 'required',
      },
    ],
    laneCredentials: [{ laneId, requiredCredentialExposureSet: { secretRefs: [] } }],
    workspaceBinding: {
      workspaceId: parseWorkspaceId(
        `workspace_${providerId === 'opencode' ? '9'.repeat(32) : 'a'.repeat(32)}`
      ),
      registrationRevision: 1,
      bindingGeneration: 1,
      mountGeneration: 1,
    },
    executionUnits: [
      {
        executionUnitId: parseExecutionUnitId(`unit-${providerId}`),
        backendBinding: {
          backend,
          bindingId: parseRuntimeBackendBindingId(`binding-${providerId}`),
          bindingRevision: 1,
        },
        laneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId(`binary-${providerId}`),
          binaryRevision: 1,
          binaryHash: hash('3'),
        },
        environmentPolicy: { policy: 'explicit_allowlist', variables: [] },
        credentialExposureSet: { secretRefs: [] },
        resourcePolicy: {
          maxRuntimeMs: 30_000,
          gracefulStopMs: 2_000,
          maxOutputBytes: 100_000,
          maxProcessCount: 2,
        },
      },
    ],
  });
  return {
    plan,
    lane: plan.lanes[0],
    executionUnit: plan.executionUnits[0],
    requiredProviderIds: [providerId],
  };
}

function cancellation(): RuntimeCancellation {
  return {
    cancellationId: 'cancel-conformance' as RuntimeCancellationId,
    isCancellationRequested: () => false,
  };
}

function mutationBinding(operationId = 'operation:backend-conformance', fence = 7) {
  return {
    operationId,
    effectLease: Object.freeze({
      token: `lease-token-${fence}`,
      fence,
      ownerId: 'backend-conformance-owner',
      claimedAtIso: '2026-07-24T13:59:00.000Z',
      expiresAtIso: '2026-07-24T14:01:00.000Z',
    }),
  } as const;
}

interface ControlledMutationRecord {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly leaseOwnerId: string;
  readonly leaseFence: number;
  readonly claimedAtIso: string;
  readonly expiresAtIso: string;
  readonly payloadJson: string;
  status: 'started' | 'completed' | 'unknown';
  result?: unknown;
}

class ControlledMutationAuthority implements LaneExecutionMutationAuthority {
  nowMs = Date.parse('2026-07-24T14:00:00.000Z');
  private readonly records = new Map<string, ControlledMutationRecord[]>();

  async execute<TResult>(
    request: LaneExecutionMutationAuthorityRequest,
    effect: () => Promise<TResult>
  ): Promise<TResult> {
    const scope = request.payload.scope;
    const scopeKey = [
      scope.plan.teamId,
      scope.plan.runId,
      scope.plan.generation,
      scope.lane.laneId,
      request.backend,
    ].join(':');
    const records = this.records.get(scopeKey) ?? [];
    const payloadJson = JSON.stringify(request.payload);
    const existingOperation = records.find(
      ({ operationId }) => operationId === request.operationId
    );
    if (existingOperation) {
      if (
        existingOperation.status === 'completed' &&
        existingOperation.payloadJson === payloadJson &&
        existingOperation.leaseToken === request.effectLease.token &&
        existingOperation.leaseOwnerId === request.effectLease.ownerId &&
        existingOperation.leaseFence === request.effectLease.fence &&
        existingOperation.claimedAtIso === request.effectLease.claimedAtIso &&
        existingOperation.expiresAtIso === request.effectLease.expiresAtIso
      ) {
        return existingOperation.result as TResult;
      }
      throw new Error('controlled-mutation-operation-rebound');
    }
    if (
      this.nowMs < Date.parse(request.effectLease.claimedAtIso) ||
      this.nowMs >= Date.parse(request.effectLease.expiresAtIso)
    ) {
      throw new Error('controlled-mutation-expired');
    }
    if (records.some(({ leaseToken }) => leaseToken === request.effectLease.token)) {
      throw new Error('controlled-mutation-token-rebound');
    }
    const maximum = records.reduce<ControlledMutationRecord | null>(
      (current, candidate) =>
        !current || candidate.leaseFence > current.leaseFence ? candidate : current,
      null
    );
    if (
      maximum &&
      (maximum.status !== 'completed' || request.effectLease.fence <= maximum.leaseFence)
    ) {
      throw new Error('controlled-mutation-stale-or-unsettled');
    }
    const record: ControlledMutationRecord = {
      operationId: request.operationId,
      leaseToken: request.effectLease.token,
      leaseOwnerId: request.effectLease.ownerId,
      leaseFence: request.effectLease.fence,
      claimedAtIso: request.effectLease.claimedAtIso,
      expiresAtIso: request.effectLease.expiresAtIso,
      payloadJson,
      status: 'started',
    };
    records.push(record);
    this.records.set(scopeKey, records);
    try {
      const result = await effect();
      record.status = 'completed';
      record.result = result;
      return result;
    } catch (error) {
      record.status = 'unknown';
      throw error;
    }
  }
}

function capabilities(request: LaneExecutionRequest): readonly LaneExecutionProviderCapability[] {
  return request.scope.requiredProviderIds.map((providerId) => ({
    backend: request.scope.executionUnit.backendBinding.backend,
    bindingId: request.scope.executionUnit.backendBinding.bindingId,
    bindingRevision: request.scope.executionUnit.backendBinding.bindingRevision,
    providerId,
    capabilityRevision: 1,
    supported: true,
    readiness: 'ready',
  }));
}

function createProvisioningBackend(
  outcomes: MutableOutcomes,
  observed: ObservedMutationBinding[] = [],
  mutationAuthority: LaneExecutionMutationAuthority | null = new ControlledMutationAuthority()
): LaneExecutionBackend {
  const ports: ProvisioningCliDeterministicExecutionPorts = {
    readCapabilities: (request) => Promise.resolve(capabilities(request)),
    preflight: () => Promise.resolve(outcomes.preflight as LaneExecutionPreflightDecision),
    launch: (request) => {
      observeMutation(observed, 'launch', request);
      return Promise.resolve(outcomes.launch as LaneExecutionLaunchOutcome);
    },
    observe: () => Promise.resolve(outcomes.observe as LaneExecutionObserveOutcome),
    stop: (request) => {
      observeMutation(observed, 'stop', request);
      return Promise.resolve(outcomes.stop as LaneExecutionStopOutcome);
    },
    recover: (request) => {
      observeMutation(observed, 'recover', request);
      return Promise.resolve(outcomes.recover as LaneExecutionRecoverOutcome);
    },
  };
  return new ProvisioningCliExecutionBackend(ports, mutationAuthority);
}

function createOpenCodeBackend(
  outcomes: MutableOutcomes,
  observed: ObservedMutationBinding[] = [],
  mutationAuthority: LaneExecutionMutationAuthority | null = new ControlledMutationAuthority()
): LaneExecutionBackend {
  const adapter: FakeRegistryAdapter = { providerId: 'opencode' };
  const ports: OpenCodeExecutionCompatibilityPorts<FakeRegistryAdapter> = {
    registry: {
      has: (providerId) => providerId === 'opencode',
      get: () => adapter,
    },
    readCapabilities: (_adapter, request) => Promise.resolve(capabilities(request)),
    preflight: () => Promise.resolve(outcomes.preflight as LaneExecutionPreflightDecision),
    launch: (_adapter, request) => {
      observeMutation(observed, 'launch', request);
      return Promise.resolve(outcomes.launch as LaneExecutionLaunchOutcome);
    },
    observe: () => Promise.resolve(outcomes.observe as LaneExecutionObserveOutcome),
    stop: (_adapter, request) => {
      observeMutation(observed, 'stop', request);
      return Promise.resolve(outcomes.stop as LaneExecutionStopOutcome);
    },
    recover: (_adapter, request) => {
      observeMutation(observed, 'recover', request);
      return Promise.resolve(outcomes.recover as LaneExecutionRecoverOutcome);
    },
  };
  return new OpenCodeExecutionBackend(ports, mutationAuthority);
}

function observeMutation(
  observed: ObservedMutationBinding[],
  kind: ObservedMutationBinding['kind'],
  request: MutatingLaneExecutionRequest
): void {
  observed.push({
    kind,
    operationId: request.operationId,
    effectLease: request.effectLease,
  });
}

const cases = [
  {
    name: 'provisioning CLI',
    providerId: 'anthropic' as const,
    providers: ['anthropic', 'codex', 'gemini'],
    create: createProvisioningBackend,
  },
  {
    name: 'OpenCode',
    providerId: 'opencode' as const,
    providers: ['opencode'],
    create: createOpenCodeBackend,
  },
] as const;

describe('lane execution backend conformance', () => {
  it.each(cases)(
    '$name implements the same bounded lifecycle outcome contract',
    async (fixture) => {
      const outcomes: MutableOutcomes = {
        preflight: { status: 'ready' },
        launch: { status: 'launched', executionRef: 'conformance-run' },
        observe: { status: 'stopping' },
        stop: { status: 'stopped' },
        recover: { status: 'not_started' },
      };
      const backend = fixture.create(outcomes);
      const scope = createScope(fixture.providerId);
      const activeCancellation = cancellation();
      const launchBinding = mutationBinding('operation:launch', 7);
      const stopBinding = mutationBinding('operation:stop', 8);
      const recoverBinding = mutationBinding('operation:recover', 9);
      const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
      if (preflight.status !== 'ready') throw new Error('expected ready conformance preflight');
      const executionRef = parseLaneExecutionRef('conformance-run');

      expect(backend.supportedProviderIds).toEqual(fixture.providers);
      expect(backend.validatePlan(scope)).toEqual({ status: 'accepted' });
      await expect(
        backend.launch({
          scope,
          cancellation: activeCancellation,
          readiness: preflight.readiness,
          ...launchBinding,
        })
      ).resolves.toEqual({ status: 'launched', executionRef });
      await expect(backend.observe({ scope, executionRef })).resolves.toEqual({
        status: 'stopping',
      });
      await expect(
        backend.stop({
          scope,
          executionRef,
          mode: 'graceful',
          cancellation: activeCancellation,
          ...stopBinding,
        })
      ).resolves.toEqual({ status: 'stopped' });
      await expect(
        backend.recover({ scope, cancellation: activeCancellation, ...recoverBinding })
      ).resolves.toEqual({
        status: 'not_started',
      });
    }
  );

  it.each(cases)('$name contains malformed compatibility outcomes', async (fixture) => {
    const outcomes: MutableOutcomes = {
      preflight: { status: 'ready' },
      launch: { status: 'launched', executionRef: 'invalid execution ref' },
      observe: { status: 'invented-state' },
      stop: { status: 'invented-state' },
      recover: { status: 'recovered', executionRef: '' },
    };
    const backend = fixture.create(outcomes);
    const scope = createScope(fixture.providerId);
    const activeCancellation = cancellation();
    const launchBinding = mutationBinding('operation:malformed-launch', 7);
    const stopBinding = mutationBinding('operation:malformed-stop', 8);
    const recoverBinding = mutationBinding('operation:malformed-recover', 9);
    const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
    if (preflight.status !== 'ready') throw new Error('expected ready conformance preflight');
    const executionRef = parseLaneExecutionRef('conformance-run');
    const rejected = { status: 'rejected', reason: 'capability_mismatch' };
    const ambiguous = { status: 'operator_required' };

    await expect(
      backend.launch({
        scope,
        cancellation: activeCancellation,
        readiness: preflight.readiness,
        ...launchBinding,
      })
    ).resolves.toEqual(ambiguous);
    await expect(backend.observe({ scope, executionRef })).resolves.toEqual(rejected);
    await expect(
      backend.stop({
        scope,
        executionRef,
        mode: 'graceful',
        cancellation: activeCancellation,
        ...stopBinding,
      })
    ).resolves.toEqual(ambiguous);
    await expect(
      backend.recover({ scope, cancellation: activeCancellation, ...recoverBinding })
    ).resolves.toEqual(ambiguous);
  });

  it.each(cases)(
    '$name preserves explicit unavailable outcomes with ready capability snapshots',
    async (fixture) => {
      const unavailable = { status: 'rejected', reason: 'unavailable' } as const;
      const outcomes: MutableOutcomes = {
        preflight: { status: 'ready' },
        launch: unavailable,
        observe: unavailable,
        stop: unavailable,
        recover: unavailable,
      };
      const backend = fixture.create(outcomes);
      const scope = createScope(fixture.providerId);
      const activeCancellation = cancellation();
      const launchBinding = mutationBinding('operation:unavailable-launch', 7);
      const stopBinding = mutationBinding('operation:unavailable-stop', 8);
      const recoverBinding = mutationBinding('operation:unavailable-recover', 9);
      const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
      if (preflight.status !== 'ready') throw new Error('expected ready conformance preflight');
      const executionRef = parseLaneExecutionRef('conformance-run');

      outcomes.preflight = unavailable;
      await expect(backend.preflight({ scope, cancellation: activeCancellation })).resolves.toEqual(
        unavailable
      );
      await expect(
        backend.launch({
          scope,
          cancellation: activeCancellation,
          readiness: preflight.readiness,
          ...launchBinding,
        })
      ).resolves.toEqual(unavailable);
      await expect(backend.observe({ scope, executionRef })).resolves.toEqual(unavailable);
      await expect(
        backend.stop({
          scope,
          executionRef,
          mode: 'graceful',
          cancellation: activeCancellation,
          ...stopBinding,
        })
      ).resolves.toEqual(unavailable);
      await expect(
        backend.recover({ scope, cancellation: activeCancellation, ...recoverBinding })
      ).resolves.toEqual(unavailable);
    }
  );

  it.each(cases)(
    '$name propagates stable operation identity and the exact lease fence on idempotent retries',
    async (fixture) => {
      const outcomes: MutableOutcomes = {
        preflight: { status: 'ready' },
        launch: { status: 'already_launched', executionRef: 'conformance-run' },
        observe: { status: 'stopping' },
        stop: { status: 'already_stopped' },
        recover: { status: 'not_started' },
      };
      const observed: ObservedMutationBinding[] = [];
      const backend = fixture.create(outcomes, observed);
      const scope = createScope(fixture.providerId);
      const activeCancellation = cancellation();
      const launchBinding = mutationBinding('operation:idempotent-launch', 11);
      const stopBinding = mutationBinding('operation:idempotent-stop', 12);
      const recoverBinding = mutationBinding('operation:idempotent-recover', 13);
      const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
      if (preflight.status !== 'ready') throw new Error('expected ready conformance preflight');
      const executionRef = parseLaneExecutionRef('conformance-run');
      const launchRequest = {
        scope,
        cancellation: activeCancellation,
        readiness: preflight.readiness,
        ...launchBinding,
      };
      const stopRequest = {
        scope,
        executionRef,
        mode: 'graceful' as const,
        cancellation: activeCancellation,
        ...stopBinding,
      };
      const recoveryRequest = {
        scope,
        cancellation: activeCancellation,
        ...recoverBinding,
      };

      await backend.launch(launchRequest);
      await backend.launch(launchRequest);
      await backend.stop(stopRequest);
      await backend.stop(stopRequest);
      await backend.recover(recoveryRequest);
      await backend.recover(recoveryRequest);

      expect(observed.map(({ kind }) => kind)).toEqual(['launch', 'stop', 'recover']);
      expect(observed).toEqual([
        { kind: 'launch', ...launchBinding },
        { kind: 'stop', ...stopBinding },
        { kind: 'recover', ...recoverBinding },
      ]);
    }
  );

  it.each(cases)(
    '$name executes one effect for exact retries and none for invalid durable claims',
    async (fixture) => {
      const outcomes: MutableOutcomes = {
        preflight: { status: 'ready' },
        launch: { status: 'already_launched', executionRef: 'conformance-run' },
        observe: { status: 'stopping' },
        stop: { status: 'already_stopped' },
        recover: { status: 'not_started' },
      };
      const observed: ObservedMutationBinding[] = [];
      const authority = new ControlledMutationAuthority();
      const backend = fixture.create(outcomes, observed, authority);
      const scope = createScope(fixture.providerId);
      const executionRef = parseLaneExecutionRef('conformance-run');
      const activeCancellation = cancellation();
      const binding = mutationBinding('operation:durable-stop', 10);
      const request = {
        scope,
        executionRef,
        mode: 'graceful' as const,
        cancellation: activeCancellation,
        ...binding,
      };

      await expect(backend.stop(request)).resolves.toEqual({ status: 'already_stopped' });
      authority.nowMs = Date.parse('2026-07-24T16:00:00.000Z');
      await expect(backend.stop(request)).resolves.toEqual({ status: 'already_stopped' });
      authority.nowMs = Date.parse('2026-07-24T14:00:00.000Z');

      for (const [operationId, leaseToken, leaseFence] of [
        ['operation:lower', 'lease-token-lower', 9],
        ['operation:equal', 'lease-token-equal', 10],
      ] as const) {
        await expect(
          backend.stop({
            ...request,
            ...mutationBinding(operationId, leaseFence),
            effectLease: {
              ...mutationBinding(operationId, leaseFence).effectLease,
              token: leaseToken,
            },
          })
        ).resolves.toEqual({ status: 'operator_required' });
      }
      await expect(
        backend.stop({
          ...request,
          ...mutationBinding(binding.operationId, 11),
        })
      ).resolves.toEqual({ status: 'operator_required' });
      await expect(
        backend.stop({
          ...request,
          ...mutationBinding('operation:token-rebound', 11),
          effectLease: {
            ...mutationBinding('operation:token-rebound', 11).effectLease,
            token: binding.effectLease.token,
          },
        })
      ).resolves.toEqual({ status: 'operator_required' });
      await expect(
        backend.stop({
          ...request,
          mode: 'immediate',
        })
      ).resolves.toEqual({ status: 'operator_required' });
      await expect(
        backend.stop({
          ...request,
          ...mutationBinding('operation:expired', 11),
          effectLease: {
            ...mutationBinding('operation:expired', 11).effectLease,
            claimedAtIso: '2026-07-24T12:00:00.000Z',
            expiresAtIso: '2026-07-24T13:00:00.000Z',
          },
        })
      ).resolves.toEqual({ status: 'operator_required' });

      expect(observed).toHaveLength(1);
      expect(observed[0]).toEqual({ kind: 'stop', ...binding });
    }
  );

  it.each(cases)(
    '$name fails closed when mutation authority is missing or unavailable',
    async (fixture) => {
      const outcomes: MutableOutcomes = {
        preflight: { status: 'ready' },
        launch: { status: 'launched', executionRef: 'must-not-launch' },
        observe: { status: 'stopping' },
        stop: { status: 'stopped' },
        recover: { status: 'not_started' },
      };
      const scope = createScope(fixture.providerId);
      const executionRef = parseLaneExecutionRef('conformance-run');
      const request = {
        scope,
        executionRef,
        mode: 'graceful' as const,
        cancellation: cancellation(),
        ...mutationBinding('operation:authority-failure', 7),
      };

      for (const authority of [
        null,
        {
          execute: () => Promise.reject(new Error('mutation-authority-unavailable')),
        } satisfies LaneExecutionMutationAuthority,
      ]) {
        const observed: ObservedMutationBinding[] = [];
        const backend = fixture.create(outcomes, observed, authority);
        await expect(backend.stop(request)).resolves.toEqual({ status: 'operator_required' });
        expect(observed).toEqual([]);
      }
    }
  );

  it.each(cases)(
    '$name fails closed before an unfenced mutation reaches its adapter',
    async (fixture) => {
      const outcomes: MutableOutcomes = {
        preflight: { status: 'ready' },
        launch: { status: 'launched', executionRef: 'must-not-launch' },
        observe: { status: 'stopping' },
        stop: { status: 'stopped' },
        recover: { status: 'not_started' },
      };
      const observed: ObservedMutationBinding[] = [];
      const backend = fixture.create(outcomes, observed);
      const scope = createScope(fixture.providerId);
      const activeCancellation = cancellation();
      const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
      if (preflight.status !== 'ready') throw new Error('expected ready conformance preflight');
      const executionRef = parseLaneExecutionRef('conformance-run');
      const rejected = { status: 'rejected', reason: 'not_owned' };

      await expect(
        backend.launch({
          scope,
          cancellation: activeCancellation,
          readiness: preflight.readiness,
        } as Parameters<LaneExecutionBackend['launch']>[0])
      ).resolves.toEqual(rejected);
      await expect(
        backend.stop({
          scope,
          executionRef,
          mode: 'graceful',
          cancellation: activeCancellation,
          ...mutationBinding('operation:invalid-fence', 0),
        })
      ).resolves.toEqual(rejected);
      await expect(
        backend.recover({
          scope,
          cancellation: activeCancellation,
        } as Parameters<LaneExecutionBackend['recover']>[0])
      ).resolves.toEqual(rejected);
      expect(observed).toEqual([]);
    }
  );

  it('keeps product adapters free of alternate planners, process creation, and shell globals', () => {
    const productionPaths = [
      'src/features/team-runtime-control/main/adapters/output/backends/ProvisioningCliExecutionBackend.ts',
      'src/features/team-runtime-control/main/adapters/output/backends/OpenCodeExecutionBackend.ts',
    ];
    for (const path of productionPaths) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      expect(source).not.toMatch(/planTeamRuntimeLanes|createCompositeRuntimePlan/);
      expect(source).not.toMatch(/node:child_process|child_process|\.spawn\s*\(|\.exec\s*\(/);
      expect(source).not.toMatch(/electron|window\.|process\.env/);
      expect(source).not.toMatch(/claudePath|apiKey|secretValue|tokenValue/);
    }
  });
});
