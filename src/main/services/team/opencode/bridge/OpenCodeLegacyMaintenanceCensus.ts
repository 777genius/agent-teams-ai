import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

import { inspectSavedTeamMaintenance } from './LegacySavedTeamMaintenanceCensus';

export type LegacyMaintenanceCensus = 'absent' | 'present' | 'unknown';

export interface LegacyMaintenanceCensusInput {
  teamsBasePath: string;
  multimodelDataPath: string;
  attributionPath: string;
  /** Includes accepted launches, operation locks and stops, not just live teams. */
  hasTrackedObligations(): boolean;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

interface HookScaffold {
  readonly [name: string]: HookScaffold | 'file';
}

// The shared hook installer runs before any legacy team allocation. Only its
// empty scaffold is non-native evidence. Team records require a separate strict
// saved-product census; reports and unknown files/dirs retain maintenance.
const TEAM_ROOT_HOOK_SCAFFOLD: HookScaffold = {
  '.member-work-sync': {
    'runtime-hooks': {
      bin: { 'turn-settled-hook-v1.sh': 'file' },
      incoming: {},
      processing: {},
      processed: {},
      invalid: {},
    },
  },
};

async function directory(
  path: string,
  scaffold?: HookScaffold,
  savedTeams = false
): Promise<LegacyMaintenanceCensus> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return 'unknown';
    const entries = await opendir(path);
    try {
      for (let entry = await entries.read(); entry !== null; entry = await entries.read()) {
        const known =
          scaffold && Object.hasOwn(scaffold, entry.name) ? scaffold[entry.name] : undefined;
        if (!known) {
          if (!savedTeams || !entry.isDirectory() || entry.isSymbolicLink()) return 'present';
          const state = await inspectSavedTeamMaintenance(join(path, entry.name), entry.name);
          if (state !== 'absent') return state;
          continue;
        }
        if (known === 'file') {
          const file = await lstat(join(path, entry.name)).catch(() => null);
          if (!file?.isFile() || file.isSymbolicLink()) return 'unknown';
        } else {
          const state = await directory(join(path, entry.name), known);
          if (state !== 'absent') return state;
        }
      }
      const after = await lstat(path);
      return info.dev === after.dev &&
        info.ino === after.ino &&
        info.mtimeMs === after.mtimeMs &&
        info.ctimeMs === after.ctimeMs
        ? 'absent'
        : 'unknown';
    } finally {
      await entries.close();
    }
  } catch (error) {
    return missing(error) ? 'absent' : 'unknown';
  }
}

async function registry(dataPath: string): Promise<LegacyMaintenanceCensus> {
  try {
    const root = await lstat(dataPath);
    if (!root.isDirectory() || root.isSymbolicLink()) return 'unknown';
    const opencode = join(dataPath, 'opencode');
    const info = await lstat(opencode);
    if (!info.isDirectory() || info.isSymbolicLink()) return 'unknown';
    try {
      await lstat(join(opencode, 'host-registry.json'));
      // Presence is enough. Do not duplicate/normalize the runtime's opaque schema.
      return 'present';
    } catch (error) {
      if (!missing(error)) return 'unknown';
    }
    return await directory(join(opencode, 'host-startup-locks'));
  } catch (error) {
    return missing(error) ? 'absent' : 'unknown';
  }
}

/**
 * Absence only skips native registry maintenance; process fallback ownership
 * checks remain independent. Host descriptors/handles never prove legacy absence.
 * Raw presence is intentional: forgiving/quarantining legacy readers are not a census.
 */
export async function inspectLegacyOpenCodeMaintenance(
  input: LegacyMaintenanceCensusInput
): Promise<LegacyMaintenanceCensus> {
  try {
    if (input.hasTrackedObligations()) return 'present';
    const states = await Promise.all([
      directory(input.teamsBasePath, TEAM_ROOT_HOOK_SCAFFOLD, true),
      registry(input.multimodelDataPath),
      directory(input.attributionPath),
    ]);
    // A legacy launch may have become visible while filesystem reads were pending.
    if (input.hasTrackedObligations() || states.includes('present')) return 'present';
    return states.includes('unknown') ? 'unknown' : 'absent';
  } catch {
    return 'unknown';
  }
}

/** Retain observed obligations through stopAllTeams removing its maps/artifacts. */
export function createLegacyOpenCodeMaintenanceRequirement(
  input: () => LegacyMaintenanceCensusInput
): () => Promise<boolean> {
  let retained = false;
  return async () => {
    if (retained) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const census = inspectLegacyOpenCodeMaintenance(input());
      const state = await Promise.race([
        census,
        new Promise<LegacyMaintenanceCensus>((resolve) => {
          timer = setTimeout(() => resolve('unknown'), 1000);
        }),
      ]);
      if (state !== 'absent') retained = true;
    } catch {
      retained = true;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return retained;
  };
}
