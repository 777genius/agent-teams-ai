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

import type {
  HostedTeamMessageAuthorityPort,
  HostedTeamMessageMutationAuthorityPort,
} from '../ports/HostedTeamMessageAuthorityPort';
import type { HostedTeamMessageRequestAuthorization } from './AuthorizedHostedTeamMessageAuthority';
import type { HostedInboxOwnerProvenanceAuthority } from './AuthorizedHostedTeamMessageAuthority';
import type { HostedTeamMessageReadDiagnostic } from './AuthorizedHostedTeamMessageAuthority';
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
  /** Mutation-only facet from the already-admitted lifecycle owner. */
  readonly writer?: HostedTeamMessageMutationAuthorityPort;
  /** Authenticated owner provenance for classifying durable operator-authored inbox rows. */
  readonly ownerProvenance?: HostedInboxOwnerProvenanceAuthority;
  /** Emits bounded, non-sensitive failure stages for hosted production diagnostics. */
  readonly reportReadDiagnostic?: HostedTeamMessageReadDiagnostic;
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
  if (dependencies.source !== undefined && dependencies.writer !== undefined) {
    throw new TypeError('hosted-team-message-composition-source-writer-conflict');
  }
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
  const inboxAuthority = new HostedTeamInboxAuthority({
    runtimeInstance,
    mountBinding: dependencies.mountBinding,
    teamIdentities: dependencies.teamIdentities,
    nowMs,
    ...(dependencies.ownerProvenance === undefined
      ? {}
      : { ownerProvenance: dependencies.ownerProvenance }),
    ...(dependencies.reportReadDiagnostic === undefined
      ? {}
      : { reportReadDiagnostic: dependencies.reportReadDiagnostic }),
  });
  const mutationFenceOwner = dependencies.writer ?? dependencies.source;
  const mutationFenceBinder =
    typeof mutationFenceOwner?.bindGrantFence === 'function'
      ? mutationFenceOwner.bindGrantFence.bind(mutationFenceOwner)
      : undefined;
  const source: HostedTeamMessageAuthorityPort =
    dependencies.source ??
    Object.freeze({
      readWindow: inboxAuthority.readWindow.bind(inboxAuthority),
      persistMessage:
        dependencies.writer?.persistMessage.bind(dependencies.writer) ??
        inboxAuthority.persistMessage.bind(inboxAuthority),
      deliverPersistedMessage:
        dependencies.writer?.deliverPersistedMessage.bind(dependencies.writer) ??
        inboxAuthority.deliverPersistedMessage.bind(inboxAuthority),
      ...(mutationFenceBinder === undefined
        ? {}
        : {
            bindGrantFence: mutationFenceBinder,
          }),
    });
  const authority = new AuthorizedHostedTeamMessageAuthority(
    source,
    contextRequests,
    dependencies.authorization,
    dependencies.reportReadDiagnostic
  );
  const feature = createHostedTeamMessageFeature({
    ...createHostedTeamMessageOutputAdapters(authority, {
      ...(dependencies.reportReadDiagnostic === undefined
        ? {}
        : { reportReadDiagnostic: dependencies.reportReadDiagnostic }),
    }),
    clock: Object.freeze({ now: nowMs }),
  });
  let registered = false;

  return Object.freeze({
    register(app: unknown): void {
      if (registered) throw new Error('hosted-team-message-composition-already-registered');
      registered = true;
      registerHostedTeamMessageHttp(
        app as FastifyInstance,
        feature,
        (request, signal) => {
          const result = contexts.create(request, signal);
          if (result.kind !== 'success') {
            throw new Error(`hosted-team-message-query-context-${result.code}`);
          }
          contextRequests.set(result.context, request);
          return result.context;
        },
        {
          enableMutations:
            mutationFenceBinder !== undefined &&
            (dependencies.writer !== undefined || dependencies.source !== undefined),
          ...(dependencies.reportReadDiagnostic === undefined
            ? {}
            : { reportReadDiagnostic: dependencies.reportReadDiagnostic }),
        }
      );
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
