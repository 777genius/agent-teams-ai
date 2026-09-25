// eslint-disable-next-line no-restricted-imports -- Bounded server-only hosted context facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only hosted lifecycle facet.
import {
  createHostedLifecycleCommandRouteContribution,
  ExecuteHostedLifecycleCommand,
  GetHostedLifecycleControlState,
  GetHostedProvisioningStatus,
  HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR,
  type HostedLifecycleCommandExecutionResult,
  type HostedLifecycleCommandGatewayPort,
  type HostedLifecycleControlStateResult,
  type HostedLifecycleDiagnosticReporter,
  type HostedLifecycleOwnerEffectFence,
  type HostedLifecyclePrepareResult,
  type HostedLifecycleProgressResult,
  OrchestratorLifecycleCommandClient,
  type OrchestratorLifecycleCommandClientOptions,
  parseHostedLifecycleCommand,
  PrepareHostedProvisioning,
  registerHostedLifecycleCommandHttp,
  sameOrchestratorLifecycleOwnerBinding,
} from '@features/team-lifecycle/main/hosted';
import {
  createQueryContext,
  parseAuthorizedScope,
  parseWorkspaceId,
  type QueryContext,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  HostedLifecycleOrchestratorReadiness,
  type OrchestratorLifecycleBootstrapBinding,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
} from './hostedLifecycleOrchestratorReadiness';
import { TeamLifecycleCurrentRunRetirement } from './teamLifecycleCurrentRunRetirement';

import type { HostedRouteAdmissionBinding } from './application';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type {
  HostedLifecycleCurrentAuthorityGateway,
  HostedLifecycleRunReservationGateway,
} from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { FastifyInstance } from 'fastify';

const COMMAND_SCOPE = parseAuthorizedScope('scope_hosted-lifecycle-command');
const QUERY_SCOPE = parseAuthorizedScope('scope_hosted-lifecycle-control-state');
const DEFAULT_ORCHESTRATOR_SOCKET_PATH = '/run/agent-teams/orchestrator-lifecycle.sock';
const DEFAULT_ORCHESTRATOR_HIGH_WATER_PATH = '/var/lib/agent-teams/lifecycle-owner-high-water';
const RETIREMENT_BUSY_BACKOFF_MS = [10, 25, 50, 100, 200, 400, 800, 800, 800, 800] as const;

export interface TeamLifecycleCommandComposition {
  register(app: FastifyInstance): void;
  isReady(): boolean;
  readonly mutationLease: TeamLifecycleCommandMutationLease;
  admitPromotionPlan(
    request: {
      readonly workspaceId: WorkspaceId;
      readonly teamId: TeamId;
      readonly workspaceRoot: string;
      readonly expectedPlanGeneration: string;
    },
    context: QueryContext,
    httpRequest: object,
    promotionFence: HostedPromotionAdmissionFence
  ): Promise<
    | { readonly kind: 'admitted'; readonly planGeneration: string }
    | { readonly kind: 'not_found' | 'unavailable' }
  >;
  close(): void;
  drainRetirement(): Promise<void>;
}

/** Captured only from a published draft and its current workspace grant by Product composition. */
export interface HostedPromotionAdmissionFence {
  readonly actorId: QueryContext['actorId'];
  readonly sessionId: QueryContext['sessionId'];
  readonly userId: HostedAuthenticatedPrincipal['principal']['userId'];
  readonly authenticatedSessionId: HostedAuthenticatedPrincipal['authenticatedSessionId'];
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
  revalidate(): Promise<boolean>;
}

/** Narrow borrowed view of the already-connected lifecycle owner; it creates no readiness listener. */
export interface TeamLifecycleCommandMutationLease {
  readonly socketPath: string;
  currentBinding(): OrchestratorLifecycleOwnerBinding | null;
  invalidate(): void;
}

interface LifecycleOrchestratorReadinessPort {
  isReady(): boolean;
  currentBinding(): OrchestratorLifecycleOwnerBinding | null;
  invalidate(): void;
  close(): void;
}

export interface CreateTeamLifecycleCommandCompositionDependencies {
  readonly authentication: {
    authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
    captureTeamWorkspaceGrantFence?(
      request: object,
      teamId: import('@shared/contracts/hosted').TeamId,
      permission: 'hosted.query' | 'hosted.command'
    ): Promise<Readonly<{
      publicWorkspaceId: string;
      runtimeWorkspaceId: string;
      ownerEffectFence: HostedLifecycleOwnerEffectFence;
      revalidate(): Promise<boolean>;
    }> | null>;
  };
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly expectedDeploymentId: string;
  readonly orchestratorSocketPath?: string;
  readonly orchestratorOwnerHighWaterPath?: string;
  readonly orchestratorTrustAnchor: OrchestratorLifecycleOwnerProofKey;
  readonly orchestratorExpectedOwnerBinding?: OrchestratorLifecycleOwnerBinding;
  readonly orchestratorBootstrapBinding?: OrchestratorLifecycleBootstrapBinding;
  readonly orchestratorExpectedUid?: number;
  readonly orchestratorExpectedGid?: number;
  readonly orchestratorExpectedMode?: number;
  readonly orchestratorHandshakeTimeoutMs?: number;
  readonly orchestratorRetryBackoffMs?: readonly number[];
  readonly orchestratorConnect?: OrchestratorLifecycleCommandClientOptions['connect'];
  readonly orchestratorInspectSocketIdentity?: OrchestratorLifecycleCommandClientOptions['inspectSocketIdentity'];
  readonly connectReadiness?: (
    options: Parameters<typeof HostedLifecycleOrchestratorReadiness.connect>[0],
    onCreated?: (readiness: LifecycleOrchestratorReadinessPort) => void
  ) => Promise<LifecycleOrchestratorReadinessPort>;
  /** Publishes cancellation before readiness performs its first asynchronous acquisition. */
  readonly registerReadinessCleanup?: (cleanup: (() => void) | null) => void;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly routeAdmissionBinding?: HostedRouteAdmissionBinding;
  readonly admitLifecycleAction?: (action: string) => Promise<boolean>;
  readonly reportDiagnostic?: HostedLifecycleDiagnosticReporter;
  readonly onFatalOwnerLoss?: (
    error: Error,
    ownerBinding: OrchestratorLifecycleOwnerBinding
  ) => void;
  readonly now?: () => number;
  readonly runReservations?: () => HostedLifecycleRunReservationGateway | null;
  readonly currentAuthority?: () => HostedLifecycleCurrentAuthorityGateway | null;
}

export type CreateOptionalTeamLifecycleCommandCompositionDependencies = Omit<
  CreateTeamLifecycleCommandCompositionDependencies,
  'runtimeInstance' | 'mountGeneration'
> & {
  readonly runtimeInstance: RuntimeInstanceContext | null;
  readonly mountGeneration: number | null;
};

export async function createOptionalTeamLifecycleCommandComposition(
  dependencies: CreateOptionalTeamLifecycleCommandCompositionDependencies
): Promise<TeamLifecycleCommandComposition | null> {
  const { runtimeInstance, mountGeneration } = dependencies;
  if (
    runtimeInstance === null ||
    mountGeneration === null ||
    dependencies.routeAdmissionBinding === undefined
  )
    return null;
  return createTeamLifecycleCommandComposition({
    ...dependencies,
    runtimeInstance,
    mountGeneration,
  });
}

/**
 * Mounts the browser adapter against one injected external orchestrator ACL. It intentionally owns
 * neither lifecycle state nor process/provider execution.
 */
export async function createTeamLifecycleCommandComposition(
  dependencies: CreateTeamLifecycleCommandCompositionDependencies
): Promise<TeamLifecycleCommandComposition> {
  if (dependencies.runtimeInstance.deploymentId !== dependencies.expectedDeploymentId) {
    throw new TypeError('hosted-lifecycle-command-deployment-binding-invalid');
  }
  if (dependencies.routeAdmissionBinding === undefined) {
    throw new Error('hosted-lifecycle-command-authoritative-admission-required');
  }
  if (
    dependencies.restoreGeneration === undefined ||
    !Number.isSafeInteger(dependencies.restoreGeneration) ||
    dependencies.restoreGeneration < 0
  ) {
    throw new TypeError('hosted-lifecycle-command-restore-generation-invalid');
  }
  const routeAdmission = dependencies.routeAdmissionBinding.routeAdmission;
  const { mountGeneration, restoreGeneration } = dependencies;
  if (!Number.isSafeInteger(mountGeneration) || mountGeneration < 1) {
    throw new TypeError('hosted-lifecycle-command-mount-generation-invalid');
  }
  const createContexts = (permission: 'hosted.command' | 'hosted.query') =>
    createAuthenticatedHostedQueryContextFactory({
      authentication: Object.freeze({
        authenticatedPrincipalFor(request: object) {
          const authenticated = dependencies.authentication.authenticatedPrincipalFor(request);
          return authenticated?.principal.permissions.includes(permission) === true
            ? authenticated
            : null;
        },
      }),
      runtimeInstance: dependencies.runtimeInstance,
      ...(dependencies.now === undefined ? {} : { clock: { nowMs: dependencies.now } }),
    });
  const commandContexts = createContexts('hosted.command');
  const queryContexts = createContexts('hosted.query');
  const grantFences = new WeakMap<
    import('@shared/contracts/hosted').QueryContext,
    Readonly<{
      publicWorkspaceId?: string;
      runtimeWorkspaceId?: string;
      ownerEffectFence: HostedLifecycleOwnerEffectFence;
      authorityEvidence?: Readonly<{ userId: string; sessionId: string; grantGeneration: number }>;
      revalidate(): Promise<boolean>;
    }>
  >();
  type BrowserResult =
    | HostedLifecycleCommandExecutionResult
    | HostedLifecycleControlStateResult
    | HostedLifecyclePrepareResult
    | HostedLifecycleProgressResult;
  const unavailable = (diagnostic?: string) => {
    if (diagnostic) dependencies.reportDiagnostic?.('lifecycle-browser', diagnostic);
    return Object.freeze({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      kind: 'unavailable' as const,
      retryAfterMs: null,
    });
  };
  const runtimeRequest = (body: unknown, context: QueryContext): unknown | null => {
    const fence = grantFences.get(context);
    if (fence === undefined || typeof body !== 'object' || body === null || Array.isArray(body))
      return null;
    const source = body as Record<string, unknown>;
    if (
      typeof fence.publicWorkspaceId !== 'string' ||
      typeof fence.runtimeWorkspaceId !== 'string' ||
      source.workspaceId !== fence.publicWorkspaceId
    )
      return null;
    try {
      const publicWorkspaceId = parseWorkspaceId(fence.publicWorkspaceId);
      const runtimeWorkspaceId = parseWorkspaceId(fence.runtimeWorkspaceId);
      if (source.workspaceId !== publicWorkspaceId) return null;
      return Object.freeze({ ...source, workspaceId: runtimeWorkspaceId });
    } catch {
      return null;
    }
  };
  const browserResult = async <Result extends BrowserResult>(
    result: Result,
    context: QueryContext,
    ownerIsCurrent: () => boolean
  ): Promise<Result> => {
    const fence = grantFences.get(context);
    if (
      fence === undefined ||
      typeof fence.publicWorkspaceId !== 'string' ||
      typeof fence.runtimeWorkspaceId !== 'string' ||
      !(await fence.revalidate()) ||
      !ownerIsCurrent()
    )
      throw new Error('hosted-lifecycle-command-grant-fence-unavailable');
    const project = <Value extends { readonly workspaceId: WorkspaceId }>(value: Value): Value => {
      if (value.workspaceId !== fence.runtimeWorkspaceId)
        throw new Error('hosted-lifecycle-command-response-scope-invalid');
      return Object.freeze({
        ...value,
        workspaceId: parseWorkspaceId(fence.publicWorkspaceId),
      }) as Value;
    };
    if (result.kind === 'provisioning_status') {
      const projected = project(result) as Extract<
        HostedLifecycleProgressResult,
        {
          readonly kind: 'provisioning_status';
        }
      >;
      return Object.freeze({
        ...projected,
        recentCommands: Object.freeze(
          projected.recentCommands.map((recent) =>
            Object.freeze({
              ...recent,
              result: 'workspaceId' in recent.result ? project(recent.result) : recent.result,
            })
          )
        ),
      }) as Result;
    }
    if ('workspaceId' in result)
      return project(result as Result & { readonly workspaceId: WorkspaceId });
    return result;
  };
  const socketPath = dependencies.orchestratorSocketPath ?? DEFAULT_ORCHESTRATOR_SOCKET_PATH;
  const orchestratorExpectedOwnerBinding = dependencies.orchestratorExpectedOwnerBinding;
  const orchestratorBootstrapBinding = dependencies.orchestratorBootstrapBinding;
  if (
    orchestratorExpectedOwnerBinding === undefined ||
    orchestratorBootstrapBinding === undefined
  ) {
    throw new Error('hosted-lifecycle-command-authenticated-handoff-required');
  }
  let gateway: OrchestratorLifecycleCommandClient | null = null;
  let ownerEpoch = 0;
  let pendingReadiness: LifecycleOrchestratorReadinessPort | null = null;
  let retirementDrain: Promise<void> | null = null;
  let cleanupRequested = false;
  let compositionBuilt = false;
  const retirement = new TeamLifecycleCurrentRunRetirement({
    current: () => dependencies.currentAuthority?.() ?? null,
    reservations: () => dependencies.runReservations?.() ?? null,
    currentOwner: () => pendingReadiness?.currentBinding() ?? null,
    expectedOwner: orchestratorExpectedOwnerBinding,
    restoreGeneration,
    mountGeneration,
    fenceForContext: (context) => grantFences.get(context) ?? null,
    controlState: (request, context) =>
      gateway?.getControlState(request, context) ?? Promise.resolve(unavailable()),
  });
  const retireCapturedOwner = (): void => {
    retirementDrain ??= (async () => {
      const binding = retirement.capturedBinding(
        dependencies.runtimeInstance.deploymentId,
        dependencies.runtimeInstance.bootId
      );
      for (let attempt = 0; attempt <= RETIREMENT_BUSY_BACKOFF_MS.length; attempt += 1) {
        try {
          // Each attempt enters a fresh Product transaction and re-reads its CAS row.
          await retirement.retireLostOwner(binding);
          return;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== 'product-authority-lock-transient-busy' ||
            attempt >= RETIREMENT_BUSY_BACKOFF_MS.length
          )
            throw error;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, RETIREMENT_BUSY_BACKOFF_MS[attempt])
          );
        }
      }
    })();
    void retirementDrain.catch(() => undefined);
  };
  const closeReadiness = (): void => {
    cleanupRequested = true;
    pendingReadiness?.close();
  };
  // Register before calling (and therefore before awaiting) the connector. Production connect
  // publishes its concrete handle synchronously through onCreated, while test/custom connectors
  // are still closed immediately when their deferred promise eventually resolves.
  dependencies.registerReadinessCleanup?.(closeReadiness);
  try {
    const readiness = await (
      dependencies.connectReadiness ?? HostedLifecycleOrchestratorReadiness.connect
    )(
      {
        socketPath,
        ownerHighWaterPath:
          dependencies.orchestratorOwnerHighWaterPath ?? DEFAULT_ORCHESTRATOR_HIGH_WATER_PATH,
        expectedUid: dependencies.orchestratorExpectedUid ?? process.getuid?.() ?? 0,
        expectedGid: dependencies.orchestratorExpectedGid ?? process.getgid?.() ?? 0,
        expectedMode: dependencies.orchestratorExpectedMode ?? 0o600,
        ...(dependencies.orchestratorHandshakeTimeoutMs === undefined
          ? {}
          : { handshakeTimeoutMs: dependencies.orchestratorHandshakeTimeoutMs }),
        ...(dependencies.orchestratorRetryBackoffMs === undefined
          ? {}
          : { retryBackoffMs: dependencies.orchestratorRetryBackoffMs }),
        onOwnerLoss: () => {
          ownerEpoch += 1;
          gateway?.ownerLost();
          retireCapturedOwner();
          dependencies.onFatalOwnerLoss?.(
            new Error('hosted-lifecycle-orchestrator-owner-lost'),
            orchestratorExpectedOwnerBinding
          );
        },
        trustAnchor: dependencies.orchestratorTrustAnchor,
        expectedOwnerBinding: orchestratorExpectedOwnerBinding,
        bootstrapBinding: orchestratorBootstrapBinding,
      },
      (created) => {
        pendingReadiness = created;
        if (cleanupRequested) created.close();
      }
    );
    pendingReadiness = readiness;
    if (cleanupRequested) {
      readiness.close();
      throw new Error('hosted-lifecycle-command-composition-unavailable');
    }
    gateway = new OrchestratorLifecycleCommandClient({
      socketPath,
      restoreGeneration,
      mountGeneration,
      ownerBinding: () => readiness.currentBinding(),
      ownerProofKey: () => dependencies.orchestratorTrustAnchor,
      onOwnerMismatch: () => readiness.invalidate(),
      grantFenceForContext: (context) => grantFences.get(context) ?? null,
      runReservations: dependencies.runReservations,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.orchestratorConnect === undefined
        ? {}
        : { connect: dependencies.orchestratorConnect }),
      ...(dependencies.orchestratorInspectSocketIdentity === undefined
        ? {}
        : { inspectSocketIdentity: dependencies.orchestratorInspectSocketIdentity }),
    });
    const terminalRetirement = new WeakSet<QueryContext>();
    const guardedGateway: HostedLifecycleCommandGatewayPort &
      Pick<OrchestratorLifecycleCommandClient, 'release'> = {
      getControlState: gateway.getControlState.bind(gateway),
      authorize: gateway.authorize.bind(gateway),
      revalidate: gateway.revalidate.bind(gateway),
      execute: async (command, authorization, context) => {
        if (command.action !== 'launch') {
          try {
            const admission = await retirement.beforeNonLaunchExecute(command, context);
            if (admission === 'denied') return { kind: 'operator_required' };
            if (admission === 'terminal_pending') terminalRetirement.add(context);
          } catch {
            return { kind: 'operator_required' };
          }
        }
        return gateway!.execute(command, authorization, context);
      },
      release: gateway.release.bind(gateway),
    };
    const execute = new ExecuteHostedLifecycleCommand(guardedGateway, dependencies.now);
    const controlState = new GetHostedLifecycleControlState(
      gateway,
      dependencies.now,
      dependencies.reportDiagnostic
    );
    const prepare = new PrepareHostedProvisioning(gateway, dependencies.now);
    const getProgress = new GetHostedProvisioningStatus(gateway, dependencies.now);
    let registered = false;
    let closed = false;
    const invokeBrowser = async <Result extends BrowserResult>(
      body: unknown,
      context: QueryContext,
      operation: (request: unknown) => Promise<Result>
    ): Promise<Result | ReturnType<typeof unavailable>> => {
      const ownerBinding = readiness.currentBinding();
      const capturedOwnerEpoch = ownerEpoch;
      const ownerIsCurrent = (): boolean => {
        try {
          const currentBinding = readiness.currentBinding();
          const nowMs = (dependencies.now ?? Date.now)();
          return (
            !closed &&
            ownerEpoch === capturedOwnerEpoch &&
            readiness.isReady() &&
            ownerBinding !== null &&
            currentBinding !== null &&
            sameOrchestratorLifecycleOwnerBinding(currentBinding, ownerBinding) &&
            !context.signal.aborted &&
            Number.isSafeInteger(nowMs) &&
            nowMs < context.deadlineAtMs
          );
        } catch {
          return false;
        }
      };
      if (!ownerIsCurrent()) return unavailable('owner-not-current');
      const request = runtimeRequest(body, context);
      if (request === null) return unavailable('request-scope-invalid');
      return browserResult(await operation(request), context, ownerIsCurrent);
    };
    const executeBrowserCommand = async (
      action: Parameters<typeof execute.execute>[0],
      request: unknown,
      context: QueryContext
    ): Promise<HostedLifecycleCommandExecutionResult> => {
      if (action !== 'launch') {
        const parsedTerminal = parseHostedLifecycleCommand(action, request);
        const result = await execute.execute(action, request, context);
        // Only a fenced request settles here, including a recover of a superseded run.
        if (!terminalRetirement.has(context)) return result;
        if (!parsedTerminal.ok || parsedTerminal.value.action === 'launch') return unavailable();
        const terminalCommand = parsedTerminal.value;
        const operatorRequired = (): HostedLifecycleCommandExecutionResult => ({
          schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
          kind: 'operator_required',
          action,
          commandId: terminalCommand.commandId,
          workspaceId: terminalCommand.workspaceId,
          teamId: terminalCommand.teamId,
        });
        if (result.kind !== 'accepted' && result.kind !== 'idempotent_replay')
          return operatorRequired();
        try {
          if (await retirement.afterTerminalReceipt(terminalCommand, context)) return result;
        } catch {
          /* The pending Product fence remains durable. */
        }
        return operatorRequired();
      }
      const parsed = parseHostedLifecycleCommand(action, request);
      if (!parsed.ok || parsed.value.action !== 'launch')
        return execute.execute(action, request, context);
      const incoming = parsed.value;
      const storage = dependencies.runReservations?.();
      if (!storage) return unavailable();
      const operatorRequired = (): HostedLifecycleCommandExecutionResult =>
        Object.freeze({
          schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
          kind: 'operator_required',
          action: 'launch',
          commandId: incoming.commandId,
          workspaceId: incoming.workspaceId,
          teamId: incoming.teamId,
        });
      try {
        const previous = await storage.lookupByResource({
          deploymentId: context.deploymentId,
          bootId: context.bootId,
          teamId: incoming.teamId,
          expectedRevision: incoming.expectedRevision,
        });
        if (!(await retirement.beforeLaunch(incoming, context, previous?.runId ?? null)))
          return operatorRequired();
        if (!previous) {
          return execute.execute(action, request, context);
        }
        const sameCommandId = previous.commandId === incoming.commandId;
        const sameIdempotencyKey = previous.idempotencyKey === incoming.idempotencyKey;
        if (sameCommandId && sameIdempotencyKey) return execute.execute(action, request, context);
        if (sameCommandId || sameIdempotencyKey) return operatorRequired();
        const fence = grantFences.get(context);
        const binding = readiness.currentBinding();
        if (
          !fence ||
          !binding ||
          !fence.authorityEvidence ||
          !fence.publicWorkspaceId ||
          !fence.runtimeWorkspaceId ||
          incoming.workspaceId !== fence.runtimeWorkspaceId ||
          previous.workspaceId !== fence.publicWorkspaceId ||
          previous.runtimeWorkspaceId !== fence.runtimeWorkspaceId ||
          previous.actorId !== context.actorId ||
          previous.ownerAuthority !== binding.ownerAuthority ||
          previous.ownerGeneration !== binding.ownerGeneration ||
          previous.ownerSessionId !== binding.ownerSessionId ||
          previous.restoreGeneration !== restoreGeneration ||
          previous.mountGeneration !== mountGeneration ||
          previous.authorityEvidence.userId !== fence.authorityEvidence.userId ||
          previous.authorityEvidence.sessionId !== fence.authorityEvidence.sessionId ||
          previous.authorityEvidence.grantGeneration !== fence.authorityEvidence.grantGeneration ||
          previous.ownerEffectFence.grantRevision !== fence.ownerEffectFence.grantRevision ||
          previous.ownerEffectFence.identityChecksum !== fence.ownerEffectFence.identityChecksum ||
          !(await fence.revalidate())
        )
          return operatorRequired();
        const currentPlanGeneration = await storage.currentPlanGeneration({
          workspaceId: previous.workspaceId,
          teamId: previous.teamId,
          actorId: previous.actorId,
          deploymentId: previous.deploymentId,
        });
        if (currentPlanGeneration !== previous.expectedPlanGeneration) return operatorRequired();
        const resumed = await storage.reserve(
          {
            schemaVersion: 1,
            workspaceId: previous.workspaceId,
            runtimeWorkspaceId: previous.runtimeWorkspaceId,
            teamId: previous.teamId,
            actorId: previous.actorId,
            deploymentId: previous.deploymentId,
            bootId: previous.bootId,
            commandId: previous.commandId,
            idempotencyKey: previous.idempotencyKey,
            expectedRevision: previous.expectedRevision,
            expectedPlanGeneration: previous.expectedPlanGeneration,
            ownerAuthority: binding.ownerAuthority,
            ownerGeneration: binding.ownerGeneration,
            ownerSessionId: binding.ownerSessionId,
            restoreGeneration,
            mountGeneration,
            ownerEffectFence: fence.ownerEffectFence,
            authorityEvidence: fence.authorityEvidence,
            deadlineAtMs: context.deadlineAtMs,
          },
          { signal: context.signal }
        );
        const latestBinding = readiness.currentBinding();
        if (
          resumed.kind !== 'idempotent_replay' ||
          resumed.reservation.runId !== previous.runId ||
          latestBinding === null ||
          !sameOrchestratorLifecycleOwnerBinding(latestBinding, binding)
        )
          return operatorRequired();
        const alias = await storage.claimAlias({
          runId: previous.runId,
          deploymentId: previous.deploymentId,
          actorId: previous.actorId,
          bootId: previous.bootId,
          teamId: previous.teamId,
          expectedRevision: previous.expectedRevision,
          commandId: incoming.commandId,
          idempotencyKey: incoming.idempotencyKey,
        });
        if (alias.kind === 'conflict') return operatorRequired();
        const canonical = Object.freeze({
          schemaVersion: incoming.schemaVersion,
          commandId: previous.commandId,
          idempotencyKey: previous.idempotencyKey,
          workspaceId: incoming.workspaceId,
          teamId: incoming.teamId,
          expectedRevision: incoming.expectedRevision,
        });
        const result = await execute.execute('launch', canonical, context);
        if (result.kind === 'accepted' || result.kind === 'idempotent_replay') {
          return Object.freeze({
            ...result,
            kind: 'idempotent_replay',
            commandId: incoming.commandId,
          });
        }
        if ('commandId' in result) {
          return Object.freeze({
            ...result,
            commandId: incoming.commandId,
          });
        }
        return result;
      } catch {
        return operatorRequired();
      }
    };
    const feature = Object.freeze({
      routes: HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
      async execute(
        action: Parameters<typeof execute.execute>[0],
        body: unknown,
        context: QueryContext
      ) {
        if ((await dependencies.admitLifecycleAction?.(action)) === false) return unavailable();
        return invokeBrowser(body, context, (request) =>
          executeBrowserCommand(action, request, context)
        );
      },
      async getControlState(body: unknown, context: QueryContext) {
        return invokeBrowser(body, context, (request) => controlState.execute(request, context));
      },
      async prepare(body: unknown, context: QueryContext) {
        return invokeBrowser(body, context, (request) => prepare.execute(request, context));
      },
      async getProgress(body: unknown, context: QueryContext) {
        return invokeBrowser(body, context, (request) => getProgress.execute(request, context));
      },
    });
    const contribution = createHostedLifecycleCommandRouteContribution(feature);

    const mutationLease = Object.freeze({
      socketPath,
      currentBinding: () => (closed ? null : readiness.currentBinding()),
      invalidate: () => readiness.invalidate(),
    });
    const composition = Object.freeze({
      mutationLease,
      async admitPromotionPlan(
        request: {
          readonly workspaceId: WorkspaceId;
          readonly teamId: TeamId;
          readonly workspaceRoot: string;
          readonly expectedPlanGeneration: string;
        },
        context: QueryContext,
        httpRequest: object,
        promotionFence: HostedPromotionAdmissionFence
      ) {
        if (closed || !readiness.isReady()) return { kind: 'unavailable' as const };
        const authenticated = dependencies.authentication.authenticatedPrincipalFor(httpRequest);
        if (
          !authenticated ||
          authenticated.principal.userId.length === 0 ||
          !authenticated.principal.permissions.includes('hosted.command') ||
          authenticated.principal.userId !== promotionFence.userId ||
          authenticated.authenticatedSessionId !== promotionFence.authenticatedSessionId ||
          context.actorId !== promotionFence.actorId ||
          context.sessionId !== promotionFence.sessionId ||
          request.workspaceId !== promotionFence.workspaceId ||
          request.teamId !== promotionFence.teamId
        ) {
          return { kind: 'unavailable' as const };
        }
        if (!(await promotionFence.revalidate())) return { kind: 'unavailable' as const };
        grantFences.set(context, promotionFence);
        try {
          return await gateway!.admitLaunchPlan({ schemaVersion: 1, ...request }, context);
        } finally {
          grantFences.delete(context);
        }
      },
      isReady(): boolean {
        return !closed && readiness.isReady();
      },
      register(app: FastifyInstance): void {
        if (closed || registered)
          throw new Error('hosted-lifecycle-command-composition-unavailable');
        registered = true;
        registerHostedLifecycleCommandHttp(
          app,
          contribution.facade,
          routeAdmission,
          async (descriptor, request, signal) => {
            if (closed || !readiness.isReady()) {
              throw new Error('hosted-lifecycle-command-composition-unavailable');
            }
            const isControlState =
              descriptor.id === HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR.id;
            const isQuery =
              isControlState ||
              descriptor.id === 'team-lifecycle.prepare.v1' ||
              descriptor.id === 'team-lifecycle.progress.v1';
            const result = (isQuery ? queryContexts : commandContexts).create(request, signal);
            if (result.kind !== 'success') {
              throw new Error(`hosted-lifecycle-command-context-${result.code}`);
            }
            const context = createQueryContext({
              ...result.context,
              authorizedScope: isQuery ? QUERY_SCOPE : COMMAND_SCOPE,
            });
            const body = request.body as Record<string, unknown> | null;
            const teamIdValue = body?.teamId;
            const capture = dependencies.authentication.captureTeamWorkspaceGrantFence;
            if (typeof capture !== 'function' || typeof teamIdValue !== 'string') {
              throw new Error('hosted-lifecycle-command-grant-fence-unavailable');
            }
            const fence = await capture.call(
              dependencies.authentication,
              request,
              teamIdValue as import('@shared/contracts/hosted').TeamId,
              isQuery ? 'hosted.query' : 'hosted.command'
            );
            if (fence === null || !(await fence.revalidate())) {
              throw new Error('hosted-lifecycle-command-grant-fence-unavailable');
            }
            const authenticated = dependencies.authentication.authenticatedPrincipalFor(request);
            if (
              !authenticated ||
              !authenticated.principal.permissions.includes(
                isQuery ? 'hosted.query' : 'hosted.command'
              )
            )
              throw new Error('hosted-lifecycle-command-principal-unavailable');
            grantFences.set(
              context,
              Object.freeze({
                ...fence,
                authorityEvidence: Object.freeze({
                  userId: authenticated.principal.userId,
                  sessionId: authenticated.authenticatedSessionId,
                  grantGeneration: restoreGeneration,
                }),
              })
            );
            return context;
          },
          dependencies.reportDiagnostic
        );
      },
      close(): void {
        if (closed) return;
        closed = true;
        gateway?.close();
        retireCapturedOwner();
        closeReadiness();
        dependencies.registerReadinessCleanup?.(null);
      },
      async drainRetirement(): Promise<void> {
        await retirementDrain;
      },
    });
    compositionBuilt = true;
    return composition;
  } finally {
    if (!compositionBuilt) {
      closeReadiness();
      dependencies.registerReadinessCleanup?.(null);
    }
  }
}
