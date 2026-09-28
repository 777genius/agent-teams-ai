import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';
import {
  getCrossTeamSentTarget,
  parseQualifiedRecipient,
} from '@renderer/components/team/activity/activityMessagePresentation';
import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
} from '@shared/constants/crossTeam';

import type { ConversationScope } from '@features/team-direct-chats/renderer';
import type { InboxMessage } from '@shared/types';

interface ReplyRecipientInput {
  message: InboxMessage;
  scope: ConversationScope;
  teamName: string;
  members: readonly { name: string }[];
}

/** Resolves only an unambiguous local reply route. Quote authorship remains message.from. */
export function resolveReplyRecipient({
  message,
  scope,
  teamName,
  members,
}: ReplyRecipientInput): string {
  const memberByNormalizedName = new Map(
    members.map((member) => [normalizeConversationParticipant(member.name), member.name])
  );
  const localMemberNames = new Set(members.map((member) => member.name));
  const route = message.to?.trim();
  const hasQualifiedExternalRoute =
    route != null &&
    !localMemberNames.has(route) &&
    (parseQualifiedRecipient(route) !== null ||
      getCrossTeamSentTarget(route, teamName, localMemberNames) !== null);
  const isCrossTeam =
    message.source === CROSS_TEAM_SOURCE ||
    message.source === CROSS_TEAM_SENT_SOURCE ||
    parseCrossTeamPrefix(message.text) !== null ||
    hasQualifiedExternalRoute;
  if (isCrossTeam) return '';

  if (scope.kind === 'direct') {
    return memberByNormalizedName.get(normalizeConversationParticipant(scope.participant)) ?? '';
  }

  if (normalizeConversationParticipant(message.from) === 'user') {
    return memberByNormalizedName.get(normalizeConversationParticipant(message.to)) ?? '';
  }

  return memberByNormalizedName.get(normalizeConversationParticipant(message.from)) ?? '';
}
