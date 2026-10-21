import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { atomicCreateAsync } from '@main/utils/atomicWrite';

import {
  assertIdentity,
  BackendRoutingError,
  captureStoredBinding,
} from '../application/backendBinding';

import type { HandleBindingStore, StoredBackendBinding } from '../application/backendBinding';

/** Each immutable record is published durably without replacing an existing binding. */
export class FileHandleBindingStore implements HandleBindingStore {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory) || directory.includes('\0'))
      throw new BackendRoutingError('invalid-binding');
  }

  private path(handleId: string): string {
    assertIdentity(handleId);
    return join(this.directory, `${createHash('sha256').update(handleId).digest('hex')}.json`);
  }

  async read(handleId: string): Promise<StoredBackendBinding | null> {
    try {
      const file = await open(this.path(handleId), 'r');
      try {
        const stats = await file.stat();
        if (!stats.isFile() || stats.size > 16_384) throw new BackendRoutingError('hold');
        const bytes = Buffer.alloc(16_385);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > 16_384) throw new BackendRoutingError('hold');
        const binding = captureStoredBinding(
          JSON.parse(bytes.subarray(0, length).toString('utf8'))
        );
        if (binding.handleId !== handleId) throw new BackendRoutingError('hold');
        return binding;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new BackendRoutingError('hold');
    }
  }

  async create(value: StoredBackendBinding): Promise<boolean> {
    const binding = captureStoredBinding(value);
    const bytes = `${JSON.stringify(binding)}\n`;
    if (Buffer.byteLength(bytes) > 16_384) throw new BackendRoutingError('invalid-binding');
    try {
      await atomicCreateAsync(this.path(binding.handleId), bytes, { mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw new BackendRoutingError('hold');
    }
  }
}
