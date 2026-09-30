import { mkdir, readFile, rm } from 'node:fs/promises';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { durablePathExistsAsync } from '@main/utils/durablePathOperations';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

const logger = createLogger('OpenCodeRuntimeLaneIndexStore');
export const OPENCODE_TEAM_RUNTIME_DIR = '.opencode-runtime';
export const OPENCODE_TEAM_RUNTIME_LANES_INDEX_FILE = 'lanes.json';

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

export function createEmptyOpenCodeRuntimeLaneIndex(
  updatedAt = new Date().toISOString()
): OpenCodeRuntimeLaneIndex {
  return {
    version: 1,
    updatedAt,
    lanes: {},
  };
}

export function normalizeOpenCodeRuntimeLaneIndex(
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

export async function readOpenCodeRuntimeLaneIndexUnlocked(
  teamsBasePath: string,
  teamName: string,
  runtimeDirectory = path.join(teamsBasePath, teamName, OPENCODE_TEAM_RUNTIME_DIR)
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

export async function quarantineInvalidOpenCodeRuntimeLaneIndex(
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
export async function writeOpenCodeRuntimeLaneIndexUnlocked(
  teamsBasePath: string,
  teamName: string,
  index: OpenCodeRuntimeLaneIndex,
  runtimeDirectory = path.join(teamsBasePath, teamName, OPENCODE_TEAM_RUNTIME_DIR)
): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true });
  await atomicWriteAsync(
    path.join(runtimeDirectory, OPENCODE_TEAM_RUNTIME_LANES_INDEX_FILE),
    `${JSON.stringify(index, null, 2)}\n`
  );
}
