import type {
  ComposerDraftAddress,
  ComposerWorkingSummary,
  RestoreRecoveryResult,
} from '@renderer/types/composerDraft';

export interface ComposerDraftDestination {
  readonly address: ComposerDraftAddress;
  readonly isEmpty: boolean;
  readonly isLoaded: boolean;
  readonly loadGeneration: number;
  readonly workingRevision: string;
  readonly restoreRecovery: (
    sourceContextId: string,
    sourceTeamName: string,
    id: string,
    options?: { readonly asNewMessage?: boolean }
  ) => Promise<RestoreRecoveryResult>;
  readonly moveWorkingAsNew: (
    summary: ComposerWorkingSummary
  ) => Promise<RestoreRecoveryResult>;
}
