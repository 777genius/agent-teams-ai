// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectCodexLocalAccountArtifacts,
  detectCodexLocalAccountState,
  ensureCodexLegacyAuthFromActiveAccount,
  resolveCodexActiveChatgptAuthFile,
} from '../../../../../src/features/codex-account/main/infrastructure/detectCodexLocalAccountArtifacts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-artifacts-'));
  tempDirs.push(dir);
  return dir;
}

async function makeCodexHome(): Promise<{ codexHome: string; accountsDir: string }> {
  const codexHome = await makeTempDir();
  const accountsDir = path.join(codexHome, 'accounts');
  await mkdir(accountsDir, { recursive: true });
  return { codexHome, accountsDir };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function encodeAccountKeyForAuthFilename(accountKey: string): string {
  return Buffer.from(accountKey, 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

describe('detectCodexLocalAccountArtifacts', () => {
  it('returns true when the Codex accounts registry exists', async () => {
    const accountsDir = await makeTempDir();
    await writeFile(path.join(accountsDir, 'registry.json'), '{}', 'utf8');

    await expect(detectCodexLocalAccountArtifacts(accountsDir)).resolves.toBe(true);
  });

  it('returns true when auth artifacts exist without a registry file', async () => {
    const accountsDir = await makeTempDir();
    await writeFile(path.join(accountsDir, 'chatgpt.auth.json'), '{}', 'utf8');

    await expect(detectCodexLocalAccountArtifacts(accountsDir)).resolves.toBe(true);
  });

  it('returns false when the accounts directory is missing or empty', async () => {
    const missingDir = path.join(await makeTempDir(), 'missing');
    const emptyDir = await makeTempDir();
    await mkdir(emptyDir, { recursive: true });

    await expect(detectCodexLocalAccountArtifacts(missingDir)).resolves.toBe(false);
    await expect(detectCodexLocalAccountArtifacts(emptyDir)).resolves.toBe(false);
  });

  it('detects a locally selected ChatGPT account from the registry and active auth file', async () => {
    const { accountsDir } = await makeCodexHome();
    const activeAccountKey = 'user-test::chatgpt-account';
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: activeAccountKey }),
      'utf8'
    );
    await writeFile(
      path.join(accountsDir, `${encodeAccountKeyForAuthFilename(activeAccountKey)}.auth.json`),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'refresh-token' } }),
      'utf8'
    );

    await expect(detectCodexLocalAccountState(accountsDir)).resolves.toEqual({
      hasArtifacts: true,
      hasActiveChatgptAccount: true,
    });
  });

  it('resolves the active accounts-format auth file before legacy auth when a registry exists', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    const activeAccountKey = 'user-active::chatgpt-account';
    await writeFile(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'legacy-refresh-token' } }),
      'utf8'
    );
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: activeAccountKey }),
      'utf8'
    );
    const activeAuthPath = path.join(
      accountsDir,
      `${encodeAccountKeyForAuthFilename(activeAccountKey)}.auth.json`
    );
    await writeFile(
      activeAuthPath,
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'active-refresh-token' } }),
      'utf8'
    );

    await expect(resolveCodexActiveChatgptAuthFile(accountsDir)).resolves.toMatchObject({
      authFilePath: activeAuthPath,
      source: 'accounts',
      activeAccountKey,
    });
  });

  it('materializes active accounts-format auth into legacy auth.json for Codex CLI compatibility', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    const activeAccountKey = 'user-active::chatgpt-account';
    const authPayload = {
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'active-refresh-token', access_token: 'active-access-token' },
    };
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: activeAccountKey }),
      'utf8'
    );
    await writeFile(
      path.join(accountsDir, `${encodeAccountKeyForAuthFilename(activeAccountKey)}.auth.json`),
      JSON.stringify(authPayload),
      'utf8'
    );

    const result = await ensureCodexLegacyAuthFromActiveAccount(accountsDir);

    expect(result).toMatchObject({
      codexHome,
      authFilePath: path.join(codexHome, 'auth.json'),
      source: 'accounts',
      materializedLegacyAuth: true,
    });
    await expect(readFile(path.join(codexHome, 'auth.json'), 'utf8')).resolves.toBe(
      JSON.stringify(authPayload)
    );
  });

  it('does not overwrite a newer synced legacy auth file for the same active account', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    const activeAccountKey = 'user-active::chatgpt-account';
    const activeAuthPath = path.join(
      accountsDir,
      `${encodeAccountKeyForAuthFilename(activeAccountKey)}.auth.json`
    );
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: activeAccountKey }),
      'utf8'
    );
    await writeFile(
      activeAuthPath,
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'first-refresh-token' } }),
      'utf8'
    );
    await ensureCodexLegacyAuthFromActiveAccount(accountsDir);

    const refreshedLegacyPayload = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'runtime-refreshed-token' },
    });
    const legacyAuthPath = path.join(codexHome, 'auth.json');
    await writeFile(legacyAuthPath, refreshedLegacyPayload, 'utf8');
    const future = new Date(Date.now() + 60_000);
    await utimes(legacyAuthPath, future, future);

    const result = await ensureCodexLegacyAuthFromActiveAccount(accountsDir);

    expect(result?.materializedLegacyAuth).toBe(false);
    await expect(readFile(legacyAuthPath, 'utf8')).resolves.toBe(refreshedLegacyPayload);
  });

  it('refreshes legacy auth when the selected accounts-format account changes', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    const firstAccountKey = 'user-first::chatgpt-account';
    const secondAccountKey = 'user-second::chatgpt-account';
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: firstAccountKey }),
      'utf8'
    );
    await writeFile(
      path.join(accountsDir, `${encodeAccountKeyForAuthFilename(firstAccountKey)}.auth.json`),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'first-refresh-token' } }),
      'utf8'
    );
    await writeFile(
      path.join(accountsDir, `${encodeAccountKeyForAuthFilename(secondAccountKey)}.auth.json`),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'second-refresh-token' } }),
      'utf8'
    );
    await ensureCodexLegacyAuthFromActiveAccount(accountsDir);

    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: secondAccountKey }),
      'utf8'
    );

    const result = await ensureCodexLegacyAuthFromActiveAccount(accountsDir);

    expect(result?.materializedLegacyAuth).toBe(true);
    await expect(readFile(path.join(codexHome, 'auth.json'), 'utf8')).resolves.toContain(
      'second-refresh-token'
    );
  });

  it('requires a ChatGPT refresh token for the selected account', async () => {
    const { accountsDir } = await makeCodexHome();
    const activeAccountKey = 'user-test::chatgpt-account';
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ activeAccountId: activeAccountKey }),
      'utf8'
    );
    await writeFile(
      path.join(accountsDir, `${encodeAccountKeyForAuthFilename(activeAccountKey)}.auth.json`),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'access-token' } }),
      'utf8'
    );

    await expect(detectCodexLocalAccountState(accountsDir)).resolves.toEqual({
      hasArtifacts: true,
      hasActiveChatgptAccount: false,
    });
  });

  it('falls back to legacy auth.json when the accounts registry is absent', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    await writeFile(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'legacy-refresh-token' } }),
      'utf8'
    );

    await expect(detectCodexLocalAccountState(accountsDir)).resolves.toEqual({
      hasArtifacts: true,
      hasActiveChatgptAccount: true,
    });
  });

  it('ignores a stale legacy auth.json without deleting it when the accounts registry is absent', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    const legacyAuthPath = path.join(codexHome, 'auth.json');
    await writeFile(
      legacyAuthPath,
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'legacy-refresh-token' } }),
      'utf8'
    );
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(legacyAuthPath, staleDate, staleDate);

    await expect(detectCodexLocalAccountState(accountsDir)).resolves.toEqual({
      hasArtifacts: true,
      hasActiveChatgptAccount: false,
    });
    await expect(resolveCodexActiveChatgptAuthFile(accountsDir)).resolves.toBeNull();
    await expect(readFile(legacyAuthPath, 'utf8')).resolves.toContain('legacy-refresh-token');
  });

  it('trusts a stale last_refresh in legacy auth.json content over a fresh file mtime', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    await writeFile(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        last_refresh: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        tokens: { refresh_token: 'legacy-refresh-token' },
      }),
      'utf8'
    );

    await expect(resolveCodexActiveChatgptAuthFile(accountsDir)).resolves.toBeNull();
  });

  it('accepts a fresh last_refresh in legacy auth.json even when the file mtime is old', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    const legacyAuthPath = path.join(codexHome, 'auth.json');
    await writeFile(
      legacyAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        last_refresh: new Date().toISOString(),
        tokens: { refresh_token: 'legacy-refresh-token' },
      }),
      'utf8'
    );
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(legacyAuthPath, staleDate, staleDate);

    await expect(resolveCodexActiveChatgptAuthFile(accountsDir)).resolves.toMatchObject({
      authFilePath: legacyAuthPath,
      source: 'legacy',
    });
  });

  it('does not treat a future last_refresh as fresh', async () => {
    const { codexHome, accountsDir } = await makeCodexHome();
    const legacyAuthPath = path.join(codexHome, 'auth.json');
    await writeFile(
      legacyAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        last_refresh: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        tokens: { refresh_token: 'legacy-refresh-token' },
      }),
      'utf8'
    );

    await expect(resolveCodexActiveChatgptAuthFile(accountsDir)).resolves.toBeNull();
  });

  it('keeps reporting local artifacts for a 15-day-old legacy login instead of erasing it', async () => {
    // A legacy login just past the freshness window is withheld as a *trusted* active
    // account (replaying its refresh token is what trips reuse detection), but it must
    // still surface as local account data so callers keep the "reconnect" wording and
    // the file itself is never touched. It is not a signed-out signal: launch readiness
    // is decided by the authoritative `codex app-server` account read, not by this flag.
    const { codexHome, accountsDir } = await makeCodexHome();
    const legacyAuthPath = path.join(codexHome, 'auth.json');
    await writeFile(
      legacyAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        last_refresh: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
        tokens: { refresh_token: 'legacy-refresh-token' },
      }),
      'utf8'
    );

    await expect(detectCodexLocalAccountState(accountsDir)).resolves.toEqual({
      hasArtifacts: true,
      hasActiveChatgptAccount: false,
    });
    await expect(readFile(legacyAuthPath, 'utf8')).resolves.toContain('legacy-refresh-token');
  });

  it('keeps artifact detection true but selected-account detection false when the active auth file is missing', async () => {
    const { accountsDir } = await makeCodexHome();
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: 'user-test::missing-auth' }),
      'utf8'
    );

    await expect(detectCodexLocalAccountState(accountsDir)).resolves.toEqual({
      hasArtifacts: true,
      hasActiveChatgptAccount: false,
    });
  });
});
