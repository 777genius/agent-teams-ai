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
 * What the metadata of a team without `config.json` says, as far as this server can read it:
 * `per_project` for a team that keeps a separate history per project, `unreadable` for a file that
 * is there but cannot be read (only the app can tell then), `null` for anything else.
 */
function readHistoryMode(metaPath: string): 'per_project' | 'unreadable' | null {
  const meta = readJsonObject(metaPath);
  if (meta) return isPerProjectTeamMeta(meta) ? 'per_project' : null;
  return fs.existsSync(metaPath) ? 'unreadable' : null;
}

function appUnreachableMessage(teamName: string, reason: 'projectPath' | 'per_project' | 'unreadable'): string {
  const head = {
    projectPath: `projectPath was given for team "${teamName}", and the Agent Teams app checks it`,
    per_project:
      `Team "${teamName}" keeps a separate history per project, and the Agent Teams app chooses ` +
      'its board in a project',
    unreadable:
      `Team "${teamName}" has no config.json and its metadata cannot be read here; only the ` +
      'Agent Teams app can tell what it is',
  }[reason];
  const way =
    reason === 'projectPath'
      ? 'Start the app, or call without projectPath.'
      : 'Start the app, or use the exact name of a project team (projectHistoryContexts of team_list).';
  return `${head}, but the app could not be reached. ${way}`;
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
 *   So does a team whose metadata this server cannot read. No copy is ever created here.
 * - Anything else is an unknown team, as before.
 *
 * A refusal of the app is thrown as the controller reports it (with `code`); the tool registration
 * shows it to the client.
 */
export async function resolveBoardTeam(
  teamName: string,
  claudeDir?: string,
  projectPath?: string
): Promise<string> {
  const { configPath, metaPath } = resolveTeamPaths(teamName, claudeDir);
  const configured = isConfiguredTeamConfig(readJsonObject(configPath));
  if (configured && !projectPath) return teamName;
  const mode = configured ? null : readHistoryMode(metaPath);
  if (!configured && !mode) throw new Error(unknownTeamMessage(teamName));
  const target = await getController(teamName, claudeDir).appRouting.getBoardTarget(projectPath);
  if (target === null) throw new Error(appUnreachableMessage(teamName, mode ?? 'projectPath'));
  const board = typeof target.teamName === 'string' ? target.teamName : '';
  if (configured) {
    if (board !== teamName) throw new Error(`The app named another board for team "${teamName}"`);
    return teamName;
  }
  // The app does not see a per-project team under this name: it has no board.
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
