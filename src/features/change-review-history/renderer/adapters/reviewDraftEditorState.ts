import { historyField } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';

import type { Extension } from '@codemirror/state';
import type { ReviewSerializedEditorState } from '@features/change-review-history/contracts';

export function serializeReviewDraftEditorState(state: EditorState): ReviewSerializedEditorState {
  const raw = state.toJSON({ history: historyField }) as Record<string, unknown>;
  // CodeMirror leaves internal `undefined` fields in some history events. Canonicalize
  // through JSON so IPC and the on-disk payload see exactly the same restorable shape.
  const serialized = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  if (typeof serialized.doc !== 'string' || !Object.hasOwn(serialized, 'history')) {
    throw new Error('Editor state does not contain native history');
  }
  return serialized as ReviewSerializedEditorState;
}

export function restoreReviewDraftEditorState(
  serialized: ReviewSerializedEditorState,
  extensions: Extension
): EditorState {
  return EditorState.fromJSON(serialized, { extensions }, { history: historyField });
}
