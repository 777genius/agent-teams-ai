import { Sparkles, X } from 'lucide-react';

import type { JSX } from 'react';

/** Passive preview: neither provider execution nor a durable outbound message. */
export function NativeNextPromptRow({
  text,
  compact = false,
  insertLabel,
  dismissLabel,
  shortcutLabel,
  onInsert,
  onDismiss,
}: {
  readonly text: string;
  readonly compact?: boolean;
  readonly insertLabel: string;
  readonly dismissLabel: string;
  readonly shortcutLabel: string;
  readonly onInsert: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  return (
    <div
      className="flex min-w-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-text-muted)]"
      data-testid="native-next-prompt-row"
    >
      <Sparkles size={14} className="shrink-0 opacity-70" aria-hidden="true" />
      <span className={compact ? 'min-w-0 flex-1 truncate' : 'min-w-0 flex-1 line-clamp-2'}>
        {text}
      </span>
      {!compact ? (
        <kbd
          className="hidden shrink-0 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] sm:inline"
          aria-hidden="true"
        >
          {shortcutLabel}
        </kbd>
      ) : null}
      <button
        type="button"
        className="inline-flex min-h-8 shrink-0 items-center rounded px-2 font-medium text-[var(--color-text-secondary)] hover:bg-white/[0.045] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label={insertLabel}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onInsert}
      >
        {insertLabel}
      </button>
      <button
        type="button"
        className="inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded hover:bg-white/[0.045] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label={dismissLabel}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
