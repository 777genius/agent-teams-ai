import { parseHostedLifecycleRunReservation } from '@features/internal-storage/contracts';
import { type QueryContext, type WorkspaceId } from '@shared/contracts/hosted';

import { type OrchestratorLifecycleOwnerBinding } from '../../../application/ExecuteHostedLifecycleCommand';

import { isOrchestratorLifecycleGrantFenceCurrent } from './orchestratorLifecycleWireExchange';

import type { HostedLifecycleLaunchCommand } from '../../../../contracts/hosted-lifecycle-commands';
import type { HostedLifecycleOwnerEffectFence } from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type { OrchestratorLifecycleGrantFence } from './orchestratorLifecycleWireExchange';
import type {
  HostedLifecycleRunReservation,
  HostedLifecycleRunReservationGateway,
} from '@features/internal-storage/contracts';

/** Product commits a run before the first Owner replay/execute exchange. */
export async function reserveHostedLifecycleLaunchRun(input: {
  readonly command: HostedLifecycleLaunchCommand;
  readonly context: QueryContext;
  readonly grantFence: OrchestratorLifecycleGrantFence;
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
  readonly ownerBinding: OrchestratorLifecycleOwnerBinding;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly reservations: HostedLifecycleRunReservationGateway;
  authorizationIsCurrent(): boolean;
}): Promise<HostedLifecycleRunReservation | null> {
  const { command, context, grantFence, ownerEffectFence, ownerBinding } = input;
  if (
    !grantFence.publicWorkspaceId ||
    !grantFence.runtimeWorkspaceId ||
    !grantFence.authorityEvidence ||
    command.workspaceId !== grantFence.runtimeWorkspaceId
  )
    return null;
  try {
    const scope = {
      workspaceId: grantFence.publicWorkspaceId as WorkspaceId,
      teamId: command.teamId,
      actorId: context.actorId,
      deploymentId: context.deploymentId,
    };
    const generation = await input.reservations.currentPlanGeneration(scope);
    if (
      generation === null ||
      !input.authorizationIsCurrent() ||
      !(await isOrchestratorLifecycleGrantFenceCurrent(grantFence, ownerEffectFence))
    )
      return null;
    const reserved = await input.reservations.reserve(
      {
        schemaVersion: 1,
        ...scope,
        runtimeWorkspaceId: command.workspaceId,
        bootId: context.bootId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        expectedRevision: command.expectedRevision,
        expectedPlanGeneration: generation,
        ownerAuthority: ownerBinding.ownerAuthority,
        ownerGeneration: ownerBinding.ownerGeneration,
        ownerSessionId: ownerBinding.ownerSessionId,
        restoreGeneration: input.restoreGeneration,
        mountGeneration: input.mountGeneration,
        ownerEffectFence,
        authorityEvidence: grantFence.authorityEvidence,
        deadlineAtMs: context.deadlineAtMs,
      },
      { signal: context.signal }
    );
    if (reserved.kind !== 'reserved' && reserved.kind !== 'idempotent_replay') return null;
    const reservation = parseHostedLifecycleRunReservation(reserved.reservation);
    if (
      reservation.commandId !== command.commandId ||
      reservation.idempotencyKey !== command.idempotencyKey ||
      reservation.expectedRevision !== command.expectedRevision ||
      reservation.expectedPlanGeneration !== generation ||
      reservation.ownerAuthority !== ownerBinding.ownerAuthority ||
      reservation.ownerGeneration !== ownerBinding.ownerGeneration ||
      reservation.ownerSessionId !== ownerBinding.ownerSessionId ||
      reservation.workspaceId !== scope.workspaceId ||
      reservation.runtimeWorkspaceId !== command.workspaceId ||
      reservation.teamId !== command.teamId ||
      reservation.actorId !== context.actorId ||
      reservation.deploymentId !== context.deploymentId ||
      reservation.bootId !== context.bootId ||
      reservation.restoreGeneration !== input.restoreGeneration ||
      reservation.mountGeneration !== input.mountGeneration ||
      reservation.ownerEffectFence.grantRevision !== ownerEffectFence.grantRevision ||
      reservation.ownerEffectFence.identityChecksum !== ownerEffectFence.identityChecksum ||
      reservation.authorityEvidence.userId !== grantFence.authorityEvidence.userId ||
      reservation.authorityEvidence.sessionId !== grantFence.authorityEvidence.sessionId ||
      reservation.authorityEvidence.grantGeneration !== grantFence.authorityEvidence.grantGeneration
    )
      return null;
    return reservation;
  } catch {
    return null;
  }
}
