import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { type Dirent, promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const CODEX_ACCOUNTS_DIR = path.join(os.homedir(), '.codex', 'accounts');
const LEGACY_AUTH_SYNC_MARKER_FILE = '.agent-teams-legacy-auth-sync.json';

interface CodexAccountsRegistry {
  active_account_id?: string | null;
  active_account_key?: string | null;
  activeAccountId?: string | null;
  activeAccountKey?: string | null;
}

interface CodexAuthFile {
  auth_mode?: string | null;
  authMode?: string | null;
  tokens?: {
    refresh_token?: string | null;
    refreshToken?: string | null;
  } | null;
}

export interface CodexLocalAccountState {
  hasArtifacts: boolean;
  hasActiveChatgptAccount: boolean;
}

export interface CodexActiveChatgptAuthFile {
  codexHome: string;
  authFilePath: string;
  source: 'accounts' | 'legacy';
  activeAccountKey: string | null;
}

export interface CodexLegacyAuthCompatibilityResult {
  codexHome: string;
  authFilePath: string;
  source: 'accounts' | 'legacy';
  materializedLegacyAuth: boolean;
}

interface LegacyAuthSyncMarker {
  activeAccountKey?: string | null;
  sourceAuthFilePath?: string | null;
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

function hasChatgptRefreshToken(authFile: CodexAuthFile | null): boolean {
  if (!authFile) {
    return false;
  }

  const authMode = authFile.auth_mode ?? authFile.authMode ?? null;
  const refreshToken = authFile.tokens?.refresh_token ?? authFile.tokens?.refreshToken ?? null;
  return (
    authMode === 'chatgpt' && typeof refreshToken === 'string' && refreshToken.trim().length > 0
  );
}

async function readCodexAuthFile(filePath: string): Promise<CodexAuthFile | null> {
  return readJsonFile<CodexAuthFile>(filePath);
}

function getLegacyAuthFilePath(accountsDir: string): string {
  return path.join(path.dirname(accountsDir), 'auth.json');
}

function getActiveAccountKey(registry: CodexAccountsRegistry | null): string | null {
  return (
    registry?.active_account_key?.trim() ||
    registry?.activeAccountKey?.trim() ||
    registry?.active_account_id?.trim() ||
    registry?.activeAccountId?.trim() ||
    null
  );
}

function getActiveAccountAuthFileCandidates(
  accountsDir: string,
  activeAccountKey: string
): string[] {
  const candidates = [
    path.join(accountsDir, `${encodeAccountKeyForAuthFilename(activeAccountKey)}.auth.json`),
  ];
  if (!activeAccountKey.includes('/') && !activeAccountKey.includes('\\')) {
    candidates.push(path.join(accountsDir, `${activeAccountKey}.auth.json`));
  }
  return Array.from(new Set(candidates));
}

export async function detectCodexLocalAccountState(
  accountsDir = CODEX_ACCOUNTS_DIR
): Promise<CodexLocalAccountState> {
  try {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(accountsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const hasAccountsArtifacts = entries.some(
      (entry) =>
        entry.isFile() && (entry.name === 'registry.json' || entry.name.endsWith('.auth.json'))
    );
    const legacyAuthFilePath = getLegacyAuthFilePath(accountsDir);
    const hasLegacyAuthFile = await fileExists(legacyAuthFilePath);
    const hasArtifacts = hasAccountsArtifacts || hasLegacyAuthFile;

    if (!hasArtifacts) {
      return {
        hasArtifacts: false,
        hasActiveChatgptAccount: false,
      };
    }

    return {
      hasArtifacts: true,
      hasActiveChatgptAccount: (await resolveCodexActiveChatgptAuthFile(accountsDir)) !== null,
    };
  } catch {
    return {
      hasArtifacts: false,
      hasActiveChatgptAccount: false,
    };
  }
}

export async function resolveCodexActiveChatgptAuthFile(
  accountsDir = CODEX_ACCOUNTS_DIR
): Promise<CodexActiveChatgptAuthFile | null> {
  const codexHome = path.dirname(accountsDir);
  const legacyAuthFilePath = getLegacyAuthFilePath(accountsDir);
  const registryPath = path.join(accountsDir, 'registry.json');
  const hasRegistry = await fileExists(registryPath);

  if (!hasRegistry) {
    const legacyAuthFile = await readCodexAuthFile(legacyAuthFilePath);
    return hasChatgptRefreshToken(legacyAuthFile)
      ? {
          codexHome,
          authFilePath: legacyAuthFilePath,
          source: 'legacy',
          activeAccountKey: null,
        }
      : null;
  }

  const registry = await readJsonFile<CodexAccountsRegistry>(registryPath);
  const activeAccountKey = getActiveAccountKey(registry);
  if (!activeAccountKey) {
    return null;
  }

  for (const authFilePath of getActiveAccountAuthFileCandidates(accountsDir, activeAccountKey)) {
    if (!(await fileExists(authFilePath))) {
      continue;
    }
    if (hasChatgptRefreshToken(await readCodexAuthFile(authFilePath))) {
      return {
        codexHome,
        authFilePath,
        source: 'accounts',
        activeAccountKey,
      };
    }
  }

  return null;
}

async function readLegacyAuthSyncMarker(markerPath: string): Promise<LegacyAuthSyncMarker | null> {
  return readJsonFile<LegacyAuthSyncMarker>(markerPath);
}

async function getMtimeMs(filePath: string): Promise<number | null> {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function writeFileAtomic(filePath: string, content: string, mode = 0o600): Promise<void> {
  await atomicWriteAsync(filePath, content, { mode });
  await fs.chmod(filePath, mode).catch(() => undefined);
}

export async function ensureCodexLegacyAuthFromActiveAccount(
  accountsDir = CODEX_ACCOUNTS_DIR
): Promise<CodexLegacyAuthCompatibilityResult | null> {
  const activeAuth = await resolveCodexActiveChatgptAuthFile(accountsDir);
  if (!activeAuth) {
    return null;
  }

  if (activeAuth.source === 'legacy') {
    return {
      codexHome: activeAuth.codexHome,
      authFilePath: activeAuth.authFilePath,
      source: activeAuth.source,
      materializedLegacyAuth: false,
    };
  }

  const legacyAuthFilePath = getLegacyAuthFilePath(accountsDir);
  const markerPath = path.join(activeAuth.codexHome, LEGACY_AUTH_SYNC_MARKER_FILE);
  const [sourceRaw, sourceMtimeMs, legacyMtimeMs, legacyAuthFile, marker] = await Promise.all([
    fs.readFile(activeAuth.authFilePath, 'utf8'),
    getMtimeMs(activeAuth.authFilePath),
    getMtimeMs(legacyAuthFilePath),
    readCodexAuthFile(legacyAuthFilePath),
    readLegacyAuthSyncMarker(markerPath),
  ]);

  const legacyUsable = hasChatgptRefreshToken(legacyAuthFile);
  const activeAccountChanged =
    marker?.activeAccountKey !== activeAuth.activeAccountKey ||
    marker?.sourceAuthFilePath !== activeAuth.authFilePath;
  const activeAuthNewerThanLegacy =
    sourceMtimeMs !== null && (legacyMtimeMs === null || sourceMtimeMs > legacyMtimeMs + 1);
  const shouldMaterialize = !legacyUsable || activeAccountChanged || activeAuthNewerThanLegacy;

  if (shouldMaterialize) {
    await writeFileAtomic(legacyAuthFilePath, sourceRaw);
  }

  await writeFileAtomic(
    markerPath,
    `${JSON.stringify(
      {
        activeAccountKey: activeAuth.activeAccountKey,
        sourceAuthFilePath: activeAuth.authFilePath,
      },
      null,
      2
    )}\n`,
    0o600
  ).catch(() => undefined);

  return {
    codexHome: activeAuth.codexHome,
    authFilePath: legacyAuthFilePath,
    source: activeAuth.source,
    materializedLegacyAuth: shouldMaterialize,
  };
}

export async function detectCodexLocalAccountArtifacts(
  accountsDir = CODEX_ACCOUNTS_DIR
): Promise<boolean> {
  const state = await detectCodexLocalAccountState(accountsDir);
  return state.hasArtifacts;
}
