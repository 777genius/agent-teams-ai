import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { withFileLock } from '../../fileLock';

import {
  createDefaultRuntimeStoreManifest,
  validateRuntimeStoreManifest,
} from './RuntimeStoreManifest';

import type { RuntimeStoreManifestEvidence } from '../bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../bridge/OpenCodeStateChangingBridgeCommandService';

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

export interface OpenCodeRuntimeLaneIndexEntry {
  laneId: string;
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
  teamName: string
): Promise<OpenCodeRuntimeLaneIndex> {
  const filePath = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
  if (!(await fileExists(filePath))) {
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
  index: OpenCodeRuntimeLaneIndex
): Promise<void> {
  const runtimeDir = getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName);
  await mkdir(runtimeDir, { recursive: true });
  await atomicWriteAsync(
    getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName),
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

async function readRuntimeStoreManifestEvidenceData(
  manifestPath: string,
  teamName: string,
  clock: () => Date
) {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createDefaultRuntimeStoreManifest(teamName, clock().toISOString());
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  const maybeRecord =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const manifestData =
    maybeRecord && Object.prototype.hasOwnProperty.call(maybeRecord, 'data')
      ? maybeRecord.data
      : parsed;
  return validateRuntimeStoreManifest(manifestData);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOpenCodeRuntimeManifestReadPath(
  teamsBasePath: string,
  teamName: string,
  laneId: string
): Promise<string> {
  const laneManifestPath = getOpenCodeRuntimeManifestPath(teamsBasePath, teamName, laneId);
  if (await fileExists(laneManifestPath)) {
    return laneManifestPath;
  }

  const legacyManifestPath = getOpenCodeRuntimeManifestPath(teamsBasePath, teamName);
  if (!(await fileExists(legacyManifestPath))) {
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
  fileNames: string[];
}> {
  const laneDir = getOpenCodeTeamRuntimeLaneDirectory(
    params.teamsBasePath,
    params.teamName,
    params.laneId
  );
  const laneDirectoryExists = await fileExists(laneDir);
  if (!laneDirectoryExists) {
    return {
      laneDirectoryExists: false,
      hasStateOnDisk: false,
      fileNames: [],
    };
  }

  const fileNames = (await readdir(laneDir).catch(() => [] as string[])).sort();
  return {
    laneDirectoryExists: true,
    hasStateOnDisk: fileNames.length > 0,
    fileNames,
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
  await withFileLock(filePath, async () => {
    await writeOpenCodeRuntimeLaneIndexUnlocked(teamsBasePath, teamName, index);
  });
}

export async function upsertOpenCodeRuntimeLaneIndexEntry(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
  state: OpenCodeRuntimeLaneIndexEntry['state'];
  diagnostics?: string[];
}): Promise<void> {
  const filePath = getOpenCodeRuntimeLaneIndexPath(params.teamsBasePath, params.teamName);
  await withFileLock(filePath, async () => {
    const index = await readOpenCodeRuntimeLaneIndexUnlocked(params.teamsBasePath, params.teamName);
    index.updatedAt = new Date().toISOString();
    index.lanes[params.laneId] = {
      laneId: params.laneId,
      state: params.state,
      updatedAt: index.updatedAt,
      diagnostics: params.diagnostics?.length ? [...params.diagnostics] : undefined,
    };
    await writeOpenCodeRuntimeLaneIndexUnlocked(params.teamsBasePath, params.teamName, index);
  });
}

export async function removeOpenCodeRuntimeLaneIndexEntry(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
}): Promise<void> {
  const filePath = getOpenCodeRuntimeLaneIndexPath(params.teamsBasePath, params.teamName);
  await withFileLock(filePath, async () => {
    const index = await readOpenCodeRuntimeLaneIndexUnlocked(params.teamsBasePath, params.teamName);
    if (!index.lanes[params.laneId]) {
      return;
    }
    delete index.lanes[params.laneId];
    index.updatedAt = new Date().toISOString();
    await writeOpenCodeRuntimeLaneIndexUnlocked(params.teamsBasePath, params.teamName, index);
  });
}

export async function clearOpenCodeRuntimeLaneStorage(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
}): Promise<void> {
  await rm(
    getOpenCodeTeamRuntimeLaneDirectory(params.teamsBasePath, params.teamName, params.laneId),
    { recursive: true, force: true }
  );
  await removeOpenCodeRuntimeLaneIndexEntry(params);
}

export async function recoverStaleOpenCodeRuntimeLaneIndexEntry(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
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
  if (storage.hasStateOnDisk) {
    return {
      stale: false,
      degraded: false,
      diagnostics: [],
    };
  }

  const diagnostics = [
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

  if (!(await fileExists(runtimeDir))) {
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
        (await fileExists(path.join(runtimeDir, fileName))) ? fileName : null
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
    await rename(path.join(runtimeDir, fileName), path.join(laneDir, fileName));
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
