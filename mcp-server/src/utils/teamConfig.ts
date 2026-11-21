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

/**
 * The logical team of the per-project history mode: a definition (team.meta.json)
 * with no config.json, because it never has a process. Its runtime lives in its
 * project copies, which the desktop API resolves.
 */
function isPerProjectTeamMeta(value: Record<string, unknown> | null): boolean {
  return value?.version === 1 && value.projectContextMode === 'per_project';
}

export function assertConfiguredTeam(teamName: string, claudeDir?: string): void {
  const { configPath } = resolveTeamPaths(teamName, claudeDir);
  const parsed = readJsonObject(configPath);
  if (!parsed || !isConfiguredTeamConfig(parsed)) {
    throw new Error(unknownTeamMessage(teamName));
  }
}

/**
 * A team the app may resolve to a project copy: its metadata says it keeps a separate history per
 * project, or the file is there but unreadable (the app then refuses with
 * `TEAM_METADATA_UNREADABLE` instead of this server guessing an unknown team).
 */
function mayKeepProjectHistory(metaPath: string): boolean {
  const meta = readJsonObject(metaPath);
  return meta ? isPerProjectTeamMeta(meta) : fs.existsSync(metaPath);
}

function appUnreachableMessage(teamName: string, configured: boolean): string {
  return configured
    ? `projectPath was given for team "${teamName}", but the Agent Teams app, which checks it, ` +
        'could not be reached. Start the app, or call without projectPath.'
    : `Team "${teamName}" keeps a separate history per project. Its board in a project is chosen ` +
        'by the Agent Teams app, which could not be reached. Start the app, or use the exact name ' +
        'of the project team (projectHistoryContexts of team_list).';
}

/**
 * MCP clients only see the text of a tool error, not its fields: a refusal of the app starts with
 * its code, `[PROJECT_REQUIRED] ...`, so a client can act on it. The `code` field is kept.
 */
function withCodeInMessage(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (!(error instanceof Error) || typeof code !== 'string' || !/^[A-Z][A-Z_]+$/.test(code)) {
    return error;
  }
  return Object.assign(new Error(`[${code}] ${error.message}`), { code });
}

/**
 * The team whose board a board tool works on: one rule for every board tool, applied where the
 * tools are registered (`tools/projectBoard.ts`).
 *
 * - A configured team (an ordinary team, or a project copy named exactly) without `projectPath` is
 *   itself and the app is not asked, so these calls behave exactly as before.
 * - With `projectPath`, the app checks it: an ordinary team keeps one history for every project;
 *   a project copy must be the copy of that project and its launch must have finished.
 * - A team that keeps a separate history per project has no board of its own: the app resolves it
 *   with `projectPath` to its ready copy for that project, or refuses with a code and what to do.
 *   No copy is ever created here.
 * - Anything else is an unknown team, as before.
 */
export async function resolveBoardTeam(
  teamName: string,
  claudeDir?: string,
  projectPath?: string
): Promise<string> {
  const { configPath, metaPath } = resolveTeamPaths(teamName, claudeDir);
  const configured = isConfiguredTeamConfig(readJsonObject(configPath));
  if (configured && !projectPath) return teamName;
  if (!configured && !mayKeepProjectHistory(metaPath)) {
    throw new Error(unknownTeamMessage(teamName));
  }
  let target: Record<string, unknown> | null;
  try {
    target = await getController(teamName, claudeDir).appRouting.getBoardTarget(projectPath);
  } catch (error) {
    throw withCodeInMessage(error);
  }
  if (target === null) throw new Error(appUnreachableMessage(teamName, configured));
  const board = typeof target.teamName === 'string' ? target.teamName : '';
  if (configured) {
    if (board !== teamName) throw new Error(`The app named another board for team "${teamName}"`);
    return teamName;
  }
  // The app no longer sees a per-project team under this name: it has no board.
  if (!board || board === teamName) throw new Error(unknownTeamMessage(teamName));
  assertConfiguredTeam(board, claudeDir);
  return board;
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

  assertConfiguredTeam(teamName, claudeDir);
  // The controller owns member and lead-alias rules ("lead"/"team-lead" -> the real lead name).
  const { memberName, leadName } = getController(teamName, claudeDir).taskBoard.resolveTaskActor(
    normalizedActor
  );
  if (memberName) {
    return memberName;
  }

  const leadHint = leadName ? `the team lead "${leadName}", ` : '';
  throw new Error(
    `Unknown task actor "${normalizedActor}". Use ${leadHint}a configured team member name, or "user" only when acting for the user.`
  );
}

export function assertConfiguredOrDraftTeam(teamName: string, claudeDir?: string): void {
  const { configPath, metaPath } = resolveTeamPaths(teamName, claudeDir);
  if (isConfiguredTeamConfig(readJsonObject(configPath))) {
    return;
  }

  const meta = readJsonObject(metaPath);
  if (isDraftTeamMeta(meta) || isPerProjectTeamMeta(meta)) {
    return;
  }

  throw new Error(unknownTeamMessage(teamName));
}
