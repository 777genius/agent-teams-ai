import { resolveCrossTeamRecipientIdentity } from '../CrossTeamRecipientIdentity';

import type { RuntimeDeliveryJournalRecord } from '../opencode/delivery/RuntimeDeliveryJournal';
import type { TeamConfig, TeamMember } from '@shared/types';

export interface RuntimeDeliveryIdentitySources {
  config: TeamConfig;
  metaMembers: readonly TeamMember[];
}

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

export function getRuntimeDeliveryDestinationTeamName(
  record: RuntimeDeliveryJournalRecord
): string | null {
  if (record.destination.kind === 'user_sent_messages') {
    return null;
  }
  return record.destination.kind === 'member_inbox'
    ? record.destination.teamName
    : record.destination.toTeamName;
}

export function canonicalizeRuntimeDeliveryJournalDestination(
  destination: RuntimeDeliveryJournalRecord['destination'],
  sources: RuntimeDeliveryIdentitySources
): RuntimeDeliveryJournalRecord['destination'] {
  if (destination.kind === 'user_sent_messages') {
    return destination;
  }
  const rawMemberName =
    destination.kind === 'member_inbox' ? destination.memberName : destination.toMemberName;
  const canonicalMemberName = resolveCrossTeamRecipientIdentity({
    sources,
    rawToMember: rawMemberName,
  }).memberName;
  if (canonicalMemberName === rawMemberName) {
    return destination;
  }
  return destination.kind === 'member_inbox'
    ? { ...destination, memberName: canonicalMemberName }
    : { ...destination, toMemberName: canonicalMemberName };
}

export function canonicalizeRuntimeDeliveryJournalLocation(
  location: NonNullable<RuntimeDeliveryJournalRecord['committedLocation']>,
  sources: RuntimeDeliveryIdentitySources
): NonNullable<RuntimeDeliveryJournalRecord['committedLocation']> {
  if (location.kind === 'user_sent_messages') {
    return location;
  }
  const rawMemberName =
    location.kind === 'member_inbox' ? location.memberName : location.toMemberName;
  const canonicalMemberName = resolveCrossTeamRecipientIdentity({
    sources,
    rawToMember: rawMemberName,
  }).memberName;
  if (canonicalMemberName === rawMemberName) {
    return location;
  }
  return location.kind === 'member_inbox'
    ? { ...location, memberName: canonicalMemberName }
    : { ...location, toMemberName: canonicalMemberName };
}
