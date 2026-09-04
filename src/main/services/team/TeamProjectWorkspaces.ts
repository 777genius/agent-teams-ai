import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * The project directory each team was launched against, read straight off disk.
 *
 * It exists for the cleanup paths that have to prove a process belongs to a
 * team before they touch it: an external lead carries its team's workspace on
 * its own command line, and matching that against what this app has on disk is
 * the only attribution available for a process the app never recorded a pid for.
 *
 * `projectPath` and nothing else. `resolveProjectPathFromConfig` falls back to a
 * lead member's cwd and then to the path history, which is right when the
 * question is "where does this team work" and wrong when the question is "may I
 * kill this" - a stale history entry would name a directory the team has since
 * left, and a process running there belongs to somebody else.
 */

const TEAM_CONFIG_FILE = 'config.json';

function normalizeProjectPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Never throws: an unreadable or unparseable config answers `null`, which every
 * caller has to treat as "cannot prove ownership" rather than as "no
 * restriction".
 */
export async function readTeamProjectWorkspace(
  teamsBasePath: string,
  teamName: string
): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(teamsBasePath, teamName, TEAM_CONFIG_FILE), 'utf8');
    return normalizeProjectPath((JSON.parse(raw) as { projectPath?: unknown }).projectPath);
  } catch {
    return null;
  }
}

/**
 * Every workspace this app has a team for, de-duplicated. A team whose config
 * cannot be read contributes nothing instead of widening the result, so a
 * caller that scopes a sweep by this list never reaches further than the teams
 * it could actually read.
 */
export async function listTeamProjectWorkspaces(teamsBasePath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(teamsBasePath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const workspaces = new Set<string>();
  for (const teamName of entries) {
    const workspace = await readTeamProjectWorkspace(teamsBasePath, teamName);
    if (workspace) {
      workspaces.add(workspace);
    }
  }
  return [...workspaces];
}
