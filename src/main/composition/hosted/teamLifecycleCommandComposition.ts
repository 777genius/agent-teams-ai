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
  readonly now?: () => number;
}

export type CreateOptionalTeamLifecycleCommandCompositionDependencies = Omit<
  CreateTeamLifecycleCommandCompositionDependencies,
  'runtimeInstance'
> & {
  readonly runtimeInstance: RuntimeInstanceContext | null;
};

export function createOptionalTeamLifecycleCommandComposition(
  dependencies: CreateOptionalTeamLifecycleCommandCompositionDependencies
): TeamLifecycleCommandComposition | null {
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
export function createTeamLifecycleCommandComposition(
  dependencies: CreateTeamLifecycleCommandCompositionDependencies
): TeamLifecycleCommandComposition {
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
  const gateway = new OrchestratorLifecycleCommandClient({
    socketPath: dependencies.orchestratorSocketPath ?? DEFAULT_ORCHESTRATOR_SOCKET_PATH,
  });
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
        if (closed) throw new Error('hosted-lifecycle-command-composition-unavailable');
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
      gateway.close();
    },
  });
}
