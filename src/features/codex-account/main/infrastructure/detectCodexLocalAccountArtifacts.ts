import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const CODEX_ACCOUNTS_DIR = path.join(os.homedir(), '.codex', 'accounts');

interface CodexAccountsRegistry {
  active_account_key?: string | null;
  activeAccountKey?: string | null;
}

interface CodexAuthFile {
  auth_mode?: string | null;
  authMode?: string | null;
}

export interface CodexLocalAccountState {
  hasArtifacts: boolean;
  hasActiveChatgptAccount: boolean;
}

function encodeAccountKeyForAuthFilename(accountKey: string): string {
  return Buffer.from(accountKey, 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function detectCodexLocalAccountState(
  accountsDir = CODEX_ACCOUNTS_DIR
): Promise<CodexLocalAccountState> {
  try {
    const entries = await fs.readdir(accountsDir, { withFileTypes: true });
    const hasArtifacts = entries.some(
      (entry) =>
        entry.isFile() && (entry.name === 'registry.json' || entry.name.endsWith('.auth.json'))
    );

    if (!hasArtifacts) {
      return {
        hasArtifacts: false,
        hasActiveChatgptAccount: false,
      };
    }

    const registry = await readJsonFile<CodexAccountsRegistry>(
      path.join(accountsDir, 'registry.json')
    );
    const activeAccountKey =
      registry?.active_account_key?.trim() || registry?.activeAccountKey?.trim() || null;

    if (!activeAccountKey) {
      return {
        hasArtifacts: true,
        hasActiveChatgptAccount: false,
      };
    }

    const authFilePath = path.join(
      accountsDir,
      `${encodeAccountKeyForAuthFilename(activeAccountKey)}.auth.json`
    );
    if (!(await fileExists(authFilePath))) {
      return {
        hasArtifacts: true,
        hasActiveChatgptAccount: false,
      };
    }

    const authFile = await readJsonFile<CodexAuthFile>(authFilePath);
    const authMode = authFile?.auth_mode ?? authFile?.authMode ?? null;

    return {
      hasArtifacts: true,
      hasActiveChatgptAccount: authMode === 'chatgpt',
    };
  } catch {
    return {
      hasArtifacts: false,
      hasActiveChatgptAccount: false,
    };
  }
}

export async function detectCodexLocalAccountArtifacts(
  accountsDir = CODEX_ACCOUNTS_DIR
): Promise<boolean> {
  const state = await detectCodexLocalAccountState(accountsDir);
  return state.hasArtifacts;
}
