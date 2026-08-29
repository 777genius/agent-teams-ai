import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { normalizePersistedProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeProviderBillingMode } from '@shared/utils/providerBillingMode';
import { normalizeTeamLeadRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type {
  ProviderModelLaunchIdentity,
  TeamFastMode,
  TeamLeadRuntimeSelectionProvenance,
  TeamProviderId,
} from '@shared/types';

/**
 * Persisted team-level metadata saved by the UI before CLI provisioning.
 * CLI does not know about this file — it only reads/writes config.json.
 * If provisioning fails before TeamCreate, this file preserves user's
 * configuration for retry.
 */
export interface TeamMetaFile {
  version: 1 | 2;
  displayName?: string;
  description?: string;
  color?: string;
  cwd: string;
  prompt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  leadRuntimeSelectionProvenance?: TeamLeadRuntimeSelectionProvenance;
  fastMode?: TeamFastMode;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
  limitContext?: boolean;
  launchIdentity?: ProviderModelLaunchIdentity;
  createdAt: number;
}

const MAX_META_FILE_BYTES = 256 * 1024;
const metaMutationLocks = new Map<string, Promise<void>>();

export class UnsupportedTeamMetaVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported team metadata version: ${String(version)}`);
    this.name = 'UnsupportedTeamMetaVersionError';
  }
}

async function withMetaMutationLock<T>(pathKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = metaMutationLocks.get(pathKey);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  metaMutationLocks.set(pathKey, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (metaMutationLocks.get(pathKey) === current) metaMutationLocks.delete(pathKey);
  }
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

function normalizeLaunchIdentity(
  value: unknown,
  source: 'legacy-storage' | 'explicit-selection'
): ProviderModelLaunchIdentity | undefined {
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
  const rawProviderBackendId = normalizeOptionalString(raw.providerBackendId);
  const providerBackendId = normalizePersistedProviderBackendId(
    providerId,
    rawProviderBackendId,
    source === 'explicit-selection' ? 'current-version' : 'legacy-unversioned'
  );

  return {
    providerId,
    // The provider/backend pair belongs to this identity record. Preserve an
    // absent or incompatible backend as unknown instead of allowing consumers
    // to borrow a backend from root or roster metadata.
    providerBackendId: providerBackendId ?? null,
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

async function assertSupportedMetaVersionForMutation(metaPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(metaPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Existing team metadata is malformed', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Existing team metadata is malformed');
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== undefined && version !== 1 && version !== 2) {
    throw new UnsupportedTeamMetaVersionError(version);
  }
  if (version === 2 && typeof (parsed as { cwd?: unknown }).cwd !== 'string') {
    throw new Error('Existing team metadata is malformed');
  }
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
    if (
      (file.version !== undefined && file.version !== 1 && file.version !== 2) ||
      typeof file.cwd !== 'string'
    ) {
      return null;
    }

    const version = file.version === 2 ? 2 : 1;
    const migrationSource = version === 2 ? 'explicit-selection' : 'legacy-storage';
    const providerId = normalizeProviderId(file.providerId);

    return {
      version,
      displayName:
        typeof file.displayName === 'string' ? file.displayName.trim() || undefined : undefined,
      description:
        typeof file.description === 'string' ? file.description.trim() || undefined : undefined,
      color: typeof file.color === 'string' ? file.color.trim() || undefined : undefined,
      cwd: file.cwd.trim(),
      prompt: typeof file.prompt === 'string' ? file.prompt.trim() || undefined : undefined,
      providerId,
      providerBackendId: normalizePersistedProviderBackendId(
        providerId,
        normalizeOptionalBackendId(file.providerBackendId),
        migrationSource === 'explicit-selection' ? 'current-version' : 'legacy-unversioned'
      ),
      model: typeof file.model === 'string' ? file.model.trim() || undefined : undefined,
      effort: typeof file.effort === 'string' ? file.effort.trim() || undefined : undefined,
      leadRuntimeSelectionProvenance: normalizeTeamLeadRuntimeSelectionProvenance(
        file.leadRuntimeSelectionProvenance
      ),
      fastMode: normalizeFastMode(file.fastMode) ?? undefined,
      skipPermissions: typeof file.skipPermissions === 'boolean' ? file.skipPermissions : undefined,
      worktree: typeof file.worktree === 'string' ? file.worktree.trim() || undefined : undefined,
      extraCliArgs:
        typeof file.extraCliArgs === 'string' ? file.extraCliArgs.trim() || undefined : undefined,
      limitContext: typeof file.limitContext === 'boolean' ? file.limitContext : undefined,
      launchIdentity: normalizeLaunchIdentity(file.launchIdentity, migrationSource),
      createdAt: typeof file.createdAt === 'number' ? file.createdAt : Date.now(),
    };
  }

  async assertMutable(teamName: string): Promise<void> {
    await assertSupportedMetaVersionForMutation(this.getMetaPath(teamName));
  }

  async writeMeta(teamName: string, data: Omit<TeamMetaFile, 'version'>): Promise<void> {
    const metaPath = this.getMetaPath(teamName);
    await withMetaMutationLock(metaPath, async () => {
      await assertSupportedMetaVersionForMutation(metaPath);
      await this.writeMetaUnlocked(metaPath, data);
    });
  }

  async updateMeta(
    teamName: string,
    update: (
      current: TeamMetaFile | null
    ) => Omit<TeamMetaFile, 'version'> | Promise<Omit<TeamMetaFile, 'version'>>
  ): Promise<void> {
    const metaPath = this.getMetaPath(teamName);
    await withMetaMutationLock(metaPath, async () => {
      await assertSupportedMetaVersionForMutation(metaPath);
      const data = await update(await this.getMeta(teamName));
      await this.writeMetaUnlocked(metaPath, data);
    });
  }

  private async writeMetaUnlocked(
    metaPath: string,
    data: Omit<TeamMetaFile, 'version'>
  ): Promise<void> {
    const payload: TeamMetaFile = {
      version: 2,
      displayName: data.displayName?.trim() || undefined,
      description: data.description?.trim() || undefined,
      color: data.color?.trim() || undefined,
      cwd: data.cwd.trim(),
      prompt: data.prompt?.trim() || undefined,
      providerId: data.providerId,
      providerBackendId: normalizePersistedProviderBackendId(
        data.providerId,
        normalizeOptionalBackendId(data.providerBackendId),
        'current-version'
      ),
      model: data.model?.trim() || undefined,
      effort: data.effort?.trim() || undefined,
      leadRuntimeSelectionProvenance: normalizeTeamLeadRuntimeSelectionProvenance(
        data.leadRuntimeSelectionProvenance
      ),
      fastMode: normalizeFastMode(data.fastMode) ?? undefined,
      skipPermissions: data.skipPermissions,
      worktree: data.worktree?.trim() || undefined,
      extraCliArgs: data.extraCliArgs?.trim() || undefined,
      limitContext: data.limitContext,
      launchIdentity: normalizeLaunchIdentity(data.launchIdentity, 'explicit-selection'),
      createdAt: data.createdAt,
    };
    await atomicWriteAsync(metaPath, JSON.stringify(payload, null, 2));
  }

  async deleteMeta(teamName: string): Promise<void> {
    const metaPath = this.getMetaPath(teamName);
    await withMetaMutationLock(metaPath, async () => {
      await assertSupportedMetaVersionForMutation(metaPath);
      try {
        await fs.promises.unlink(metaPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    });
  }
}
