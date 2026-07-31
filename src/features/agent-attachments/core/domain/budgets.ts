import type { ImageBudgetAllocation, ImageDimensions, ImageOptimizationBudget } from './types';

export const DEFAULT_AGENT_IMAGE_OPTIMIZATION_BUDGET: ImageOptimizationBudget = {
  maxInputBytes: 20 * 1024 * 1024,
  maxInputPixels: 32_000_000,
  maxOutputBytesPerImage: 4 * 1024 * 1024,
  maxOutputBytesTotal: 8 * 1024 * 1024,
  maxOutputEdge: 2400,
  jpegQualityAttempts: [0.86, 0.82, 0.78, 0.74, 0.72],
};

export const MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES = 7_500_000;
export const MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL = 8 * 1024 * 1024;
export const MAX_AGENT_VIDEO_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const utf8Encoder = new TextEncoder();

export function estimateAgentAttachmentSerializedPayloadBytes(input: {
  text?: string;
  attachments: {
    mimeType: string;
    data: string;
    filename?: string;
  }[];
}): number {
  const contentBlocks: unknown[] = [{ type: 'text', text: input.text ?? '' }];
  for (const attachment of input.attachments) {
    const isImage = attachment.mimeType.startsWith('image/');
    contentBlocks.push({
      type: isImage ? 'image' : 'document',
      ...(isImage
        ? {}
        : {
            title: attachment.filename ?? 'attachment',
          }),
      source: {
        type: 'base64',
        media_type: attachment.mimeType,
        data: attachment.data,
      },
    });
  }

  return utf8Encoder.encode(
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
    })
  ).byteLength;
}

export function calculatePixelCount(dimensions: ImageDimensions): number {
  return dimensions.width * dimensions.height;
}

export function planResizeDimensions(
  dimensions: ImageDimensions,
  options: { maxEdge: number; allowUpscale?: boolean }
): ImageDimensions {
  const width = Math.max(1, Math.floor(dimensions.width));
  const height = Math.max(1, Math.floor(dimensions.height));
  const maxEdge = Math.max(1, Math.floor(options.maxEdge));
  const longest = Math.max(width, height);

  if (longest <= maxEdge && options.allowUpscale !== true) {
    return { width, height };
  }

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function allocateImageBudgets(input: {
  images: { id: string }[];
  totalMaxBytes: number;
  perImageMaxBytes: number;
}): ImageBudgetAllocation[] {
  const count = Math.max(1, input.images.length);
  const fairShare = Math.floor(input.totalMaxBytes / count);
  const targetBytes = Math.max(1, Math.min(input.perImageMaxBytes, fairShare));

  return input.images.map((image) => ({ imageId: image.id, targetBytes }));
}

export function assertImageInputWithinBudget(input: {
  sizeBytes: number;
  dimensions: ImageDimensions;
  budget?: ImageOptimizationBudget;
}): void {
  const budget = input.budget ?? DEFAULT_AGENT_IMAGE_OPTIMIZATION_BUDGET;
  if (input.sizeBytes > budget.maxInputBytes) {
    throw new Error('Image input exceeds byte budget');
  }
  if (calculatePixelCount(input.dimensions) > budget.maxInputPixels) {
    throw new Error('Image input exceeds pixel budget');
  }
}

export function sortAttachmentsForDelivery<T extends { order: number }>(attachments: T[]): T[] {
  return [...attachments].sort((left, right) => left.order - right.order);
}
