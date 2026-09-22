import {
  type AttachmentWarning,
  DEFAULT_AGENT_IMAGE_OPTIMIZATION_BUDGET,
  type ImageDimensions,
  type ImageOptimizationBudget,
  planResizeDimensions,
  validateImageOptimizationInput,
} from '@features/agent-attachments/core/domain';
import createPica from 'pica';

export interface OptimizeImageForAgentInput {
  file: File;
  budget?: ImageOptimizationBudget;
}

export interface OptimizeImageForAgentResult {
  original: {
    blob: Blob;
    mimeType: string;
    sizeBytes: number;
    width: number;
    height: number;
  };
  optimized: {
    blob: Blob;
    mimeType: 'image/png' | 'image/jpeg';
    sizeBytes: number;
    width: number;
    height: number;
  };
  warnings: AttachmentWarning[];
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error('Could not encode image canvas'));
        else resolve(blob);
      },
      mimeType,
      quality
    );
  });
}

async function drawBitmapToCanvas(
  bitmap: ImageBitmap,
  dimensions: ImageDimensions
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create image canvas context');
  context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
  return canvas;
}

async function resizeCanvas(
  source: HTMLCanvasElement,
  dimensions: ImageDimensions
): Promise<HTMLCanvasElement> {
  const target = document.createElement('canvas');
  target.width = dimensions.width;
  target.height = dimensions.height;
  const pica = createPica();
  await pica.resize(source, target);
  return target;
}

async function encodeJpegWithinBudget(
  canvas: HTMLCanvasElement,
  budget: ImageOptimizationBudget,
  targetBytes: number,
  warnings: AttachmentWarning[]
): Promise<Blob> {
  for (const quality of budget.jpegQualityAttempts) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (blob.size <= targetBytes) {
      if (quality < budget.jpegQualityAttempts[0]) {
        warnings.push({
          code: 'image_quality_reduced',
          message: 'Image quality was reduced to fit the provider budget.',
        });
      }
      return blob;
    }
  }
  throw new Error('Image is too large after optimization. Remove it or use a smaller image.');
}

export async function optimizeImageForAgent(
  input: OptimizeImageForAgentInput
): Promise<OptimizeImageForAgentResult> {
  const budget = input.budget ?? DEFAULT_AGENT_IMAGE_OPTIMIZATION_BUDGET;
  const bitmap = await createImageBitmap(input.file);
  const originalDimensions = { width: bitmap.width, height: bitmap.height };
  const validation = validateImageOptimizationInput({
    mimeType: input.file.type,
    sizeBytes: input.file.size,
    width: originalDimensions.width,
    height: originalDimensions.height,
    budget,
  });
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const targetDimensions = planResizeDimensions(originalDimensions, {
    maxEdge: budget.maxOutputEdge,
  });
  const warnings: AttachmentWarning[] = [...validation.warnings];
  if (
    targetDimensions.width !== originalDimensions.width ||
    targetDimensions.height !== originalDimensions.height
  ) {
    warnings.push({ code: 'image_was_resized', message: 'Image was resized before sending.' });
  }

  const sourceCanvas = await drawBitmapToCanvas(bitmap, originalDimensions);
  const outputCanvas =
    targetDimensions.width === originalDimensions.width &&
    targetDimensions.height === originalDimensions.height
      ? sourceCanvas
      : await resizeCanvas(sourceCanvas, targetDimensions);

  let optimizedBlob: Blob;
  let optimizedMimeType: 'image/png' | 'image/jpeg';
  if (input.file.type === 'image/png') {
    optimizedBlob = await canvasToBlob(outputCanvas, 'image/png');
    optimizedMimeType = 'image/png';
    if (optimizedBlob.size > budget.maxOutputBytesPerImage) {
      throw new Error(
        'PNG image is too large after optimization. Use a smaller screenshot or JPEG image.'
      );
    }
  } else {
    optimizedBlob = await encodeJpegWithinBudget(
      outputCanvas,
      budget,
      budget.maxOutputBytesPerImage,
      warnings
    );
    optimizedMimeType = 'image/jpeg';
    if (input.file.type !== 'image/jpeg') {
      warnings.push({ code: 'image_was_reencoded', message: 'Image was converted to JPEG.' });
    }
  }

  return {
    original: {
      blob: input.file,
      mimeType: input.file.type,
      sizeBytes: input.file.size,
      ...originalDimensions,
    },
    optimized: {
      blob: optimizedBlob,
      mimeType: optimizedMimeType,
      sizeBytes: optimizedBlob.size,
      ...targetDimensions,
    },
    warnings,
  };
}
