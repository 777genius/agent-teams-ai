import type {
  ComposerDraftContent,
  ComposerDraftRepository,
  ComposerEditorContext,
} from '@renderer/types/composerDraft';

export interface PendingComposerDraftPersistence {
  readonly address: Parameters<ComposerDraftRepository['loadWorking']>[0];
  readonly addressKey: string;
  readonly editCounter: number;
  readonly content: ComposerDraftContent;
  readonly editorContext: ComposerEditorContext;
}

interface PersistBeforeHydrationOptions {
  readonly repository: ComposerDraftRepository;
  readonly pending: PendingComposerDraftPersistence;
  readonly nextWorkingRevision: string;
  readonly isLatest: () => boolean;
  readonly preserveConflict: (currentWorkingRevision: string) => Promise<void>;
}

export function contentIsEmpty(content: ComposerDraftContent): boolean {
  return content.text.length === 0 && content.chips.length === 0 && content.attachments.length === 0;
}

export function contentEquals(left: ComposerDraftContent, right: ComposerDraftContent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function persistComposerDraftBeforeHydration({
  repository,
  pending,
  nextWorkingRevision,
  isLatest,
  preserveConflict,
}: PersistBeforeHydrationOptions): Promise<void> {
  const loaded = await repository.loadWorking(pending.address);
  if (loaded.writeBlocked || !isLatest()) return;

  let revision = loaded.working.workingRevision;
  if (
    loaded.working.content &&
    !contentIsEmpty(loaded.working.content) &&
    !contentEquals(loaded.working.content, pending.content)
  ) {
    const displacedId =
      `displaced:${encodeURIComponent(pending.addressKey)}:${revision}`;
    const stashed = await repository.stashWorking(pending.address, revision, displacedId);
    if (stashed.kind !== 'restored') return;
    revision = stashed.working.workingRevision;
  }

  if (!isLatest()) return;
  const result = await repository.saveWorking(
    pending.address,
    revision,
    nextWorkingRevision,
    contentIsEmpty(pending.content) ? null : pending.content,
    pending.editorContext
  );
  if (result.kind === 'conflict') await preserveConflict(result.currentWorkingRevision);
}
