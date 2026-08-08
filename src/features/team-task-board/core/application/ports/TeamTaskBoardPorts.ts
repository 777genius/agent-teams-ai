export type {
  PreparedTaskAttachmentDeletion,
  SavedTaskAttachment,
  TaskAttachmentMetadataPort,
  TaskAttachmentStoragePort,
  TaskAttachmentStorageTransactionPort,
} from './TeamTaskAttachmentPorts';
export type {
  TaskClarificationValue,
  TaskFields,
  TaskFieldsWriterPort,
  TaskRelationshipType,
  TeamTaskBoardCommandPort,
} from './TeamTaskBoardMutationPorts';
export type {
  ClockPort,
  GlobalTaskQueryPort,
  MainOperationTrackerPort,
  TaskChangePresencePort,
  TeamLeadNotificationPort,
  TeamRuntimeStatusPort,
  TeamTaskBoardLoggerPort,
  TeamTaskBoardQueryPort,
} from './TeamTaskBoardSupportPorts';
export type {
  SavedTaskCommentAttachment,
  TaskCommentAttachmentTransactionPort,
  TaskCommentAttachmentWriterPort,
  TaskCommentRequest,
  TaskCommentWriterPort,
} from './TeamTaskCommentPorts';
