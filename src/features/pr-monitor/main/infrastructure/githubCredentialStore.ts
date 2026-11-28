import type { OAuthCredential } from '../../core/application/deviceAuthorization';
import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';

/** A dedicated ApiKeyService instance is never registered in generic renderer IPC. */
export function githubCredentialStore(
  vault: Pick<ApiKeyService, 'list' | 'readValueById' | 'save' | 'delete' | 'getStorageStatus'>
) {
  let writes = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = writes.then(operation);
    writes = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  const marker = 'PR_MONITOR_GITHUB_DEVICE_LOGIN';
  const entries = async () => (await vault.list()).filter((item) => item.envVarName === marker);
  return {
    async available() {
      return (await vault.getStorageStatus()).encryptionMethod === 'os-keychain';
    },
    async read(): Promise<OAuthCredential | null> {
      await writes;
      const records = await entries();
      if (records.length > 1) throw new Error('Stored GitHub sign-in is ambiguous. Sign in again.');
      const [saved] = records;
      if (!saved) return null;
      const raw = await vault.readValueById(saved.id);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (
        !value ||
        typeof value !== 'object' ||
        !('accessToken' in value) ||
        typeof value.accessToken !== 'string' ||
        !('clientId' in value) ||
        typeof value.clientId !== 'string' ||
        !('accountId' in value) ||
        typeof value.accountId !== 'string'
      )
        throw new Error('Stored GitHub sign-in is invalid.');
      const record = value as Record<string, unknown>;
      for (const key of ['expiresAt', 'refreshExpiresAt'] as const)
        if (key in value && (typeof record[key] !== 'number' || !Number.isFinite(record[key])))
          throw new Error('Stored GitHub expiry is invalid.');
      if ('refreshToken' in value && typeof value.refreshToken !== 'string')
        throw new Error('Stored GitHub refresh token is invalid.');
      return value as OAuthCredential;
    },
    save(credential: OAuthCredential, signal?: AbortSignal) {
      return serialize(async () => {
        if (signal?.aborted) throw new Error('Sign-in cancelled.');
        const [previous, ...duplicates] = await entries();
        if (signal?.aborted) throw new Error('Sign-in cancelled.');
        for (const duplicate of duplicates) {
          await vault.delete(duplicate.id);
          if (signal?.aborted) throw new Error('Sign-in cancelled.');
        }
        const saved = await vault.save({
          id: previous?.id,
          name: 'GitHub for Pull Requests',
          envVarName: marker,
          value: JSON.stringify(credential),
          scope: 'user',
        });
        if (signal?.aborted) {
          await vault.delete(saved.id);
          throw new Error('Sign-in cancelled.');
        }
      });
    },
    clear() {
      return serialize(async () => {
        for (const saved of await vault.list())
          if (saved.envVarName === marker) await vault.delete(saved.id);
      });
    },
  };
}
