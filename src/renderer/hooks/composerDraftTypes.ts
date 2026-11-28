import type { ComposerAttemptRequest, ComposerBeginAttemptResult } from './useComposerDraftAttempt';
import type { AutonomousGoalOptions } from '@features/agent-backend/contracts';
import type {
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerEditorContext,
  ComposerPersistenceStatus,
  ComposerWorkingRecord,
  ComposerWorkingSummary,
  MessageRevisionContext,
  RestoreRecoveryResult,
} from '@renderer/types/composerDraft';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { AgentActionMode, AttachmentPayload } from '@shared/types';

export interface UseComposerDraftResult {
  text: string;
  setText: (value: string) => void;
  chips: InlineChip[];
  addChip: (chip: InlineChip) => void;
  removeChip: (chipId: string) => void;
  attachments: AttachmentPayload[];
  attachmentError: string | null;
  canAddMore: boolean;
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  clearAttachmentError: () => void;
  handlePaste: (event: React.ClipboardEvent) => void;
  handleDrop: (event: React.DragEvent) => void;
  autonomousGoal: AutonomousGoalOptions | undefined;
  setAutonomousGoal: (value: AutonomousGoalOptions | undefined) => void;
  actionMode: AgentActionMode;
  setActionMode: (mode: AgentActionMode) => void;
  editorContext: ComposerEditorContext;
  revisionContext: MessageRevisionContext | null;
  setRevision: (context: MessageRevisionContext, content: ComposerDraftContent) => boolean;
  clearRevision: () => void;
  isSaved: boolean;
  isLoaded: boolean;
  isRestoring: boolean;
  persistenceStatus: ComposerPersistenceStatus;
  readError: string | null;
  address: ComposerDraftAddress;
  addressKey: string;
  renderedAddressKey: string;
  workingRevision: string;
  localEditCounter: number;
  loadGeneration: number;
  canSubmit: boolean;
  snapshot: () => ComposerDraftContent;
  clearDraft: () => Promise<void>;
  flush: () => Promise<void>;
  beginAttempt: (
    attemptId: string,
    prepareRequest: ComposerAttemptRequest
  ) => Promise<ComposerBeginAttemptResult | null>;
  stashWorking: () => Promise<RestoreRecoveryResult>;
  restoreRecovery: (
    sourceContextId: string,
    sourceTeamName: string,
    id: string,
    options?: { readonly asNewMessage?: boolean }
  ) => Promise<RestoreRecoveryResult>;
  moveWorkingAsNew: (summary: ComposerWorkingSummary) => Promise<RestoreRecoveryResult>;
  adoptWorking: (
    working: ComposerWorkingRecord,
    expected?: {
      readonly addressKey: string;
      readonly loadGeneration: number;
      readonly localEditCounter: number;
    }
  ) => boolean;
}
