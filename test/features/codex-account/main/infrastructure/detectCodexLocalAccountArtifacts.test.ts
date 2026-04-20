// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectCodexLocalAccountArtifacts,
  detectCodexLocalAccountState,
} from '../../../../../src/features/codex-account/main/infrastructure/detectCodexLocalAccountArtifacts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-artifacts-'));
  tempDirs.push(dir);
  return dir;
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
    const accountsDir = await makeTempDir();
    const activeAccountKey = 'user-test::chatgpt-account';
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: activeAccountKey }),
      'utf8'
    );
    await writeFile(
      path.join(accountsDir, `${encodeAccountKeyForAuthFilename(activeAccountKey)}.auth.json`),
      JSON.stringify({ auth_mode: 'chatgpt' }),
      'utf8'
    );

    await expect(detectCodexLocalAccountState(accountsDir)).resolves.toEqual({
      hasArtifacts: true,
      hasActiveChatgptAccount: true,
    });
  });

  it('keeps artifact detection true but selected-account detection false when the active auth file is missing', async () => {
    const accountsDir = await makeTempDir();
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
