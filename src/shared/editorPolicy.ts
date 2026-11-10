/** Shared editor byte budgets. Text remains editable up to the same read/write ceiling. */
export const EDITOR_FULL_MAX_BYTES = 32 * 1024 * 1024;
export const EDITOR_PREVIEW_MAX_BYTES = 256 * 1024;
export const EDITOR_REDUCED_MODE_BYTES = 2 * 1024 * 1024;
export const EDITOR_DRAFT_MAX_CHARS = 500 * 1024;
export type EditorDocumentMode = 'full' | 'large' | 'preview' | 'binary';
