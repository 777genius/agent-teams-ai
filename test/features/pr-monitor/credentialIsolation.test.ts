import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { githubCredentialStore } from '../../../src/features/pr-monitor/main/infrastructure/githubCredentialStore';

const storage = vi.hoisted(() => ({ available: true, fail: false, writeFail: false }));
vi.mock('@main/utils/atomicWrite', async (importOriginal) => {
  const original = await importOriginal<typeof import('@main/utils/atomicWrite')>();
  return {
    ...original,
    atomicWriteAsync: async (...args: Parameters<typeof original.atomicWriteAsync>) => {
      if (storage.writeFail) throw new Error('TEST_ATOMIC_WRITE_FAILED');
      return original.atomicWriteAsync(...args);
    },
  };
});
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    getSelectedStorageBackend: () => (storage.available ? 'gnome_libsecret' : 'basic_text'),
    encryptString: (value: string) => {
      if (storage.fail) throw new Error('TEST_KEYCHAIN_FAILURE');
      return Buffer.from(value.split('').reverse().join(''));
    },
    decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
  },
}));
beforeEach(() => {
  storage.available = true;
  storage.fail = false;
  storage.writeFail = false;
});
const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('isolated GitHub credential custody', () => {
  it('encrypts access and refresh tokens, isolates generic IPC, and removes them on sign out', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-monitor-vault-TEST-'));
    owned.push(root);
    const generic = new ApiKeyService(path.join(root, 'generic'));
    const vault = new ApiKeyService(path.join(root, 'pr-monitor-credentials'), {
      requireSecureBackend: true,
    });
    const store = githubCredentialStore(vault);
    const credential = {
      accessToken: 'TEST_ACCESS_PRIVATE',
      refreshToken: 'TEST_REFRESH_PRIVATE',
      clientId: 'TEST_CLIENT',
      accountId: '123',
      expiresAt: Date.now() + 28800000,
    };
    await store.save(credential);
    expect(await store.read()).toEqual(credential);
    expect(await generic.lookup(['PR_MONITOR_GITHUB_DEVICE_LOGIN'])).toEqual([]);
    expect(await generic.list()).toEqual([]);
    const file = path.join(root, 'pr-monitor-credentials', 'api-keys.json');
    const content = await fs.readFile(file, 'utf8');
    expect(content).not.toContain(credential.accessToken);
    expect(content).not.toContain(credential.refreshToken);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o077).toBe(0);
    await store.clear();
    expect(await store.read()).toBeNull();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual([]);
  });
  it('refuses missing or failed keychain encryption without insecure fallback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-monitor-vault-fail-TEST-'));
    owned.push(root);
    const vault = new ApiKeyService(root, { requireSecureBackend: true });
    const request = {
      name: 'TEST',
      envVarName: 'TEST',
      value: 'TEST_PRIVATE',
      scope: 'user' as const,
    };
    storage.available = false;
    await expect(vault.save(request)).rejects.toThrow('unavailable');
    storage.available = true;
    storage.fail = true;
    await expect(vault.save(request)).rejects.toThrow('failed');
    await expect(fs.readFile(path.join(root, 'api-keys.json'))).rejects.toThrow();
    storage.fail = false;
    const saved = await vault.save(request);
    storage.available = false;
    await expect(vault.readValueById(saved.id)).rejects.toThrow('unavailable');
  });
  it('replaces one authoritative record atomically and preserves it when a write fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-monitor-vault-replace-TEST-'));
    owned.push(root);
    const vault = new ApiKeyService(root, { requireSecureBackend: true });
    const store = githubCredentialStore(vault);
    const previous = { accessToken: 'TEST_OLD', clientId: 'TEST_CLIENT', accountId: '123' };
    await store.save(previous);
    const [{ id }] = await vault.list();
    storage.writeFail = true;
    await expect(
      store.save({ ...previous, accessToken: 'TEST_FAILED', accountId: '456' })
    ).rejects.toThrow('TEST_ATOMIC_WRITE_FAILED');
    expect(await store.read()).toEqual(previous);
    expect(
      await githubCredentialStore(new ApiKeyService(root, { requireSecureBackend: true })).read()
    ).toEqual(previous);
    storage.writeFail = false;
    const next = { ...previous, accessToken: 'TEST_RETRIED', accountId: '789' };
    const removal = vi
      .spyOn(vault, 'delete')
      .mockRejectedValue(new Error('TEST_OLD_DELETE_FAILED'));
    await store.save(next);
    expect(removal).not.toHaveBeenCalled();
    expect(await vault.list()).toMatchObject([{ id }]);
    expect(
      await githubCredentialStore(new ApiKeyService(root, { requireSecureBackend: true })).read()
    ).toEqual(next);
    expect(JSON.parse(await fs.readFile(path.join(root, 'api-keys.json'), 'utf8'))).toHaveLength(1);
  });
  it('rejects ambiguous legacy records until a successful retry leaves only its credential', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-monitor-vault-duplicate-TEST-'));
    owned.push(root);
    const vault = new ApiKeyService(root, { requireSecureBackend: true });
    const credential = { accessToken: 'TEST_OLD', clientId: 'TEST_CLIENT', accountId: '123' };
    const entry = {
      name: 'TEST',
      envVarName: 'PR_MONITOR_GITHUB_DEVICE_LOGIN',
      scope: 'user' as const,
      value: JSON.stringify(credential),
    };
    await vault.save(entry);
    await vault.save({ ...entry, value: JSON.stringify({ ...credential, accountId: '456' }) });
    const store = githubCredentialStore(vault);
    await expect(store.read()).rejects.toThrow('ambiguous');
    const removal = vi
      .spyOn(vault, 'delete')
      .mockRejectedValueOnce(new Error('TEST_DELETE_FAILED'));
    const next = { ...credential, accountId: '789' };
    await expect(store.save(next)).rejects.toThrow('TEST_DELETE_FAILED');
    await expect(store.read()).rejects.toThrow('ambiguous');
    await store.save(next);
    expect(removal).toHaveBeenCalledTimes(2);
    expect(await vault.list()).toHaveLength(1);
    expect(
      await githubCredentialStore(new ApiKeyService(root, { requireSecureBackend: true })).read()
    ).toEqual(next);
  });
  it('stops before replacement if cancellation arrives during duplicate cleanup', async () => {
    const abort = new AbortController();
    const keys = [
      { id: 'old', envVarName: 'PR_MONITOR_GITHUB_DEVICE_LOGIN' },
      { id: 'duplicate', envVarName: 'PR_MONITOR_GITHUB_DEVICE_LOGIN' },
    ];
    let finish!: () => void;
    const vault = {
      list: vi.fn(async () => [...keys]),
      readValueById: vi.fn(),
      getStorageStatus: vi.fn(),
      save: vi.fn(async () => {
        const saved = { id: 'new', envVarName: 'PR_MONITOR_GITHUB_DEVICE_LOGIN' };
        keys.push(saved);
        return saved;
      }),
      delete: vi.fn(async (id: string) => {
        if (id === 'duplicate')
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        keys.splice(
          keys.findIndex((item) => item.id === id),
          1
        );
      }),
    };
    const store = githubCredentialStore(vault as unknown as ApiKeyService);
    const pending = store.save(
      { accessToken: 'TEST', clientId: 'TEST_CLIENT', accountId: '123' },
      abort.signal
    );
    await vi.waitFor(() => expect(vault.delete).toHaveBeenCalledWith('duplicate'));
    abort.abort();
    finish();
    await expect(pending).rejects.toThrow('cancelled');
    expect(keys).toEqual([{ id: 'old', envVarName: 'PR_MONITOR_GITHUB_DEVICE_LOGIN' }]);
    expect(vault.save).not.toHaveBeenCalled();
  });
  it('serializes sign-out behind a cancelled pending credential write', async () => {
    const abort = new AbortController();
    const keys: { id: string; envVarName: string }[] = [];
    let finish!: () => void;
    const vault = {
      list: vi.fn(async () => keys),
      readValueById: vi.fn(),
      delete: vi.fn(async (id: string) => {
        keys.splice(
          keys.findIndex((item) => item.id === id),
          1
        );
      }),
      save: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        const saved = { id: 'private', envVarName: 'PR_MONITOR_GITHUB_DEVICE_LOGIN' };
        keys.push(saved);
        return saved;
      }),
    };
    const store = githubCredentialStore(vault as unknown as ApiKeyService);
    const pending = store.save(
      { accessToken: 'TEST', clientId: 'TEST_CLIENT', accountId: '123' },
      abort.signal
    );
    await vi.waitFor(() => expect(vault.save).toHaveBeenCalled());
    abort.abort();
    const removal = store.clear();
    finish();
    await expect(pending).rejects.toThrow('cancelled');
    await removal;
    expect(keys).toEqual([]);
  });
});
