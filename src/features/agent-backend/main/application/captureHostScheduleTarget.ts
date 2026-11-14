import { parseHostTeamSelectionKey } from '../../contracts';

import { assertBackendRequestGuard, BackendRoutingError } from './backendBinding';

import type { BackendOperationRequest } from '../../contracts/operations';
import type { DesktopBackendFeature } from '../composition/DesktopBackendFeature';
import type { CapturedRuntimeReadinessTarget } from '../infrastructure/CapturedLocalModelReadiness';
import type { BackendRequestGuard } from './backendBinding';
import type { CapturedTeamModelRequest } from './prepareCapturedTeamModels';
import type { HostScheduleTarget } from '@shared/types/schedule';

/** Captures only an already authorized team; schedules do not create another owner registry. */
export async function captureHostScheduleTarget(
  feature: DesktopBackendFeature,
  contextId: string,
  selection: string,
  guard: BackendRequestGuard
): Promise<HostScheduleTarget> {
  assertBackendRequestGuard(guard);
  const handleId = parseHostTeamSelectionKey(selection);
  const snapshot = await feature.discoverBindings(contextId, guard);
  assertBackendRequestGuard(guard);
  const binding = snapshot.bindings.find((row) => row.handle.handleId === handleId);
  if (snapshot.state !== 'ready' || !binding?.ownerResourceRef || !binding.teamResourceRef ||
    !feature.authorizeHandle(contextId, binding.handle))
    throw new BackendRoutingError('forbidden');
  return Object.freeze({ kind: 'host', contextId, handleId,
    ownerResourceRef: binding.ownerResourceRef, teamResourceRef: binding.teamResourceRef });
}

/** Each occurrence restores its persisted original binding independently of the foreground tab. */
export async function restoreHostScheduleTarget(
  feature: DesktopBackendFeature,
  selection: string,
  original: HostScheduleTarget | undefined,
  ownerCurrent: () => boolean
) {
  if (!original || original.kind !== 'host' || original.handleId !== parseHostTeamSelectionKey(selection) ||
    [original.contextId, original.ownerResourceRef, original.teamResourceRef].some(
      (value) => typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')))
    throw new BackendRoutingError('invalid-binding');
  const target = structuredClone(original);
  const sameBinding = () => {
    if (!ownerCurrent()) return false;
    const snapshot = feature.listBindings(target.contextId);
    return snapshot.state === 'ready' && snapshot.bindings.some((row) =>
      row.handle.handleId === target.handleId && row.ownerResourceRef === target.ownerResourceRef &&
      row.teamResourceRef === target.teamResourceRef) &&
      feature.authorizeHandle(target.contextId, { handleId: target.handleId });
  };
  await feature.discoverBindings(target.contextId, { isCurrent: ownerCurrent });
  assertBackendRequestGuard({ isCurrent: sameBinding });
  return Object.freeze({
    target,
    isCurrent: sameBinding,
    async invoke(request: Omit<BackendOperationRequest, 'handle'>, readinessTarget?: CapturedRuntimeReadinessTarget) {
      return feature.facade.invoke({ ...request, handle: { handleId: target.handleId } },
        { isCurrent: sameBinding }, undefined, readinessTarget);
    },
    prepareModels(request: CapturedTeamModelRequest) {
      assertBackendRequestGuard({ isCurrent: sameBinding });
      return feature.prepareCapturedModels({ handleId: target.handleId }, request, { isCurrent: sameBinding });
    },
  });
}

export type CapturedHostScheduleTarget = Awaited<ReturnType<typeof restoreHostScheduleTarget>>;
