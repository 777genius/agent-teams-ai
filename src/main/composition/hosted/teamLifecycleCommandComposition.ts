// eslint-disable-next-line no-restricted-imports -- Bounded server-only hosted context facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only hosted lifecycle facet.
import {
  createHostedLifecycleCommandFeature,
  createHostedLifecycleCommandRouteContribution,
  OrchestratorLifecycleCommandClient,
  registerHostedLifecycleCommandHttp,
} from '@features/team-lifecycle/main/hosted';
import { createQueryContext, parseAuthorizedScope } from '@shared/contracts/hosted';

import { HostedLifecycleOrchestratorReadiness } from './hostedLifecycleOrchestratorReadiness';

import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { FastifyInstance } from 'fastify';

const COMMAND_SCOPE = parseAuthorizedScope('scope_hosted-lifecycle-command');
const DEFAULT_ORCHESTRATOR_SOCKET_PATH = '/run/agent-teams/orchestrator-lifecycle.sock';

export interface TeamLifecycleCommandComposition {
  register(app: FastifyInstance): void;
  close(): void;
}

export interface CreateTeamLifecycleCommandCompositionDependencies {
  readonly authentication: {
    authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  };
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly expectedDeploymentId: string;
  readonly orchestratorSocketPath?: string;
  readonly orchestratorExpectedUid?: number;
  readonly orchestratorExpectedGid?: number;
  readonly orchestratorExpectedMode?: number;
  readonly orchestratorHandshakeTimeoutMs?: number;
  readonly now?: () => number;
}

export type CreateOptionalTeamLifecycleCommandCompositionDependencies = Omit<
  CreateTeamLifecycleCommandCompositionDependencies,
  'runtimeInstance'
> & {
  readonly runtimeInstance: RuntimeInstanceContext | null;
};

export async function createOptionalTeamLifecycleCommandComposition(
  dependencies: CreateOptionalTeamLifecycleCommandCompositionDependencies
): Promise<TeamLifecycleCommandComposition | null> {
  if (dependencies.runtimeInstance === null) return null;
  return createTeamLifecycleCommandComposition({
    ...dependencies,
    runtimeInstance: dependencies.runtimeInstance,
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
  const authentication = Object.freeze({
    authenticatedPrincipalFor(request: object) {
      const authenticated = dependencies.authentication.authenticatedPrincipalFor(request);
      return authenticated?.principal.permissions.includes('hosted.command') === true
        ? authenticated
        : null;
    },
  });
  const contexts = createAuthenticatedHostedQueryContextFactory({
    authentication,
    runtimeInstance: dependencies.runtimeInstance,
    ...(dependencies.now === undefined ? {} : { clock: { nowMs: dependencies.now } }),
  });
  const socketPath = dependencies.orchestratorSocketPath ?? DEFAULT_ORCHESTRATOR_SOCKET_PATH;
  let gateway: OrchestratorLifecycleCommandClient | null = null;
  const readiness = await HostedLifecycleOrchestratorReadiness.connect({
    socketPath,
    expectedUid: dependencies.orchestratorExpectedUid ?? process.getuid?.() ?? 0,
    expectedGid: dependencies.orchestratorExpectedGid ?? process.getgid?.() ?? 0,
    expectedMode: dependencies.orchestratorExpectedMode ?? 0o600,
    ...(dependencies.orchestratorHandshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: dependencies.orchestratorHandshakeTimeoutMs }),
    onOwnerLoss: () => gateway?.close(),
  });
  gateway = new OrchestratorLifecycleCommandClient({ socketPath });
  const feature = createHostedLifecycleCommandFeature({
    gateway,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const contribution = createHostedLifecycleCommandRouteContribution(feature);
  let registered = false;
  let closed = false;

  return Object.freeze({
    register(app: FastifyInstance): void {
      if (closed || registered) throw new Error('hosted-lifecycle-command-composition-unavailable');
      registered = true;
      registerHostedLifecycleCommandHttp(app, contribution.facade, (request, signal) => {
        if (closed || !readiness.isReady()) {
          throw new Error('hosted-lifecycle-command-composition-unavailable');
        }
        const result = contexts.create(request, signal);
        if (result.kind !== 'success') {
          throw new Error(`hosted-lifecycle-command-context-${result.code}`);
        }
        return createQueryContext({ ...result.context, authorizedScope: COMMAND_SCOPE });
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      gateway?.close();
      readiness.close();
    },
  });
}
