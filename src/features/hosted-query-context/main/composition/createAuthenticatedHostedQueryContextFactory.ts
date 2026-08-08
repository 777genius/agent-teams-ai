import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { parseAuthorizedScope } from '@shared/contracts/hosted';

import { AuthenticatedHostedQueryContextFactory } from '../../core/application/AuthenticatedHostedQueryContextFactory';
import { NodeHostedQueryContextIdentity } from '../infrastructure/NodeHostedQueryContextIdentity';

import type {
  AuthenticatedHostedPrincipalSourcePort,
  AuthenticatedHostedQueryContextFactoryPort,
  HostedQueryContextClockPort,
} from '../../core/application/ports';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

const AUTHENTICATED_HOSTED_QUERY_CONTEXT_POLICY = Object.freeze({
  authorizedScope: parseAuthorizedScope('scope_authenticated-hosted-query'),
  requiredPermission: 'hosted.query' as const,
  timeoutMs: 10_000,
});

const SERVER_CLOCK: HostedQueryContextClockPort = Object.freeze({ nowMs: Date.now });

export interface CreateAuthenticatedHostedQueryContextFactoryDependencies {
  readonly authentication: AuthenticatedHostedPrincipalSourcePort;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly clock?: HostedQueryContextClockPort;
}

export function createAuthenticatedHostedQueryContextFactory(
  dependencies: CreateAuthenticatedHostedQueryContextFactoryDependencies
): AuthenticatedHostedQueryContextFactoryPort {
  const runtimeInstance = createRuntimeInstanceContext(dependencies.runtimeInstance);
  return new AuthenticatedHostedQueryContextFactory({
    authentication: dependencies.authentication,
    identity: new NodeHostedQueryContextIdentity(),
    runtimeInstance,
    clock: dependencies.clock ?? SERVER_CLOCK,
    policy: AUTHENTICATED_HOSTED_QUERY_CONTEXT_POLICY,
  });
}
