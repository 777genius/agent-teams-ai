import { AsyncLocalStorage } from 'node:async_hooks';

import { RuntimeControlProviderRegistry } from './application/RuntimeControlProviderRegistry';
import {
  assertRuntimeControlAckMatchesCommand,
  createRuntimeControlEventFromAck,
} from './domain/RuntimeControlEventFactory';

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
  deliveryWriteFence?: RuntimeDeliveryWriteFence;
}

export interface RuntimeDeliveryWriteFence {
  runExclusive<T>(key: string, action: () => Promise<T>): Promise<T>;
}

interface RuntimeDeliveryWriteFenceOwnership {
  readonly key: string;
  readonly parent?: RuntimeDeliveryWriteFenceOwnership;
  active: boolean;
}

/** Serializes provider delivery commits while allowing unrelated identities to proceed. */
export class KeyedRuntimeDeliveryWriteFence implements RuntimeDeliveryWriteFence {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly ownership = new AsyncLocalStorage<RuntimeDeliveryWriteFenceOwnership>();

  async runExclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.currentCallOwns(key)) {
      throw new Error(`Runtime delivery write fence is not reentrant for key: ${key}`);
    }

    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous;
    const owner: RuntimeDeliveryWriteFenceOwnership = {
      key,
      parent: this.ownership.getStore(),
      active: true,
    };
    try {
      return await this.ownership.run(owner, action);
    } finally {
      owner.active = false;
      release();
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }

  private currentCallOwns(key: string): boolean {
    let owner = this.ownership.getStore();
    while (owner) {
      if (owner.active && owner.key === key) {
        return true;
      }
      owner = owner.parent;
    }
    return false;
  }
}

function isRuntimeControlProviderList(
  value: readonly RuntimeControlProviderHandler[] | RuntimeControlServiceOptions
): value is readonly RuntimeControlProviderHandler[] {
  return Array.isArray(value);
}

export class RuntimeControlService {
  private readonly providers: RuntimeControlProviderRegistry;
  private readonly eventSink?: RuntimeControlEventSink;
  private readonly deliveryWriteFence: RuntimeDeliveryWriteFence;

  constructor(
    providersOrOptions: readonly RuntimeControlProviderHandler[] | RuntimeControlServiceOptions = []
  ) {
    const options: RuntimeControlServiceOptions = isRuntimeControlProviderList(providersOrOptions)
      ? { providers: providersOrOptions }
      : providersOrOptions;
    this.providers = new RuntimeControlProviderRegistry(options.providers ?? []);
    this.eventSink = options.eventSink;
    this.deliveryWriteFence = options.deliveryWriteFence ?? new KeyedRuntimeDeliveryWriteFence();
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
    return this.withRecordedEvent(command, () => {
      const handler = this.providers.requireOperation(command.providerId, 'recordBootstrapCheckin');
      return handler.recordBootstrapCheckin!(command);
    });
  }

  deliverMessage(command: RuntimeDeliverMessageCommand): Promise<RuntimeControlAck> {
    return this.withRecordedEvent(command, () => {
      const handler = this.providers.requireOperation(command.providerId, 'deliverMessage');
      return this.deliveryWriteFence.runExclusive(buildLaneWriteFenceKey(command), () =>
        handler.deliverMessage!(command)
      );
    });
  }

  recordTaskEvent(command: RuntimeTaskEventCommand): Promise<RuntimeControlAck> {
    return this.withRecordedEvent(command, () => {
      const handler = this.providers.requireOperation(command.providerId, 'recordTaskEvent');
      return handler.recordTaskEvent!(command);
    });
  }

  recordHeartbeat(command: RuntimeHeartbeatCommand): Promise<RuntimeControlAck> {
    return this.withRecordedEvent(command, () => {
      const handler = this.providers.requireOperation(command.providerId, 'recordHeartbeat');
      return handler.recordHeartbeat!(command);
    });
  }

  answerPermission(command: RuntimePermissionAnswerCommand): Promise<RuntimeControlAck> {
    return this.withRecordedEvent(command, () => {
      const handler = this.providers.requireOperation(command.providerId, 'answerPermission');
      return this.deliveryWriteFence.runExclusive(buildLaneWriteFenceKey(command), () =>
        handler.answerPermission!(command)
      );
    });
  }

  private async withRecordedEvent(
    command: RuntimeControlCommand,
    action: () => Promise<RuntimeControlAck>
  ): Promise<RuntimeControlAck> {
    const ack = await action();
    assertRuntimeControlAckMatchesCommand(command, ack);
    if (this.eventSink) {
      await this.eventSink.record(createRuntimeControlEventFromAck(command, ack));
    }
    return ack;
  }
}

function buildLaneWriteFenceKey(
  command: RuntimeDeliverMessageCommand | RuntimePermissionAnswerCommand
): string {
  return JSON.stringify([
    command.kind,
    command.providerId,
    command.teamName,
    command.laneId,
    command.runId,
  ]);
}
