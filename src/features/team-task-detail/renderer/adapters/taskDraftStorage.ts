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
  answerClarificationRequestId?: string | null;
  legacyText: string | null;
  legacyCommentChips: InlineChip[] | null;
}

interface TaskDraftWrite {
  text?: string;
  commentChips?: InlineChip[];
  answerClarificationRequestId?: string | null;
}

interface TaskDraftBundle {
  version: 1;
  text: string;
  commentChips: InlineChip[];
  answerClarificationRequestId: string | null;
}

const taskDraftTextKey = (identity: TaskDetailIdentity): string =>
  JSON.stringify(['task-comment', identity.contextId, identity.teamName, identity.taskId]);

const taskDraftChipsKey = (identity: TaskDetailIdentity): string =>
  JSON.stringify(['task-comment-chips', identity.contextId, identity.teamName, identity.taskId]);

// The answer ID and text MUST be saved as one value. Two independent keys
// could recover text A with request ID B after a partial draft save.
const taskDraftBundleKey = (identity: TaskDetailIdentity): string =>
  JSON.stringify(['task-comment-bundle', identity.contextId, identity.teamName, identity.taskId]);

const legacyTextKey = (identity: TaskDetailIdentity): string =>
  `taskComment:${identity.teamName}:${identity.taskId}`;

const legacyChipsKey = (identity: TaskDetailIdentity): string =>
  `taskCommentChips:${identity.teamName}:${identity.taskId}`;

const VALID_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function parseBundle(raw: string | null): TaskDraftBundle | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || typeof row.text !== 'string' || !Array.isArray(row.commentChips))
      return null;
    const chips = parseChips(JSON.stringify(row.commentChips));
    if (!chips) return null;
    return {
      version: 1,
      text: row.text,
      commentChips: chips,
      // Corrupt/unknown metadata can never be used to clear a current task.
      answerClarificationRequestId:
        typeof row.answerClarificationRequestId === 'string' &&
          VALID_REQUEST_ID.test(row.answerClarificationRequestId)
          ? row.answerClarificationRequestId : null,
    };
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

  const hydrate = async (identity: TaskDetailIdentity): Promise<TaskDraftHydration> => {
      const [rawBundle, text, chips, legacyText, legacyChips] = await Promise.all([
        repository.loadDraft(taskDraftBundleKey(identity)),
        repository.loadDraft(taskDraftTextKey(identity)),
        repository.loadDraft(taskDraftChipsKey(identity)),
        identity.contextId === 'local' ? repository.loadDraft(legacyTextKey(identity)) : null,
        identity.contextId === 'local' ? repository.loadDraft(legacyChipsKey(identity)) : null,
      ]);
      const bundle = parseBundle(rawBundle);
      const draftText = bundle ? bundle.text : (text ?? legacyText);
      const draftChips = bundle ? bundle.commentChips : (parseChips(chips) ?? parseChips(legacyChips));
      const hasContent = Boolean(draftText?.trim() || draftChips?.length);
      return {
        text: draftText,
        commentChips: draftChips,
        // Legacy text has no provable generation: ordinary comment only.
        answerClarificationRequestId: hasContent ? (bundle?.answerClarificationRequestId ?? null) : undefined,
        legacyText: legacyText == null ? null : legacyText,
        legacyCommentChips: parseChips(legacyChips),
      };
  };

  return {
    hydrate,

    save(
      identity: TaskDetailIdentity,
      value: TaskDraftWrite,
      options?: { migrateLegacy?: boolean }
    ): Promise<void> {
      return serialize(writeKey(identity), async () => {
        // Most edits update an already-versioned bundle. Read one key per
        // keystroke; only older drafts need the full migration fallback.
        const previous = parseBundle(await repository.loadDraft(taskDraftBundleKey(identity))) ??
          await hydrate(identity);
        const bundle: TaskDraftBundle = {
          version: 1,
          text: value.text === undefined ? previous.text ?? '' : value.text,
          commentChips: value.commentChips === undefined ? previous.commentChips ?? [] : value.commentChips,
          answerClarificationRequestId: 'answerClarificationRequestId' in value
            ? value.answerClarificationRequestId ?? null
            : previous.answerClarificationRequestId ?? null,
        };
        // A single draft-storage commit keeps text/chips and its answer ID
        // together. Existing text/chip keys are read-only migration sources.
        await repository.saveDraft(taskDraftBundleKey(identity), JSON.stringify(bundle));
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
      return serialize(writeKey(identity), async () => {
        // Keep an authoritative empty bundle even if legacy deletion fails.
        await repository.saveDraft(taskDraftBundleKey(identity), JSON.stringify({
          version: 1, text: '', commentChips: [], answerClarificationRequestId: null,
        } satisfies TaskDraftBundle));
        await repository.deleteDraft(taskDraftTextKey(identity));
        await repository.deleteDraft(taskDraftChipsKey(identity));
        if (identity.contextId === 'local') {
          await repository.deleteDraft(legacyTextKey(identity));
          await repository.deleteDraft(legacyChipsKey(identity));
        }
      });
    },
  };
}

export const taskDraftStorage = createTaskDraftStorage();
