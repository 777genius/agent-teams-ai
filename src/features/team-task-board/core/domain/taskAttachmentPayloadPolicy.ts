export const TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES = 20 * 1024 * 1024;

export const TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH =
  Math.ceil(TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES / 3) * 4;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalTaskAttachmentId(value: string): boolean {
  return CANONICAL_UUID_PATTERN.test(value);
}

function getBase64AlphabetIndex(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (character === '+') return 62;
  if (character === '/') return 63;
  return -1;
}

export function isCanonicalTaskAttachmentBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }

  const paddingLength = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const payloadLength = value.length - paddingLength;
  for (let index = 0; index < payloadLength; index += 1) {
    if (getBase64AlphabetIndex(value[index] ?? '') < 0) return false;
  }
  for (let index = payloadLength; index < value.length; index += 1) {
    if (value[index] !== '=') return false;
  }

  if (paddingLength === 2) {
    const finalPayloadIndex = getBase64AlphabetIndex(value[payloadLength - 1] ?? '');
    return finalPayloadIndex >= 0 && (finalPayloadIndex & 0b1111) === 0;
  }
  if (paddingLength === 1) {
    const finalPayloadIndex = getBase64AlphabetIndex(value[payloadLength - 1] ?? '');
    return finalPayloadIndex >= 0 && (finalPayloadIndex & 0b11) === 0;
  }
  return true;
}

export function estimateTaskAttachmentDecodedBytes(base64Data: string): number {
  const trimmed = base64Data.trim();
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}
