import fs from 'node:fs';
import path from 'node:path';

import { getController } from '../controller';

function unknownTeamMessage(teamName: string): string {
  return `Unknown team "${teamName}". Board tools require an existing configured team with config.json. Use the real board teamName from durable team context - never use a member or lead name as teamName.`;
}

function resolveTeamPaths(
  teamName: string,
  claudeDir?: string
): {
  configPath: string;
  membersMetaPath: string;
  metaPath: string;
} {
  const controller = getController(teamName, claudeDir) as {
    context?: { paths?: { teamDir?: string } };
  };
  const teamDir = controller.context?.paths?.teamDir;
  if (typeof teamDir !== 'string' || teamDir.trim().length === 0) {
    throw new Error(unknownTeamMessage(teamName));
  }
  return {
    configPath: path.join(teamDir, 'config.json'),
    membersMetaPath: path.join(teamDir, 'members.meta.json'),
    metaPath: path.join(teamDir, 'team.meta.json'),
  };
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isConfiguredTeamConfig(value: Record<string, unknown> | null): boolean {
  return typeof value?.name === 'string' && value.name.trim().length > 0;
}

function isDraftTeamMeta(value: Record<string, unknown> | null): boolean {
  return value?.version === 1 && typeof value.cwd === 'string' && value.cwd.trim().length > 0;
}

export function assertConfiguredTeam(teamName: string, claudeDir?: string): void {
  const { configPath } = resolveTeamPaths(teamName, claudeDir);
  const parsed = readJsonObject(configPath);
  if (!parsed || !isConfiguredTeamConfig(parsed)) {
    throw new Error(unknownTeamMessage(teamName));
  }
}

export function assertConfiguredTaskActor(
  teamName: string,
  actor: string,
  claudeDir?: string
): string {
  const normalizedActor = actor.trim();
  if (normalizedActor.toLowerCase() === 'user') {
    return 'user';
  }

  const { configPath, membersMetaPath } = resolveTeamPaths(teamName, claudeDir);
  const parsed = readJsonObject(configPath);
  if (!parsed || !isConfiguredTeamConfig(parsed)) {
    throw new Error(unknownTeamMessage(teamName));
  }

  const memberNamesByKey = new Map<string, string>();
  const applyMember = (member: unknown, fromMeta: boolean): void => {
    if (!member || typeof member !== 'object') {
      return;
    }
    const record = member as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) {
      return;
    }
    const key = name.toLowerCase();
    if (fromMeta && typeof record.removedAt === 'number') {
      memberNamesByKey.delete(key);
      return;
    }
    memberNamesByKey.set(key, name);
  };

  if (Array.isArray(parsed.members)) {
    for (const member of parsed.members) {
      applyMember(member, false);
    }
  }

  const membersMeta = readJsonObject(membersMetaPath);
  if (Array.isArray(membersMeta?.members)) {
    for (const member of membersMeta.members) {
      applyMember(member, true);
    }
  }

  const configuredMemberName = memberNamesByKey.get(normalizedActor.toLowerCase());
  if (configuredMemberName) {
    return configuredMemberName;
  }

  throw new Error(
    `Unknown task actor "${normalizedActor}". Use "user" or a configured team member name.`
  );
}

export function assertConfiguredOrDraftTeam(teamName: string, claudeDir?: string): void {
  const { configPath, metaPath } = resolveTeamPaths(teamName, claudeDir);
  if (isConfiguredTeamConfig(readJsonObject(configPath))) {
    return;
  }

  if (isDraftTeamMeta(readJsonObject(metaPath))) {
    return;
  }

  throw new Error(unknownTeamMessage(teamName));
}
