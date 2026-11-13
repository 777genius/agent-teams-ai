import { createHash } from 'node:crypto';

import { BackendRoutingError, ownerKey } from '../application/backendBinding';

import type { DesktopBackendDescriptor } from './loadDesktopBackendDescriptor';
import type { RuntimeSourceGrant } from '@agent-teams/legacy-agent-host/runtime-sources';

/** One original private descriptor binding; no renderer payload or current source pointer contributes. */
export function capturedRuntimeSourceGrant(
  descriptor: DesktopBackendDescriptor,
  selected: NonNullable<DesktopBackendDescriptor['management']>[number]
): RuntimeSourceGrant {
  const owner = descriptor.owners.find(entry => ownerKey(entry) === ownerKey(selected.owner));
  if (!owner) throw new BackendRoutingError('hold');
  const teamScopes = [...new Map(descriptor.handles.filter(entry =>
    entry.contextId === selected.contextId && ownerKey(entry.owner) === ownerKey(selected.owner))
    .map(({ scope }) => [JSON.stringify([scope.teamId, scope.projectId, scope.workspaceId]), {
      teamId: scope.teamId, projectId: scope.projectId, workspaceId: scope.workspaceId,
    }] as const)).values()];
  return {
    targetId: createHash('sha256').update(JSON.stringify({ selected, owner })).digest('hex'),
    ownerId: selected.owner.ownerId, ownerRevision: selected.owner.revision,
    contextId: selected.contextId, projectPath: selected.projectPath, runtimeId: selected.runtimeId,
    profileId: selected.profileId, configRevision: selected.configRevision, teamScopes,
  };
}
