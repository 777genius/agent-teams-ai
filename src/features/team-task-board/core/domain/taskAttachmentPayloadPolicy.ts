export const TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES = 20 * 1024 * 1024;

export const TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH =
  Math.ceil(TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES / 3) * 4;

export function estimateTaskAttachmentDecodedBytes(base64Data: string): number {
  const trimmed = base64Data.trim();
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}
