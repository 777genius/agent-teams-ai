import {
  parseDirectoryFingerprint,
  parseTeamDraftPublication,
  parseTeamIdentityChecksum,
} from '@features/internal-storage/contracts';

import type {
  HostedDraftPublicationFeature,
  HostedDraftPublicationRequest,
  HostedDraftPublicationResult,
} from '../../core/application/ports/HostedDraftPublicationFeature';
import type { HostedDraftPublicationDependencies } from '../ports/HostedDraftPublicationDependencies';

/** The host admits custody before construction and transfers its disposal to this facade. */
export function createHostedDraftPublicationFeature(
  dependencies: HostedDraftPublicationDependencies
): HostedDraftPublicationFeature {
  const publisher = dependencies.directories;
  const identities = dependencies.identities;
  const now = dependencies.now ?? (() => new Date());
  // A single serialized writer owns each reservation. Local ordering also avoids concurrent initial
  // directory creation observing the marker before it has become durable.
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  let queued = 0;
  const enqueue = <T>(effect: () => Promise<T>, unavailable: T): Promise<T> => {
    // Saturation settles this attempt without effects; the durable operation remains recoverable.
    if (closed || queued >= 16) return Promise.resolve(unavailable);
    queued += 1;
    const result = tail.then(effect).finally(() => { queued -= 1; });
    tail = result.catch(() => undefined);
    return result;
  };
  const publish = async (request: HostedDraftPublicationRequest): Promise<HostedDraftPublicationResult> => {
    try {
      if (closed) throw new Error('draft-publication-closed');
      const operation = parseTeamDraftPublication(request.publication);
      if (operation.state === 'tombstoned') return { kind: 'recovery_required' };
      await request.assertCurrent();
      const before = await identities.getTeamIdentity(operation.teamId);
      if (before?.state === 'tombstoned') return { kind: 'recovery_required' };
      return await publisher.withDirectory({
        legacyKey: operation.legacyKey, operationId: operation.operationId, teamId: operation.teamId,
        expectedFingerprint: operation.directoryFingerprint, assertCurrent: request.assertCurrent,
      }, async (lease) => {
        const directoryFingerprint = parseDirectoryFingerprint(lease.fingerprint);
        const assertCurrent = async () => {
          await request.assertCurrent();
          await lease.revalidate();
          if ((await identities.getTeamIdentity(operation.teamId))?.state === 'tombstoned') {
            throw new Error('draft-publication-tombstoned');
          }
          await request.assertCurrent();
        };
        await assertCurrent();
        await request.recordDirectory(directoryFingerprint);
        await assertCurrent();
        const reservation = {
          teamId: operation.teamId, legacyKey: operation.legacyKey, directoryFingerprint,
          workspaceBinding: { workspaceId: operation.runtimeWorkspaceId, generation: operation.bindingGeneration },
          createdAt: operation.createdAt,
        };
        const existing = await identities.getTeamIdentity(operation.teamId);
        // Later saga stages replay prepare directly. Calling reserve again would collide by design.
        if (existing === null || existing.state === 'reserved') {
          await assertCurrent();
          await identities.reserveTeamIdentity(reservation);
        }
        // Canonical v1 identity projection: fixed key order, two-space indentation, final newline.
        const identityBytes = `${JSON.stringify({
          schemaVersion: 1, teamId: operation.teamId, createdAt: operation.createdAt,
          originDeploymentId: operation.deploymentId,
        }, null, 2)}\n`;
        const identityChecksum = parseTeamIdentityChecksum(dependencies.checksumIdentity(identityBytes));
        // Compatibility projection carries no provider plan or launch capability.
        const configBytes = `${JSON.stringify({ name: operation.legacyKey, pendingCreate: true }, null, 2)}\n`;
        await assertCurrent();
        const prepared = await identities.prepareReservedTeamAdoption({
          ...reservation, intentId: operation.operationId, expectedIdentityChecksum: identityChecksum,
          preparedAt: operation.createdAt,
        });
        await assertCurrent();
        if (prepared.intent.state === 'prepared') await lease.publish(configBytes, identityBytes);
        else await lease.verify(configBytes, identityBytes);
        await assertCurrent();
        const published = await identities.recordTeamIdentityFilePublished({
          intentId: operation.operationId, teamId: operation.teamId,
          intentChecksum: prepared.intent.intentChecksum, identityChecksum, filePublishedAt: now().toISOString(),
        });
        await lease.verify(configBytes, identityBytes);
        await assertCurrent();
        await identities.commitTeamAdoption({
          intentId: operation.operationId, teamId: operation.teamId,
          intentChecksum: published.intent.intentChecksum, identityChecksum, committedAt: now().toISOString(),
        });
        await assertCurrent();
        return { kind: 'published' as const, directoryFingerprint };
      });
    } catch {
      // No filesystem cleanup, directory attachment, fresh identity, or overwrite on uncertainty.
      return { kind: 'recovery_required' };
    }
  };
  return Object.freeze({
    publishDraft: (request: HostedDraftPublicationRequest) =>
      enqueue(() => publish(request), { kind: 'recovery_required' } as HostedDraftPublicationResult),
    retireDraft: (request: Pick<HostedDraftPublicationRequest, 'publication' | 'assertCurrent'>) =>
      enqueue(async (): Promise<'retired' | 'recovery_required'> => {
        try {
          if (closed) throw new Error('draft-publication-closed');
          const operation = parseTeamDraftPublication(request.publication);
          if (operation.state !== 'tombstoned') throw new Error('draft-retirement-not-persisted');
          await request.assertCurrent();
          const identity = await identities.getTeamIdentity(operation.teamId);
          if (!identity) return 'retired';
          if (identity.legacyKey !== operation.legacyKey || identity.createdAt !== operation.createdAt ||
              identity.directoryFingerprint !== operation.directoryFingerprint ||
              identity.workspaceBinding?.workspaceId !== operation.runtimeWorkspaceId ||
              identity.workspaceBinding.generation !== operation.bindingGeneration ||
              (identity.adoptionIntentId !== null && identity.adoptionIntentId !== operation.operationId)) {
            throw new Error('draft-retirement-binding-mismatch');
          }
          await request.assertCurrent();
          await identities.tombstoneTeamIdentity({ teamId: operation.teamId, legacyKey: operation.legacyKey,
            reason: 'draft_deleted', tombstonedAt: now().toISOString() });
          await request.assertCurrent();
          return 'retired';
        } catch { return 'recovery_required'; }
      }, 'recovery_required' as const),
    dispose: async () => { closed = true; await tail; await publisher.dispose(); },
  });
}
