export { AgentAttachmentError } from '../core/domain';
export * from './adapters/input/attachmentIpcPayloadValidation';
export {
  admitNativeTeammateAttachmentIpcMessage,
  assertAttachmentRecipientOnline,
} from './adapters/input/nativeTeammateAttachmentIpc';
export { getNativeAttachmentRecipientRestriction } from './application/messageAttachmentModelAdmission';
export * from './application/nativeTeammateAttachmentAdmission';
export {
  prepareMessageAttachments,
  selectNativeMessageAttachments,
} from './application/prepareMessageAttachments';
export * from './infrastructure/attachmentArtifactStore';
export { createAttachmentBridgeEnvironment } from './infrastructure/attachmentBridgeEnvironment';
export * from './providers/claudeAttachmentAdapter';
export * from './providers/codexNativeAttachmentAdapter';
export * from './providers/opencodeAttachmentAdapter';
