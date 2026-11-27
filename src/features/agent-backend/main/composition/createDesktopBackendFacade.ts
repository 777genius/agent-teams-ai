import { BackendOperationsFacade } from '../adapters/input/BackendOperationsFacade';
import {
  assertBackendRequestGuard,
  BackendRoutingError,
  ownerKey,
} from '../application/backendBinding';
import { requestWithLocalModelReadiness } from '../infrastructure/CapturedLocalModelReadiness';
import { CapturedRosterCommands } from '../infrastructure/CapturedRosterCommands';

import { recoverCapturedHost } from './recoverCapturedHost';

import type { BackendHandle } from '../../contracts';
import type { BackendRequestGuard } from '../application/backendBinding';
import type { BackendOwnerRouter } from '../application/BackendOwnerRouter';
import type { DesktopBackendCompositionContext } from './DesktopBackendCompositionContext';

/** Compose the original request and recovery routes over live captured feature state. */
export function createDesktopBackendFacade(
  context: DesktopBackendCompositionContext
): BackendOperationsFacade {
  const target = async (
    handle: BackendHandle,
    guard?: BackendRequestGuard
  ): Promise<BackendOwnerRouter> => {
    await context.initialize();
    if (context.sealed) throw new BackendRoutingError('shutting-down');
    assertBackendRequestGuard(guard);
    const definition = context.definitions().find((entry) => entry.handleId === handle.handleId);
    if (context.state !== 'ready' || !definition || !context.router)
      throw new BackendRoutingError('unavailable');
    // This is the captured client instance, not a recovery/replacement factory.
    await context.router.startOwner(definition.owner);
    if (context.sealed) throw new BackendRoutingError('shutting-down');
    assertBackendRequestGuard(guard);
    return context.router;
  };
  const rosterCommands = context.options.commandRunner
    ? new CapturedRosterCommands(context.options.commandRunner)
    : undefined;
  return new BackendOperationsFacade(
    {
      request: (handle, command) => {
        const definition = context.definitions().find((row) => row.handleId === handle.handleId);
        return requestWithLocalModelReadiness(
          () => target(handle, command.guard),
          handle,
          command,
          definition,
          {
            requestTimeoutMs: definition
              ? context.clients.get(ownerKey(definition.owner))?.client.profile.requestTimeoutMs
              : undefined,
            intents: context.options.modelIntents,
            rosterCommands,
          }
        );
      },
      requestPair: async (source, destination, command) => {
        const router = await target(source, command.guard);
        const original = context.definitions().find((entry) => entry.handleId === source.handleId);
        if (!original || !context.authorizeHandle(original.contextId, destination))
          throw new BackendRoutingError('forbidden');
        return router.requestPair(source, destination, command);
      },
      lookup: async (handle, commandId, method, guard) =>
        (await target(handle, guard)).lookup(handle, commandId, method, guard),
    },
    rosterCommands,
    (request, guard) =>
      recoverCapturedHost(request, guard, {
        selection: context.options.descriptor,
        descriptor: () => context.descriptor,
        router: () => context.router,
        definitions: () => context.definitions(),
        clients: context.clients,
        isCurrent: () => !context.sealed && context.state === 'ready',
        clientOptions: context.hostClientOptions,
      })
  );
}
