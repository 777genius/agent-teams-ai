export type {
  AgentAttachmentCapability,
  AgentAttachmentCapabilityTarget,
  AgentAttachmentErrorJson,
  AgentAttachmentPayload,
  AgentVideoMimeType,
  AttachmentDeliveryFailureCode,
  AttachmentValidationResult,
  AttachmentWarning,
  AttachmentWarningCode,
  ImageOptimizationBudget,
  NativeAgentAttachmentMimeType,
} from '../core/domain';
export {
  AGENT_ATTACHMENT_SCHEMA_VERSION,
  isAgentVideoMimeType,
  MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
  MAX_AGENT_VIDEO_ATTACHMENT_BYTES,
  NATIVE_VIDEO_MIME_TYPES,
  resolveAgentAttachmentCapability,
} from '../core/domain';
export {
  estimateAgentAttachmentSerializedPayloadBytes,
  MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES,
} from '../core/domain';
