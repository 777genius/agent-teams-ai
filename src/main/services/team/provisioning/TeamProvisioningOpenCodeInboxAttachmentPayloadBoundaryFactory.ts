import {
  type OpenCodeAttachmentPayloadStore,
  type OpenCodeInboxAttachmentPayloadsResult,
  resolveOpenCodeInboxAttachmentPayloads,
} from './TeamProvisioningOpenCodeAttachmentPayloads';

import type { InboxMessage } from '@shared/types';

export interface TeamProvisioningOpenCodeInboxAttachmentPayloadBoundaryDeps {
  getAttachmentStore(): OpenCodeAttachmentPayloadStore;
}

export interface TeamProvisioningOpenCodeInboxAttachmentPayloadBoundary {
  resolveOpenCodeInboxAttachmentPayloads(input: {
    teamName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<OpenCodeInboxAttachmentPayloadsResult>;
}

export function createTeamProvisioningOpenCodeInboxAttachmentPayloadBoundary(
  deps: TeamProvisioningOpenCodeInboxAttachmentPayloadBoundaryDeps
): TeamProvisioningOpenCodeInboxAttachmentPayloadBoundary {
  return {
    resolveOpenCodeInboxAttachmentPayloads(input) {
      return resolveOpenCodeInboxAttachmentPayloads(input, {
        attachmentStore: deps.getAttachmentStore(),
      });
    },
  };
}
