import fs from 'node:fs/promises';

import { atomicWriteAsync } from '@main/utils/atomicWrite';

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
    if (data.channels.some((item: unknown) =>
      !item || typeof item !== 'object' || typeof (item as StoredDeliveryChannel).id !== 'string' ||
      typeof (item as StoredDeliveryChannel).credentialId !== 'string'
    )) throw new Error('Invalid channel settings file');
    return data.channels as StoredDeliveryChannel[];
  }

  async write(channels: readonly StoredDeliveryChannel[]): Promise<void> {
    await atomicWriteAsync(this.path, JSON.stringify({
      schemaVersion: 1,
      channels,
    }, null, 2), { mode: 0o600 });
  }
}
