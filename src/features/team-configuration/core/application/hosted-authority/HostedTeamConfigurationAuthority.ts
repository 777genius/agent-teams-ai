import {
  type AppErrorCode,
  createSafeAppError,
  type QueryContext,
  type Revision,
} from '@shared/contracts/hosted';

import { canonicalHostedTeamConfigurationCreate } from './canonicalHostedTeamConfigurationCreate';

import type {
  HostedTeamConfigurationIdentity,
  HostedUpdateDraftTeamRequest,
} from '../../../contracts/hosted';
import type { HostedDraftPublicationLookup } from '../../../contracts/hostedDraftPublication';
import type {
  HostedTeamConfigurationAuthorityCreateRequest,
  HostedTeamConfigurationAuthorityDependencies,
} from './HostedTeamConfigurationAuthorityPorts';

function error(code: AppErrorCode, reason: string) {
  return Object.freeze({
    kind: 'error' as const,
    error: createSafeAppError({ code, reason }),
  });
}

export class HostedTeamConfigurationAuthority {
  constructor(private readonly dependencies: HostedTeamConfigurationAuthorityDependencies) {}

  async createDraft(request: HostedTeamConfigurationAuthorityCreateRequest) {
    const rejected = this.admit(request.context);
    if (rejected) return rejected;
    try {
      const captured = await this.dependencies.publication?.capture(request.workspaceId, request.context);
      const publicationBinding = captured?.binding;
      const result = await this.dependencies.storage.create(
        {
          ...(publicationBinding ? { publicationBinding } : {}),
          workspaceId: request.workspaceId,
          idempotencyKey: request.idempotencyKey,
          payloadHash: await this.dependencies.sha256Hex(
            canonicalHostedTeamConfigurationCreate(request)
          ),
          metadata: { name: request.name },
          members: request.members,
          ...(Object.hasOwn(request, 'configuration') ? { configuration: request.configuration } : {}),
          deadlineAtMs: request.context.deadlineAtMs,
        },
        request.context.signal
      );
      if (result.kind === 'conflict') return error('conflict', 'team_configuration_idempotency_conflict');
      // The durable draft commits first. Never race an unfinished publication with the response.
      const publication = await this.dependencies.publication?.settle(
        { workspaceId: request.workspaceId, teamId: result.teamId }, request.context, captured);
      return { ...result, ...(publication ? { publication } : {}) };
    } catch {
      return this.unavailable();
    }
  }

  async getSavedRequest(identity: HostedTeamConfigurationIdentity, context: QueryContext) {
    const rejected = this.admit(context);
    if (rejected) return rejected;
    try {
      const result = await this.dependencies.storage.read(identity);
      if (this.admit(context)) return this.unavailable();
      return result.kind === 'found'
        ? Object.freeze({ kind: 'found' as const, draft: result.draft })
        : error('not_found', 'team_configuration_not_found');
    } catch {
      return this.unavailable();
    }
  }

  async updateDraft(
    identity: HostedTeamConfigurationIdentity,
    expectedRevision: Revision,
    updates: HostedUpdateDraftTeamRequest['updates'],
    context: QueryContext
  ) {
    const rejected = this.admit(context);
    if (rejected) return rejected;
    try {
      const result = await this.dependencies.storage.update(
        {
          ...identity,
          expectedRevision,
          updates,
          deadlineAtMs: context.deadlineAtMs,
        },
        context.signal
      );
      if (result.kind === 'updated') return result;
      return result.kind === 'not_found'
        ? error('not_found', 'team_configuration_not_found')
        : error('conflict', result.reason === 'promotion_frozen'
          ? 'team_configuration_promotion_frozen' : 'team_configuration_revision_conflict');
    } catch {
      return this.unavailable();
    }
  }

  async deleteDraft(
    identity: HostedTeamConfigurationIdentity,
    expectedRevision: Revision,
    context: QueryContext
  ) {
    const rejected = this.admit(context);
    if (rejected) return rejected;
    try {
      const captured = await this.dependencies.publication?.capture(identity.workspaceId, context);
      const result = await this.dependencies.storage.delete(
        { ...identity, expectedRevision, deadlineAtMs: context.deadlineAtMs,
          ...(captured ? { publicationBinding: captured.binding } : {}) },
        context.signal
      );
      if (result.kind === 'conflict') return error('conflict', result.reason === 'promotion_frozen'
          ? 'team_configuration_promotion_frozen' : 'team_configuration_revision_conflict');
      const publication = await this.dependencies.publication?.settle(identity, context, captured);
      if (publication && publication.state !== 'tombstoned') return this.unavailable();
      return result;
    } catch {
      return this.unavailable();
    }
  }

  async publicationStatus(request: HostedDraftPublicationLookup, context: QueryContext, recover: boolean) {
    const rejected = this.admit(context);
    if (rejected) return rejected;
    try {
      if (!this.dependencies.publication) return this.unavailable();
      const result = await this.dependencies.publication.lookup(request, context, recover);
      return result ? { kind: 'publication' as const, ...result } : error('not_found', 'team_configuration_not_found');
    } catch { return this.unavailable(); }
  }

  private admit(context: QueryContext): ReturnType<typeof error> | null {
    if (context.signal.aborted) return error('cancelled', 'team_configuration_cancelled');
    if (
      !Number.isSafeInteger(context.deadlineAtMs) ||
      this.dependencies.now() >= context.deadlineAtMs
    ) {
      return this.unavailable();
    }
    return null;
  }

  private unavailable(): ReturnType<typeof error> {
    return error('unavailable', 'team_configuration_unavailable');
  }
}
