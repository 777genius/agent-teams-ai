export const AGENT_ATTACHMENT_SCHEMA_VERSION = 1 as const;

export type AgentAttachmentKind = 'image' | 'file' | 'video' | 'unsupported';

export type AgentImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type AgentVideoMimeType = 'video/mp4' | 'video/webm' | 'video/quicktime';
export type ProviderFileMimeType = 'application/pdf' | 'text/*';

export type AttachmentDeliveryFailureCode =
  | 'attachment_too_large'
  | 'attachment_type_unsupported'
  | 'attachment_model_unsupported'
  | 'attachment_optimization_failed'
  | 'attachment_artifact_missing'
  | 'attachment_artifact_path_unsafe'
  | 'attachment_provider_rejected'
  | 'attachment_runtime_transport_failed';

export type AttachmentWarningCode =
  | 'image_was_resized'
  | 'image_was_reencoded'
  | 'image_quality_reduced'
  | 'model_support_unknown'
  | 'model_does_not_support_images'
  | 'file_type_not_supported';

export interface AttachmentWarning {
  code: AttachmentWarningCode;
  message: string;
  attachmentId?: string;
}

export interface AgentAttachmentErrorJson {
  code: AttachmentDeliveryFailureCode;
  message: string;
  providerId?: string;
  model?: string;
  attachmentId?: string;
  retryable: boolean;
  safeDetails?: Record<string, string | number | boolean | null>;
}

export interface AgentImageMetadata {
  width?: number;
  height?: number;
  animated?: boolean;
  optimizedWidth?: number;
  optimizedHeight?: number;
  optimization: 'none' | 'lossless' | 'resized' | 'jpeg-reencoded' | 'unsupported';
}

export interface AgentAttachmentStorageReference {
  originalArtifactId?: string;
  optimizedArtifactId?: string;
  thumbnailArtifactId?: string;
}

export interface AgentAttachmentPayload {
  schemaVersion: typeof AGENT_ATTACHMENT_SCHEMA_VERSION;
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  kind: AgentAttachmentKind;
  source: 'composer' | 'clipboard' | 'drag-drop' | 'task' | 'inbox';
  order: number;
  storage: AgentAttachmentStorageReference;
  image?: AgentImageMetadata;
  warnings: AttachmentWarning[];
}

export interface ImageOptimizationBudget {
  maxInputBytes: number;
  maxInputPixels: number;
  maxOutputBytesPerImage: number;
  maxOutputBytesTotal: number;
  maxOutputEdge: number;
  jpegQualityAttempts: readonly number[];
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImageBudgetAllocation {
  imageId: string;
  targetBytes: number;
}

export type AgentAttachmentProviderId = 'anthropic' | 'codex' | 'opencode' | 'unknown';

export interface AgentAttachmentCapabilityTarget {
  providerId: AgentAttachmentProviderId | string;
  model?: string | null;
}

export interface AgentAttachmentCapability {
  supportsImages: boolean;
  supportsFiles: boolean;
  supportsVideo: boolean;
  supportedImageMimeTypes: AgentImageMimeType[];
  supportedFileMimeTypes: ProviderFileMimeType[];
  supportedVideoMimeTypes: AgentVideoMimeType[];
  maxImages: number;
  maxFiles: number;
  maxVideos: number;
  maxBytesPerImage: number;
  maxBytesPerFile: number;
  maxBytesPerVideo: number;
  maxBytesTotal: number;
  reason:
    | 'known_provider_support'
    | 'known_vision_model'
    | 'known_non_vision_model'
    | 'unknown_model'
    | 'unsupported_provider';
  displayText: string;
  filesDisplayText: string;
  videoDisplayText: string;
}

export type AttachmentValidationResult =
  | { ok: true; warnings: AttachmentWarning[] }
  | {
      ok: false;
      code: AttachmentDeliveryFailureCode;
      message: string;
      warnings: AttachmentWarning[];
    };
