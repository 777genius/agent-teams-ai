import { CROSS_TEAM_SENT_SOURCE, CROSS_TEAM_SOURCE } from '@shared/constants/crossTeam';
import { isConversationLeadAlias, isLeadThoughtSourceMessage } from '@shared/utils/leadDetection';

import { type ConversationScope, normalizeConversationParticipant } from './conversationScope';

import type { InboxMessage } from '@shared/types';

const USER_PARTICIPANT = 'user';

export function isLeadConversationParticipant(
  value: string | undefined,
  leadNames: Iterable<string>
): boolean {
  if (isConversationLeadAlias(value)) {
    return true;
  }
  const normalized = normalizeConversationParticipant(value);
  if (!normalized) {
    return false;
  }
  for (const leadName of leadNames) {
    if (normalizeConversationParticipant(leadName) === normalized) {
      return true;
    }
  }
  return false;
}

function isQualifiedParticipant(value: string): boolean {
  return value.includes('/');
}

function isCrossTeamMessage(message: InboxMessage): boolean {
  if (message.source === CROSS_TEAM_SOURCE || message.source === CROSS_TEAM_SENT_SOURCE) {
    return true;
  }
  return isQualifiedParticipant(message.from) || isQualifiedParticipant(message.to ?? '');
}

function isUserParticipant(value: string): boolean {
  return value === USER_PARTICIPANT;
}

function isDirectPair(from: string, to: string, participant: string): boolean {
  if (!participant || isQualifiedParticipant(from) || isQualifiedParticipant(to)) {
    return false;
  }
  return (
    (isUserParticipant(from) && to === participant) ||
    (from === participant && isUserParticipant(to))
  );
}

function isLeadThreadTraffic(
  from: string,
  to: string,
  participant: string,
  leadNames: Iterable<string>
): boolean {
  if (!to || !isLeadConversationParticipant(participant, leadNames)) {
    return false;
  }
  if (isQualifiedParticipant(from) || isQualifiedParticipant(to)) {
    return false;
  }
  return (
    isLeadConversationParticipant(from, leadNames) || isLeadConversationParticipant(to, leadNames)
  );
}

function isLeadBootstrapToParticipant(
  from: string,
  to: string,
  participant: string,
  leadNames: Iterable<string>
): boolean {
  if (!participant || to !== participant) {
    return false;
  }
  if (isQualifiedParticipant(from) || isQualifiedParticipant(to)) {
    return false;
  }
  return isLeadConversationParticipant(from, leadNames);
}

function isLeadThoughtForLead(
  message: InboxMessage,
  participant: string,
  leadNames: Iterable<string>
): boolean {
  if (!isLeadThoughtSourceMessage(message)) {
    return false;
  }
  return isLeadConversationParticipant(participant, leadNames);
}

export function belongsToConversation(
  message: InboxMessage,
  scope: ConversationScope,
  leadNames: Iterable<string>
): boolean {
  if (scope.kind === 'team-feed') {
    return true;
  }
  if (isCrossTeamMessage(message)) {
    return false;
  }
  const participant = normalizeConversationParticipant(scope.participant);
  if (!participant) {
    return false;
  }
  const leadNameList = [...leadNames];
  const from = normalizeConversationParticipant(message.from);
  const to = normalizeConversationParticipant(message.to);
  if (isLeadThoughtSourceMessage(message)) {
    return isLeadThoughtForLead(message, participant, leadNameList);
  }
  if (isDirectPair(from, to, participant)) {
    return true;
  }
  if (isLeadThreadTraffic(from, to, participant, leadNameList)) {
    return true;
  }
  if (isLeadBootstrapToParticipant(from, to, participant, leadNameList)) {
    return true;
  }
  return false;
}
