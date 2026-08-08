import { api } from '@renderer/api';

import type { TeamMessageAttachmentReadPort } from '@features/team-message-delivery/renderer';

export function createTeamMessageAttachmentReadTransport(): TeamMessageAttachmentReadPort {
  return {
    getAttachments: (teamName, messageId) => api.teams.getAttachments(teamName, messageId),
  };
}
