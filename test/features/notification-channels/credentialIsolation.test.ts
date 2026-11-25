import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('not available'); },
    decryptString: () => { throw new Error('not available'); },
    getSelectedStorageBackend: () => 'basic_text',
  },
}));

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Notification Channel credential vault', () => {
  it('does not leak to generic renderer API-key list, lookup or mutations', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-keys-'));
    owned.push(base);
    const generic = new ApiKeyService(path.join(base, 'generic'));
    const isolated = new ApiKeyService(path.join(base, 'notification-channel-credentials'));
    const token = '123456789:abcdefghijklmnopqrstuvwxyz_0123456789';
    const key = await isolated.save({
      name: 'Notification: Private bot',
      envVarName: 'NOTIFICATION_CHANNEL_TEST',
      value: token,
      scope: 'user',
    });
    expect(key.maskedValue).not.toContain(token);
    expect(await generic.list()).toEqual([]);
    expect(await generic.lookup(['NOTIFICATION_CHANNEL_TEST'])).toEqual([]);
    await expect(generic.delete(key.id)).rejects.toThrow();
    expect(await isolated.readValueById(key.id)).toBe(token);
    const securePath = path.join(base, 'notification-channel-credentials', 'api-keys.json');
    const encrypted = await fs.readFile(securePath, 'utf8');
    expect(encrypted).not.toContain(token);
    if (process.platform !== 'win32') {
      expect((await fs.stat(securePath)).mode & 0o077).toBe(0);
    }
  });
});
