import type {
  AgentImageMimeType,
  AgentVideoMimeType,
  NativeAgentAttachmentMimeType,
} from './types';

export const AGENT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const satisfies readonly AgentImageMimeType[];

export const NATIVE_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const satisfies readonly NativeAgentAttachmentMimeType[];

export const NATIVE_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const satisfies readonly AgentVideoMimeType[];

export const CLAUDE_IMAGE_MIME_TYPES = [
  ...NATIVE_IMAGE_MIME_TYPES,
  'image/gif',
] as const satisfies readonly AgentImageMimeType[];

export function isAgentImageMimeType(mimeType: string): mimeType is AgentImageMimeType {
  return AGENT_IMAGE_MIME_TYPES.includes(mimeType as AgentImageMimeType);
}

export function isAgentVideoMimeType(mimeType: string): mimeType is AgentVideoMimeType {
  return NATIVE_VIDEO_MIME_TYPES.includes(mimeType as AgentVideoMimeType);
}

export function isNativeImageMimeType(
  mimeType: string
): mimeType is (typeof NATIVE_IMAGE_MIME_TYPES)[number] {
  return NATIVE_IMAGE_MIME_TYPES.includes(mimeType as (typeof NATIVE_IMAGE_MIME_TYPES)[number]);
}
