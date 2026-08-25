// eslint-disable-next-line no-restricted-imports -- Bounded server-only hosted context facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only hosted lifecycle facet.
import {
  createHostedLifecycleCommandRouteContribution,
  ExecuteHostedLifecycleCommand,
  GetHostedLifecycleControlState,
  HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
  HOSTED_LIFECYCLE_CONTROL_STATE_ROUTE_DESCRIPTOR,
  type HostedLifecycleOwnerEffectFence,
  OrchestratorLifecycleCommandClient,
  type OrchestratorLifecycleCommandClientOptions,
  registerHostedLifecycleCommandHttp,
} from '@features/team-lifecycle/main/hosted';
import { createQueryContext, parseAuthorizedScope } from '@shared/contracts/hosted';

import {
  HostedLifecycleOrchestratorReadiness,
  type OrchestratorLifecycleBootstrapBinding,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
} from './hostedLifecycleOrchestratorReadiness';

import type { HostedRouteAdmissionBinding } from './application';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { FastifyInstance } from 'fastify';

const COMMAND_SCOPE = parseAuthorizedScope('scope_hosted-lifecycle-command');
const QUERY_SCOPE = parseAuthorizedScope('scope_hosted-lifecycle-control-state');
const DEFAULT_ORCHESTRATOR_SOCKET_PATH = '/run/agent-teams/orchestrator-lifecycle.sock';
const DEFAULT_ORCHESTRATOR_HIGH_WATER_PATH = '/var/lib/agent-teams/lifecycle-owner-high-water';

export interface TeamLifecycleCommandComposition {
  register(app: FastifyInstance): void;
  isReady(): boolean;
  readonly mutationLease: TeamLifecycleCommandMutationLease;
  close(): void;
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
  readonly onFatalOwnerLoss?: (error: Error) => void;
  readonly now?: () => number;
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
  const runtimeInstance = dependencies.runtimeInstance;
  const mountGeneration = dependencies.mountGeneration;
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
  const restoreGeneration = dependencies.restoreGeneration;
  if (!Number.isSafeInteger(dependencies.mountGeneration) || dependencies.mountGeneration < 1) {
    throw new TypeError('hosted-lifecycle-command-mount-generation-invalid');
  }
  const mountGeneration = dependencies.mountGeneration;
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
      ownerEffectFence: HostedLifecycleOwnerEffectFence;
      revalidate(): Promise<boolean>;
    }>
  >();
  const socketPath = dependencies.orchestratorSocketPath ?? DEFAULT_ORCHESTRATOR_SOCKET_PATH;
  if (
    dependencies.orchestratorExpectedOwnerBinding === undefined ||
    dependencies.orchestratorBootstrapBinding === undefined
  ) {
    throw new Error('hosted-lifecycle-command-authenticated-handoff-required');
  }
  let gateway: OrchestratorLifecycleCommandClient | null = null;
  let pendingReadiness: LifecycleOrchestratorReadinessPort | null = null;
  let cleanupRequested = false;
  let compositionBuilt = false;
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
          gateway?.ownerLost();
          dependencies.onFatalOwnerLoss?.(new Error('hosted-lifecycle-orchestrator-owner-lost'));
        },
        trustAnchor: dependencies.orchestratorTrustAnchor,
        expectedOwnerBinding: dependencies.orchestratorExpectedOwnerBinding,
        bootstrapBinding: dependencies.orchestratorBootstrapBinding,
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
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.orchestratorConnect === undefined
        ? {}
        : { connect: dependencies.orchestratorConnect }),
      ...(dependencies.orchestratorInspectSocketIdentity === undefined
        ? {}
        : { inspectSocketIdentity: dependencies.orchestratorInspectSocketIdentity }),
    });
    const execute = new ExecuteHostedLifecycleCommand(gateway, dependencies.now);
    const controlState = new GetHostedLifecycleControlState(gateway, dependencies.now);
    const feature = Object.freeze({
      routes: HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
      execute: execute.execute.bind(execute),
      getControlState: controlState.execute.bind(controlState),
    });
    const contribution = createHostedLifecycleCommandRouteContribution(feature);
    let registered = false;
    let closed = false;

    const mutationLease = Object.freeze({
      socketPath,
      currentBinding: () => (closed ? null : readiness.currentBinding()),
      invalidate: () => readiness.invalidate(),
    });
    const composition = Object.freeze({
      mutationLease,
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
            const result = (isControlState ? queryContexts : commandContexts).create(
              request,
              signal
            );
            if (result.kind !== 'success') {
              throw new Error(`hosted-lifecycle-command-context-${result.code}`);
            }
            const context = createQueryContext({
              ...result.context,
              authorizedScope: isControlState ? QUERY_SCOPE : COMMAND_SCOPE,
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
              isControlState ? 'hosted.query' : 'hosted.command'
            );
            if (fence === null || !(await fence.revalidate())) {
              throw new Error('hosted-lifecycle-command-grant-fence-unavailable');
            }
            grantFences.set(context, fence);
            return context;
          }
        );
      },
      close(): void {
        if (closed) return;
        closed = true;
        gateway?.close();
        closeReadiness();
        dependencies.registerReadinessCleanup?.(null);
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
