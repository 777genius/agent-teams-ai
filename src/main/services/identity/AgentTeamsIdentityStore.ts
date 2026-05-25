import { atomicWriteAsync } from '@main/utils/atomicWrite';
import {
  getAppDataPath,
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
} from '@main/utils/pathDecoder';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const AGENT_TEAMS_IDENTITY_STORE_PATH_ENV = 'AGENT_TEAMS_IDENTITY_STORE_PATH';
export const AGENT_TEAMS_IDENTITY_SCHEMA_VERSION = 1;
const SENTRY_ANONYMOUS_USER_PREFIX = 'agent-teams-sentry-v1:';
const IDENTITY_DIR_MODE = 0o700;
const IDENTITY_FILE_MODE = 0o600;

type ParsedJson = null | boolean | number | string | ParsedJson[] | { [key: string]: ParsedJson };

export type AgentTeamsIdentitySource = 'app-data' | 'legacy-global-config' | 'created';

export interface AgentTeamsIdentityStoreV1 {
  schemaVersion: typeof AGENT_TEAMS_IDENTITY_SCHEMA_VERSION;
  clientId: string;
  session?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTeamsClientIdentity {
  clientId: string;
  source: AgentTeamsIdentitySource;
  storePath: string;
}

interface LegacyAgentTeamsState {
  clientId: string;
  session?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidAgentTeamsClientId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pickObjectField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function getAgentTeamsIdentityStorePath(): string {
  return path.join(getAppDataPath(), 'identity', 'agent-teams-client.json');
}

export function applyAgentTeamsIdentityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV];
  if (!isNonEmptyString(existing)) {
    env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV] = getAgentTeamsIdentityStorePath();
  }
  return env;
}

export function getSentryAnonymousUserId(clientId: string): string {
  if (!isValidAgentTeamsClientId(clientId)) {
    throw new Error('Invalid Agent Teams clientId');
  }
  return createHash('sha256').update(`${SENTRY_ANONYMOUS_USER_PREFIX}${clientId}`).digest('hex');
}

function getLegacyGlobalConfigPath(): string {
  const claudeBasePath = getClaudeBasePath();
  return claudeBasePath !== getAutoDetectedClaudeBasePath()
    ? path.join(claudeBasePath, '.claude.json')
    : path.join(getHomeDir(), '.claude.json');
}

async function readJsonFile(filePath: string): Promise<ParsedJson | undefined> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as ParsedJson;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.stat(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function normalizeStoreRecord(value: unknown): AgentTeamsIdentityStoreV1 | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.schemaVersion !== AGENT_TEAMS_IDENTITY_SCHEMA_VERSION) {
    return null;
  }

  if (!isValidAgentTeamsClientId(value.clientId)) {
    return null;
  }

  const createdAt = isNonEmptyString(value.createdAt) ? value.createdAt : new Date().toISOString();
  const updatedAt = isNonEmptyString(value.updatedAt) ? value.updatedAt : createdAt;
  return {
    schemaVersion: AGENT_TEAMS_IDENTITY_SCHEMA_VERSION,
    clientId: value.clientId,
    session: pickObjectField(value, 'session'),
    capabilities: pickObjectField(value, 'capabilities'),
    createdAt,
    updatedAt,
  };
}

function normalizeLegacyAgentTeams(value: unknown): LegacyAgentTeamsState | null {
  if (!isRecord(value) || !isValidAgentTeamsClientId(value.clientId)) {
    return null;
  }

  return {
    clientId: value.clientId,
    session: pickObjectField(value, 'session'),
    capabilities: pickObjectField(value, 'capabilities'),
  };
}

async function readLegacyAgentTeamsState(): Promise<LegacyAgentTeamsState | null> {
  const legacyConfig = await readJsonFile(getLegacyGlobalConfigPath());
  if (!isRecord(legacyConfig)) {
    return null;
  }

  return normalizeLegacyAgentTeams(legacyConfig.agentTeams);
}

function buildStoreRecord(
  source: LegacyAgentTeamsState | null,
  options?: { existingCreatedAt?: string }
): AgentTeamsIdentityStoreV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: AGENT_TEAMS_IDENTITY_SCHEMA_VERSION,
    clientId: source?.clientId ?? randomUUID(),
    session: source?.session,
    capabilities: source?.capabilities,
    createdAt: options?.existingCreatedAt ?? now,
    updatedAt: now,
  };
}

async function writeStoreRecord(
  storePath: string,
  record: AgentTeamsIdentityStoreV1
): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: IDENTITY_DIR_MODE });
  await fs.promises.chmod(dir, IDENTITY_DIR_MODE).catch(() => undefined);
  await atomicWriteAsync(storePath, `${JSON.stringify(record, null, 2)}\n`);
  await fs.promises.chmod(storePath, IDENTITY_FILE_MODE).catch(() => undefined);
}

async function loadAppDataIdentity(storePath: string): Promise<AgentTeamsIdentityStoreV1 | null> {
  return normalizeStoreRecord(await readJsonFile(storePath));
}

export async function ensureAgentTeamsClientIdentity(options?: {
  storePath?: string;
}): Promise<AgentTeamsClientIdentity> {
  const storePath = options?.storePath ?? getAgentTeamsIdentityStorePath();
  const existing = await loadAppDataIdentity(storePath);
  if (existing) {
    return {
      clientId: existing.clientId,
      source: 'app-data',
      storePath,
    };
  }

  const legacy = !(await pathExists(storePath)) ? await readLegacyAgentTeamsState() : null;
  const record = buildStoreRecord(legacy);
  await writeStoreRecord(storePath, record);

  return {
    clientId: record.clientId,
    source: legacy ? 'legacy-global-config' : 'created',
    storePath,
  };
}

export async function readAgentTeamsIdentityStore(options?: {
  storePath?: string;
}): Promise<AgentTeamsIdentityStoreV1 | null> {
  return loadAppDataIdentity(options?.storePath ?? getAgentTeamsIdentityStorePath());
}
