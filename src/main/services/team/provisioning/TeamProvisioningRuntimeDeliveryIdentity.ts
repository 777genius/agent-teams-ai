import {
  createAppCrossTeamRecipientPorts,
  createProjectLaunchProbe,
  resolveCrossTeamRecipient,
} from '@features/team-project-context/main';

import { resolveCrossTeamRecipientIdentity } from '../CrossTeamRecipientIdentity';

import type { RuntimeDeliveryEnvelope } from '../opencode/delivery/RuntimeDeliveryJournal';
import type { CrossTeamRoute } from '@features/team-project-context/main';
import type { TeamConfig, TeamMember } from '@shared/types';

export interface RuntimeDeliveryIdentitySources {
  config: TeamConfig;
  metaMembers: readonly TeamMember[];
}

/** Which physical team receives a cross-team message (`resolveCrossTeamRecipient`). */
export type CrossTeamTargetRoute = (route: CrossTeamRoute) => Promise<string>;

/**
 * The rule of the running app, the same one `CrossTeamService` applies. A pending copy reads as
 * being launched only while a launch of it is in flight in this app.
 */
export const routeCrossTeamTargetInApp: CrossTeamTargetRoute = async (route) =>
  (
    await resolveCrossTeamRecipient(
      createAppCrossTeamRecipientPorts(createProjectLaunchProbe()),
      route
    )
  ).teamName;

export async function readRuntimeDeliveryIdentitySources(
  teamNames: readonly string[],
  senderTeamName: string,
  readConfig: (teamName: string) => Promise<TeamConfig | null>,
  readMetaMembers: (teamName: string) => Promise<readonly TeamMember[]>
): Promise<Map<string, RuntimeDeliveryIdentitySources>> {
  const identitySources = new Map<string, RuntimeDeliveryIdentitySources>();
  await Promise.all(
    [...new Set(teamNames)].map(async (teamName) => {
      const [config, metaMembers] = await Promise.all([
        readConfig(teamName),
        readMetaMembers(teamName),
      ]);
      if (!config || config.deletedAt) {
        const identityKind = teamName === senderTeamName ? 'sender' : 'target';
        throw new Error(`Cross-team ${identityKind} identity is unavailable: ${teamName}`);
      }
      identitySources.set(teamName, { config, metaMembers });
    })
  );
  return identitySources;
}

export function requireRuntimeDeliveryIdentitySources(
  identitySources: ReadonlyMap<string, RuntimeDeliveryIdentitySources>,
  teamName: string,
  kind: 'sender' | 'target'
): RuntimeDeliveryIdentitySources {
  const sources = identitySources.get(teamName);
  if (!sources) {
    throw new Error(`Cross-team ${kind} identity is unavailable: ${teamName}`);
  }
  return sources;
}

async function readIdentity(
  teamName: string,
  senderTeamName: string,
  kind: 'sender' | 'target',
  readConfig: (teamName: string) => Promise<TeamConfig | null>,
  readMetaMembers: (teamName: string) => Promise<readonly TeamMember[]>
): Promise<RuntimeDeliveryIdentitySources> {
  const sources = await readRuntimeDeliveryIdentitySources(
    [teamName],
    senderTeamName,
    readConfig,
    readMetaMembers
  );
  return requireRuntimeDeliveryIdentitySources(sources, teamName, kind);
}

/**
 * The canonical sender and target of a runtime message, before it is journaled.
 * A cross-team target is first routed by the one cross-team rule, so a message to
 * a per-project team names its copy for the sender's project everywhere after
 * this: in the journal, at the destination and in its delivery proof.
 */
export async function canonicalizeRuntimeDeliveryCrossTeamIdentities(
  envelope: RuntimeDeliveryEnvelope,
  readConfig: (teamName: string) => Promise<TeamConfig | null>,
  readMetaMembers: (teamName: string) => Promise<readonly TeamMember[]>,
  routeTarget: CrossTeamTargetRoute
): Promise<RuntimeDeliveryEnvelope> {
  const senderSources = await readIdentity(
    envelope.teamName,
    envelope.teamName,
    'sender',
    readConfig,
    readMetaMembers
  );
  const canonicalFromMemberName = resolveCrossTeamRecipientIdentity({
    sources: senderSources,
    rawToMember: envelope.fromMemberName,
  }).memberName;

  let canonicalTarget = envelope.to;
  if (envelope.to !== 'user' && 'teamName' in envelope.to) {
    const targetTeamName = await routeTarget({
      fromTeam: envelope.teamName,
      toTeam: envelope.to.teamName,
      senderProjectPath: senderSources.config.projectPath,
    });
    const targetSources = await readIdentity(
      targetTeamName,
      envelope.teamName,
      'target',
      readConfig,
      readMetaMembers
    );
    canonicalTarget = {
      teamName: targetTeamName,
      memberName: resolveCrossTeamRecipientIdentity({
        sources: targetSources,
        rawToMember: envelope.to.memberName,
      }).memberName,
    };
  }

  if (
    canonicalFromMemberName === envelope.fromMemberName &&
    (canonicalTarget === envelope.to ||
      (canonicalTarget !== 'user' &&
        envelope.to !== 'user' &&
        'teamName' in canonicalTarget &&
        'teamName' in envelope.to &&
        canonicalTarget.teamName === envelope.to.teamName &&
        canonicalTarget.memberName === envelope.to.memberName))
  ) {
    return envelope;
  }
  return {
    ...envelope,
    fromMemberName: canonicalFromMemberName,
    to: canonicalTarget,
  };
}
