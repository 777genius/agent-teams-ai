import { hostTeamSelectionKey } from './hostTeamRouting';
import {
  qualifyHostTaskReferenceTeam,
  translateHostTaskReferences,
} from './translateHostTaskReferences';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';
import type { InboxMessage } from '@shared/types/team';

/** Display names stay canonical. Navigation uses only existing original scope bindings. */
export function remapHostCrossTeamMessages(
  messages: BackendTeamSnapshot['messages'],
  teamName: string,
  selection: string,
  bindings: BackendConnectionSnapshot['bindings']
): InboxMessage[] {
  return messages.map((message) => {
    const origin = message.crossTeamOrigin;
    const key = (handle: string | undefined, resource: string) => {
      const found = bindings.find((binding) =>
        handle === undefined
          ? binding.teamResourceRef === resource
          : binding.handle.handleId === handle
      );
      return found ? hostTeamSelectionKey(found.handle.handleId) : undefined;
    };
    const from = origin ? key(origin.fromHandleId, origin.fromTeamResourceRef) : undefined;
    const to = origin ? key(origin.toHandleId, origin.toTeamResourceRef) : undefined;
    const map = (value?: string) => {
      if (origin && value === origin.fromTeamName && from) return from;
      if (origin && value === origin.toTeamName && to) return to;
      return qualifyHostTaskReferenceTeam(value, teamName, selection);
    };
    return {
      ...message,
      text: translateHostTaskReferences(message.text, map),
      ...(message.summary === undefined
        ? {}
        : { summary: translateHostTaskReferences(message.summary, map) }),
      ...(message.taskRefs === undefined
        ? {}
        : { taskRefs: message.taskRefs.map((ref) => ({ ...ref, teamName: map(ref.teamName) })) }),
      ...(origin
        ? {
            crossTeamNavigation: {
              fromTeamName: origin.fromTeamName,
              toTeamName: origin.toTeamName,
              ...(from === undefined ? {} : { fromTeamKey: from }),
              ...(to === undefined ? {} : { toTeamKey: to }),
            },
          }
        : {}),
    };
  });
}
