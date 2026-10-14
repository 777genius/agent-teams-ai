import { draftStorage } from '@renderer/services/draftStorage';

import type { TaskDetailIdentity } from '../../contracts';
import type { InlineChip } from '@shared/types/inlineChip';

interface DraftRepository {
  saveDraft(key: string, value: string): Promise<void>;
  loadDraft(key: string): Promise<string | null>;
  deleteDraft(key: string): Promise<void>;
}

export interface TaskDraftHydration {
  text: string | null;
  commentChips: InlineChip[] | null;
  legacyText: string | null;
  legacyCommentChips: InlineChip[] | null;
}

interface TaskDraftWrite {
  text?: string;
  commentChips?: InlineChip[];
}

const taskDraftTextKey = (identity: TaskDetailIdentity): string =>
  JSON.stringify(['task-comment', identity.contextId, identity.teamName, identity.taskId]);

const taskDraftChipsKey = (identity: TaskDetailIdentity): string =>
  JSON.stringify(['task-comment-chips', identity.contextId, identity.teamName, identity.taskId]);

const legacyTextKey = (identity: TaskDetailIdentity): string =>
  `taskComment:${identity.teamName}:${identity.taskId}`;

const legacyChipsKey = (identity: TaskDetailIdentity): string =>
  `taskCommentChips:${identity.teamName}:${identity.taskId}`;

function parseChips(raw: string | null): InlineChip[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.every((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const chip = candidate as Record<string, unknown>;
      return (
        typeof chip.id === 'string' &&
        typeof chip.filePath === 'string' &&
        typeof chip.fileName === 'string' &&
        (typeof chip.fromLine === 'number' || chip.fromLine === null) &&
        (typeof chip.toLine === 'number' || chip.toLine === null) &&
        typeof chip.codeText === 'string' &&
        typeof chip.language === 'string'
      );
    });
    return valid ? (parsed as InlineChip[]) : null;
  } catch {
    return null;
  }
}

export function createTaskDraftStorage(repository: DraftRepository = draftStorage) {
  const queueByKey = new Map<string, Promise<void>>();

  const writeKey = (identity: TaskDetailIdentity): string =>
    JSON.stringify([identity.contextId, identity.teamName, identity.taskId]);

  const serialize = (key: string, operation: () => Promise<void>): Promise<void> => {
    const previous = queueByKey.get(key) ?? Promise.resolve();
    const next = previous.then(operation);
    const tail = next.catch(() => undefined);
    queueByKey.set(key, tail);
    void tail.then(() => {
      if (queueByKey.get(key) === tail) queueByKey.delete(key);
    });
    return next;
  };

  return {
    async hydrate(identity: TaskDetailIdentity): Promise<TaskDraftHydration> {
      const textKey = taskDraftTextKey(identity);
      const chipsKey = taskDraftChipsKey(identity);
      const [text, chips, legacyText, legacyChips] = await Promise.all([
        repository.loadDraft(textKey),
        repository.loadDraft(chipsKey),
        identity.contextId === 'local' ? repository.loadDraft(legacyTextKey(identity)) : null,
        identity.contextId === 'local' ? repository.loadDraft(legacyChipsKey(identity)) : null,
      ]);
      return {
        text: text ?? legacyText,
        commentChips: parseChips(chips) ?? parseChips(legacyChips),
        legacyText: legacyText == null ? null : legacyText,
        legacyCommentChips: parseChips(legacyChips),
      };
    },

    save(
      identity: TaskDetailIdentity,
      value: TaskDraftWrite,
      options?: { migrateLegacy?: boolean }
    ): Promise<void> {
      const key = writeKey(identity);
      return serialize(key, async () => {
        const textKey = taskDraftTextKey(identity);
        const chipsKey = taskDraftChipsKey(identity);
        if (value.text !== undefined) {
          await repository.saveDraft(textKey, value.text);
        }
        if (value.commentChips !== undefined) {
          await repository.saveDraft(chipsKey, JSON.stringify(value.commentChips));
        }
        if (
          options?.migrateLegacy &&
          identity.contextId === 'local' &&
          value.text !== undefined &&
          value.commentChips !== undefined
        ) {
          await repository.deleteDraft(legacyTextKey(identity));
          await repository.deleteDraft(legacyChipsKey(identity));
        }
      });
    },

    clear(identity: TaskDetailIdentity): Promise<void> {
      const key = writeKey(identity);
      return serialize(key, async () => {
        if (identity.contextId === 'local') {
          // Keep an authoritative empty namespace if legacy deletion fails.
          await repository.saveDraft(taskDraftTextKey(identity), '');
          await repository.saveDraft(taskDraftChipsKey(identity), '[]');
          await repository.deleteDraft(legacyTextKey(identity));
          await repository.deleteDraft(legacyChipsKey(identity));
        }
        await repository.deleteDraft(taskDraftTextKey(identity));
        await repository.deleteDraft(taskDraftChipsKey(identity));
      });
    },
  };
}

export const taskDraftStorage = createTaskDraftStorage();
