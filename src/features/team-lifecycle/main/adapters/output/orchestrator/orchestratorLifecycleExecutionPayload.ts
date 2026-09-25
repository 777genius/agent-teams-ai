import {
  createOrchestratorLifecycleDurableCommand,
  serializeOrchestratorLifecycleAuthority,
  serializeOrchestratorLifecycleContext,
} from '../../../application/ExecuteHostedLifecycleCommand';

import type { HostedLifecycleCommand } from '../../../../contracts/hosted-lifecycle-commands';
import type {
  HostedLifecycleCommandAuthorization,
  HostedLifecycleOwnerEffectFence,
} from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type { HostedLifecycleRunReservation } from '@features/internal-storage/contracts';
import type { QueryContext } from '@shared/contracts/hosted';

/** Execute has Product reservation proof; read-only replay has only the stable run locator. */
export function createOrchestratorLifecycleExecutionPayload(input: {
  readonly command: HostedLifecycleCommand;
  readonly authorization: HostedLifecycleCommandAuthorization;
  readonly context: QueryContext;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
  readonly reservation: HostedLifecycleRunReservation | null;
}) {
  const { command, authorization, context, ownerEffectFence, reservation } = input;
  const durableCommand = createOrchestratorLifecycleDurableCommand(
    command,
    context,
    input.restoreGeneration,
    input.mountGeneration,
    ownerEffectFence,
    reservation?.runId ?? null
  );
  const requestPayload = Object.freeze({
    command,
    authorization,
    durableCommand,
    ...(reservation === null ? {} : { runReservation: reservation }),
    context: serializeOrchestratorLifecycleContext(context),
    authority: serializeOrchestratorLifecycleAuthority(
      context,
      command.workspaceId,
      command.teamId,
      input.restoreGeneration,
      input.mountGeneration,
      authorization.resourceRevision,
      ownerEffectFence
    ),
  });
  const { runReservation: ignored, ...replayPayload } = requestPayload as typeof requestPayload & {
    runReservation?: HostedLifecycleRunReservation;
  };
  void ignored;
  return { durableCommand, requestPayload, replayPayload };
}
