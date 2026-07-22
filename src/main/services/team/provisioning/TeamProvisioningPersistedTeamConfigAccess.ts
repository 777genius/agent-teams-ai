import * as fs from 'fs';
import * as path from 'path';

import type { PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';

export interface PersistedTeamConfigCacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  projectPath: string | null;
  members: PersistedRuntimeMemberLike[];
}

export interface PersistedTeamConfigAccess {
  teamsBasePath: string;
  cache: Map<string, PersistedTeamConfigCacheEntry>;
}

export function clonePersistedRuntimeMember(
  member: PersistedRuntimeMemberLike
): PersistedRuntimeMemberLike {
  return { ...member };
}

export function isPersistedRuntimeMemberLike(
  member: unknown
): member is PersistedRuntimeMemberLike {
  return !!member && typeof member === 'object';
}

export function readPersistedTeamConfig(
  teamName: string,
  access: PersistedTeamConfigAccess
): PersistedTeamConfigCacheEntry | null {
  const configPath = path.join(access.teamsBasePath, teamName, 'config.json');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch {
    access.cache.delete(teamName);
    return null;
  }

  const cached = access.cache.get(teamName);
  if (
    cached &&
    cached.path === configPath &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.ctimeMs === stat.ctimeMs
  ) {
    return cached;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { projectPath?: unknown; members?: unknown };
    const projectPath = typeof parsed.projectPath === 'string' ? parsed.projectPath.trim() : '';
    const members = Array.isArray(parsed.members)
      ? parsed.members
          .filter((member): member is PersistedRuntimeMemberLike =>
            isPersistedRuntimeMemberLike(member)
          )
          .map((member) => clonePersistedRuntimeMember(member))
      : [];
    const entry: PersistedTeamConfigCacheEntry = {
      path: configPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      projectPath: projectPath || null,
      members,
    };
    access.cache.set(teamName, entry);
    return entry;
  } catch {
    access.cache.delete(teamName);
    return null;
  }
}

export function readPersistedTeamProjectPath(
  teamName: string,
  access: PersistedTeamConfigAccess
): string | null {
  return readPersistedTeamConfig(teamName, access)?.projectPath ?? null;
}

export function readPersistedRuntimeMembers(
  teamName: string,
  access: PersistedTeamConfigAccess
): PersistedRuntimeMemberLike[] {
  return (
    readPersistedTeamConfig(teamName, access)?.members.map((member) =>
      clonePersistedRuntimeMember(member)
    ) ?? []
  );
}

export function listPersistedTeamNames(teamsBasePath: string): string[] {
  try {
    return fs
      .readdirSync(teamsBasePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.trim().length > 0);
  } catch {
    return [];
  }
}
