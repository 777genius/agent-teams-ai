import { isHostTeamSelectionKey } from '@features/agent-backend/renderer';

import { capturedCrossTeamReply } from '../messages/capturedCrossTeamReply';

import type { InboxMessage } from '@shared/types';

/** Cross-Team display parsing and captured navigation share this one activity-row boundary. */
export function crossTeamActivityPresentation(options: {
  message: InboxMessage;
  teamName?: string;
  isCrossTeam: boolean;
  isCrossTeamSent: boolean;
  prefixFrom?: string;
  sentTarget: string | null;
  qualifiedTeam?: string;
  onTeamClick?: (team: string) => void;
  onReply?: (message: InboxMessage) => void;
}) {
  const { message, onTeamClick, onReply } = options;
  const from = options.prefixFrom ?? message.from,
    dot = from.indexOf('.');
  const origin =
    options.isCrossTeam && dot > 0 && dot < from.length - 1
      ? { teamName: from.substring(0, dot), memberName: from.substring(dot + 1) }
      : null;
  let target: string | null = null;
  if (options.isCrossTeamSent) {
    const toDot = message.to?.indexOf('.') ?? -1;
    target = options.sentTarget
      ? options.sentTarget
      : options.qualifiedTeam !== undefined
        ? options.qualifiedTeam
        : message.to
          ? toDot > 0
            ? message.to.substring(0, toDot)
            : message.to
          : null;
  }
  const host = isHostTeamSelectionKey(options.teamName);
  const fromKey = message.crossTeamNavigation?.fromTeamKey,
    toKey = message.crossTeamNavigation?.toTeamKey;
  const originTeamClick = host
    ? fromKey && onTeamClick
      ? () => onTeamClick(fromKey)
      : undefined
    : onTeamClick;
  const targetTeamClick = host
    ? toKey && onTeamClick
      ? () => onTeamClick(toKey)
      : undefined
    : onTeamClick;
  const canReply =
    !host || (!options.isCrossTeam && !options.isCrossTeamSent) || capturedCrossTeamReply(message);
  return {
    origin,
    target,
    originTeamClick,
    targetTeamClick,
    replyClick: onReply && canReply ? () => onReply(message) : undefined,
  };
}
