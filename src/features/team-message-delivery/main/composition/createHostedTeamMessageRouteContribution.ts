// eslint-disable-next-line no-restricted-imports -- Hosted query context exposes a bounded server-only facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { WorkspaceMountBinding } from '@features/workspace-registry';

import { registerHostedTeamMessageHttp } from '../adapters/input/http/registerHostedTeamMessageHttp';

import {
  AuthorizedHostedTeamMessageAuthority,
  HostedTeamInboxAuthority,
} from './AuthorizedHostedTeamMessageAuthority';
import { createHostedTeamMessageFeature } from './createHostedTeamMessageFeature';
import { createHostedTeamMessageOutputAdapters } from './createHostedTeamMessageOutputAdapters';

import type { HostedTeamMessageAuthorityPort } from '../ports/HostedTeamMessageAuthorityPort';
import type { HostedTeamMessageRequestAuthorization } from './AuthorizedHostedTeamMessageAuthority';
import type { TeamIdentityReadGateway } from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { QueryContext } from '@shared/contracts/hosted';
import type { FastifyInstance } from 'fastify';

export interface CreateHostedTeamMessageRouteContributionDependencies {
  readonly authorization: HostedTeamMessageRequestAuthorization;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly expectedDeploymentId: string;
  readonly nowMs?: () => number;
  /**
   * Existing cooperative/external writer authority, when an owning host already provides one.
   * Without it, the identity-bound default serves reads and fails closed before any inbox mutation.
   */
  readonly source?: HostedTeamMessageAuthorityPort;
}

export interface HostedTeamMessageRouteContribution {
  /** Opaque host boundary; the feature's HTTP adapter validates the concrete application. */
  register(app: unknown): void;
}

export interface HostedTeamMessageRouteAccess {
  readonly http: HostedTeamMessageRequestAuthorization;
  readonly deploymentId: string;
}

export type HostedTeamMessageRouteFactory = (
  access: HostedTeamMessageRouteAccess
) => HostedTeamMessageRouteContribution;

/**
 * Creates the feature-owned hosted message route contribution. The app shell only decides when to
 * mount it; all bounded message policy and request authorization remain inside this feature.
 */
export function createHostedTeamMessageRouteContribution(
  dependencies: CreateHostedTeamMessageRouteContributionDependencies
): HostedTeamMessageRouteContribution {
  const runtimeInstance = createRuntimeInstanceContext(dependencies.runtimeInstance);
  if (
    runtimeInstance.deploymentId !== dependencies.expectedDeploymentId ||
    !(dependencies.mountBinding instanceof WorkspaceMountBinding) ||
    dependencies.mountBinding.bootId !== runtimeInstance.bootId ||
    dependencies.mountBinding.health === 'unavailable'
  ) {
    throw new TypeError('hosted-team-message-composition-binding-invalid');
  }
  const nowMs = dependencies.nowMs ?? Date.now;
  const contexts = createAuthenticatedHostedQueryContextFactory({
    authentication: dependencies.authorization,
    runtimeInstance,
    clock: Object.freeze({ nowMs }),
  });
  const contextRequests = new WeakMap<QueryContext, object>();
  const source =
    dependencies.source ??
    new HostedTeamInboxAuthority({
      runtimeInstance,
      mountBinding: dependencies.mountBinding,
      teamIdentities: dependencies.teamIdentities,
      nowMs,
    });
  const authority = new AuthorizedHostedTeamMessageAuthority(
    source,
    contextRequests,
    dependencies.authorization
  );
  const feature = createHostedTeamMessageFeature({
    ...createHostedTeamMessageOutputAdapters(authority),
    clock: Object.freeze({ now: nowMs }),
  });
  let registered = false;

  return Object.freeze({
    register(app: unknown): void {
      if (registered) throw new Error('hosted-team-message-composition-already-registered');
      registered = true;
      registerHostedTeamMessageHttp(app as FastifyInstance, feature, (request, signal) => {
        const result = contexts.create(request, signal);
        if (result.kind !== 'success') {
          throw new Error(`hosted-team-message-query-context-${result.code}`);
        }
        contextRequests.set(result.context, request);
        return result.context;
      });
    },
  });
}

export function createHostedTeamMessageRouteFactory(
  dependencies: Omit<
    CreateHostedTeamMessageRouteContributionDependencies,
    'authorization' | 'expectedDeploymentId'
  >
): HostedTeamMessageRouteFactory {
  return (access) =>
    createHostedTeamMessageRouteContribution({
      ...dependencies,
      authorization: access.http,
      expectedDeploymentId: access.deploymentId,
    });
}
