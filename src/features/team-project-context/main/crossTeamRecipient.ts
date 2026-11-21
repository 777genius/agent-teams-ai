import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { readTeamProjectContextMode, TeamMetadataUnreadableError } from './projectContextMode';
import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';

import type { TeamModeMetaReader } from './projectContextMode';
import type {
  OwnedExecutionAliasLookup,
  PersistedTeamWorkContext,
} from './TeamProjectContextRegistry';
import type { TeamProjectContextMode } from '@shared/types';

const UNREADABLE_MESSAGE = 'Team metadata is unreadable; refusing cross-team delivery';

export interface CrossTeamRecipientPorts {
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  /** The context of a team for one project, a pending one included. Never creates one. */
  inspectContext(
    logicalTeamName: string,
    projectPath: string
  ): Promise<PersistedTeamWorkContext | null>;
  /** Which of the names are project copies, and of which team (one scan for all). */
  findCopyOwners(teamNames: readonly string[]): Promise<Map<string, OwnedExecutionAliasLookup>>;
}

export interface CrossTeamRoute {
  fromTeam: string;
  toTeam: string;
  /** The project the sender works in (its `config.json` `projectPath`). */
  senderProjectPath?: string | null;
}

export interface CrossTeamRecipient {
  /** The physical team that receives the message: its inbox, outbox and process. */
  teamName: string;
  /** Set when the requested name was a per-project team, resolved to one of its copies. */
  logicalTeamName?: string;
  projectPath?: string;
}

export type CrossTeamRecipientRefusal =
  | 'SENDER_IS_PROJECT_TEAM'
  | 'SENDER_PROJECT_UNKNOWN'
  | 'NO_PROJECT_HISTORY'
  | 'PROJECT_LAUNCH_PENDING'
  | 'SAME_TEAM'
  | 'UNRESOLVED';

/** A message that cannot be delivered; the text says what to do instead. */
export class CrossTeamRecipientError extends Error {
  /** Understood by the HTTP error mapping. */
  readonly statusCode = 409;

  constructor(
    readonly code: CrossTeamRecipientRefusal,
    message: string
  ) {
    super(message);
    this.name = 'CrossTeamRecipientError';
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function modeOf(ports: CrossTeamRecipientPorts, teamName: string) {
  try {
    return await ports.getMode(teamName);
  } catch (error) {
    // Unreadable metadata keeps its own error (and code); anything else is still a refusal.
    if (error instanceof TeamMetadataUnreadableError) throw error;
    throw new CrossTeamRecipientError(
      'UNRESOLVED',
      `Cannot read how team "${teamName}" keeps its history: ${reasonOf(error)}`
    );
  }
}

/** A per-project team has no inbox or process of its own, so it never sends. */
export async function assertCrossTeamSender(
  ports: CrossTeamRecipientPorts,
  fromTeam: string
): Promise<void> {
  if ((await modeOf(ports, fromTeam)) === 'per_project') {
    throw new CrossTeamRecipientError(
      'SENDER_IS_PROJECT_TEAM',
      `Team "${fromTeam}" keeps a separate history per project and has no inbox of its own. ` +
        'Send from the team opened in a project.'
    );
  }
}

/**
 * A project copy named exactly: it stays addressable (the `from` of a message a
 * copy sent is its own name, and the reply has to reach that copy), unless it is
 * a copy of the sender's own team, its launch never finished, or its team is
 * being deleted or moved to trash.
 *
 * Known limit: a copy of another team is reachable from any project, not only
 * from its own project or from an open conversation with it. Narrowing it needs
 * conversation evidence that every sender (the controller included) can read.
 *
 * Deliberately fail-closed: telling a `ptc-…` name from an ordinary team scans
 * the contexts indexes, so a damaged index of any per-project team refuses
 * messages to copies until it is repaired. An unproven owner could be the
 * sender's own team. Names not shaped like a copy are never scanned.
 */
async function exactName(
  ports: CrossTeamRecipientPorts,
  { fromTeam, toTeam }: CrossTeamRoute
): Promise<CrossTeamRecipient> {
  let owners: Map<string, OwnedExecutionAliasLookup>;
  try {
    owners = await ports.findCopyOwners([fromTeam, toTeam]);
  } catch (error) {
    throw new CrossTeamRecipientError(
      'UNRESOLVED',
      `Cannot tell which teams are project copies: ${reasonOf(error)}`
    );
  }
  const ownerOf = (name: string) => {
    const lookup = owners.get(name);
    if (lookup && 'error' in lookup) {
      throw new CrossTeamRecipientError(
        'UNRESOLVED',
        `Cannot tell whether "${name}" is a project copy: ${lookup.error.message}`
      );
    }
    return lookup?.alias ?? null;
  };
  const target = ownerOf(toTeam);
  if (!target) return { teamName: toTeam };
  const sender = ownerOf(fromTeam);
  if (sender && sender.logicalTeamName === target.logicalTeamName) {
    throw new CrossTeamRecipientError(
      'SAME_TEAM',
      'Cannot send cross-team message to the same team'
    );
  }
  if (target.context.state !== 'ready') {
    throw new CrossTeamRecipientError(
      'PROJECT_LAUNCH_PENDING',
      `Team "${target.logicalTeamName}" is being launched in project ${target.context.projectPath}. ` +
        'Send again when the launch has finished.'
    );
  }
  try {
    // The same read as a send by the team's name: it refuses a team that is being
    // deleted or moved to trash.
    await ports.inspectContext(target.logicalTeamName, target.context.projectPath);
  } catch (error) {
    throw new CrossTeamRecipientError(
      'UNRESOLVED',
      `Team "${target.logicalTeamName}" cannot receive messages in project ` +
        `${target.context.projectPath}: ${reasonOf(error)}`
    );
  }
  return { teamName: toTeam };
}

/**
 * The one rule for which physical team receives a cross-team message.
 *
 * - An ordinary team receives it under its name; so does a ready project copy
 *   named exactly (see `exactName`).
 * - A per-project team has no inbox or process of its own. It receives through
 *   its ready copy for the project the sender works in: the message never goes to
 *   the history of another project, and no copy is created to receive it.
 *   Anything else is refused with what to do instead.
 * - A per-project team cannot be the sender, for the same reason.
 *
 * Unreadable metadata and an index that cannot be read fail closed.
 */
export async function resolveCrossTeamRecipient(
  ports: CrossTeamRecipientPorts,
  route: CrossTeamRoute
): Promise<CrossTeamRecipient> {
  const { fromTeam, toTeam } = route;
  await assertCrossTeamSender(ports, fromTeam);
  if ((await modeOf(ports, toTeam)) !== 'per_project') return exactName(ports, route);

  const projectPath = route.senderProjectPath?.trim();
  if (!projectPath) {
    throw new CrossTeamRecipientError(
      'SENDER_PROJECT_UNKNOWN',
      `Team "${toTeam}" keeps a separate history per project, and team "${fromTeam}" ` +
        'has no project folder to choose it by. Launch the sending team in a project first.'
    );
  }
  let context: PersistedTeamWorkContext | null;
  try {
    context = await ports.inspectContext(toTeam, projectPath);
  } catch (error) {
    throw new CrossTeamRecipientError(
      'UNRESOLVED',
      `Cannot find the history of team "${toTeam}" in project ${projectPath}: ${reasonOf(error)}`
    );
  }
  if (!context) {
    throw new CrossTeamRecipientError(
      'NO_PROJECT_HISTORY',
      `Team "${toTeam}" has no history in project ${projectPath} yet. ` +
        'Open the team in that project in the app and launch it once, then send again.'
    );
  }
  if (context.state !== 'ready') {
    throw new CrossTeamRecipientError(
      'PROJECT_LAUNCH_PENDING',
      `Team "${toTeam}" is being launched in project ${projectPath}. ` +
        'Send again when the launch has finished.'
    );
  }
  if (context.executionTeamName === fromTeam) {
    throw new CrossTeamRecipientError(
      'SAME_TEAM',
      'Cannot send cross-team message to the same team'
    );
  }
  return {
    teamName: context.executionTeamName,
    logicalTeamName: toTeam,
    projectPath: context.projectPath,
  };
}

type RecipientRegistry = Pick<
  TeamProjectContextRegistry,
  'inspect' | 'resolveOwnedExecutionAliases'
>;

/** The ports over any metadata store and registry; tests inject a temp-dir registry. */
export function createCrossTeamRecipientPorts(
  meta: TeamModeMetaReader,
  registry: RecipientRegistry
): CrossTeamRecipientPorts {
  return {
    getMode: (teamName) => readTeamProjectContextMode(meta, teamName, UNREADABLE_MESSAGE),
    inspectContext: (logicalTeamName, projectPath) =>
      registry.inspect(logicalTeamName, projectPath),
    findCopyOwners: (teamNames) => registry.resolveOwnedExecutionAliases(teamNames),
  };
}

/** The ports of the running app (read per call: the data root can change at runtime). */
export function createAppCrossTeamRecipientPorts(): CrossTeamRecipientPorts {
  return createCrossTeamRecipientPorts(
    new TeamMetaStore(),
    TeamProjectContextRegistry.fromCurrentApp()
  );
}
