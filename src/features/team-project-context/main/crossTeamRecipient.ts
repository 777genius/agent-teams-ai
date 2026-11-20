import { readTeamProjectContextMode } from './projectContextMode';

import type { TeamModeMetaReader } from './projectContextMode';
import type {
  PersistedTeamWorkContext,
  TeamProjectContextRegistry,
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

/**
 * The one rule for which physical team receives a cross-team message.
 *
 * - An ordinary team, or a project copy named exactly, receives it under that
 *   name. A copy must stay addressable: the `from` of a message a copy sent is
 *   its own name, and the reply has to reach that copy, not another project.
 * - A per-project team has no inbox or process of its own. It receives through
 *   its copy for the project the sender works in, and only a ready one: the
 *   message never crosses into the history of another project, and no copy is
 *   created to receive it. Anything else is refused with what to do instead.
 * - A per-project team cannot be the sender, for the same reason.
 *
 * Unreadable metadata and an index that cannot be read fail closed.
 */
export async function resolveCrossTeamRecipient(
  ports: CrossTeamRecipientPorts,
  route: CrossTeamRoute
): Promise<CrossTeamRecipient> {
  const { fromTeam, toTeam } = route;
  if ((await ports.getMode(fromTeam)) === 'per_project') {
    throw new CrossTeamRecipientError(
      'SENDER_IS_PROJECT_TEAM',
      `Team "${fromTeam}" keeps a separate history per project and has no inbox of its own. ` +
        'Send from the team opened in a project.'
    );
  }
  if ((await ports.getMode(toTeam)) !== 'per_project') return { teamName: toTeam };

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
    const reason = error instanceof Error ? error.message : String(error);
    throw new CrossTeamRecipientError(
      'UNRESOLVED',
      `Cannot find the history of team "${toTeam}" in project ${projectPath}: ${reason}`
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

/** The ports every production caller uses; tests inject a temp-dir registry. */
export function createCrossTeamRecipientPorts(
  meta: TeamModeMetaReader,
  registry: Pick<TeamProjectContextRegistry, 'inspect'>
): CrossTeamRecipientPorts {
  return {
    getMode: (teamName) => readTeamProjectContextMode(meta, teamName, UNREADABLE_MESSAGE),
    inspectContext: (logicalTeamName, projectPath) =>
      registry.inspect(logicalTeamName, projectPath),
  };
}
