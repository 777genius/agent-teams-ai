import {
  type CloseRuntimeIngressRelayRequest,
  createCompositeRuntimePlan,
  type LaneRelayHandle,
  type ObserveProcessExecutionUnitRequest,
  type OpenRuntimeIngressRelayRequest,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  parseSecretClass,
  parseSecretRefId,
  type ProcessSupervisorPort,
  type RecoverProcessExecutionUnitRequest,
  type ResolvedEnvironmentAuthorityRef,
  type ResolvedExecutableAuthorityRef,
  type ResolvedProcessLaunchSpec,
  type ResolvedWorkdirAuthorityRef,
  type ResolveRuntimeExecutionRequest,
  type ResolveWorkspaceExecutionRequest,
  type RuntimeCancellation,
  type RuntimeCancellationId,
  type RuntimeExecutionBackend,
  type RuntimeIngressRelayPort,
  type RuntimeIngressRelayRef,
  type RuntimeIngressVerb,
  type RuntimePlanRef,
  type Sha256Hash,
  type StartProcessExecutionUnitRequest,
  type StopProcessExecutionUnitRequest,
  type SupervisedProcessRef,
  type WorkspaceExecutionAuthorityPort,
  type WorkspaceExecutionGrant,
  type WorkspaceExecutionGrantId,
} from '@features/team-runtime-control';
import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const hash = (character: string): Sha256Hash => `sha256:${character.repeat(64)}` as Sha256Hash;

function createSoloPlan() {
  const laneId = parseLaneId('primary');
  const memberId = parseMemberId(`member_${'c'.repeat(32)}`);
  const secret = {
    secretRefId: parseSecretRefId('secret-opencode-account'),
    secretClass: parseSecretClass('provider-account'),
  };
  return createCompositeRuntimePlan({
    teamId: parseTeamId(`team_${'c'.repeat(32)}`),
    runId: parseRunId(`run_${'d'.repeat(32)}`),
    generation: 1,
    leadProviderId: 'opencode',
    lanePlanResult: planTeamRuntimeLanes({ leadProviderId: 'opencode', members: [] }),
    rosterGeneration: 1,
    memberBindings: [
      {
        memberId,
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('solo'),
        providerId: 'opencode',
        laneId,
        policy: 'required',
      },
    ],
    laneCredentials: [
      {
        laneId,
        requiredCredentialExposureSet: { secretRefs: [secret] },
      },
    ],
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'e'.repeat(32)}`),
      registrationRevision: 1,
      bindingGeneration: 1,
      mountGeneration: 2,
    },
    executionUnits: [
      {
        executionUnitId: parseExecutionUnitId('unit-opencode-solo'),
        backendBinding: {
          backend: 'opencode',
          bindingId: parseRuntimeBackendBindingId('backend-opencode'),
          bindingRevision: 1,
        },
        laneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId('binary-opencode'),
          binaryRevision: 1,
          binaryHash: hash('1'),
        },
        environmentPolicy: {
          policy: 'explicit_allowlist',
          variables: [
            {
              name: 'OPENCODE_ACCOUNT',
              provenance: 'secret_ref',
              secretRef: secret,
            },
          ],
        },
        credentialExposureSet: { secretRefs: [secret] },
        resourcePolicy: {
          maxRuntimeMs: 30_000,
          gracefulStopMs: 3_000,
          maxOutputBytes: 500_000,
          maxProcessCount: 2,
        },
      },
    ],
  });
}

const activeCancellation = (): RuntimeCancellation => ({
  cancellationId: 'cancel-active' as RuntimeCancellationId,
  isCancellationRequested: () => false,
});

class FakeRuntimeExecutionBackend implements RuntimeExecutionBackend {
  readonly backend = 'opencode' as const;
  readonly resolutions: ResolveRuntimeExecutionRequest[] = [];

  async resolve(request: ResolveRuntimeExecutionRequest) {
    this.resolutions.push(request);
    if (request.cancellation.isCancellationRequested()) {
      return { status: 'rejected' as const, reason: 'cancelled' as const };
    }
    const unit = request.plan.executionUnits.find(
      (candidate) => candidate.executionUnitId === request.executionUnitId
    );
    if (!unit || unit.backendBinding.backend !== this.backend) {
      return { status: 'rejected' as const, reason: 'invalid_plan' as const };
    }
    return {
      status: 'resolved' as const,
      execution: {
        argvAuthority: {
          executableRef: 'executable-opencode-v1' as ResolvedExecutableAuthorityRef,
          binaryPolicy: unit.binaryPolicy,
          argv: ['serve', '--runtime-relay'],
          argvHash: hash('a'),
        },
        environmentAuthority: {
          environmentRef: 'environment-opencode-v1' as ResolvedEnvironmentAuthorityRef,
          policy: unit.environmentPolicy,
        },
      },
    };
  }
}

class FakeWorkspaceExecutionAuthority implements WorkspaceExecutionAuthorityPort {
  readonly resolutions: ResolveWorkspaceExecutionRequest[] = [];

  async resolve(request: ResolveWorkspaceExecutionRequest) {
    this.resolutions.push(request);
    if (request.cancellation.isCancellationRequested()) {
      return { status: 'rejected' as const, reason: 'cancelled' as const };
    }
    const binding = request.workspaceBinding;
    const grant = request.grant;
    if (
      grant.workspaceId !== binding.workspaceId ||
      grant.registrationRevision !== binding.registrationRevision ||
      grant.bindingGeneration !== binding.bindingGeneration ||
      grant.mountGeneration !== binding.mountGeneration
    ) {
      return { status: 'rejected' as const, reason: 'stale_grant' as const };
    }
    return {
      status: 'resolved' as const,
      workdirAuthority: {
        workdirRef: 'workdir-authority-v1' as ResolvedWorkdirAuthorityRef,
        grant,
      },
    };
  }
}

class FakeProcessSupervisor implements ProcessSupervisorPort {
  readonly starts: StartProcessExecutionUnitRequest[] = [];
  readonly stops: StopProcessExecutionUnitRequest[] = [];
  readonly observations: ObserveProcessExecutionUnitRequest[] = [];
  readonly recoveries: RecoverProcessExecutionUnitRequest[] = [];

  async start(request: StartProcessExecutionUnitRequest) {
    this.starts.push(request);
    if (request.cancellation.isCancellationRequested()) {
      return { status: 'rejected' as const, reason: 'cancelled' as const };
    }
    return {
      status: 'started' as const,
      processRef: 'owned-process-ref' as SupervisedProcessRef,
    };
  }

  async stop(request: StopProcessExecutionUnitRequest) {
    this.stops.push(request);
    return request.cancellation.isCancellationRequested()
      ? ({ status: 'cancelled' as const } as const)
      : ({ status: 'drained' as const } as const);
  }

  async observe(request: ObserveProcessExecutionUnitRequest) {
    this.observations.push(request);
    return { status: 'ready' as const };
  }

  async recover(request: RecoverProcessExecutionUnitRequest) {
    this.recoveries.push(request);
    return request.cancellation.isCancellationRequested()
      ? ({ status: 'cancelled' as const } as const)
      : ({ status: 'not_started' as const } as const);
  }
}

class FakeRuntimeIngressRelay implements RuntimeIngressRelayPort {
  readonly opens: OpenRuntimeIngressRelayRequest[] = [];
  readonly closes: CloseRuntimeIngressRelayRequest[] = [];

  async open(request: OpenRuntimeIngressRelayRequest) {
    this.opens.push(request);
    return {
      status: 'opened' as const,
      relayRef: 'relay-ref' as RuntimeIngressRelayRef,
      laneRelayHandle: 'lane-handle' as LaneRelayHandle,
    };
  }

  async close(request: CloseRuntimeIngressRelayRequest) {
    this.closes.push(request);
    return { status: 'closed' as const };
  }
}

function planRefFor(plan: ReturnType<typeof createSoloPlan>): RuntimePlanRef {
  return {
    teamId: plan.teamId,
    runId: plan.runId,
    generation: plan.generation,
    planHash: plan.planHash,
  };
}

describe('team-runtime-control application port seams', () => {
  it('separates provider execution resolution from process ownership', async () => {
    const plan = createSoloPlan();
    const executionUnit = plan.executionUnits[0]!;
    const cancellation = activeCancellation();
    const backend = new FakeRuntimeExecutionBackend();
    const workspaceAuthority = new FakeWorkspaceExecutionAuthority();
    const supervisor = new FakeProcessSupervisor();
    const grant: WorkspaceExecutionGrant = {
      grantId: 'workspace-grant-v1' as WorkspaceExecutionGrantId,
      ...plan.workspaceBinding,
      permission: 'execute_process',
    };

    const backendResolution = await backend.resolve({
      plan,
      executionUnitId: executionUnit.executionUnitId,
      cancellation,
    });
    const workspaceResolution = await workspaceAuthority.resolve({
      planRef: planRefFor(plan),
      workspaceBinding: plan.workspaceBinding,
      grant,
      cancellation,
    });
    if (backendResolution.status !== 'resolved' || workspaceResolution.status !== 'resolved') {
      throw new Error('fake authority unexpectedly rejected');
    }
    const launchSpec: ResolvedProcessLaunchSpec = {
      planRef: planRefFor(plan),
      executionUnitId: executionUnit.executionUnitId,
      backend: executionUnit.backendBinding.backend,
      argvAuthority: backendResolution.execution.argvAuthority,
      workdirAuthority: workspaceResolution.workdirAuthority,
      environmentAuthority: backendResolution.execution.environmentAuthority,
      resourcePolicy: executionUnit.resourcePolicy,
    };
    const started = await supervisor.start({ executionUnit, launchSpec, cancellation });

    expect(started.status).toBe('started');
    expect(backend.resolutions).toHaveLength(1);
    expect(workspaceAuthority.resolutions).toHaveLength(1);
    expect(supervisor.starts).toEqual([{ executionUnit, launchSpec, cancellation }]);
    expect('start' in backend).toBe(false);
    expect('stop' in backend).toBe(false);
    expect('resolve' in supervisor).toBe(false);
    expect(Object.keys(launchSpec).sort()).toEqual([
      'argvAuthority',
      'backend',
      'environmentAuthority',
      'executionUnitId',
      'planRef',
      'resourcePolicy',
      'workdirAuthority',
    ]);
    expect(JSON.stringify(launchSpec)).not.toContain('cwd');
    expect(JSON.stringify(launchSpec)).not.toContain('process.env');
  });

  it('rejects stale workspace generations and threads cancellation through every effect seam', async () => {
    const plan = createSoloPlan();
    const executionUnit = plan.executionUnits[0]!;
    const workspaceAuthority = new FakeWorkspaceExecutionAuthority();
    const cancelled: RuntimeCancellation = {
      cancellationId: 'cancel-requested' as RuntimeCancellationId,
      isCancellationRequested: () => true,
    };
    const staleGrant: WorkspaceExecutionGrant = {
      grantId: 'workspace-grant-stale' as WorkspaceExecutionGrantId,
      ...plan.workspaceBinding,
      mountGeneration: plan.workspaceBinding.mountGeneration + 1,
      permission: 'execute_process',
    };

    const staleResult = await workspaceAuthority.resolve({
      planRef: planRefFor(plan),
      workspaceBinding: plan.workspaceBinding,
      grant: staleGrant,
      cancellation: activeCancellation(),
    });
    expect(staleResult).toEqual({ status: 'rejected', reason: 'stale_grant' });

    const backend = new FakeRuntimeExecutionBackend();
    const supervisor = new FakeProcessSupervisor();
    const cancelledBackend = await backend.resolve({
      plan,
      executionUnitId: executionUnit.executionUnitId,
      cancellation: cancelled,
    });
    const cancelledRecovery = await supervisor.recover({
      planRef: planRefFor(plan),
      executionUnit,
      cancellation: cancelled,
    });
    expect(cancelledBackend).toEqual({ status: 'rejected', reason: 'cancelled' });
    expect(cancelledRecovery).toEqual({ status: 'cancelled' });
  });

  it('binds supervision and ingress to exact plan-owned unit, lane, member, and cancellation refs', async () => {
    const plan = createSoloPlan();
    const executionUnit = plan.executionUnits[0]!;
    const cancellation = activeCancellation();
    const planRef = planRefFor(plan);
    const processRef = 'owned-process-ref' as SupervisedProcessRef;
    const supervisor = new FakeProcessSupervisor();
    const relay = new FakeRuntimeIngressRelay();
    const verbs = ['runtime.bootstrap.confirm', 'runtime.heartbeat.report'] as RuntimeIngressVerb[];

    await supervisor.observe({
      planRef,
      executionUnitId: executionUnit.executionUnitId,
      processRef,
    });
    await supervisor.stop({
      planRef,
      executionUnitId: executionUnit.executionUnitId,
      processRef,
      mode: 'graceful',
      cancellation,
    });
    await supervisor.recover({ planRef, executionUnit, cancellation });
    const opened = await relay.open({
      planRef,
      laneId: executionUnit.laneId,
      memberIds: executionUnit.memberIds,
      credentialGeneration: 3,
      allowedVerbs: verbs,
    });
    await relay.close({ planRef, laneId: executionUnit.laneId, relayRef: opened.relayRef });

    expect(supervisor.stops[0]?.cancellation).toBe(cancellation);
    expect(supervisor.recoveries[0]?.executionUnit).toBe(executionUnit);
    expect(relay.opens).toEqual([
      {
        planRef,
        laneId: executionUnit.laneId,
        memberIds: executionUnit.memberIds,
        credentialGeneration: 3,
        allowedVerbs: verbs,
      },
    ]);
    expect(Object.keys(relay.opens[0] ?? {}).sort()).toEqual([
      'allowedVerbs',
      'credentialGeneration',
      'laneId',
      'memberIds',
      'planRef',
    ]);
  });
});
