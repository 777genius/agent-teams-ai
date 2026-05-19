import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { ProviderModelLaunchIdentity, TeamProviderId } from '@shared/types';

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
  providerId?: 'anthropic' | 'codex' | 'gemini';
  providerBackendId?: string;
  model?: string;
  effort?: string;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
  limitContext?: boolean;
  launchIdentity?: ProviderModelLaunchIdentity;
  createdAt: number;
}

const MAX_META_FILE_BYTES = 256 * 1024;

function normalizeOptionalBackendId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeProviderId(value: unknown): TeamProviderId | undefined {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' ? value : undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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
    raw.selectedEffort === 'xhigh'
      ? raw.selectedEffort
      : null;
  const resolvedEffort =
    raw.resolvedEffort === 'none' ||
    raw.resolvedEffort === 'minimal' ||
    raw.resolvedEffort === 'low' ||
    raw.resolvedEffort === 'medium' ||
    raw.resolvedEffort === 'high' ||
    raw.resolvedEffort === 'xhigh'
      ? raw.resolvedEffort
      : null;

  return {
    providerId,
    providerBackendId:
      migrateProviderBackendId(providerId, normalizeOptionalString(raw.providerBackendId)) ?? null,
    selectedModel: normalizeOptionalString(raw.selectedModel),
    selectedModelKind,
    resolvedLaunchModel: normalizeOptionalString(raw.resolvedLaunchModel),
    catalogId: normalizeOptionalString(raw.catalogId),
    catalogSource,
    catalogFetchedAt: normalizeOptionalString(raw.catalogFetchedAt),
    selectedEffort,
    resolvedEffort,
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

    const providerId =
      file.providerId === 'anthropic' || file.providerId === 'codex' || file.providerId === 'gemini'
        ? file.providerId
        : undefined;

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
      skipPermissions: data.skipPermissions,
      worktree: data.worktree?.trim() || undefined,
      extraCliArgs: data.extraCliArgs?.trim() || undefined,
      limitContext: data.limitContext,
      launchIdentity: normalizeLaunchIdentity(data.launchIdentity),
      createdAt: data.createdAt,
    };
    await atomicWriteAsync(this.getMetaPath(teamName), JSON.stringify(payload, null, 2));
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
