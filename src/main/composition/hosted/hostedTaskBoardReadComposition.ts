// eslint-disable-next-line no-restricted-imports -- Hosted query context exposes a bounded server-only facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
// eslint-disable-next-line no-restricted-imports -- Task-board hosted exports are main-process-only.
import {
  createHostedTeamTaskBoardFeature,
  createHostedTeamTaskBoardOutputAdapters,
  createHostedTeamTaskBoardRouteContribution,
  type HostedTaskBoardAuthorityMutationRequest,
  type HostedTaskBoardAuthorityMutationResult,
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowRequest,
  type HostedTaskBoardAuthorityReadWindowResult,
  registerHostedTeamTaskBoardHttp,
} from '@features/team-task-board/main/hosted';
import { WorkspaceMountBinding } from '@features/workspace-registry';

import { createHostedTaskBoardMutationFileAuthority } from './hostedTaskBoardMutationFileAuthority';
import { DescriptorBoundHostedTaskBoardReadSource } from './hostedTaskBoardReadFileSource';

import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { TeamIdentityReadGateway } from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { QueryContext, TeamId } from '@shared/contracts/hosted';
import type { FastifyInstance } from 'fastify';

interface HostedTaskBoardReadAuthentication {
  authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  isHostedQueryAuthorized(request: object): Promise<boolean>;
  isHostedTaskMutationAuthorized?(request: object, teamId: TeamId): Promise<boolean>;
  isTeamWorkspaceAuthorized(request: object, teamId: TeamId): Promise<boolean>;
}

export interface CreateHostedTaskBoardReadCompositionDependencies {
  readonly authentication: HostedTaskBoardReadAuthentication;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly expectedDeploymentId: string;
  readonly nowMs?: () => number;
  /** Narrow test seam; production always uses the descriptor-bound file source. */
  readonly source?: HostedTaskBoardAuthorityPort;
  /** Narrow test seam; production always composes the descriptor-bound mutation authority. */
  readonly mutationAuthority?: Pick<HostedTaskBoardAuthorityPort, 'admitTaskMutation'>;
}

export interface HostedTaskBoardReadComposition {
  readonly mutationsEnabled: boolean;
  register(app: FastifyInstance): void;
}

export interface HostedTaskBoardReadCompositionAccess {
  readonly http: HostedTaskBoardReadAuthentication;
  readonly deploymentId: string;
}

export interface HostedTaskBoardReadRouteFactory {
  (access: HostedTaskBoardReadCompositionAccess): HostedTaskBoardReadComposition;
}

export function createHostedTaskBoardReadRouteFactory(
  dependencies: Omit<
    CreateHostedTaskBoardReadCompositionDependencies,
    'authentication' | 'expectedDeploymentId'
  >
): HostedTaskBoardReadRouteFactory {
  return Object.freeze((access: HostedTaskBoardReadCompositionAccess) =>
    createHostedTaskBoardReadComposition({
      ...dependencies,
      authentication: access.http,
      expectedDeploymentId: access.deploymentId,
    })
  );
}

class LiveGrantTaskBoardReadAuthority implements HostedTaskBoardAuthorityPort {
  readonly admitTaskMutation?: (
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ) => Promise<HostedTaskBoardAuthorityMutationResult>;

  constructor(
    private readonly source: HostedTaskBoardAuthorityPort,
    private readonly mutationAuthority:
      | Pick<HostedTaskBoardAuthorityPort, 'admitTaskMutation'>
      | undefined,
    private readonly requests: WeakMap<QueryContext, object>,
    private readonly authentication: HostedTaskBoardReadAuthentication
  ) {
    if (typeof mutationAuthority?.admitTaskMutation === 'function') {
      this.admitTaskMutation = (request, context) => this.mutate(request, context);
    }
  }

  async readWindow(
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult> {
    const httpRequest = this.requests.get(context);
    if (httpRequest === undefined) return Object.freeze({ kind: 'unavailable' });
    try {
      if (!(await this.isAuthorized(httpRequest, request.teamId))) {
        return Object.freeze({ kind: 'unavailable' });
      }
      const result = await this.source.readWindow(request, context);
      if (!(await this.isAuthorized(httpRequest, request.teamId))) {
        return Object.freeze({ kind: 'unavailable' });
      }
      return result;
    } catch {
      return Object.freeze({ kind: 'unavailable' });
    }
  }

  private async mutate(
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityMutationResult> {
    const httpRequest = this.requests.get(context);
    const mutationAuthority = this.mutationAuthority;
    const admitTaskMutation = mutationAuthority?.admitTaskMutation;
    if (
      context.signal.aborted ||
      httpRequest === undefined ||
      mutationAuthority === undefined ||
      typeof admitTaskMutation !== 'function' ||
      !(await this.isMutationAuthorized(httpRequest, request.command.teamId))
    ) {
      return Object.freeze({ kind: 'unavailable' });
    }
    try {
      const result = await admitTaskMutation.call(mutationAuthority, request, context);
      if (context.signal.aborted) return Object.freeze({ kind: 'unavailable' });
      return (await this.isMutationAuthorized(httpRequest, request.command.teamId))
        ? result
        : Object.freeze({ kind: 'unavailable' });
    } catch {
      return Object.freeze({ kind: 'unavailable' });
    }
  }

  private async isAuthorized(request: object, teamId: TeamId): Promise<boolean> {
    return (
      (await this.authentication.isHostedQueryAuthorized(request)) &&
      (await this.authentication.isTeamWorkspaceAuthorized(request, teamId))
    );
  }

  private async isMutationAuthorized(request: object, teamId: TeamId): Promise<boolean> {
    try {
      return (await this.authentication.isHostedTaskMutationAuthorized?.(request, teamId)) === true;
    } catch {
      return false;
    }
  }
}

/**
 * Owns the single hosted task-board HTTP contribution. It deliberately exposes only `register`;
 * the standalone/lifecycle owner decides whether and where to mount that contribution later.
 */
export function createHostedTaskBoardReadComposition(
  dependencies: CreateHostedTaskBoardReadCompositionDependencies
): HostedTaskBoardReadComposition {
  const runtimeInstance = createRuntimeInstanceContext(dependencies.runtimeInstance);
  if (
    runtimeInstance.deploymentId !== dependencies.expectedDeploymentId ||
    !(dependencies.mountBinding instanceof WorkspaceMountBinding) ||
    dependencies.mountBinding.bootId !== runtimeInstance.bootId ||
    dependencies.mountBinding.health === 'unavailable'
  ) {
    throw new TypeError('hosted-task-board-read-composition-binding-invalid');
  }
  const nowMs = dependencies.nowMs ?? Date.now;
  const contexts = createAuthenticatedHostedQueryContextFactory({
    authentication: dependencies.authentication,
    runtimeInstance,
    clock: Object.freeze({ nowMs }),
  });
  const contextRequests = new WeakMap<QueryContext, object>();
  const source =
    dependencies.source ??
    new DescriptorBoundHostedTaskBoardReadSource({
      runtimeInstance,
      mountBinding: dependencies.mountBinding,
      teamIdentities: dependencies.teamIdentities,
      nowMs,
    });
  const mutationAuthorityCandidate =
    dependencies.mountBinding.health !== 'healthy' ||
    typeof dependencies.authentication.isHostedTaskMutationAuthorized !== 'function'
      ? undefined
      : (dependencies.mutationAuthority ??
        createHostedTaskBoardMutationFileAuthority({
          readSource: source,
          runtimeInstance,
          mountBinding: dependencies.mountBinding,
          teamIdentities: dependencies.teamIdentities,
          nowMs,
        }));
  const mutationAuthority =
    typeof mutationAuthorityCandidate?.admitTaskMutation === 'function'
      ? mutationAuthorityCandidate
      : undefined;
  const authority = new LiveGrantTaskBoardReadAuthority(
    source,
    mutationAuthority,
    contextRequests,
    dependencies.authentication
  );
  const feature = createHostedTeamTaskBoardFeature({
    ...createHostedTeamTaskBoardOutputAdapters(authority),
    clock: Object.freeze({ now: nowMs }),
  });
  const contribution = createHostedTeamTaskBoardRouteContribution(feature);
  let registered = false;

  return Object.freeze({
    get mutationsEnabled(): boolean {
      return registered && typeof feature.executeMutation === 'function';
    },
    register(app: FastifyInstance): void {
      if (registered) throw new Error('hosted-task-board-read-composition-already-registered');
      registerHostedTeamTaskBoardHttp(app, contribution.facade, (request, signal) => {
        const result = contexts.create(request, signal);
        if (result.kind !== 'success') {
          throw new Error(`hosted-task-board-read-query-context-${result.code}`);
        }
        contextRequests.set(result.context, request);
        return result.context;
      });
      registered = true;
    },
  });
}
