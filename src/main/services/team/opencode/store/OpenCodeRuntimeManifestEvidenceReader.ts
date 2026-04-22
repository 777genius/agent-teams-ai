import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'path';

import type { RuntimeStoreManifestEvidence } from '../bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../bridge/OpenCodeStateChangingBridgeCommandService';
import { createRuntimeStoreManifestStore } from './RuntimeStoreManifest';

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
    const manifest = await createRuntimeStoreManifestStore({
      filePath: manifestPath,
      teamName,
      clock: this.clock,
    }).read();

    return {
      highWatermark: manifest.highWatermark,
      activeRunId: manifest.activeRunId,
      capabilitySnapshotId: manifest.activeCapabilitySnapshotId,
    };
  }
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
  const filePath = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
  if (!(await fileExists(filePath))) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      lanes: {},
    };
  }
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<OpenCodeRuntimeLaneIndex>;
  if (
    parsed.version !== 1 ||
    typeof parsed.updatedAt !== 'string' ||
    !parsed.lanes ||
    typeof parsed.lanes !== 'object'
  ) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      lanes: {},
    };
  }
  return {
    version: 1,
    updatedAt: parsed.updatedAt,
    lanes: Object.fromEntries(
      Object.entries(parsed.lanes).flatMap(([key, value]) => {
        if (
          !value ||
          typeof value !== 'object' ||
          typeof (value as OpenCodeRuntimeLaneIndexEntry).laneId !== 'string' ||
          typeof (value as OpenCodeRuntimeLaneIndexEntry).updatedAt !== 'string'
        ) {
          return [];
        }
        const entry = value as OpenCodeRuntimeLaneIndexEntry;
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

export async function writeOpenCodeRuntimeLaneIndex(
  teamsBasePath: string,
  teamName: string,
  index: OpenCodeRuntimeLaneIndex
): Promise<void> {
  const runtimeDir = getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName);
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName),
    `${JSON.stringify(index, null, 2)}\n`,
    'utf8'
  );
}

export async function upsertOpenCodeRuntimeLaneIndexEntry(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
  state: OpenCodeRuntimeLaneIndexEntry['state'];
  diagnostics?: string[];
}): Promise<void> {
  const index = await readOpenCodeRuntimeLaneIndex(params.teamsBasePath, params.teamName);
  index.updatedAt = new Date().toISOString();
  index.lanes[params.laneId] = {
    laneId: params.laneId,
    state: params.state,
    updatedAt: index.updatedAt,
    diagnostics: params.diagnostics?.length ? [...params.diagnostics] : undefined,
  };
  await writeOpenCodeRuntimeLaneIndex(params.teamsBasePath, params.teamName, index);
}

export async function removeOpenCodeRuntimeLaneIndexEntry(params: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
}): Promise<void> {
  const index = await readOpenCodeRuntimeLaneIndex(params.teamsBasePath, params.teamName);
  if (!index.lanes[params.laneId]) {
    return;
  }
  delete index.lanes[params.laneId];
  index.updatedAt = new Date().toISOString();
  await writeOpenCodeRuntimeLaneIndex(params.teamsBasePath, params.teamName, index);
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
