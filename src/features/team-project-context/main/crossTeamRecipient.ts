import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import {
  assertReadyProjectCopy,
  createProjectCopyPorts,
  findProjectCopyOwners,
  inspectProjectCopy,
  projectContextModeOf,
  ProjectContextRefusalError,
  resolveReadyProjectCopy,
  withProjectCopyRefusal,
} from './projectCopyRouting';
import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';

import type { TeamModeMetaReader } from './projectContextMode';
import type { ProjectCopyPorts, ProjectCopyRefusal } from './projectCopyRouting';

const UNREADABLE_MESSAGE = 'Team metadata is unreadable; refusing cross-team delivery';

export type CrossTeamRecipientPorts = Pick<
  ProjectCopyPorts,
  'getMode' | 'inspectContext' | 'findCopyOwners' | 'isLaunching'
>;

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
  | ProjectCopyRefusal
  | 'SENDER_IS_PROJECT_TEAM'
  | 'SENDER_PROJECT_UNKNOWN'
  | 'SAME_TEAM';

/** A message that cannot be delivered; the text says what to do instead. */
export class CrossTeamRecipientError extends ProjectContextRefusalError<CrossTeamRecipientRefusal> {
  override name = 'CrossTeamRecipientError';
}

/** What a sender does about a copy that cannot receive now. */
const NEXT_STEP: Record<ProjectCopyRefusal, string> = {
  NO_PROJECT_HISTORY:
    'Open the team in that project in the app and launch it once, then send again.',
  PROJECT_LAUNCH_PENDING: 'Send again when the launch has finished.',
  PROJECT_LAUNCH_INCOMPLETE:
    'Ensure the previous runtime has stopped and cleanup is complete, then launch the team again in that project.',
  UNRESOLVED: '',
};

/** A per-project team has no inbox or process of its own, so it never sends. */
export function assertCrossTeamSender(
  ports: CrossTeamRecipientPorts,
  fromTeam: string
): Promise<void> {
  return withProjectCopyRefusal(
    () => assertSender(ports, fromTeam),
    NEXT_STEP,
    (code, message) => new CrossTeamRecipientError(code, message)
  );
}

async function assertSender(ports: CrossTeamRecipientPorts, fromTeam: string): Promise<void> {
  if ((await projectContextModeOf(ports, fromTeam)) === 'per_project') {
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
 * the contexts indexes (`findProjectCopyOwners`).
 */
async function exactName(
  ports: CrossTeamRecipientPorts,
  { fromTeam, toTeam }: CrossTeamRoute
): Promise<CrossTeamRecipient> {
  const ownerOf = await findProjectCopyOwners(ports, [fromTeam, toTeam]);
  const target = ownerOf(toTeam);
  if (!target) return { teamName: toTeam };
  const sender = ownerOf(fromTeam);
  if (sender?.logicalTeamName === target.logicalTeamName) {
    throw new CrossTeamRecipientError(
      'SAME_TEAM',
      'Cannot send cross-team message to the same team'
    );
  }
  // The same rule as a send by the team's name: a ready copy (its row from the owner lookup) of a
  // team that is not being deleted or moved to trash (the same read as a send by name).
  const { logicalTeamName, context } = target;
  assertReadyProjectCopy(ports, logicalTeamName, context.projectPath, context);
  const inspected = await inspectProjectCopy(
    ports,
    logicalTeamName,
    context.projectPath,
    `Team "${logicalTeamName}" cannot receive messages in project ${context.projectPath}`
  );
  if (inspected?.executionTeamName !== toTeam) {
    throw new CrossTeamRecipientError(
      'UNRESOLVED',
      'The project copy changed while resolving the recipient'
    );
  }
  assertReadyProjectCopy(ports, logicalTeamName, context.projectPath, inspected);
  return { teamName: toTeam };
}

/**
 * The one rule for which physical team receives a cross-team message.
 *
 * - An ordinary team receives it under its name; so does a ready project copy
 *   named exactly (see `exactName`).
 * - A per-project team has no inbox or process of its own. It receives through
 *   its ready copy for the project the sender works in (`resolveReadyProjectCopy`):
 *   the message never goes to the history of another project, and no copy is
 *   created to receive it. Anything else is refused with what to do instead.
 * - A per-project team cannot be the sender, for the same reason.
 *
 * Unreadable metadata and an index that cannot be read fail closed.
 */
export function resolveCrossTeamRecipient(
  ports: CrossTeamRecipientPorts,
  route: CrossTeamRoute
): Promise<CrossTeamRecipient> {
  return withProjectCopyRefusal(
    () => routeCrossTeam(ports, route),
    NEXT_STEP,
    (code, message) => new CrossTeamRecipientError(code, message)
  );
}

async function routeCrossTeam(
  ports: CrossTeamRecipientPorts,
  route: CrossTeamRoute
): Promise<CrossTeamRecipient> {
  const { fromTeam, toTeam } = route;
  await assertSender(ports, fromTeam);
  if ((await projectContextModeOf(ports, toTeam)) !== 'per_project') {
    return exactName(ports, route);
  }

  const projectPath = route.senderProjectPath?.trim();
  if (!projectPath) {
    throw new CrossTeamRecipientError(
      'SENDER_PROJECT_UNKNOWN',
      `Team "${toTeam}" keeps a separate history per project, and team "${fromTeam}" ` +
        'has no project folder to choose it by. Launch the sending team in a project first.'
    );
  }
  const context = await resolveReadyProjectCopy(ports, toTeam, projectPath);
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

/**
 * The ports over any metadata store and registry; tests inject a temp-dir registry.
 * `isLaunching` tells a launch in flight from one that failed (see `resolveReadyProjectCopy`).
 */
export function createCrossTeamRecipientPorts(
  meta: TeamModeMetaReader,
  registry: Parameters<typeof createProjectCopyPorts>[1],
  isLaunching?: (executionTeamName: string) => boolean
): CrossTeamRecipientPorts {
  return createProjectCopyPorts(meta, registry, {
    unreadableMessage: UNREADABLE_MESSAGE,
    isLaunching,
  });
}

/** The ports of the running app (read per call: the data root can change at runtime). */
export function createAppCrossTeamRecipientPorts(
  isLaunching?: (executionTeamName: string) => boolean
): CrossTeamRecipientPorts {
  return createCrossTeamRecipientPorts(
    new TeamMetaStore(),
    TeamProjectContextRegistry.fromCurrentApp(),
    isLaunching
  );
}
