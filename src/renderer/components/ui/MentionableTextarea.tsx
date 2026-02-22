import * as React from 'react';

import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useMentionDetection } from '@renderer/hooks/useMentionDetection';

import { AutoResizeTextarea } from './auto-resize-textarea';
import { MentionSuggestionList } from './MentionSuggestionList';

import type { AutoResizeTextareaProps } from './auto-resize-textarea';
import type { MentionSuggestion } from '@renderer/types/mention';

// ---------------------------------------------------------------------------
// Mention segment parsing (splits text into plain text + @mention segments)
// ---------------------------------------------------------------------------

interface TextSegment {
  type: 'text';
  value: string;
}

interface MentionSegment {
  type: 'mention';
  value: string;
  suggestion: MentionSuggestion;
}

type Segment = TextSegment | MentionSegment;

/**
 * Splits text into alternating text / @mention segments.
 *
 * Rules:
 * - `@` must be at start of text or preceded by whitespace
 * - The name after `@` must exactly match a suggestion name (case-insensitive)
 * - The character after the name must be whitespace, punctuation, or end-of-text
 * - Longer names are tried first (greedy matching)
 */
function parseMentionSegments(text: string, suggestions: MentionSuggestion[]): Segment[] {
  if (!text || suggestions.length === 0) return [{ type: 'text', value: text }];

  // Sort by name length descending for greedy matching
  const sorted = [...suggestions].sort((a, b) => b.name.length - a.name.length);

  const segments: Segment[] = [];
  let i = 0;
  let textStart = 0;

  while (i < text.length) {
    if (text[i] !== '@') {
      i++;
      continue;
    }

    // @ must be at start or after whitespace
    if (i > 0) {
      const ch = text[i - 1];
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
        i++;
        continue;
      }
    }

    let matched = false;
    for (const suggestion of sorted) {
      const end = i + 1 + suggestion.name.length;
      if (end > text.length) continue;
      if (text.slice(i + 1, end).toLowerCase() !== suggestion.name.toLowerCase()) continue;

      // Character after name must be boundary
      if (end < text.length) {
        const after = text[end];
        // eslint-disable-next-line no-useless-escape
        if (!/[\s,.:;!?\)\]\}\-]/.test(after)) continue;
      }

      // Flush preceding text
      if (i > textStart) {
        segments.push({ type: 'text', value: text.slice(textStart, i) });
      }

      segments.push({ type: 'mention', value: text.slice(i, end), suggestion });
      i = end;
      textStart = i;
      matched = true;
      break;
    }

    if (!matched) i++;
  }

  if (textStart < text.length) {
    segments.push({ type: 'text', value: text.slice(textStart) });
  }

  return segments;
}

// Default fallback color for mentions without a team color
const DEFAULT_MENTION_BG = 'rgba(59, 130, 246, 0.15)';
const DEFAULT_MENTION_TEXT = '#60a5fa';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MentionableTextareaProps extends Omit<
  AutoResizeTextareaProps,
  'value' | 'onChange' | 'onKeyDown' | 'onSelect'
> {
  value: string;
  onValueChange: (v: string) => void;
  suggestions: MentionSuggestion[];
  hintText?: string;
  showHint?: boolean;
  /** Content rendered at the right side of the footer row (e.g. "Draft saved") */
  footerRight?: React.ReactNode;
}

export const MentionableTextarea = React.forwardRef<HTMLTextAreaElement, MentionableTextareaProps>(
  (
    {
      value,
      onValueChange,
      suggestions,
      hintText = 'Use @ to mention team members',
      showHint = true,
      footerRight,
      style,
      ...textareaProps
    },
    forwardedRef
  ) => {
    const internalRef = React.useRef<HTMLTextAreaElement | null>(null);
    const backdropRef = React.useRef<HTMLDivElement>(null);

    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        internalRef.current = node;
        if (typeof forwardedRef === 'function') {
          forwardedRef(node);
        } else if (forwardedRef) {
          // eslint-disable-next-line no-param-reassign -- ref merging requires mutation
          forwardedRef.current = node;
        }
      },
      [forwardedRef]
    );

    const {
      isOpen,
      query,
      filteredSuggestions,
      selectedIndex,
      dropdownPosition,
      selectSuggestion,
      handleKeyDown,
      handleChange,
      handleSelect,
    } = useMentionDetection({
      suggestions,
      value,
      onValueChange,
      textareaRef: internalRef,
    });

    // --- Mention overlay ---
    const hasMentionOverlay = suggestions.length > 0;

    const segments = React.useMemo(
      () => (hasMentionOverlay ? parseMentionSegments(value, suggestions) : []),
      [hasMentionOverlay, value, suggestions]
    );

    // Sync backdrop scroll with textarea scroll
    const handleScroll = React.useCallback(() => {
      const textarea = internalRef.current;
      const backdrop = backdropRef.current;
      if (textarea && backdrop) {
        backdrop.scrollTop = textarea.scrollTop;
      }
    }, []);

    // When overlay is active: textarea text is transparent, caret stays visible
    const textareaStyle: React.CSSProperties | undefined = hasMentionOverlay
      ? {
          ...style,
          color: 'transparent',
          caretColor: 'var(--color-text)',
          position: 'relative' as const,
          zIndex: 10,
          background: 'transparent',
        }
      : style;

    const showFooter = (showHint && suggestions.length > 0) || footerRight;

    return (
      <div className="relative">
        {/* Inner wrapper for textarea + backdrop overlay */}
        <div className="relative">
          {hasMentionOverlay ? (
            <div
              ref={backdropRef}
              className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-md border border-transparent px-3 py-2 text-sm text-[var(--color-text)]"
              style={{
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
                overflowWrap: 'break-word',
              }}
              aria-hidden="true"
            >
              {segments.map((seg, idx) => {
                if (seg.type === 'text') {
                  return <React.Fragment key={idx}>{seg.value}</React.Fragment>;
                }
                const colorSet = seg.suggestion.color
                  ? getTeamColorSet(seg.suggestion.color)
                  : null;
                const bg = colorSet?.badge ?? DEFAULT_MENTION_BG;
                const fg = colorSet?.text ?? DEFAULT_MENTION_TEXT;
                return (
                  <span
                    key={idx}
                    style={{
                      backgroundColor: bg,
                      color: fg,
                      borderRadius: '3px',
                      boxShadow: `0 0 0 1.5px ${bg}`,
                    }}
                  >
                    {seg.value}
                  </span>
                );
              })}
              {/* Trailing space ensures trailing newlines render correctly */}{' '}
            </div>
          ) : null}

          <AutoResizeTextarea
            ref={setRefs}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            {...textareaProps}
            onScroll={handleScroll}
            style={textareaStyle}
          />
        </div>

        {showFooter ? (
          <div className="mt-1 flex items-center justify-between">
            {showHint && suggestions.length > 0 ? (
              <span className="text-[10px] text-[var(--color-text-muted)]">{hintText}</span>
            ) : (
              <span />
            )}
            {footerRight}
          </div>
        ) : null}
        {isOpen && dropdownPosition ? (
          <div className="absolute left-0 z-50 w-full" style={{ top: `${dropdownPosition.top}px` }}>
            <MentionSuggestionList
              suggestions={filteredSuggestions}
              selectedIndex={selectedIndex}
              onSelect={selectSuggestion}
              query={query}
            />
          </div>
        ) : null}
      </div>
    );
  }
);
MentionableTextarea.displayName = 'MentionableTextarea';
