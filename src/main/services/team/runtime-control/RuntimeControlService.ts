import { RuntimeControlProviderRegistry } from './application/RuntimeControlProviderRegistry';

import type { RuntimeControlAck } from './domain/RuntimeControlAck';
import type {
  RuntimeBootstrapCheckinCommand,
  RuntimeDeliverMessageCommand,
  RuntimeHeartbeatCommand,
  RuntimePermissionAnswerCommand,
  RuntimeTaskEventCommand,
} from './domain/RuntimeControlCommand';
import type {
  RuntimeControlProviderHandler,
  RuntimeControlProviderId,
} from './domain/RuntimeControlProvider';

export class RuntimeControlService {
  private readonly providers: RuntimeControlProviderRegistry;

  constructor(providers: readonly RuntimeControlProviderHandler[] = []) {
    this.providers = new RuntimeControlProviderRegistry(providers);
  }

  registerProvider(handler: RuntimeControlProviderHandler): void {
    this.providers.register(handler);
  }

  hasProvider(providerId: RuntimeControlProviderId): boolean {
    return this.providers.has(providerId);
  }

  providerIds(): RuntimeControlProviderId[] {
    return this.providers.providers();
  }

  recordBootstrapCheckin(command: RuntimeBootstrapCheckinCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'recordBootstrapCheckin');
    return handler.recordBootstrapCheckin!(command);
  }

  deliverMessage(command: RuntimeDeliverMessageCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'deliverMessage');
    return handler.deliverMessage!(command);
  }

  recordTaskEvent(command: RuntimeTaskEventCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'recordTaskEvent');
    return handler.recordTaskEvent!(command);
  }

  recordHeartbeat(command: RuntimeHeartbeatCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'recordHeartbeat');
    return handler.recordHeartbeat!(command);
  }

  answerPermission(command: RuntimePermissionAnswerCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'answerPermission');
    return handler.answerPermission!(command);
  }
}
