import {
  MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
  MAX_AGENT_VIDEO_ATTACHMENT_BYTES,
} from './budgets';
import {
  CLAUDE_IMAGE_MIME_TYPES,
  NATIVE_IMAGE_MIME_TYPES,
  NATIVE_VIDEO_MIME_TYPES,
} from './mimeTypes';

import type {
  AgentAttachmentCapability,
  AgentAttachmentCapabilityTarget,
  AgentImageMimeType,
} from './types';

const DEFAULT_IMAGE_BYTES_PER_PROVIDER = 4 * 1024 * 1024;
const DEFAULT_FILE_BYTES_PER_PROVIDER = 4 * 1024 * 1024;
function supportedImagesOnly(
  displayText: string,
  supportedImageMimeTypes: readonly AgentImageMimeType[] = NATIVE_IMAGE_MIME_TYPES
): AgentAttachmentCapability {
  return {
    supportsImages: true,
    supportsFiles: false,
    supportsVideo: false,
    supportedImageMimeTypes: [...supportedImageMimeTypes],
    supportedFileMimeTypes: [],
    supportedVideoMimeTypes: [],
    maxImages: 5,
    maxFiles: 0,
    maxVideos: 0,
    maxBytesPerImage: DEFAULT_IMAGE_BYTES_PER_PROVIDER,
    maxBytesPerFile: 0,
    maxBytesPerVideo: 0,
    maxBytesTotal: MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
    reason: 'known_provider_support',
    displayText,
    filesDisplayText:
      'This provider path currently supports image attachments only. Non-image files are blocked before provider delivery.',
    videoDisplayText:
      'This provider path does not support video attachments through this delivery path.',
  };
}

function supportedClaude(displayText: string): AgentAttachmentCapability {
  return {
    ...supportedImagesOnly(displayText, CLAUDE_IMAGE_MIME_TYPES),
    supportsFiles: true,
    supportedFileMimeTypes: ['application/pdf', 'text/*'],
    maxFiles: 5,
    maxBytesPerFile: DEFAULT_FILE_BYTES_PER_PROVIDER,
    filesDisplayText: 'Claude can receive text files and PDFs through structured document blocks.',
  };
}

function unsupported(
  reason: AgentAttachmentCapability['reason'],
  displayText: string
): AgentAttachmentCapability {
  return {
    supportsImages: false,
    supportsFiles: false,
    supportsVideo: false,
    supportedImageMimeTypes: [],
    supportedFileMimeTypes: [],
    supportedVideoMimeTypes: [],
    maxImages: 0,
    maxFiles: 0,
    maxVideos: 0,
    maxBytesPerImage: 0,
    maxBytesPerFile: 0,
    maxBytesPerVideo: 0,
    maxBytesTotal: 0,
    reason,
    displayText,
    filesDisplayText:
      'Selected provider does not support non-image file attachments through this delivery path.',
    videoDisplayText:
      'Selected provider does not support video attachments through this delivery path.',
  };
}

export function resolveAgentAttachmentCapability(
  target: AgentAttachmentCapabilityTarget
): AgentAttachmentCapability {
  const providerId = target.providerId.trim().toLowerCase();

  if (providerId === 'anthropic') {
    return supportedClaude('Claude can receive image attachments through structured image blocks.');
  }

  if (providerId === 'codex') {
    const images = supportedImagesOnly(
      'Codex can receive image attachments through the native image channel.'
    );
    if (target.nativeInboxTextAttachmentsSupported !== true) return images;
    return {
      ...images,
      supportsFiles: true,
      supportedFileMimeTypes: ['text/plain'],
      maxFiles: 5,
      maxBytesPerFile: DEFAULT_FILE_BYTES_PER_PROVIDER,
      filesDisplayText: 'This Codex teammate can receive UTF-8 text file contents in its turn.',
    };
  }

  if (providerId === 'opencode') {
    const declaration = target.declaredInputModalities;
    if (
      !Array.isArray(declaration) ||
      declaration.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      const unknown = unsupported(
        'unknown_model',
        'This OpenCode model has unknown image input support. Refresh the model catalog or remove the image.'
      );
      return {
        ...unknown,
        videoDisplayText:
          'This OpenCode model has unknown video input support. Refresh the model catalog or remove the video.',
      };
    }
    const images = declaration.includes('image');
    const video = declaration.includes('video');
    return {
      ...unsupported(
        images || video ? 'known_vision_model' : 'known_non_vision_model',
        images
          ? 'This OpenCode model declares image input support.'
          : 'This OpenCode model does not declare image input support.'
      ),
      supportsImages: images,
      supportsVideo: video,
      supportedImageMimeTypes: images ? [...NATIVE_IMAGE_MIME_TYPES] : [],
      supportedVideoMimeTypes: video ? [...NATIVE_VIDEO_MIME_TYPES] : [],
      maxImages: images ? 5 : 0,
      maxVideos: video ? 1 : 0,
      maxBytesPerImage: images ? DEFAULT_IMAGE_BYTES_PER_PROVIDER : 0,
      maxBytesPerVideo: video ? MAX_AGENT_VIDEO_ATTACHMENT_BYTES : 0,
      maxBytesTotal: MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
      videoDisplayText: video
        ? 'This OpenCode model declares video input support.'
        : 'This OpenCode model does not declare video input support.',
    };
  }

  return unsupported(
    'unsupported_provider',
    'Selected provider does not support image attachments through this delivery path.'
  );
}
