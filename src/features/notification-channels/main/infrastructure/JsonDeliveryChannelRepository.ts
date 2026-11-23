import fs from 'node:fs/promises';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { isDeliveryEvent } from '../../core/domain/routing';

import type {
  DeliveryChannelsRepository,
  StoredDeliveryChannel,
} from '../../core/application/NotificationChannelsService';

export class JsonDeliveryChannelRepository implements DeliveryChannelsRepository {
  constructor(private readonly path: string) {}

  async read(): Promise<StoredDeliveryChannel[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid channel settings file');
    const data = parsed as { schemaVersion?: unknown; channels?: unknown };
    if (data.schemaVersion !== 1 || !Array.isArray(data.channels)) {
      throw new Error('Unsupported channel settings version');
    }
    // Reject corruption instead of silently overwriting settings or credentials.
    if (data.channels.some((item: unknown) => {
      if (!item || typeof item !== 'object') return true;
      const channel = item as Partial<StoredDeliveryChannel>;
      return typeof channel.id !== 'string' ||
        typeof channel.credentialId !== 'string' ||
        typeof channel.name !== 'string' ||
        !['telegram', 'discord', 'slack', 'ms-teams', 'google-chat'].includes(String(channel.provider)) ||
        typeof channel.enabled !== 'boolean' ||
        !Array.isArray(channel.events) ||
        channel.events.some((event) => !isDeliveryEvent(event)) ||
        (channel.chatId !== undefined && typeof channel.chatId !== 'string');
    })) throw new Error('Invalid channel settings file');
    return data.channels as StoredDeliveryChannel[];
  }

  async write(channels: readonly StoredDeliveryChannel[]): Promise<void> {
    await atomicWriteAsync(this.path, JSON.stringify({
      schemaVersion: 1,
      channels,
    }, null, 2), { mode: 0o600 });
  }
}
