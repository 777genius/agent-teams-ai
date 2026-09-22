import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inferProviderBillingMode } from '@shared/utils/providerBillingMode';

import type { TokenUsageRunDto } from '../../contracts';
import type { TokenUsageRunSourceDiscoveryPort } from '../../core/application';

type UnknownRecord = Record<string, unknown>;

const SESSION_STORE_MAX_BYTES = 32 * 1024 * 1024;
const AUTH_STORE_MAX_BYTES = 2 * 1024 * 1024;
const PROFILE_ROOT_KEY_PATTERN = /^[a-f0-9]{16,64}$/i;
const OPENCODE_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;
const RECENT_RUNNING_RECORD_MS = 2 * 60 * 1000;
const DEFAULT_RUN_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const PARSER_VERSION = 'opencode-sqlite-v1';

interface OpenCodeSessionStoreRunSourceDiscoveryOptions {
  now?: () => Date;
  runLookbackMs?: number;
}

interface OpenCodeSessionStoreRecord {
  teamName: string;
  agentName: string;
  nativeSessionId: string;
  profileRootKey: string;
  model?: string;
  projectPath?: string;
  startedAt: string;
  updatedAt: string;
  staleReason?: string;
  lastKnownDurableState?: string;
}

export interface ClaudeMultimodelDataHomeResolutionOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveClaudeMultimodelDataHomePath(
  options: ClaudeMultimodelDataHomeResolutionOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  // The resolution is parameterised by platform, so it must not join with the
  // host's separator: asking for a darwin path from Windows has to answer with
  // a darwin path. Identical to path.* whenever the two agree.
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const explicit = env.CLAUDE_MULTIMODEL_DATA_HOME?.trim();
  if (explicit && platformPath.isAbsolute(explicit)) return platformPath.normalize(explicit);

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || platformPath.join(homeDir, 'AppData', 'Local');
    return platformPath.join(localAppData, 'claude-multimodel-nodejs', 'Data');
  }
  if (platform === 'darwin') {
    return platformPath.join(homeDir, 'Library', 'Application Support', 'claude-multimodel-nodejs');
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim() || platformPath.join(homeDir, '.local', 'share');
  return platformPath.join(xdgDataHome, 'claude-multimodel-nodejs');
}

export class OpenCodeSessionStoreRunSourceDiscovery implements TokenUsageRunSourceDiscoveryPort {
  readonly #sessionStorePath: string;
  readonly #profilesPath: string;
  readonly #now: () => Date;
  readonly #runLookbackMs: number;

  constructor(
    private readonly teamsBasePath: string,
    dataHomePath: string,
    options: OpenCodeSessionStoreRunSourceDiscoveryOptions = {}
  ) {
    this.#sessionStorePath = path.join(dataHomePath, 'opencode', 'session-store.json');
    this.#profilesPath = path.join(dataHomePath, 'opencode', 'profiles');
    this.#now = options.now ?? (() => new Date());
    this.#runLookbackMs = options.runLookbackMs ?? DEFAULT_RUN_LOOKBACK_MS;
  }

  async discoverAppRuns(): Promise<TokenUsageRunDto[]> {
    const [knownTeamNames, store] = await Promise.all([
      this.#readKnownTeamNames(),
      readBoundRecord(this.#sessionStorePath, SESSION_STORE_MAX_BYTES),
    ]);
    const records = asRecord(store?.records);
    if (!records || knownTeamNames.size === 0) return [];

    const candidates = Object.values(records)
      .map((value) => this.#normalizeRecord(value, knownTeamNames))
      .filter((record): record is OpenCodeSessionStoreRecord => record !== null);
    const authTypesByProfile = await this.#readAuthTypesByProfile(candidates);
    return candidates.map((record) =>
      this.#toRun(record, authTypesByProfile.get(record.profileRootKey) ?? new Map())
    );
  }

  async #readKnownTeamNames(): Promise<Set<string>> {
    const entries = await readdir(this.teamsBasePath, { withFileTypes: true }).catch(() => []);
    return new Set(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
    );
  }

  #normalizeRecord(
    value: unknown,
    knownTeamNames: ReadonlySet<string>
  ): OpenCodeSessionStoreRecord | null {
    const record = asRecord(value);
    const teamName = readString(record?.teamId);
    const agentName = readString(record?.memberName);
    const nativeSessionId = readString(record?.opencodeSessionId);
    const profileRootKey = readString(record?.profileRootKey);
    const startedAt = readIsoTimestamp(record?.createdAt);
    const updatedAt = readIsoTimestamp(record?.updatedAt) ?? startedAt;
    if (
      !teamName ||
      !knownTeamNames.has(teamName) ||
      !agentName ||
      !nativeSessionId ||
      !OPENCODE_SESSION_ID_PATTERN.test(nativeSessionId) ||
      !profileRootKey ||
      !PROFILE_ROOT_KEY_PATTERN.test(profileRootKey) ||
      !startedAt ||
      !updatedAt
    ) {
      return null;
    }
    if (this.#now().getTime() - Date.parse(updatedAt) > this.#runLookbackMs) return null;

    return {
      teamName,
      agentName,
      nativeSessionId,
      profileRootKey,
      model: readString(record?.selectedModel),
      projectPath: readString(record?.projectPath),
      startedAt,
      updatedAt,
      staleReason: readString(record?.staleReason),
      lastKnownDurableState: readString(record?.lastKnownDurableState),
    };
  }

  async #readAuthTypesByProfile(
    records: readonly OpenCodeSessionStoreRecord[]
  ): Promise<Map<string, Map<string, string>>> {
    const profileRootKeys = [...new Set(records.map((record) => record.profileRootKey))];
    const entries = await Promise.all(
      profileRootKeys.map(async (profileRootKey) => {
        const authPath = path.join(
          this.#profilesPath,
          profileRootKey,
          'data',
          'opencode',
          'auth.json'
        );
        const authStore = await readBoundRecord(authPath, AUTH_STORE_MAX_BYTES);
        const authTypes = new Map<string, string>();
        for (const [providerId, credential] of Object.entries(authStore ?? {})) {
          const type = readString(asRecord(credential)?.type);
          if (type) authTypes.set(providerId.toLowerCase(), type.toLowerCase());
        }
        return [profileRootKey, authTypes] as const;
      })
    );
    return new Map(entries);
  }

  #toRun(
    record: OpenCodeSessionStoreRecord,
    authTypes: ReadonlyMap<string, string>
  ): TokenUsageRunDto {
    const {
      teamName,
      agentName,
      nativeSessionId,
      profileRootKey,
      model,
      projectPath,
      startedAt,
      updatedAt,
      staleReason,
      lastKnownDurableState,
    } = record;

    const updatedAtMs = Date.parse(updatedAt);
    const recentlyUpdated =
      Number.isFinite(updatedAtMs) &&
      this.#now().getTime() - updatedAtMs <= RECENT_RUNNING_RECORD_MS;
    const running = !staleReason && lastKnownDurableState === 'running' && recentlyUpdated;
    const appRunId = `team:${teamName}:member:${agentName}:opencode:${nativeSessionId}`;
    const databasePath = path.join(
      this.#profilesPath,
      profileRootKey,
      'data',
      'opencode',
      'opencode.db'
    );

    return {
      appRunId,
      teamName,
      agentId: `${teamName}:${agentName}`,
      agentName,
      commandId: `team-launch:${teamName}`,
      commandInvocationId: `team-launch:${teamName}:opencode`,
      runtimeKind: 'opencode',
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      billingMode: inferOpenCodeBillingMode(model, authTypes),
      model,
      workspacePathHash: hashOptional(projectPath),
      workspaceLabel: workspaceLabelForPath(projectPath),
      startedAt,
      endedAt: running ? undefined : updatedAt,
      status: running ? 'running' : 'completed',
      source: 'team_launch_state',
      sources: [
        {
          id: `${appRunId}:session:${nativeSessionId}`,
          appRunId,
          sourceType: 'runtime_trace',
          nativeSessionId,
          nativeLogPath: databasePath,
          nativeProjectKey: profileRootKey,
          parserName: 'opencode-sqlite',
          parserVersion: PARSER_VERSION,
          discoveredAt: updatedAt,
        },
      ],
    };
  }
}

function inferOpenCodeBillingMode(
  model: string | undefined,
  authTypes: ReadonlyMap<string, string>
): TokenUsageRunDto['billingMode'] {
  const normalizedModel = model?.trim().toLowerCase() ?? '';
  const providerId = normalizedModel.split('/')[0] ?? '';
  if (
    providerId.startsWith('xiaomi-token-plan-') ||
    providerId === 'zai-coding-plan' ||
    providerId === 'minimax-coding-plan' ||
    providerId === 'kimi-for-coding' ||
    providerId === 'kiro' ||
    providerId === 'cursor-acp' ||
    providerId === 'github-copilot'
  ) {
    return 'subscription';
  }
  const credentialType = authTypes.get(providerId);
  if (credentialType === 'oauth') return 'subscription';
  if (credentialType === 'api') return 'api';
  return inferProviderBillingMode({ providerId: 'opencode', model });
}

async function readBoundRecord(filePath: string, maxBytes: number): Promise<UnknownRecord | null> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxBytes) return null;
    return asRecord(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function hashOptional(value: string | undefined): string | undefined {
  return value ? createHash('sha256').update(value).digest('hex') : undefined;
}

function workspaceLabelForPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return path.basename(value.replace(/[\\/]+$/, '')) || undefined;
}
