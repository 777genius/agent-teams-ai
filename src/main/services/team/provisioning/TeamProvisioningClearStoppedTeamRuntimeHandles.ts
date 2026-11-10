import { atomicWriteSync } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { withFileLockSync } from '../fileLock';
import { TeamConfigReader } from '../TeamConfigReader';
import { getTeamDataWorkerClient } from '../TeamDataWorkerClient';

const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;
const LIVE_RUNTIME_HANDLE_FIELDS = ['runtimePid', 'runtimeSessionId'] as const;

export interface ClearStoppedTeamLiveRuntimeHandlesPorts {
  readTeamConfigJson(teamName: string): string | null;
  writeTeamConfigJson(teamName: string, contents: string): void;
  invalidateTeamConfig(teamName: string): void;
  withTeamConfigLock?<T>(teamName: string, operation: () => T): T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasLiveRuntimeHandleValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return value != null;
}

export function stripStoppedTeamLiveRuntimeHandlesFromMember(member: Record<string, unknown>): {
  member: Record<string, unknown>;
  changed: boolean;
} {
  let changed = false;
  const next = { ...member };
  for (const field of LIVE_RUNTIME_HANDLE_FIELDS) {
    if (hasLiveRuntimeHandleValue(next[field])) {
      delete next[field];
      changed = true;
    }
  }
  const paneId = typeof next.tmuxPaneId === 'string' ? next.tmuxPaneId.trim() : '';
  if (paneId) {
    delete next.tmuxPaneId;
    changed = true;
  }
  if (next.isActive === true) {
    next.isActive = false;
    changed = true;
  }
  return { member: changed ? next : member, changed };
}

export function stripStoppedTeamLiveRuntimeHandlesFromConfig(parsed: unknown): {
  parsed: unknown;
  changed: boolean;
} {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.members)) {
    return { parsed, changed: false };
  }

  let changed = false;
  const members = parsed.members.map((member) => {
    if (!isPlainObject(member)) {
      return member;
    }
    const stripped = stripStoppedTeamLiveRuntimeHandlesFromMember(member);
    if (stripped.changed) {
      changed = true;
    }
    return stripped.member;
  });

  if (!changed) {
    return { parsed, changed: false };
  }
  return { parsed: { ...parsed, members }, changed: true };
}

export function persistClearedStoppedTeamLiveRuntimeHandles(
  teamName: string,
  ports: ClearStoppedTeamLiveRuntimeHandlesPorts
): boolean {
  const persist = (): boolean => {
    const raw = ports.readTeamConfigJson(teamName);
    if (!raw) {
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return false;
    }

    const stripped = stripStoppedTeamLiveRuntimeHandlesFromConfig(parsed);
    if (!stripped.changed) {
      return false;
    }

    ports.writeTeamConfigJson(teamName, `${JSON.stringify(stripped.parsed, null, 2)}\n`);
    ports.invalidateTeamConfig(teamName);
    return true;
  };

  if (ports.withTeamConfigLock) {
    return ports.withTeamConfigLock(teamName, persist);
  }
  return persist();
}

export function createNodeClearStoppedTeamLiveRuntimeHandlesPorts(): ClearStoppedTeamLiveRuntimeHandlesPorts {
  return {
    readTeamConfigJson(teamName) {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      try {
        const stat = fs.statSync(configPath);
        if (!stat.isFile() || stat.size > TEAM_CONFIG_MAX_BYTES) {
          return null;
        }
        return fs.readFileSync(configPath, 'utf8');
      } catch {
        return null;
      }
    },
    writeTeamConfigJson(teamName, contents) {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      atomicWriteSync(configPath, contents);
    },
    withTeamConfigLock(teamName, operation) {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      return withFileLockSync(configPath, operation);
    },
    invalidateTeamConfig(teamName) {
      TeamConfigReader.invalidateTeam(teamName);
      getTeamDataWorkerClient().invalidateTeamConfig(teamName);
    },
  };
}

export function persistClearedStoppedTeamLiveRuntimeHandlesForTeam(teamName: string): boolean {
  return persistClearedStoppedTeamLiveRuntimeHandles(
    teamName,
    createNodeClearStoppedTeamLiveRuntimeHandlesPorts()
  );
}
