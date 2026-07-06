import { RuntimeControlProviderRegistry } from './application/RuntimeControlProviderRegistry';
import { createRuntimeControlEventFromAck } from './domain/RuntimeControlEventFactory';

import type { RuntimeControlEventSink } from './application/RuntimeControlPorts';
import type { RuntimeControlAck } from './domain/RuntimeControlAck';
import type {
  RuntimeBootstrapCheckinCommand,
  RuntimeControlCommand,
  RuntimeDeliverMessageCommand,
  RuntimeHeartbeatCommand,
  RuntimePermissionAnswerCommand,
  RuntimeTaskEventCommand,
} from './domain/RuntimeControlCommand';
import type {
  RuntimeControlProviderHandler,
  RuntimeControlProviderId,
} from './domain/RuntimeControlProvider';

export interface RuntimeControlServiceOptions {
  providers?: readonly RuntimeControlProviderHandler[];
  eventSink?: RuntimeControlEventSink;
}

export class RuntimeControlService {
  private readonly providers: RuntimeControlProviderRegistry;
  private readonly eventSink?: RuntimeControlEventSink;

  constructor(
    providersOrOptions: readonly RuntimeControlProviderHandler[] | RuntimeControlServiceOptions = []
  ) {
    const options = Array.isArray(providersOrOptions)
      ? { providers: providersOrOptions }
      : providersOrOptions;
    this.providers = new RuntimeControlProviderRegistry(options.providers ?? []);
    this.eventSink = options.eventSink;
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
    return this.withRecordedEvent(command, () => handler.recordBootstrapCheckin!(command));
  }

  deliverMessage(command: RuntimeDeliverMessageCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'deliverMessage');
    return this.withRecordedEvent(command, () => handler.deliverMessage!(command));
  }

  recordTaskEvent(command: RuntimeTaskEventCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'recordTaskEvent');
    return this.withRecordedEvent(command, () => handler.recordTaskEvent!(command));
  }

  recordHeartbeat(command: RuntimeHeartbeatCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'recordHeartbeat');
    return this.withRecordedEvent(command, () => handler.recordHeartbeat!(command));
  }

  answerPermission(command: RuntimePermissionAnswerCommand): Promise<RuntimeControlAck> {
    const handler = this.providers.requireOperation(command.providerId, 'answerPermission');
    return this.withRecordedEvent(command, () => handler.answerPermission!(command));
  }

  private async withRecordedEvent(
    command: RuntimeControlCommand,
    action: () => Promise<RuntimeControlAck>
  ): Promise<RuntimeControlAck> {
    const ack = await action();
    if (this.eventSink) {
      await this.eventSink.record(createRuntimeControlEventFromAck(command, ack));
    }
    return ack;
  }
}
