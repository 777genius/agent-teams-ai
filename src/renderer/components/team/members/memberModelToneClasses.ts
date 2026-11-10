/**
 * Theme-aware tones shared by the lead and teammate model rows. Light classes
 * come first; the `dark:` variants keep the original dark palette.
 */
export const MODEL_ISSUE_TEXT_CLASS = 'text-red-700 dark:text-red-300';
export const MODEL_ADVISORY_TEXT_CLASS = 'text-amber-700 dark:text-amber-200';

const MODEL_TRIGGER_ISSUE_CLASS =
  'border-red-500/50 bg-red-500/10 text-red-800 hover:border-red-600/60 hover:bg-red-500/15 hover:text-red-900 dark:text-red-100 dark:hover:border-red-400/60 dark:hover:text-red-50';
const MODEL_TRIGGER_ADVISORY_CLASS =
  'border-amber-600/45 bg-amber-500/10 text-amber-800 hover:border-amber-600/60 hover:bg-amber-500/15 hover:text-amber-900 dark:border-amber-300/45 dark:bg-amber-300/10 dark:text-amber-100 dark:hover:border-amber-300/60 dark:hover:bg-amber-300/15 dark:hover:text-amber-50';

/** Advisory wins when both apply, matching the previous class merge order. */
export function getModelTriggerToneClass(hasIssue: boolean, hasAdvisory: boolean): string | null {
  if (hasAdvisory) return MODEL_TRIGGER_ADVISORY_CLASS;
  return hasIssue ? MODEL_TRIGGER_ISSUE_CLASS : null;
}

export function getModelNoticeTextClass(hasIssue: boolean): string {
  return hasIssue ? MODEL_ISSUE_TEXT_CLASS : MODEL_ADVISORY_TEXT_CLASS;
}

export const MCP_SETTING_NOTE_CLASS = `text-[10px] leading-snug ${MODEL_ADVISORY_TEXT_CLASS}`;

export function getMcpIndicatorDotClass(locked: boolean): string {
  return locked ? 'bg-amber-500 dark:bg-amber-300' : 'bg-sky-500 dark:bg-sky-400';
}
