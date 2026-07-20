import type {
  AgentAttachmentCapability,
  AgentAttachmentCapabilityTarget,
  AgentImageMimeType,
} from './types';

const DEFAULT_IMAGE_BYTES_PER_PROVIDER = 4 * 1024 * 1024;
const DEFAULT_IMAGE_BYTES_TOTAL = 8 * 1024 * 1024;
const DEFAULT_FILE_BYTES_PER_PROVIDER = 4 * 1024 * 1024;
const VERIFIED_OPENCODE_IMAGE_MODELS = new Set([
  'gpt-5.4-mini',
  'moonshotai/kimi-k2.6',
  'z-ai/glm-4.5v',
  'kimi-for-coding/k3',
  'kimi-for-coding/kimi-for-coding',
  'kimi-for-coding/kimi-for-coding-highspeed',
]);

export const NATIVE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const CLAUDE_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

function supportedImagesOnly(
  displayText: string,
  supportedImageMimeTypes: readonly AgentImageMimeType[] = NATIVE_IMAGE_MIME_TYPES
): AgentAttachmentCapability {
  return {
    supportsImages: true,
    supportsFiles: false,
    supportedImageMimeTypes: [...supportedImageMimeTypes],
    supportedFileMimeTypes: [],
    maxImages: 5,
    maxFiles: 0,
    maxBytesPerImage: DEFAULT_IMAGE_BYTES_PER_PROVIDER,
    maxBytesPerFile: 0,
    maxBytesTotal: DEFAULT_IMAGE_BYTES_TOTAL,
    reason: 'known_provider_support',
    displayText,
    filesDisplayText:
      'This provider path currently supports image attachments only. Non-image files are blocked before provider delivery.',
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
    supportedImageMimeTypes: [],
    supportedFileMimeTypes: [],
    maxImages: 0,
    maxFiles: 0,
    maxBytesPerImage: 0,
    maxBytesPerFile: 0,
    maxBytesTotal: 0,
    reason,
    displayText,
    filesDisplayText:
      'Selected provider does not support non-image file attachments through this delivery path.',
  };
}

export function canonicalizeOpenCodeModel(input: { providerId: string; model?: string | null }): {
  providerId: string;
  model: string;
} {
  const providerId = input.providerId.trim().toLowerCase();
  const model = (input.model ?? '')
    .trim()
    .toLowerCase()
    .replace(/^openrouter\//, '')
    .replace(/^openai\//, '');
  return { providerId, model };
}

export function resolveAgentAttachmentCapability(
  target: AgentAttachmentCapabilityTarget
): AgentAttachmentCapability {
  const providerId = target.providerId.trim().toLowerCase();

  if (providerId === 'anthropic') {
    return supportedClaude('Claude can receive image attachments through structured image blocks.');
  }

  if (providerId === 'codex') {
    return supportedImagesOnly(
      'Codex can receive image attachments through the native image channel.'
    );
  }

  if (providerId === 'opencode') {
    const { model } = canonicalizeOpenCodeModel(target);
    if (VERIFIED_OPENCODE_IMAGE_MODELS.has(model)) {
      return {
        ...supportedImagesOnly(`OpenCode model ${model} is verified for image attachments.`),
        reason: 'known_vision_model',
      };
    }
    if (model === 'z-ai/glm-5.1') {
      return unsupported(
        'known_non_vision_model',
        'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.'
      );
    }
    return unsupported(
      'unknown_model',
      'This OpenCode model has unknown image support. Image delivery is blocked for reliability.'
    );
  }

  return unsupported(
    'unsupported_provider',
    'Selected provider does not support image attachments through this delivery path.'
  );
}
