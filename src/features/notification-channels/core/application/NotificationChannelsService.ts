import {
  normalizeChannelInput,
  toOutboundNotification,
  validateProviderCredential,
} from '../domain/routing';

import type {
  ChannelTestStatus,
  DeliveryChannelDto,
  DeliveryEvent,
  DeliveryFailureCode,
  DeliveryProvider,
  SaveDeliveryChannelRequest,
} from '../../contracts';
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
  send(
    channel: StoredDeliveryChannel,
    secret: string,
    message: string,
    event?: DeliveryEvent | 'test'
  ): Promise<{
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
  private activeDispatches = 0;
  private activeAutomaticSends = 0;
  // At most one status per configured destination; no disk write per event.
  private readonly automaticResults = new Map<string, ChannelTestStatus>();
  private static readonly MAX_CONCURRENT_DISPATCHES = 4;
  // One full set of configured destinations; overlapping events share this budget.
  private static readonly MAX_CONCURRENT_AUTOMATIC_SENDS = 20;

  constructor(private readonly deps: NotificationChannelsDependencies) {}

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.transaction;
    let release!: () => void;
    this.transaction = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async list(): Promise<DeliveryChannelDto[]> {
    const channels = await this.deps.repository.read();
    return Promise.all(
      channels.map(async (channel) => ({
        ...toDto(channel),
        ...(this.automaticResults.has(channel.id)
          ? { lastDelivery: this.automaticResults.get(channel.id) }
          : {}),
        // OS-keyring credentials may be unavailable after switching runtimes.
        hasCredential: Boolean(await this.readSecret(channel.credentialId)),
      }))
    );
  }

  async save(raw: SaveDeliveryChannelRequest): Promise<DeliveryChannelDto> {
    const input = normalizeChannelInput(raw);
    return this.locked(async () => {
      const existing = await this.deps.repository.read();
      const previous = input.id ? existing.find((ch) => ch.id === input.id) : undefined;
      if (input.id && !previous) throw new Error('Channel not found');
      if (previous && input.expectedEnabled !== undefined && previous.enabled !== input.expectedEnabled) {
        throw new Error('Channel enabled state changed. Refresh and try again.');
      }
      if (
        previous &&
        input.expectedEvents !== undefined &&
        (previous.events.length !== input.expectedEvents.length ||
          previous.events.some((event) => !input.expectedEvents?.includes(event)))
      ) {
        throw new Error('Channel subscriptions changed. Refresh and try again.');
      }
      if (previous && previous.provider !== input.provider && !input.secret) {
        throw new Error('A new credential is required when changing provider');
      }
      if (existing.length >= 20 && !previous) throw new Error('Maximum of 20 channels reached');
      const secret = input.secret;
      if (!previous && !secret) throw new Error('Enter a channel credential');
      if (secret) validateProviderCredential(input.provider, secret);
      // Enabling a previously configured destination requires a currently
      // readable credential. UI checks cannot protect the local HTTP/IPC APIs.
      // Disabling a destination must remain possible after OS vault loss.
      if (input.enabled && previous && !secret && !(await this.readSecret(previous.credentialId))) {
        throw new Error('Restore the channel credential before enabling');
      }
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
        lastTest:
          secret || previous?.chatId !== input.chatId || previous?.provider !== input.provider
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
      if (secret || (previous && previous.provider !== next.provider)) {
        this.automaticResults.delete(next.id);
      }
      return {
        ...toDto(next),
        // Rotation or OS backend changes can make an existing vault unreadable.
        hasCredential: Boolean(await this.readSecret(next.credentialId)),
      };
    });
  }

  async remove(id: string): Promise<void> {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
      throw new Error('Invalid channel ID');
    return this.locked(async () => {
      const current = await this.deps.repository.read();
      const channel = current.find((item) => item.id === id);
      if (!channel) throw new Error('Channel not found');
      await this.deps.repository.write(current.filter((item) => item.id !== id));
      this.automaticResults.delete(id);
      // Deletion of orphaned credentials is best effort after the route is disabled.
      await this.deps.credentials.remove(channel.credentialId).catch(() => undefined);
    });
  }

  async test(id: string): Promise<ChannelTestStatus> {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
      throw new Error('Invalid channel ID');
    return this.locked(async () => {
      const current = await this.deps.repository.read();
      const channel = current.find((item) => item.id === id);
      if (!channel) throw new Error('Channel not found');
      const secret = await this.readSecret(channel.credentialId);
      const result = secret
        ? await this.safeSend(
            channel,
            secret,
            'Agent Teams: Test notification. No agent content is included.',
            'test'
          )
        : { success: false, code: 'credentials_missing' as DeliveryFailureCode };
      const status: ChannelTestStatus = {
        at: this.deps.now(),
        success: result.success,
        ...(result.code ? { code: result.code } : {}),
      };
      await this.deps.repository.write(
        current.map((item) => (item.id === id ? { ...item, lastTest: status } : item))
      );
      return status;
    });
  }

  async dispatch(notification: DetectedError): Promise<void> {
    if (this.deps.canDeliver && !this.deps.canDeliver()) return;
    const outbound = toOutboundNotification(notification);
    if (
      !outbound ||
      this.activeDispatches >= NotificationChannelsService.MAX_CONCURRENT_DISPATCHES
    ) {
      return;
    }
    this.activeDispatches++;
    try {
      const channels = (await this.deps.repository.read()).filter(
        (channel) => channel.enabled && channel.events.includes(outbound.event)
      );
      // Overlapping dispatches share one provider-request budget. Drop excess
      // automatic sends rather than queueing stale notifications. Manual Test
      // remains independently available (serialized by the mutation lock).
      await Promise.allSettled(
        channels.map(async (channel) => {
          const secret = await this.readSecret(channel.credentialId);
          if (!secret) {
            this.automaticResults.set(channel.id, {
              at: this.deps.now(),
              success: false,
              code: 'credentials_missing',
            });
            return;
          }
          if (
            this.activeAutomaticSends >= NotificationChannelsService.MAX_CONCURRENT_AUTOMATIC_SENDS
          ) return;
          this.activeAutomaticSends++;
          try {
            const result = await this.safeSend(channel, secret, outbound.message, outbound.event);
            this.automaticResults.set(channel.id, { at: this.deps.now(), ...result });
          } finally {
            this.activeAutomaticSends--;
          }
        })
      );
    } finally {
      this.activeDispatches--;
    }
  }

  private async readSecret(id: string): Promise<string | null> {
    try {
      return await this.deps.credentials.read(id);
    } catch {
      // Decryption can be unavailable in another host runtime; do not leak errors
      // or advertise the credential as ready.
      return null;
    }
  }

  private async safeSend(
    channel: StoredDeliveryChannel,
    secret: string,
    message: string,
    event?: DeliveryEvent | 'test'
  ): Promise<{
    success: boolean;
    code?: DeliveryFailureCode;
  }> {
    try {
      return await this.deps.sender.send(channel, secret, message, event);
    } catch {
      // Never return/log a vendor exception: it can contain a credential-bearing URL.
      return { success: false, code: 'delivery_failed' };
    }
  }
}
