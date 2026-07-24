import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamProviderBackendId, migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeProviderBillingMode } from '@shared/utils/providerBillingMode';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { ProviderModelLaunchIdentity, TeamFastMode, TeamProviderId } from '@shared/types';

/**
 * Persisted team-level metadata saved by the UI before CLI provisioning.
 * CLI does not know about this file — it only reads/writes config.json.
 * If provisioning fails before TeamCreate, this file preserves user's
 * configuration for retry.
 */
export interface TeamMetaFile {
  version: 1;
  displayName?: string;
  description?: string;
  color?: string;
  cwd: string;
  prompt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  fastMode?: TeamFastMode;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
  limitContext?: boolean;
  launchIdentity?: ProviderModelLaunchIdentity;
  createdAt: number;
}

const MAX_META_FILE_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

const TEAM_META_KNOWN_FIELDS = [
  'version',
  'displayName',
  'description',
  'color',
  'cwd',
  'prompt',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'skipPermissions',
  'worktree',
  'extraCliArgs',
  'limitContext',
  'launchIdentity',
  'createdAt',
] as const;

const LAUNCH_IDENTITY_KNOWN_FIELDS = [
  'providerId',
  'providerBackendId',
  'billingMode',
  'selectedModel',
  'selectedModelKind',
  'resolvedLaunchModel',
  'catalogId',
  'catalogSource',
  'catalogFetchedAt',
  'selectedEffort',
  'resolvedEffort',
  'selectedFastMode',
  'resolvedFastMode',
  'fastResolutionReason',
] as const;

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isSupportedPersistedBackendId(
  providerId: TeamProviderId | undefined,
  value: unknown,
  options: { nullable?: boolean } = {}
): boolean {
  if (value === undefined || (options.nullable && value === null)) return true;
  const normalized = normalizeOptionalBackendId(value);
  if (!normalized || !isTeamProviderBackendId(normalized)) return false;
  return providerId === undefined || migrateProviderBackendId(providerId, normalized) !== undefined;
}

function isLaunchEffort(value: unknown): boolean {
  return (
    value === null ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  );
}

function isSupportedLaunchIdentity(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  const providerId = normalizeProviderId(value.providerId);
  return (
    providerId !== undefined &&
    value.providerBackendId !== undefined &&
    isSupportedPersistedBackendId(providerId, value.providerBackendId, { nullable: true }) &&
    (value.billingMode === undefined ||
      value.billingMode === 'api' ||
      value.billingMode === 'subscription' ||
      value.billingMode === 'free' ||
      value.billingMode === 'unknown') &&
    (value.selectedModel === null || typeof value.selectedModel === 'string') &&
    (value.selectedModelKind === 'default' || value.selectedModelKind === 'explicit') &&
    (value.resolvedLaunchModel === null || typeof value.resolvedLaunchModel === 'string') &&
    (value.catalogId === null || typeof value.catalogId === 'string') &&
    (value.catalogSource === 'anthropic-models-api' ||
      value.catalogSource === 'anthropic-compatible-api' ||
      value.catalogSource === 'app-server' ||
      value.catalogSource === 'static-fallback' ||
      value.catalogSource === 'runtime' ||
      value.catalogSource === 'unavailable') &&
    (value.catalogFetchedAt === null || typeof value.catalogFetchedAt === 'string') &&
    isLaunchEffort(value.selectedEffort) &&
    isLaunchEffort(value.resolvedEffort) &&
    (value.selectedFastMode === undefined ||
      value.selectedFastMode === null ||
      normalizeFastMode(value.selectedFastMode) !== null) &&
    (value.resolvedFastMode === undefined ||
      value.resolvedFastMode === null ||
      typeof value.resolvedFastMode === 'boolean') &&
    (value.fastResolutionReason === undefined ||
      value.fastResolutionReason === null ||
      typeof value.fastResolutionReason === 'string')
  );
}

function isSupportedTeamMeta(value: unknown): value is JsonRecord {
  if (!isJsonRecord(value)) return false;
  const providerId = normalizeProviderId(value.providerId);
  return (
    value.version === 1 &&
    typeof value.cwd === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    isOptionalString(value.displayName) &&
    isOptionalString(value.description) &&
    isOptionalString(value.color) &&
    isOptionalString(value.prompt) &&
    (value.providerId === undefined || providerId !== undefined) &&
    (value.providerBackendId === undefined ||
      (providerId !== undefined &&
        isSupportedPersistedBackendId(providerId, value.providerBackendId))) &&
    isOptionalString(value.model) &&
    isOptionalString(value.effort) &&
    (value.fastMode === undefined || normalizeFastMode(value.fastMode) !== null) &&
    isOptionalBoolean(value.skipPermissions) &&
    isOptionalString(value.worktree) &&
    isOptionalString(value.extraCliArgs) &&
    isOptionalBoolean(value.limitContext) &&
    (value.launchIdentity === undefined || isSupportedLaunchIdentity(value.launchIdentity))
  );
}

function replaceKnownFields(
  existing: JsonRecord | null,
  replacement: JsonRecord,
  knownFields: readonly string[]
): JsonRecord {
  const merged = { ...(existing ?? {}) };
  for (const field of knownFields) {
    delete merged[field];
  }
  return Object.assign(merged, replacement);
}

function mergeTeamMeta(existing: JsonRecord | null, replacement: TeamMetaFile): JsonRecord {
  const merged = replaceKnownFields(
    existing,
    replacement as unknown as JsonRecord,
    TEAM_META_KNOWN_FIELDS
  );
  if (replacement.launchIdentity) {
    merged.launchIdentity = replaceKnownFields(
      isJsonRecord(existing?.launchIdentity) ? existing.launchIdentity : null,
      replacement.launchIdentity as unknown as JsonRecord,
      LAUNCH_IDENTITY_KNOWN_FIELDS
    );
  }
  return merged;
}

function normalizeOptionalBackendId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeProviderId(value: unknown): TeamProviderId | undefined {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode'
    ? value
    : undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeFastMode(value: unknown): TeamFastMode | null {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : null;
}

function normalizeLaunchIdentity(value: unknown): ProviderModelLaunchIdentity | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Partial<ProviderModelLaunchIdentity>;
  const providerId = normalizeProviderId(raw.providerId);
  const selectedModelKind =
    raw.selectedModelKind === 'default' || raw.selectedModelKind === 'explicit'
      ? raw.selectedModelKind
      : null;
  if (!providerId || !selectedModelKind) {
    return undefined;
  }

  const catalogSource =
    raw.catalogSource === 'anthropic-models-api' ||
    raw.catalogSource === 'anthropic-compatible-api' ||
    raw.catalogSource === 'app-server' ||
    raw.catalogSource === 'static-fallback' ||
    raw.catalogSource === 'runtime' ||
    raw.catalogSource === 'unavailable'
      ? raw.catalogSource
      : 'unavailable';
  const selectedEffort =
    raw.selectedEffort === 'none' ||
    raw.selectedEffort === 'minimal' ||
    raw.selectedEffort === 'low' ||
    raw.selectedEffort === 'medium' ||
    raw.selectedEffort === 'high' ||
    raw.selectedEffort === 'xhigh' ||
    raw.selectedEffort === 'max' ||
    raw.selectedEffort === 'ultra'
      ? raw.selectedEffort
      : null;
  const resolvedEffort =
    raw.resolvedEffort === 'none' ||
    raw.resolvedEffort === 'minimal' ||
    raw.resolvedEffort === 'low' ||
    raw.resolvedEffort === 'medium' ||
    raw.resolvedEffort === 'high' ||
    raw.resolvedEffort === 'xhigh' ||
    raw.resolvedEffort === 'max' ||
    raw.resolvedEffort === 'ultra'
      ? raw.resolvedEffort
      : null;

  return {
    providerId,
    providerBackendId:
      migrateProviderBackendId(providerId, normalizeOptionalString(raw.providerBackendId)) ?? null,
    billingMode: normalizeProviderBillingMode(raw.billingMode),
    selectedModel: normalizeOptionalString(raw.selectedModel),
    selectedModelKind,
    resolvedLaunchModel: normalizeOptionalString(raw.resolvedLaunchModel),
    catalogId: normalizeOptionalString(raw.catalogId),
    catalogSource,
    catalogFetchedAt: normalizeOptionalString(raw.catalogFetchedAt),
    selectedEffort,
    resolvedEffort,
    selectedFastMode: normalizeFastMode(raw.selectedFastMode),
    resolvedFastMode: typeof raw.resolvedFastMode === 'boolean' ? raw.resolvedFastMode : null,
    fastResolutionReason: normalizeOptionalString(raw.fastResolutionReason),
  };
}

export class TeamMetaStore {
  private getMetaPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'team.meta.json');
  }

  async getMeta(teamName: string): Promise<TeamMetaFile | null> {
    const metaPath = this.getMetaPath(teamName);
    try {
      const stat = await fs.promises.stat(metaPath);
      if (!stat.isFile() || stat.size > MAX_META_FILE_BYTES) {
        return null;
      }
    } catch {
      return null;
    }

    let raw: string;
    try {
      raw = await readFileUtf8WithTimeout(metaPath, 5_000);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        error instanceof FileReadTimeoutError
      ) {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const file = parsed as Partial<TeamMetaFile>;
    if (file.version !== 1 || typeof file.cwd !== 'string') {
      return null;
    }

    const providerId = normalizeProviderId(file.providerId);

    return {
      version: 1,
      displayName:
        typeof file.displayName === 'string' ? file.displayName.trim() || undefined : undefined,
      description:
        typeof file.description === 'string' ? file.description.trim() || undefined : undefined,
      color: typeof file.color === 'string' ? file.color.trim() || undefined : undefined,
      cwd: file.cwd.trim(),
      prompt: typeof file.prompt === 'string' ? file.prompt.trim() || undefined : undefined,
      providerId,
      providerBackendId: migrateProviderBackendId(
        providerId,
        normalizeOptionalBackendId(file.providerBackendId)
      ),
      model: typeof file.model === 'string' ? file.model.trim() || undefined : undefined,
      effort: typeof file.effort === 'string' ? file.effort.trim() || undefined : undefined,
      fastMode: normalizeFastMode(file.fastMode) ?? undefined,
      skipPermissions: typeof file.skipPermissions === 'boolean' ? file.skipPermissions : undefined,
      worktree: typeof file.worktree === 'string' ? file.worktree.trim() || undefined : undefined,
      extraCliArgs:
        typeof file.extraCliArgs === 'string' ? file.extraCliArgs.trim() || undefined : undefined,
      limitContext: typeof file.limitContext === 'boolean' ? file.limitContext : undefined,
      launchIdentity: normalizeLaunchIdentity(file.launchIdentity),
      createdAt: typeof file.createdAt === 'number' ? file.createdAt : Date.now(),
    };
  }

  async writeMeta(teamName: string, data: Omit<TeamMetaFile, 'version'>): Promise<void> {
    const payload: TeamMetaFile = {
      version: 1,
      displayName: data.displayName?.trim() || undefined,
      description: data.description?.trim() || undefined,
      color: data.color?.trim() || undefined,
      cwd: data.cwd.trim(),
      prompt: data.prompt?.trim() || undefined,
      providerId: data.providerId,
      providerBackendId: migrateProviderBackendId(
        data.providerId,
        normalizeOptionalBackendId(data.providerBackendId)
      ),
      model: data.model?.trim() || undefined,
      effort: data.effort?.trim() || undefined,
      fastMode: normalizeFastMode(data.fastMode) ?? undefined,
      skipPermissions: data.skipPermissions,
      worktree: data.worktree?.trim() || undefined,
      extraCliArgs: data.extraCliArgs?.trim() || undefined,
      limitContext: data.limitContext,
      launchIdentity: normalizeLaunchIdentity(data.launchIdentity),
      createdAt: data.createdAt,
    };
    const metaPath = this.getMetaPath(teamName);
    const existing = await this.readMetaForMutation(metaPath);
    await atomicWriteAsync(metaPath, JSON.stringify(mergeTeamMeta(existing, payload), null, 2));
  }

  private async readMetaForMutation(metaPath: string): Promise<JsonRecord | null> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(metaPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    if (!stat.isFile() || stat.size > MAX_META_FILE_BYTES) {
      throw new Error('Refusing to replace unsafe or oversized team metadata');
    }

    const raw = await readFileUtf8WithTimeout(metaPath, 5_000);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error('Refusing to replace malformed team metadata', { cause: error });
    }
    if (!isSupportedTeamMeta(parsed)) {
      throw new Error('Refusing to replace unsupported team metadata');
    }
    return parsed;
  }

  async deleteMeta(teamName: string): Promise<void> {
    try {
      await fs.promises.unlink(this.getMetaPath(teamName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
