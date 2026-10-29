import {
  estimateAgentAttachmentSerializedPayloadBytes,
  MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
  MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES,
} from '../../../core/domain';

import type { AttachmentPayload } from '@shared/types';

export {
  MAX_AGENT_IPC_ATTACHMENTS,
  validateAgentAttachmentIpcPayload,
} from '@agent-teams/legacy-agent-host/attachments/portable';

export function validateAgentAttachmentSerializedIpcPayload(input: {
  text: string;
  attachments: AttachmentPayload[];
  /** Main confirms the selected native video route, never renderer-controlled. */
  nativeVideoDelivery?: boolean;
}): { valid: true } | { valid: false; error: string } {
  const estimatedBytes = estimateAgentAttachmentSerializedPayloadBytes(input);
  const serializedLimit = input.nativeVideoDelivery
    ? Math.ceil(MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL / 3) * 4 +
      new TextEncoder().encode(JSON.stringify(input.text)).byteLength +
      4096
    : MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES;
  if (estimatedBytes <= serializedLimit) return { valid: true };

  return {
    valid: false,
    error: `Attachment payload is too large after optimization: ${formatBytes(
      estimatedBytes
    )} serialized. Limit is ${formatBytes(
      serializedLimit
    )}. Remove an attachment or use a smaller file.`,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
