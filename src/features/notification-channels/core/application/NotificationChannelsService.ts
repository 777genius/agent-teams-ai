import type {
  ChannelTestStatus,
  DeliveryChannelDto,
  DeliveryEvent,
  DeliveryFailureCode,
  DeliveryProvider,
  SaveDeliveryChannelRequest,
} from '../../contracts';
import {
  normalizeChannelInput,
  toOutboundNotification,
  validateProviderCredential,
} from '../domain/routing';

import type { DetectedError } from '@shared/types/notifications';

export interface StoredDeliveryChannel {
  id: string;
  name: string;
  provider: DeliveryProvider;
  enabled: boolean;
  events: DeliveryEvent[];
  chatId?: string;
  credentialId: string;
  lastTest?: ChannelTestStatus;
}

export interface DeliveryChannelsRepository {
  read(): Promise<StoredDeliveryChannel[]>;
  write(channels: readonly StoredDeliveryChannel[]): Promise<void>;
}

export interface DeliveryCredentials {
  create(name: string, secret: string): Promise<string>;
  read(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
}

export interface DeliverySender {
  send(channel: StoredDeliveryChannel, secret: string, message: string): Promise<{
    success: boolean;
    code?: DeliveryFailureCode;
  }>;
}

export interface NotificationChannelsDependencies {
  repository: DeliveryChannelsRepository;
  credentials: DeliveryCredentials;
  sender: DeliverySender;
  newId(): string;
  now(): string;
  canDeliver?(): boolean;
}

function toDto(channel: StoredDeliveryChannel): DeliveryChannelDto {
  return {
    id: channel.id,
    name: channel.name,
    provider: channel.provider,
    enabled: channel.enabled,
    events: [...channel.events],
    chatId: channel.chatId,
    hasCredential: true,
    lastTest: channel.lastTest,
  };
}

/** Application use cases only; no Electron, HTTP, filesystem or React dependencies. */
export class NotificationChannelsService {
  private transaction: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NotificationChannelsDependencies) {}

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.transaction;
    let release!: () => void;
    this.transaction = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async list(): Promise<DeliveryChannelDto[]> {
    return (await this.deps.repository.read()).map(toDto);
  }

  async save(raw: SaveDeliveryChannelRequest): Promise<DeliveryChannelDto> {
    const input = normalizeChannelInput(raw);
    return this.locked(async () => {
      const existing = await this.deps.repository.read();
      const previous = input.id ? existing.find((ch) => ch.id === input.id) : undefined;
      if (input.id && !previous) throw new Error('Channel not found');
      if (previous && previous.provider !== input.provider && !input.secret) {
        throw new Error('A new credential is required when changing provider');
      }
      if (existing.length >= 20 && !previous) throw new Error('Maximum of 20 channels reached');
      const secret = input.secret;
      if (!previous && !secret) throw new Error('Enter a channel credential');
      if (secret) validateProviderCredential(input.provider, secret);
      let credentialId = previous?.credentialId;
      if (secret) {
        credentialId = await this.deps.credentials.create(input.name, secret);
      }
      if (!credentialId) throw new Error('Channel credential is missing');
      const next: StoredDeliveryChannel = {
        id: previous?.id ?? this.deps.newId(),
        name: input.name,
        provider: input.provider,
        enabled: input.enabled,
        events: input.events,
        chatId: input.chatId,
        credentialId,
        lastTest: secret || previous?.chatId !== input.chatId || previous?.provider !== input.provider
          ? undefined
          : previous?.lastTest,
      };
      try {
        await this.deps.repository.write([
          ...existing.filter((channel) => channel.id !== next.id),
          next,
        ]);
      } catch (error) {
        if (secret) await this.deps.credentials.remove(credentialId).catch(() => undefined);
        throw error;
      }
      if (previous && secret) {
        await this.deps.credentials.remove(previous.credentialId).catch(() => undefined);
      }
      return toDto(next);
    });
  }

  async remove(id: string): Promise<void> {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid channel ID');
    return this.locked(async () => {
      const current = await this.deps.repository.read();
      const channel = current.find((item) => item.id === id);
      if (!channel) throw new Error('Channel not found');
      await this.deps.repository.write(current.filter((item) => item.id !== id));
      // Deletion of orphaned credentials is best effort after the route is disabled.
      await this.deps.credentials.remove(channel.credentialId).catch(() => undefined);
    });
  }

  async test(id: string): Promise<ChannelTestStatus> {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid channel ID');
    return this.locked(async () => {
      const current = await this.deps.repository.read();
      const channel = current.find((item) => item.id === id);
      if (!channel) throw new Error('Channel not found');
      const secret = await this.deps.credentials.read(channel.credentialId);
      const result = secret
        ? await this.safeSend(channel, secret, 'Agent Teams: Test notification. No agent content is included.')
        : { success: false, code: 'credentials_missing' as DeliveryFailureCode };
      const status: ChannelTestStatus = {
        at: this.deps.now(),
        success: result.success,
        ...(result.code ? { code: result.code } : {}),
      };
      await this.deps.repository.write(current.map((item) =>
        item.id === id ? { ...item, lastTest: status } : item
      ));
      return status;
    });
  }

  async dispatch(notification: DetectedError): Promise<void> {
    if (this.deps.canDeliver && !this.deps.canDeliver()) return;
    const outbound = toOutboundNotification(notification);
    if (!outbound) return;
    const channels = (await this.deps.repository.read()).filter((channel) =>
      channel.enabled && channel.events.includes(outbound.event)
    );
    // No backlog, no retry: avoid duplicate third-party messages after a restart.
    await Promise.allSettled(channels.map(async (channel) => {
      const secret = await this.deps.credentials.read(channel.credentialId);
      if (!secret) return;
      await this.safeSend(channel, secret, outbound.message);
    }));
  }

  private async safeSend(channel: StoredDeliveryChannel, secret: string, message: string): Promise<{
    success: boolean;
    code?: DeliveryFailureCode;
  }> {
    try {
      return await this.deps.sender.send(channel, secret, message);
    } catch {
      // Never return/log a vendor exception: it can contain a credential-bearing URL.
      return { success: false, code: 'delivery_failed' };
    }
  }
}
