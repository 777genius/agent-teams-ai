export { DEFAULT_AGENT_IMAGE_OPTIMIZATION_BUDGET } from '../core/domain';
export { type AgentAttachmentCapability, resolveAgentAttachmentCapability } from '../core/domain';
export {
  decorateFileReferences,
  getMessageAttachmentRoute,
  isStrictUtf8,
  mergeMessageAttachments,
} from '../core/domain/messageFileReferences';
export * from './optimizeImageForAgent';
