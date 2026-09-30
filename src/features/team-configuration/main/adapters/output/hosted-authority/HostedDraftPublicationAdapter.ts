import type { HostedTeamConfigurationIdentity } from '../../../../contracts/hosted';
import type { HostedDraftPublicationLookup, HostedDraftPublicationStatus } from '../../../../contracts/hostedDraftPublication';
import type {
  HostedDraftPublicationCapture,
  HostedDraftPublicationPort,
} from '../../../../core/application/hosted-authority/HostedDraftPublicationPort';
import type { HostedDraftPublicationDependencies } from '../../../ports/HostedDraftPublicationDependencies';
import type { TeamDraftPublication } from '@features/internal-storage/contracts';
import type { QueryContext, WorkspaceId } from '@shared/contracts/hosted';

/** Drives an explicit cross-database saga; no return value pretends the commits were atomic. */
export class HostedDraftPublicationAdapter implements HostedDraftPublicationPort {
  constructor(private readonly dependencies: HostedDraftPublicationDependencies) {}

  async capture(workspaceId: WorkspaceId, context: QueryContext): Promise<HostedDraftPublicationCapture> {
    const fence = await this.dependencies.captureWorkspace(workspaceId, context);
    await fence.assertCurrent();
    return Object.freeze({ workspaceId, context,
      binding: Object.freeze({ actorId: context.actorId, deploymentId: context.deploymentId,
        runtimeWorkspaceId: fence.runtimeWorkspaceId, bindingGeneration: fence.bindingGeneration }),
      assertCurrent: () => fence.assertCurrent(),
    });
  }

  async settle(identity: HostedTeamConfigurationIdentity, context: QueryContext, captured?: HostedDraftPublicationCapture): Promise<HostedDraftPublicationStatus | null> {
    const scope = { ...identity, actorId: context.actorId, deploymentId: context.deploymentId };
    const operation = await this.dependencies.journal.readTeamDraftPublication(scope);
    // Released pre-publication create keys retain their replay; there is no opportunistic import.
    if (!operation) return null;
    // Create/delete carry the original pre-storage fence. Only a new request captures afresh.
    const admission = captured ?? await this.capture(identity.workspaceId, context);
    if (admission.workspaceId !== identity.workspaceId || admission.context !== context ||
        admission.binding.actorId !== context.actorId || admission.binding.deploymentId !== context.deploymentId) {
      throw new Error('draft-publication-request-binding-mismatch');
    }
    const fence = admission.binding;
    const assertCurrent = async () => {
      if (context.signal.aborted || (this.dependencies.now ?? Date.now)() >= context.deadlineAtMs) {
        throw new Error('draft-publication-request-expired');
      }
      await admission.assertCurrent();
      const current = await this.dependencies.journal.readTeamDraftPublication(scope);
      if (!current || current.operationId !== operation.operationId ||
          current.runtimeWorkspaceId !== fence.runtimeWorkspaceId ||
          current.bindingGeneration !== fence.bindingGeneration ||
          (operation.state !== 'tombstoned' && current.state === 'tombstoned')) {
        throw new Error('draft-publication-authority-changed');
      }
      await admission.assertCurrent();
    };
    await assertCurrent();
    if (operation.state === 'tombstoned') {
      if (await this.dependencies.publisher.retireDraft({ publication: operation, assertCurrent }) !== 'retired') {
        throw new Error('draft-retirement-recovery-required');
      }
      return status(operation);
    }
    const result = await this.dependencies.publisher.publishDraft({ publication: operation, assertCurrent,
      recordDirectory: async (directoryFingerprint) => {
        await assertCurrent();
        const current = await this.dependencies.journal.readTeamDraftPublication(scope);
        if (!current || current.operationId !== operation.operationId || current.state === 'tombstoned') {
          throw new Error('draft-publication-authority-changed');
        }
        await this.dependencies.journal.settleTeamDraftPublication({ ...scope,
          operationId: operation.operationId, directoryFingerprint, state: current.state,
          deadlineAtMs: context.deadlineAtMs });
      },
    });
    // Settlement is bookkeeping for an admitted attempt, including cancellation/lost HTTP response.
    // It starts no new publication effect and retains the immutable scope/operation/fingerprint.
    const current = await this.dependencies.journal.readTeamDraftPublication(scope);
    if (!current || current.state === 'tombstoned') throw new Error('draft-publication-retired-during-attempt');
    const settled = await this.dependencies.journal.settleTeamDraftPublication({ ...scope,
      operationId: operation.operationId,
      directoryFingerprint: result.kind === 'published' ? result.directoryFingerprint : current.directoryFingerprint,
      state: result.kind === 'published' ? 'published' : current.state === 'published' ? 'published' : 'recovery_required',
      deadlineAtMs: (this.dependencies.now ?? Date.now)() + 5_000 });
    // A failed revalidation of a previously published identity is never advertised as available.
    if (result.kind !== 'published' && settled.state === 'published') throw new Error('draft-publication-revalidation-failed');
    return status(settled);
  }

  async lookup(request: HostedDraftPublicationLookup, context: QueryContext, recover: boolean) {
    const operation = await this.dependencies.journal.lookupTeamDraftPublication({ ...request,
      actorId: context.actorId, deploymentId: context.deploymentId });
    if (!operation) return null;
    const captured = await this.capture(request.workspaceId, context);
    const fence = captured.binding;
    if (operation.runtimeWorkspaceId !== fence.runtimeWorkspaceId ||
        operation.bindingGeneration !== fence.bindingGeneration) return null;
    const publication = recover
      ? await this.settle({ workspaceId: request.workspaceId, teamId: operation.teamId }, context, captured)
      : status(operation);
    await captured.assertCurrent();
    return publication ? { teamId: operation.teamId, publication } : null;
  }
}

function status(operation: TeamDraftPublication): HostedDraftPublicationStatus {
  return { operationId: operation.operationId, state: operation.state };
}
