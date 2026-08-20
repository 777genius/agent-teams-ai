import { mkdir, readdir, readFile, rm } from 'node:fs/promises';

import { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';
import {
  durablePathExistsAsync,
  readJsonDataEnvelopeNoFollowAsync,
  readOptionalJsonNoFollowAsync,
  removeDirectoryEntriesExceptAsync,
  withIdentityStableDirectoryTreeAsync,
  withIdentityStableIndexedDirectoryLocksAsync,
} from '@main/utils/durablePathOperations';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { withFileLock } from '../../fileLock';

import {
  type ClearOpenCodeRuntimeLaneStorageParams,
  type ClearOpenCodeRuntimeLaneStorageResult,
  normalizeOpenCodeBootstrapSessionRecord,
  type OpenCodeCommittedBootstrapSessionEvidence,
  type OpenCodeCommittedBootstrapSessionRecord,
  readRuntimeStoreManifestEvidenceData,
  resolveOpenCodeRuntimeLaneClearOwnership,
} from './OpenCodeBootstrapSessionNormalization';
import {
  createRuntimeStoreManifestStore,
  OPENCODE_RUNTIME_STORE_DESCRIPTORS,
  OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION,
  RuntimeStoreFileInspector,
  validateRuntimeStoreManifest,
} from './RuntimeStoreManifest';

import type { RuntimeStoreManifestEvidence } from '../bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../bridge/OpenCodeStateChangingBridgeCommandService';

export type {
  ClearOpenCodeRuntimeLaneStorageParams,
  ClearOpenCodeRuntimeLaneStorageResult,
  OpenCodeCommittedBootstrapSessionEvidence,
  OpenCodeCommittedBootstrapSessionRecord,
} from './OpenCodeBootstrapSessionNormalization';

const logger = createLogger('OpenCodeRuntimeManifestEvidenceReader');

export interface OpenCodeRuntimeManifestEvidenceReaderOptions {
  teamsBasePath: string;
  clock?: () => Date;
}

const OPENCODE_TEAM_RUNTIME_DIR = '.opencode-runtime';
const OPENCODE_TEAM_RUNTIME_LANES_DIR = 'lanes';
const OPENCODE_TEAM_RUNTIME_LANES_INDEX_FILE = 'lanes.json';
const OPENCODE_RUNTIME_MANIFEST_FILE = 'manifest.json';
const OPENCODE_RUNTIME_RUN_TOMBSTONES_FILE = 'opencode-run-tombstones.json';
const OPENCODE_RUNTIME_DELIVERY_JOURNAL_FILE = 'opencode-delivery-journal.json';
const OPENCODE_RUNTIME_LANE_DURABLE_ARTIFACTS = new Set([
  OPENCODE_RUNTIME_DELIVERY_JOURNAL_FILE,
  OPENCODE_RUNTIME_RUN_TOMBSTONES_FILE,
]);
const OPENCODE_ACTIVE_EMPTY_LANE_STALE_MS = 150_000;
const OPENCODE_LANE_INDEX_LOCK_OPTIONS = {
  acquireTimeoutMs: 30_000,
  staleTimeoutMs: 25_000,
  retryIntervalMs: 25,
} as const;
const OPENCODE_RUNTIME_EVIDENCE_FILES = new Set(
  OPENCODE_RUNTIME_STORE_DESCRIPTORS.filter(
    (descriptor) =>
      descriptor.schemaName !== 'opencode.promptDeliveryLedger' &&
      descriptor.schemaName !== 'opencode.deliveryJournal'
  ).map((descriptor) => descriptor.relativePath)
);

export interface OpenCodeRuntimeLaneIndexEntry {
  laneId: string;
  runId?: string;
  state: 'active' | 'stopped' | 'degraded';
  updatedAt: string;
  diagnostics?: string[];
}

export interface OpenCodeRuntimeLaneIndex {
  version: 1;
  updatedAt: string;
  lanes: Record<string, OpenCodeRuntimeLaneIndexEntry>;
}

function createEmptyOpenCodeRuntimeLaneIndex(
  updatedAt = new Date().toISOString()
): OpenCodeRuntimeLaneIndex {
  return {
    version: 1,
    updatedAt,
    lanes: {},
  };
}

function normalizeOpenCodeRuntimeLaneIndex(
  parsed: Partial<OpenCodeRuntimeLaneIndex>,
  fallbackUpdatedAt = new Date().toISOString()
): OpenCodeRuntimeLaneIndex {
  if (
    parsed.version !== 1 ||
    typeof parsed.updatedAt !== 'string' ||
    !parsed.lanes ||
    typeof parsed.lanes !== 'object'
  ) {
    return createEmptyOpenCodeRuntimeLaneIndex(fallbackUpdatedAt);
  }

  return {
    version: 1,
    updatedAt: parsed.updatedAt,
    lanes: Object.fromEntries(
      Object.entries(parsed.lanes).flatMap(([key, value]) => {
        if (
          !value ||
          typeof value !== 'object' ||
          typeof value.laneId !== 'string' ||
          typeof value.updatedAt !== 'string'
        ) {
          return [];
        }
        const entry = value;
        return [
          [
            key,
            {
              laneId: entry.laneId,
              runId:
                typeof entry.runId === 'string' && entry.runId.trim() ? entry.runId : undefined,
              state:
                entry.state === 'active' || entry.state === 'stopped' || entry.state === 'degraded'
                  ? entry.state
                  : 'degraded',
              updatedAt: entry.updatedAt,
              diagnostics: Array.isArray(entry.diagnostics)
                ? entry.diagnostics.filter((item): item is string => typeof item === 'string')
                : undefined,
            } satisfies OpenCodeRuntimeLaneIndexEntry,
          ],
        ];
      })
    ),
  };
}

async function quarantineInvalidOpenCodeRuntimeLaneIndex(
  filePath: string,
  raw: string,
  error: unknown
): Promise<void> {
  const dir = path.dirname(filePath);
  const quarantinePath = path.join(dir, `lanes.invalid.${Date.now()}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await atomicWriteAsync(quarantinePath, raw);
    await rm(filePath, { force: true });
    logger.warn(
      `Quarantined invalid OpenCode lane index ${filePath} -> ${quarantinePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } catch (quarantineError) {
    logger.warn(
      `Failed to quarantine invalid OpenCode lane index ${filePath}: ${
        quarantineError instanceof Error ? quarantineError.message : String(quarantineError)
      }`
    );
  }
}
async function readOpenCodeRuntimeLaneIndexUnlocked(
  teamsBasePath: string,
  teamName: string,
  runtimeDirectory = getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName)
): Promise<OpenCodeRuntimeLaneIndex> {
  const filePath = path.join(runtimeDirectory, OPENCODE_TEAM_RUNTIME_LANES_INDEX_FILE);
  if (!(await durablePathExistsAsync(filePath))) {
    return createEmptyOpenCodeRuntimeLaneIndex();
  }
  const raw = await readFile(filePath, 'utf8');
  let parsed: Partial<OpenCodeRuntimeLaneIndex>;
  try {
    parsed = JSON.parse(raw) as Partial<OpenCodeRuntimeLaneIndex>;
  } catch (error) {
    await quarantineInvalidOpenCodeRuntimeLaneIndex(filePath, raw, error);
    return createEmptyOpenCodeRuntimeLaneIndex();
  }
  return normalizeOpenCodeRuntimeLaneIndex(parsed);
}
async function writeOpenCodeRuntimeLaneIndexUnlocked(
  teamsBasePath: string,
  teamName: string,
  index: OpenCodeRuntimeLaneIndex,
  runtimeDirectory = getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName)
): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true });
  await atomicWriteAsync(
    path.join(runtimeDirectory, OPENCODE_TEAM_RUNTIME_LANES_INDEX_FILE),
    `${JSON.stringify(index, null, 2)}\n`
  );
}
export class OpenCodeRuntimeManifestEvidenceReader implements RuntimeStoreManifestReader {
  private readonly teamsBasePath: string;
  private readonly clock: () => Date;
  constructor(options: OpenCodeRuntimeManifestEvidenceReaderOptions) {
    this.teamsBasePath = options.teamsBasePath;
    this.clock = options.clock ?? (() => new Date());
  }
  async read(teamName: string, laneId?: string | null): Promise<RuntimeStoreManifestEvidence> {
    const normalizedLaneId = laneId?.trim() || null;
    const manifestPath = normalizedLaneId
      ? await resolveOpenCodeRuntimeManifestReadPath(this.teamsBasePath, teamName, normalizedLaneId)
      : getOpenCodeRuntimeManifestPath(this.teamsBasePath, teamName);
    const manifest = await readRuntimeStoreManifestEvidenceData(manifestPath, teamName, this.clock);
    return {
      highWatermark: manifest.highWatermark,
      activeRunId: manifest.activeRunId,
      capabilitySnapshotId: manifest.activeCapabilitySnapshotId,
    };
  }
}
async function readOpenCodeBootstrapSessionStore(
  filePath: string,
  expected: {
    teamName: string;
    laneId: string;
  }
): Promise<OpenCodeCommittedBootstrapSessionRecord[]> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const data =
    record && Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : record;
  const sessions =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).sessions
      : null;
  if (!Array.isArray(sessions)) {
    return [];
  }
  return sessions.flatMap((session): OpenCodeCommittedBootstrapSessionRecord[] => {
    const normalized = normalizeOpenCodeBootstrapSessionRecord(session);
    if (!normalized) {
      return [];
    }
    if (normalized.teamName !== expected.teamName || normalized.laneId !== expected.laneId) {
      return [];
    }
    return [normalized];
  });
}
async function resolveOpenCodeRuntimeManifestReadPath(
  teamsBasePath: string,
  teamName: string,
  laneId: string
): Promise<string> {
  const laneManifestPath = getOpenCodeRuntimeManifestPath(teamsBasePath, teamName, laneId);
  if (await durablePathExistsAsync(laneManifestPath)) {
    return laneManifestPath;
  }
  const legacyManifestPath = getOpenCodeRuntimeManifestPath(teamsBasePath, teamName);
  if (!(await durablePathExistsAsync(legacyManifestPath))) {
    return laneManifestPath;
  }
  if (!(await canFallbackToLegacyManifest(teamsBasePath, teamName, laneId))) {
    return laneManifestPath;
  }
  return legacyManifestPath;
}
async function canFallbackToLegacyManifest(
  teamsBasePath: string,
  teamName: string,
  laneId: string
): Promise<boolean> {
  const laneDirsPath = path.join(
    getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName),
    OPENCODE_TEAM_RUNTIME_LANES_DIR
  );
  const existingLaneDirs = await readdir(laneDirsPath).catch(() => [] as string[]);
  if (existingLaneDirs.length > 0) {
    return false;
  }
  const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, teamName).catch(() => ({
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    lanes: {},
  }));
  const siblingLaneIds = Object.keys(laneIndex.lanes).filter(
    (candidateLaneId) => candidateLaneId !== laneId
  );
  return siblingLaneIds.length === 0;
}
export function getOpenCodeTeamRuntimeDirectory(teamsBasePath: string, teamName: string): string {
  return path.join(teamsBasePath, teamName, OPENCODE_TEAM_RUNTIME_DIR);
}
export function getOpenCodeRuntimeLaneIndexPath(teamsBasePath: string, teamName: string): string {
  return path.join(
    getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName),
    OPENCODE_TEAM_RUNTIME_LANES_INDEX_FILE
  );
}
export function getOpenCodeTeamRuntimeLaneDirectory(
  teamsBasePath: string,
  teamName: string,
  laneId: string
): string {
  return path.join(
    getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName),
    OPENCODE_TEAM_RUNTIME_LANES_DIR,
    encodeURIComponent(laneId)
  );
}
export function getOpenCodeRuntimeManifestPath(
  teamsBasePath: string,
  teamName: string,
  laneId?: string | null
): string {
  if (laneId && laneId.trim().length > 0) {
    return path.join(
      getOpenCodeTeamRuntimeLaneDirectory(teamsBasePath, teamName, laneId.trim()),
      OPENCODE_RUNTIME_MANIFEST_FILE
    );
  }
  return path.join(
    getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName),
    OPENCODE_RUNTIME_MANIFEST_FILE
  );
}
export async function inspectOpenCodeRuntimeLaneStorage(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
}): Promise<{
  laneDirectoryExists: boolean;
  hasStateOnDisk: boolean;
  hasRuntimeEvidenceOnDisk: boolean;
  manifestEntryCount: number | null;
  manifestUpdatedAt: string | null;
  fileNames: string[];
}> {
  const laneDir = getOpenCodeTeamRuntimeLaneDirectory(
    params.teamsBasePath,
    params.teamName,
    params.laneId
  );
  const laneDirectoryExists = await durablePathExistsAsync(laneDir);
  if (!laneDirectoryExists) {
    return {
      laneDirectoryExists: false,
      hasStateOnDisk: false,
      hasRuntimeEvidenceOnDisk: false,
      manifestEntryCount: null,
      manifestUpdatedAt: null,
      fileNames: [],
    };
  }
  const fileNames = (await readdir(laneDir).catch(() => [] as string[])).sort((left, right) =>
    left.localeCompare(right)
  );
  const manifestPath = getOpenCodeRuntimeManifestPath(
    params.teamsBasePath,
    params.teamName,
    params.laneId
  );
  const manifest = (await durablePathExistsAsync(manifestPath))
    ? await readRuntimeStoreManifestEvidenceData(
        manifestPath,
        params.teamName,
        () => new Date()
      ).catch(() => null)
    : null;
  const hasRuntimeEvidenceFile = fileNames.some((fileName) =>
    OPENCODE_RUNTIME_EVIDENCE_FILES.has(fileName)
  );
  const hasRuntimeEvidenceManifestEntry =
    manifest?.entries.some((entry) => OPENCODE_RUNTIME_EVIDENCE_FILES.has(entry.relativePath)) ??
    false;
  return {
    laneDirectoryExists: true,
    hasStateOnDisk: fileNames.length > 0,
    hasRuntimeEvidenceOnDisk: hasRuntimeEvidenceFile || hasRuntimeEvidenceManifestEntry,
    manifestEntryCount: manifest ? manifest.entries.length : null,
    manifestUpdatedAt: manifest?.updatedAt ?? null,
    fileNames,
  };
}
export interface OpenCodeRuntimeLaneLaunchGenerationPreparation {
  reset: boolean;
  reason:
    | 'fresh_manifest_created'
    | 'same_generation_reused'
    | 'forced_reset'
    | 'manifest_unreadable'
    | 'lane_index_terminal'
    | 'active_run_mismatch'
    | 'stale_manifest_entries';
  diagnostics: string[];
}
export async function prepareOpenCodeRuntimeLaneForLaunchGeneration(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
  runId: string;
  reason: string;
  forceReset?: boolean;
  clock?: () => Date;
}): Promise<OpenCodeRuntimeLaneLaunchGenerationPreparation> {
  return withOpenCodeRuntimeLaneLifecycleLock(params, (runtimeDirectory, lanesDirectory) =>
    prepareOpenCodeRuntimeLaneForLaunchGenerationUnlocked(params, runtimeDirectory, lanesDirectory)
  );
}
async function prepareOpenCodeRuntimeLaneForLaunchGenerationUnlocked(
  params: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    runId: string;
    reason: string;
    forceReset?: boolean;
    clock?: () => Date;
  },
  stableRuntimeDirectory: string,
  stableLanesDirectory: string
): Promise<OpenCodeRuntimeLaneLaunchGenerationPreparation> {
  const clock = params.clock ?? (() => new Date());
  const manifestPath = path.join(
    stableLanesDirectory,
    encodeURIComponent(params.laneId.trim()),
    OPENCODE_RUNTIME_MANIFEST_FILE
  );
  const laneIndex = await readOpenCodeRuntimeLaneIndexUnlocked(
    params.teamsBasePath,
    params.teamName,
    stableRuntimeDirectory
  ).catch(() => null);
  const laneIndexEntry = laneIndex?.lanes[params.laneId] ?? null;
  const terminalLaneIndex =
    laneIndexEntry?.state === 'degraded' || laneIndexEntry?.state === 'stopped';
  let manifest: Awaited<ReturnType<typeof readRuntimeStoreManifestEvidenceData>> | null = null;
  let manifestUnreadable = false;
  if (await durablePathExistsAsync(manifestPath)) {
    try {
      manifest = await readRuntimeStoreManifestEvidenceData(manifestPath, params.teamName, clock);
    } catch {
      manifestUnreadable = true;
    }
  }
  const staleEntryRunIds =
    manifest?.entries
      .filter((entry) => entry.runId !== params.runId)
      .map((entry) => entry.runId ?? 'none') ?? [];
  const activeRunMismatch = Boolean(manifest && manifest.activeRunId !== params.runId);
  const shouldReset =
    params.forceReset ||
    manifestUnreadable ||
    terminalLaneIndex ||
    activeRunMismatch ||
    staleEntryRunIds.length > 0;
  let reason: OpenCodeRuntimeLaneLaunchGenerationPreparation['reason'];
  const diagnostics: string[] = [];
  if (params.forceReset) {
    reason = 'forced_reset';
    diagnostics.push(
      `Reset OpenCode runtime lane ${params.laneId} before ${params.reason}: forced reset requested.`
    );
  } else if (manifestUnreadable) {
    reason = 'manifest_unreadable';
    diagnostics.push(
      `Reset OpenCode runtime lane ${params.laneId} before ${params.reason}: runtime manifest could not be read.`
    );
  } else if (terminalLaneIndex) {
    reason = 'lane_index_terminal';
    diagnostics.push(
      `Reset OpenCode runtime lane ${params.laneId} before ${params.reason}: previous lane state was ${laneIndexEntry?.state}.`
    );
  } else if (activeRunMismatch) {
    reason = 'active_run_mismatch';
    diagnostics.push(
      `Reset OpenCode runtime lane ${params.laneId} before ${params.reason}: active run changed from ${manifest?.activeRunId ?? 'none'} to ${params.runId}.`
    );
  } else if (staleEntryRunIds.length > 0) {
    reason = 'stale_manifest_entries';
    diagnostics.push(
      `Reset OpenCode runtime lane ${params.laneId} before ${params.reason}: runtime manifest contained entries from previous run ${Array.from(new Set(staleEntryRunIds)).join(', ')}.`
    );
  } else if (!manifest) {
    reason = 'fresh_manifest_created';
    diagnostics.push(`Prepared fresh OpenCode runtime lane ${params.laneId} for ${params.reason}.`);
  } else {
    reason = 'same_generation_reused';
  }
  if (shouldReset) {
    await clearLaneStorageUnlocked(
      {
        teamsBasePath: params.teamsBasePath,
        teamName: params.teamName,
        laneId: params.laneId,
      },
      false,
      stableRuntimeDirectory,
      stableLanesDirectory
    );
  }
  await upsertOpenCodeRuntimeLaneIndexEntry(
    {
      teamsBasePath: params.teamsBasePath,
      teamName: params.teamName,
      laneId: params.laneId,
      runId: params.runId,
      state: 'active',
      diagnostics: diagnostics.length ? diagnostics : undefined,
    },
    stableRuntimeDirectory
  );
  await setOpenCodeRuntimeActiveRunManifestUnlocked(
    {
      teamsBasePath: params.teamsBasePath,
      teamName: params.teamName,
      laneId: params.laneId,
      runId: params.runId,
      clock,
    },
    stableRuntimeDirectory,
    stableLanesDirectory
  );
  return {
    reset: shouldReset,
    reason,
    diagnostics,
  };
}
export function getOpenCodeLaneScopedRuntimeFilePath(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
  fileName: string;
}): string {
  return path.join(
    getOpenCodeTeamRuntimeLaneDirectory(params.teamsBasePath, params.teamName, params.laneId),
    params.fileName
  );
}
export async function readCommittedOpenCodeBootstrapSessionEvidence(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
}): Promise<OpenCodeCommittedBootstrapSessionEvidence> {
  const descriptor = OPENCODE_RUNTIME_STORE_DESCRIPTORS.find(
    (candidate) => candidate.schemaName === 'opencode.sessionStore'
  );
  if (!descriptor) {
    return {
      state: 'descriptor_missing',
      committed: false,
      activeRunId: null,
      sessions: [],
      diagnostics: ['OpenCode session store descriptor is not registered.'],
    };
  }
  const runtimeDirectory = getOpenCodeTeamRuntimeLaneDirectory(
    params.teamsBasePath,
    params.teamName,
    params.laneId
  );
  const manifestPath = getOpenCodeRuntimeManifestPath(
    params.teamsBasePath,
    params.teamName,
    params.laneId
  );
  const manifestStore = createRuntimeStoreManifestStore({
    filePath: manifestPath,
    teamName: params.teamName,
  });
  const manifest = await manifestStore.read().catch(() => null);
  if (!manifest) {
    return {
      state: 'invalid_store',
      committed: false,
      activeRunId: null,
      sessions: [],
      diagnostics: ['OpenCode runtime manifest could not be read.'],
    };
  }

  const inspection = await new RuntimeStoreFileInspector(runtimeDirectory)
    .inspect({ descriptor, manifest })
    .catch((error: unknown) => ({
      state: 'invalid_store' as const,
      message: `OpenCode session store inspection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }));
  const diagnostics = inspection.message ? [inspection.message] : [];
  if (inspection.state !== 'healthy') {
    return {
      state: inspection.state,
      committed: false,
      activeRunId: manifest.activeRunId,
      sessions: [],
      diagnostics,
    };
  }

  const sessionStorePath = path.join(runtimeDirectory, descriptor.relativePath);
  const sessions = await readOpenCodeBootstrapSessionStore(sessionStorePath, params).catch(
    (error: unknown) => {
      diagnostics.push(
        `OpenCode session store could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }
  );
  if (sessions.length === 0) {
    diagnostics.push('OpenCode session store has no committed bootstrap sessions.');
  }
  return {
    state: 'healthy',
    committed: true,
    activeRunId: manifest.activeRunId,
    sessions,
    diagnostics,
  };
}

export async function readOpenCodeRuntimeLaneIndex(
  teamsBasePath: string,
  teamName: string
): Promise<OpenCodeRuntimeLaneIndex> {
  return readOpenCodeRuntimeLaneIndexUnlocked(teamsBasePath, teamName);
}

export async function writeOpenCodeRuntimeLaneIndex(
  teamsBasePath: string,
  teamName: string,
  index: OpenCodeRuntimeLaneIndex
): Promise<void> {
  const filePath = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
  await withFileLock(
    filePath,
    async () => {
      await writeOpenCodeRuntimeLaneIndexUnlocked(teamsBasePath, teamName, index);
    },
    OPENCODE_LANE_INDEX_LOCK_OPTIONS
  );
}
export async function upsertOpenCodeRuntimeLaneIndexEntry(
  params: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    runId?: string;
    state: OpenCodeRuntimeLaneIndexEntry['state'];
    diagnostics?: string[];
  },
  stableRuntimeDirectory = getOpenCodeTeamRuntimeDirectory(params.teamsBasePath, params.teamName)
): Promise<void> {
  const filePath = path.join(stableRuntimeDirectory, OPENCODE_TEAM_RUNTIME_LANES_INDEX_FILE);
  await withFileLock(
    filePath,
    async () => {
      const index = await readOpenCodeRuntimeLaneIndexUnlocked(
        params.teamsBasePath,
        params.teamName,
        stableRuntimeDirectory
      );
      const previousEntry = index.lanes[params.laneId];
      index.updatedAt = new Date().toISOString();
      index.lanes[params.laneId] = {
        laneId: params.laneId,
        runId: params.runId ?? previousEntry?.runId,
        state: params.state,
        updatedAt: index.updatedAt,
        diagnostics: params.diagnostics?.length ? [...params.diagnostics] : undefined,
      };
      await writeOpenCodeRuntimeLaneIndexUnlocked(
        params.teamsBasePath,
        params.teamName,
        index,
        stableRuntimeDirectory
      );
    },
    OPENCODE_LANE_INDEX_LOCK_OPTIONS
  );
}
export async function setOpenCodeRuntimeActiveRunManifest(params: {
  teamsBasePath: string;
  teamName: string;
  laneId?: string | null;
  runId: string | null;
  clock?: () => Date;
}): Promise<void> {
  await withOpenCodeRuntimeLaneLifecycleLock(params, (runtimeDirectory, lanesDirectory) =>
    setOpenCodeRuntimeActiveRunManifestUnlocked(params, runtimeDirectory, lanesDirectory)
  );
}

async function setOpenCodeRuntimeActiveRunManifestUnlocked(
  params: {
    teamsBasePath: string;
    teamName: string;
    laneId?: string | null;
    runId: string | null;
    clock?: () => Date;
  },
  stableRuntimeDirectory: string,
  stableLanesDirectory: string
): Promise<void> {
  const normalizedLaneId = params.laneId?.trim();
  const manifestPath = normalizedLaneId
    ? path.join(
        stableLanesDirectory,
        encodeURIComponent(normalizedLaneId),
        OPENCODE_RUNTIME_MANIFEST_FILE
      )
    : path.join(stableRuntimeDirectory, OPENCODE_RUNTIME_MANIFEST_FILE);
  await ensureRuntimeManifestEnvelope(
    manifestPath,
    params.teamName,
    params.clock ?? (() => new Date())
  );
  const manifestStore = createRuntimeStoreManifestStore({
    filePath: manifestPath,
    teamName: params.teamName,
    clock: params.clock,
  });
  await manifestStore.setActiveRun({ runId: params.runId });
}

async function ensureRuntimeManifestEnvelope(
  manifestPath: string,
  teamName: string,
  clock: () => Date
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, 'data')
  ) {
    return;
  }

  const manifest = validateRuntimeStoreManifest(parsed);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await atomicWriteAsync(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION,
        updatedAt: clock().toISOString(),
        data: {
          ...manifest,
          teamName,
        },
      },
      null,
      2
    )}\n`
  );
}

export async function removeOpenCodeRuntimeLaneIndexEntry(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
}): Promise<void> {
  const filePath = getOpenCodeRuntimeLaneIndexPath(params.teamsBasePath, params.teamName);
  await withFileLock(
    filePath,
    async () => {
      const index = await readOpenCodeRuntimeLaneIndexUnlocked(
        params.teamsBasePath,
        params.teamName
      );
      if (!index.lanes[params.laneId]) {
        return;
      }
      delete index.lanes[params.laneId];
      index.updatedAt = new Date().toISOString();
      await writeOpenCodeRuntimeLaneIndexUnlocked(params.teamsBasePath, params.teamName, index);
    },
    OPENCODE_LANE_INDEX_LOCK_OPTIONS
  );
}

export function clearOpenCodeRuntimeLaneStorage(
  params: ClearOpenCodeRuntimeLaneStorageParams & { expectedRunId: string }
): Promise<ClearOpenCodeRuntimeLaneStorageResult>;
export function clearOpenCodeRuntimeLaneStorage(
  params: ClearOpenCodeRuntimeLaneStorageParams
): Promise<void>;
export async function clearOpenCodeRuntimeLaneStorage(
  params: ClearOpenCodeRuntimeLaneStorageParams & { expectedRunId?: string }
): Promise<void | ClearOpenCodeRuntimeLaneStorageResult> {
  return clearLaneStorageUnlocked(params, true);
}
// prettier-ignore
async function clearLaneStorageUnlocked(
  params: ClearOpenCodeRuntimeLaneStorageParams & { expectedRunId?: string }, acquireLifecycleLock = false,
  stableRuntimeDirectory?: string, stableLanesDirectory?: string,
): Promise<ClearOpenCodeRuntimeLaneStorageResult> {
  return withIdentityStableIndexedDirectoryLocksAsync(
    {
      rootDirectoryPath: stableRuntimeDirectory ?? getOpenCodeTeamRuntimeDirectory(params.teamsBasePath, params.teamName),
      containerDirectoryName: OPENCODE_TEAM_RUNTIME_LANES_DIR,
      targetDirectoryName: encodeURIComponent(params.laneId),
      indexFileName: OPENCODE_TEAM_RUNTIME_LANES_INDEX_FILE,
      lifecycleLockName: `.${encodeURIComponent(params.laneId.trim() || 'primary')}.lifecycle`,
      acquireLifecycleLock,
      stableContainerDirectoryPath: stableLanesDirectory },
    (lockPath, operation) => withFileLock(lockPath, operation, OPENCODE_LANE_INDEX_LOCK_OPTIONS),
    ({ indexPath, targetDirectoryPath }) => clearIdentityStableLaneStorage(indexPath, targetDirectoryPath, params)
  );
}
// prettier-ignore
async function clearIdentityStableLaneStorage(
  indexPath: string, laneDirectory: string,
  params: ClearOpenCodeRuntimeLaneStorageParams & { expectedRunId?: string },
): Promise<ClearOpenCodeRuntimeLaneStorageResult> {
  const rawIndex = await readOptionalJsonNoFollowAsync(indexPath);
  const index = rawIndex === null ? createEmptyOpenCodeRuntimeLaneIndex()
    : normalizeOpenCodeRuntimeLaneIndex(rawIndex as Partial<OpenCodeRuntimeLaneIndex>);
  const laneEntry = index.lanes[params.laneId];
  let ownershipDecision: ClearOpenCodeRuntimeLaneStorageResult | null = null;
  const cleanupResult = await removeDirectoryEntriesExceptAsync(laneDirectory, OPENCODE_RUNTIME_LANE_DURABLE_ARTIFACTS, {
      displayPath: getOpenCodeTeamRuntimeLaneDirectory(params.teamsBasePath, params.teamName, params.laneId),
      validateDirectory: async (stableDirectory, entries) => {
        const manifestPath = path.join(stableDirectory, OPENCODE_RUNTIME_MANIFEST_FILE);
        const readManifest = () => readJsonDataEnvelopeNoFollowAsync(manifestPath).then(validateRuntimeStoreManifest);
        const manifestExists = entries.some((entry) => entry.name === OPENCODE_RUNTIME_MANIFEST_FILE);
        if (params.expectedRunId !== undefined && laneEntry === undefined && !manifestExists) {
          ownershipDecision = entries.every((entry) => OPENCODE_RUNTIME_LANE_DURABLE_ARTIFACTS.has(entry.name))
            ? null : 'owner_changed';
          return ownershipDecision === null;
        }
        ownershipDecision = await resolveOpenCodeRuntimeLaneClearOwnership({
          expectedRunId: params.expectedRunId, laneEntryExists: laneEntry !== undefined,
          laneEntryRunId: laneEntry?.runId,
          manifestExists, laneDirectoryExists: async () => true,
          readManifestActiveRunId: async () => (await readManifest()).activeRunId });
        return ownershipDecision === null;
      },
    });
  if (cleanupResult === 'missing') {
    ownershipDecision = await resolveOpenCodeRuntimeLaneClearOwnership({
      expectedRunId: params.expectedRunId, laneEntryExists: laneEntry !== undefined,
      laneEntryRunId: laneEntry?.runId,
      manifestExists: false, laneDirectoryExists: async () => false,
      readManifestActiveRunId: async () => undefined });
  }
  if (ownershipDecision || cleanupResult === 'validation_failed') return ownershipDecision ?? 'owner_changed';
  if (laneEntry) {
    delete index.lanes[params.laneId];
    index.updatedAt = new Date().toISOString();
    await atomicWriteAsync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }
  return 'cleared';
}
export function getOpenCodeRuntimeLaneLifecycleLockTargetPath(
  teamsBasePath: string,
  teamName: string,
  laneId?: string | null
): string {
  const normalizedLaneId = laneId?.trim() || 'primary';
  return path.join(
    getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName),
    OPENCODE_TEAM_RUNTIME_LANES_DIR,
    `.${encodeURIComponent(normalizedLaneId)}.lifecycle`
  );
}
// prettier-ignore
function withOpenCodeRuntimeLaneLifecycleLock<T>(
  params: { teamsBasePath: string; teamName: string; laneId?: string | null }, operation: (stableRuntimeDirectory: string, stableLanesDirectory: string) => Promise<T>): Promise<T> {
  const lockTargetPath = getOpenCodeRuntimeLaneLifecycleLockTargetPath(params.teamsBasePath, params.teamName, params.laneId);
  return withIdentityStableDirectoryTreeAsync(
    getOpenCodeTeamRuntimeDirectory(params.teamsBasePath, params.teamName), OPENCODE_TEAM_RUNTIME_LANES_DIR,
    ({ rootDirectoryPath, childDirectoryPath }) => withFileLock(path.join(childDirectoryPath, path.basename(lockTargetPath)), () => operation(rootDirectoryPath, childDirectoryPath), OPENCODE_LANE_INDEX_LOCK_OPTIONS),
    { create: true });
}
export async function recoverStaleOpenCodeRuntimeLaneIndexEntry(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
  clock?: () => Date;
  emptyLaneStaleAfterMs?: number;
}): Promise<{
  stale: boolean;
  degraded: boolean;
  diagnostics: string[];
}> {
  const index = await readOpenCodeRuntimeLaneIndex(params.teamsBasePath, params.teamName);
  const entry = index.lanes[params.laneId];
  if (entry?.state !== 'active') {
    return {
      stale: false,
      degraded: false,
      diagnostics: [],
    };
  }

  const storage = await inspectOpenCodeRuntimeLaneStorage(params);
  if (storage.hasRuntimeEvidenceOnDisk) {
    return {
      stale: false,
      degraded: false,
      diagnostics: [],
    };
  }

  const now = params.clock?.() ?? new Date();
  const staleAfterMs = params.emptyLaneStaleAfterMs ?? OPENCODE_ACTIVE_EMPTY_LANE_STALE_MS;
  const lastTouchedAt =
    Date.parse(storage.manifestUpdatedAt ?? '') || Date.parse(entry.updatedAt) || NaN;
  const laneAgeMs = Number.isFinite(lastTouchedAt) ? now.getTime() - lastTouchedAt : Infinity;
  if (storage.hasStateOnDisk && laneAgeMs < staleAfterMs) {
    return {
      stale: false,
      degraded: false,
      diagnostics: [],
    };
  }

  const diagnostics = storage.hasStateOnDisk
    ? [
        `OpenCode lane ${params.laneId} is marked active in lanes.json, but its runtime manifest has no committed runtime evidence after launch grace.`,
      ]
    : [
        `OpenCode lane ${params.laneId} is marked active in lanes.json, but no lane state exists on disk.`,
      ];
  await upsertOpenCodeRuntimeLaneIndexEntry({
    teamsBasePath: params.teamsBasePath,
    teamName: params.teamName,
    laneId: params.laneId,
    state: 'degraded',
    diagnostics,
  });
  return {
    stale: true,
    degraded: true,
    diagnostics,
  };
}
export async function migrateLegacyOpenCodeRuntimeState(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
  clock?: () => Date;
}): Promise<{ migrated: boolean; degraded: boolean; diagnostics: string[] }> {
  const clock = params.clock ?? (() => new Date());
  const runtimeDir = getOpenCodeTeamRuntimeDirectory(params.teamsBasePath, params.teamName);
  const laneDir = getOpenCodeTeamRuntimeLaneDirectory(
    params.teamsBasePath,
    params.teamName,
    params.laneId
  );
  const diagnostics: string[] = [];

  if (!(await durablePathExistsAsync(runtimeDir))) {
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: params.teamsBasePath,
      teamName: params.teamName,
      laneId: params.laneId,
      state: 'active',
    });
    return { migrated: false, degraded: false, diagnostics };
  }

  const laneDirsPath = path.join(runtimeDir, OPENCODE_TEAM_RUNTIME_LANES_DIR);
  const existingLaneDirs = await readdir(laneDirsPath).catch(() => [] as string[]);
  if (existingLaneDirs.length > 0) {
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: params.teamsBasePath,
      teamName: params.teamName,
      laneId: params.laneId,
      state: 'active',
    });
    return { migrated: false, degraded: false, diagnostics };
  }

  const knownLegacyFiles = [
    OPENCODE_RUNTIME_MANIFEST_FILE,
    'launch-state.json',
    'opencode-sessions.json',
    'opencode-launch-transaction.json',
    'opencode-delivery-journal.json',
    'opencode-permissions.json',
    'opencode-host-leases.json',
    'opencode-compatibility.json',
    'opencode-runtime-revision.json',
    'opencode-diagnostics.json',
    OPENCODE_RUNTIME_RUN_TOMBSTONES_FILE,
  ];
  const legacyFiles = (
    await Promise.all(
      knownLegacyFiles.map(async (fileName) =>
        (await durablePathExistsAsync(path.join(runtimeDir, fileName))) ? fileName : null
      )
    )
  ).filter((fileName): fileName is string => Boolean(fileName));

  if (legacyFiles.length === 0) {
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: params.teamsBasePath,
      teamName: params.teamName,
      laneId: params.laneId,
      state: 'active',
    });
    return { migrated: false, degraded: false, diagnostics };
  }

  const index = await readOpenCodeRuntimeLaneIndex(params.teamsBasePath, params.teamName);
  const otherLaneIds = Object.keys(index.lanes).filter((laneId) => laneId !== params.laneId);
  if (otherLaneIds.length > 0) {
    diagnostics.push(
      `Legacy OpenCode runtime state is ambiguous for ${params.teamName}; existing lanes: ${otherLaneIds.join(', ')}`
    );
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: params.teamsBasePath,
      teamName: params.teamName,
      laneId: params.laneId,
      state: 'degraded',
      diagnostics,
    });
    return { migrated: false, degraded: true, diagnostics };
  }

  await mkdir(laneDir, { recursive: true });
  for (const fileName of legacyFiles) {
    await renamePathWithRetry(path.join(runtimeDir, fileName), path.join(laneDir, fileName));
  }
  await upsertOpenCodeRuntimeLaneIndexEntry({
    teamsBasePath: params.teamsBasePath,
    teamName: params.teamName,
    laneId: params.laneId,
    state: 'active',
    diagnostics: [`migrated legacy team-scoped OpenCode runtime state at ${clock().toISOString()}`],
  });
  diagnostics.push(`migrated ${legacyFiles.length} legacy OpenCode runtime files`);
  return { migrated: true, degraded: false, diagnostics };
}

export function getOpenCodeRuntimeRunTombstonesPath(
  teamsBasePath: string,
  teamName: string,
  laneId?: string | null
): string {
  if (laneId && laneId.trim().length > 0) {
    return getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath,
      teamName,
      laneId: laneId.trim(),
      fileName: OPENCODE_RUNTIME_RUN_TOMBSTONES_FILE,
    });
  }
  return path.join(
    getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName),
    OPENCODE_RUNTIME_RUN_TOMBSTONES_FILE
  );
}
