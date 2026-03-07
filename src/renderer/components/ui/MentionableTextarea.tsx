import * as React from 'react';

import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useFileSuggestions } from '@renderer/hooks/useFileSuggestions';
import { useMentionDetection } from '@renderer/hooks/useMentionDetection';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { chipToken } from '@renderer/types/inlineChip';
import {
  createChipFromSelection,
  findChipBoundary,
  reconcileChips,
  removeChipTokenFromText,
} from '@renderer/utils/chipUtils';

import { AutoResizeTextarea } from './auto-resize-textarea';
import { ChipInteractionLayer } from './ChipInteractionLayer';
import { CodeChipBadge } from './CodeChipBadge';
import { MentionSuggestionList } from './MentionSuggestionList';

import type { AutoResizeTextareaProps } from './auto-resize-textarea';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';

// ---------------------------------------------------------------------------
// Segment types
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

interface ChipSegment {
  type: 'chip';
  value: string;
  chip: InlineChip;
}

type Segment = TextSegment | MentionSegment | ChipSegment;

// ---------------------------------------------------------------------------
// Mention segment parsing (splits text into plain text + @mention segments)
// ---------------------------------------------------------------------------

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
        // eslint-disable-next-line no-useless-escape -- escaped chars needed for regex character class
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

// ---------------------------------------------------------------------------
// Extended segment parser: chips + mentions
// ---------------------------------------------------------------------------

/**
 * Parses text into segments: first extracts chip tokens, then runs mention parsing
 * on the text fragments between chips.
 */
function parseSegments(
  text: string,
  suggestions: MentionSuggestion[],
  chips: InlineChip[]
): Segment[] {
  if (!text) return [{ type: 'text', value: text }];
  if (chips.length === 0) return parseMentionSegments(text, suggestions);

  // Build a map of chip tokens for fast lookup
  const chipTokenMap = new Map<string, InlineChip>();
  for (const chip of chips) {
    chipTokenMap.set(chipToken(chip), chip);
  }

  // Find all chip token positions, sorted by index
  const chipPositions: { start: number; end: number; token: string; chip: InlineChip }[] = [];
  for (const [token, chip] of chipTokenMap) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const idx = text.indexOf(token, searchFrom);
      if (idx === -1) break;
      chipPositions.push({ start: idx, end: idx + token.length, token, chip });
      searchFrom = idx + 1;
    }
  }
  chipPositions.sort((a, b) => a.start - b.start);

  if (chipPositions.length === 0) return parseMentionSegments(text, suggestions);

  const segments: Segment[] = [];
  let lastEnd = 0;

  for (const pos of chipPositions) {
    // Text before this chip → parse for mentions
    if (pos.start > lastEnd) {
      const fragment = text.slice(lastEnd, pos.start);
      segments.push(...parseMentionSegments(fragment, suggestions));
    }
    segments.push({ type: 'chip', value: pos.token, chip: pos.chip });
    lastEnd = pos.end;
  }

  // Remaining text after last chip → parse for mentions
  if (lastEnd < text.length) {
    segments.push(...parseMentionSegments(text.slice(lastEnd), suggestions));
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
  /** Content rendered in the bottom-right corner inside the textarea (e.g. send button) */
  cornerAction?: React.ReactNode;
  /** Inline code chips to display as badges */
  chips?: InlineChip[];
  /** Called when a chip is removed (by X button, backspace, or reconciliation) */
  onChipRemove?: (chipId: string) => void;
  /** Project path for @file search. When provided, enables file suggestions alongside members. */
  projectPath?: string | null;
  /** Called when a file chip is created via @ selection. Parent must add chip to state. */
  onFileChipInsert?: (chip: InlineChip) => void;
  /** Called when Enter (without Shift) is pressed. */
  onModEnter?: () => void;
}

export const MentionableTextarea = React.forwardRef<HTMLTextAreaElement, MentionableTextareaProps>(
  (
    {
      value,
      onValueChange,
      suggestions,
      hintText,
      showHint = true,
      footerRight,
      cornerAction,
      chips = [],
      onChipRemove,
      projectPath,
      onFileChipInsert,
      onModEnter,
      style,
      className,
      ...textareaProps
    },
    forwardedRef
  ) => {
    const internalRef = React.useRef<HTMLTextAreaElement | null>(null);
    const backdropRef = React.useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = React.useState(0);
    const { isLight } = useTheme();

    // --- File search activation ---
    const enableFiles = !!projectPath;

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
      filteredSuggestions: memberSuggestions,
      selectedIndex,
      dropdownPosition,
      selectSuggestion,
      dismiss,
      getTriggerIndex,
      handleKeyDown: mentionHandleKeyDown,
      handleChange: mentionHandleChange,
      handleSelect: mentionHandleSelect,
    } = useMentionDetection({
      suggestions,
      value,
      onValueChange,
      textareaRef: internalRef,
      enableTriggerAlways: enableFiles,
    });

    // --- File suggestions ---
    const { suggestions: fileSuggestions, loading: filesLoading } = useFileSuggestions(
      enableFiles ? projectPath : null,
      query,
      isOpen && enableFiles
    );

    // Merged suggestion list: members first, then files
    const allSuggestions = React.useMemo(() => {
      if (!enableFiles) return memberSuggestions;
      if (fileSuggestions.length === 0) return memberSuggestions;
      return [...memberSuggestions, ...fileSuggestions];
    }, [enableFiles, memberSuggestions, fileSuggestions]);

    // When files are enabled, manage our own selectedIndex for the merged list
    const [mergedIndex, setMergedIndex] = React.useState(0);

    // Reset merged index when suggestions change or query changes
    React.useEffect(() => {
      setMergedIndex(0);
    }, [query, allSuggestions.length]);

    // Effective index: use merged when files enabled, hook's index otherwise
    const effectiveIndex = enableFiles ? mergedIndex : selectedIndex;
    const effectiveSuggestions = enableFiles ? allSuggestions : memberSuggestions;

    // --- File selection handler ---
    const handleFileSelect = React.useCallback(
      (s: MentionSuggestion) => {
        const textarea = internalRef.current;
        const triggerIdx = getTriggerIndex();
        if (!textarea || triggerIdx < 0 || !s.filePath) return;

        const replaceStart = triggerIdx;
        const replaceEnd = triggerIdx + 1 + query.length;
        const before = value.slice(0, replaceStart);
        const after = value.slice(replaceEnd);

        if (onFileChipInsert && onChipRemove) {
          // Chip mode: create InlineChip and insert chip token
          const chip = createChipFromSelection(
            {
              type: 'sendMessage',
              filePath: s.filePath,
              fromLine: null,
              toLine: null,
              selectedText: '',
              formattedContext: '',
              displayPath: s.relativePath,
            },
            chips
          );

          if (chip) {
            const token = chipToken(chip);
            const newValue = before + token + after;
            onValueChange(newValue);
            onFileChipInsert(chip);
            dismiss();

            requestAnimationFrame(() => {
              const cursor = before.length + token.length;
              textarea.setSelectionRange(cursor, cursor);
            });
          } else {
            // Duplicate chip — just dismiss
            dismiss();
          }
        } else {
          // Text mode: insert backtick-wrapped relative path
          const displayPath = s.relativePath ?? s.name;
          const insertion = `\`${displayPath}\` `;
          const newValue = before + insertion + after;
          onValueChange(newValue);
          dismiss();

          requestAnimationFrame(() => {
            const cursor = before.length + insertion.length;
            textarea.setSelectionRange(cursor, cursor);
          });
        }
      },
      [getTriggerIndex, query, value, chips, onValueChange, onFileChipInsert, onChipRemove, dismiss]
    );

    // --- Merged selection handler ---
    const handleMergedSelect = React.useCallback(
      (s: MentionSuggestion) => {
        if (s.type === 'file') {
          handleFileSelect(s);
        } else {
          selectSuggestion(s);
        }
      },
      [handleFileSelect, selectSuggestion]
    );

    // Sync backdrop font with textarea computed font to prevent caret drift.
    React.useLayoutEffect(() => {
      const textarea = internalRef.current;
      const backdrop = backdropRef.current;
      if (!textarea || !backdrop) return;
      const cs = window.getComputedStyle(textarea);
      backdrop.style.font = cs.font;
      backdrop.style.letterSpacing = cs.letterSpacing;
      backdrop.style.wordSpacing = cs.wordSpacing;
      backdrop.style.textIndent = cs.textIndent;
      backdrop.style.textTransform = cs.textTransform;
      backdrop.style.tabSize = cs.tabSize;
    }, [value]);

    // --- Overlay activation ---
    const hasOverlay = suggestions.length > 0 || chips.length > 0;

    const segments = React.useMemo(
      () => (hasOverlay ? parseSegments(value, suggestions, chips) : []),
      [hasOverlay, value, suggestions, chips]
    );

    // Sync backdrop scroll with textarea scroll + track scrollTop for interaction layer
    const handleScroll = React.useCallback(() => {
      const textarea = internalRef.current;
      const backdrop = backdropRef.current;
      if (textarea) {
        if (backdrop) {
          backdrop.scrollTop = textarea.scrollTop;
        }
        setScrollTop(textarea.scrollTop);
      }
    }, []);

    // --- Chip keyboard handling (atomic cursor / backspace / delete) ---
    const handleChipKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (chips.length === 0 || !onChipRemove) return;

        const textarea = internalRef.current;
        if (!textarea) return;

        const { selectionStart, selectionEnd } = textarea;
        // Only act on collapsed cursor
        if (selectionStart !== selectionEnd && !e.shiftKey) return;

        const cursorPos = selectionStart;

        if (e.key === 'Backspace') {
          // If cursor is at chip end → delete entire chip
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.end) {
            e.preventDefault();
            const newText = removeChipTokenFromText(value, boundary.chip);
            onValueChange(newText);
            onChipRemove(boundary.chip.id);
            // Set cursor to where chip started
            requestAnimationFrame(() => {
              textarea.setSelectionRange(boundary.start, boundary.start);
            });
          }
        } else if (e.key === 'Delete') {
          // If cursor is at chip start → delete entire chip
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.start) {
            e.preventDefault();
            const newText = removeChipTokenFromText(value, boundary.chip);
            onValueChange(newText);
            onChipRemove(boundary.chip.id);
            requestAnimationFrame(() => {
              textarea.setSelectionRange(boundary.start, boundary.start);
            });
          }
        } else if (e.key === 'ArrowLeft' && !e.shiftKey) {
          // If cursor is at chip end → jump to chip start
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.end) {
            e.preventDefault();
            textarea.setSelectionRange(boundary.start, boundary.start);
          }
        } else if (e.key === 'ArrowRight' && !e.shiftKey) {
          // If cursor is at chip start → jump to chip end
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.start) {
            e.preventDefault();
            textarea.setSelectionRange(boundary.end, boundary.end);
          }
        } else if (e.key === 'ArrowLeft' && e.shiftKey) {
          // Extend selection past chip atomically
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.end) {
            e.preventDefault();
            textarea.setSelectionRange(boundary.start, selectionEnd);
          }
        } else if (e.key === 'ArrowRight' && e.shiftKey) {
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.start) {
            e.preventDefault();
            textarea.setSelectionRange(selectionStart, boundary.end);
          }
        }
      },
      [chips, onChipRemove, value, onValueChange]
    );

    // --- File-aware keyboard handler (replaces mention handler when files enabled) ---
    const fileMentionHandleKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!isOpen || allSuggestions.length === 0) return;

        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setMergedIndex((prev) => (prev + 1) % allSuggestions.length);
            break;
          case 'ArrowUp':
            e.preventDefault();
            setMergedIndex((prev) => (prev - 1 + allSuggestions.length) % allSuggestions.length);
            break;
          case 'Enter':
            if (!e.shiftKey) {
              e.preventDefault();
              if (allSuggestions[mergedIndex]) {
                handleMergedSelect(allSuggestions[mergedIndex]);
              }
            }
            break;
          case 'Escape':
            e.preventDefault();
            dismiss();
            break;
        }
      },
      [isOpen, allSuggestions, mergedIndex, handleMergedSelect, dismiss]
    );

    // Composed key handler: mention logic first (when open) → Mod+Enter submit → chip logic → mention fallback
    const composedHandleKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // When mention dropdown is open, let mention handler consume Enter/Arrow keys first
        if (isOpen && effectiveSuggestions.length > 0) {
          if (enableFiles) {
            fileMentionHandleKeyDown(e);
          } else {
            mentionHandleKeyDown(e);
          }
          if (e.defaultPrevented) return;
        }
        // Enter (without Shift) → submit; Shift+Enter → newline
        if (e.key === 'Enter' && !e.shiftKey && onModEnter) {
          e.preventDefault();
          onModEnter();
          return;
        }
        handleChipKeyDown(e);
        if (!e.defaultPrevented && !isOpen) {
          if (enableFiles) {
            fileMentionHandleKeyDown(e);
          } else {
            mentionHandleKeyDown(e);
          }
        }
      },
      [
        onModEnter,
        handleChipKeyDown,
        enableFiles,
        fileMentionHandleKeyDown,
        mentionHandleKeyDown,
        isOpen,
        effectiveSuggestions.length,
      ]
    );

    // --- Chip reconciliation on text change ---
    const composedHandleChange = React.useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        mentionHandleChange(e);

        // Reconcile chips after text changes (paste/cut/undo)
        if (chips.length > 0 && onChipRemove) {
          const newText = e.target.value;
          const surviving = reconcileChips(chips, newText);
          if (surviving.length < chips.length) {
            const survivingIds = new Set(surviving.map((c) => c.id));
            for (const chip of chips) {
              if (!survivingIds.has(chip.id)) {
                onChipRemove(chip.id);
              }
            }
          }
        }
      },
      [mentionHandleChange, chips, onChipRemove]
    );

    // --- Snap cursor on click/select if inside chip ---
    const composedHandleSelect = React.useCallback(
      (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        mentionHandleSelect(e);

        if (chips.length > 0) {
          const textarea = internalRef.current;
          if (!textarea) return;
          const { selectionStart, selectionEnd } = textarea;
          // Only snap collapsed cursor
          if (selectionStart !== selectionEnd) return;

          const boundary = findChipBoundary(value, chips, selectionStart);
          if (boundary && selectionStart > boundary.start && selectionStart < boundary.end) {
            // Snap to nearest boundary
            const distToStart = selectionStart - boundary.start;
            const distToEnd = boundary.end - selectionStart;
            const snapTo = distToStart <= distToEnd ? boundary.start : boundary.end;
            requestAnimationFrame(() => {
              textarea.setSelectionRange(snapTo, snapTo);
            });
          }
        }
      },
      [mentionHandleSelect, chips, value]
    );

    // --- Chip remove handler (from X button in interaction layer) ---
    const handleChipRemove = React.useCallback(
      (chipId: string) => {
        const chip = chips.find((c) => c.id === chipId);
        if (chip) {
          const newText = removeChipTokenFromText(value, chip);
          onValueChange(newText);
        }
        onChipRemove?.(chipId);
      },
      [chips, value, onValueChange, onChipRemove]
    );

    // When overlay is active: textarea text is transparent, caret stays visible
    const textareaStyle: React.CSSProperties | undefined = hasOverlay
      ? {
          ...style,
          color: 'transparent',
          caretColor: 'var(--color-text)',
          position: 'relative' as const,
          zIndex: 10,
          background: 'transparent',
        }
      : style;

    // --- Rotating tips ---
    const rotatingTips = React.useMemo(
      () => [
        'Tip: Use @ to mention team members or search files',
        'Tip: Mention "create a task" to add it to the kanban',
        "Tip: Don't overload the team lead with tasks — ask them to delegate to teammates",
      ],
      []
    );
    const [tipIndex, setTipIndex] = React.useState(0);
    const [tipVisible, setTipVisible] = React.useState(true);

    const advanceTip = React.useCallback(() => {
      setTipIndex((prev) => (prev + 1) % rotatingTips.length);
      setTipVisible(true);
    }, [rotatingTips.length]);

    React.useEffect(() => {
      const interval = setInterval(() => {
        setTipVisible(false);
        setTimeout(advanceTip, 300);
      }, 10000);
      return () => clearInterval(interval);
    }, [advanceTip]);

    const resolvedHintText = hintText ?? rotatingTips[tipIndex];
    const showHintRow = showHint && (suggestions.length > 0 || enableFiles);
    const showFooter = showHintRow || footerRight;

    return (
      <div className="relative">
        {/* Inner wrapper for textarea + backdrop overlay */}
        <div className="relative">
          {hasOverlay ? (
            <div
              ref={backdropRef}
              className={cn(
                'pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-md border border-transparent px-3 py-2 text-sm text-[var(--color-text)]',
                cornerAction && 'pb-12 pr-[4.25rem]'
              )}
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
                if (seg.type === 'chip') {
                  return <CodeChipBadge key={idx} chip={seg.chip} tokenText={seg.value} />;
                }
                // mention
                const colorSet = seg.suggestion.color
                  ? getTeamColorSet(seg.suggestion.color)
                  : null;
                const bg = colorSet ? getThemedBadge(colorSet, isLight) : DEFAULT_MENTION_BG;
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
              })}{' '}
            </div>
          ) : null}

          <AutoResizeTextarea
            ref={setRefs}
            value={value}
            onChange={composedHandleChange}
            onKeyDown={composedHandleKeyDown}
            onSelect={composedHandleSelect}
            {...textareaProps}
            className={cn(className, cornerAction && 'pb-12 pr-[4.25rem]')}
            onScroll={handleScroll}
            style={textareaStyle}
          />

          {chips.length > 0 && onChipRemove ? (
            <ChipInteractionLayer
              chips={chips}
              value={value}
              textareaRef={internalRef}
              scrollTop={scrollTop}
              onRemove={handleChipRemove}
            />
          ) : null}

          {cornerAction ? (
            <div className="pointer-events-none absolute bottom-2 right-2 z-20 flex items-end justify-end">
              <div className="pointer-events-auto">{cornerAction}</div>
            </div>
          ) : null}
        </div>

        {showFooter ? (
          <div className="mt-1 flex items-center justify-between">
            {showHintRow ? (
              <span
                className="text-[10px] text-[var(--color-text-muted)] transition-opacity duration-300"
                style={{ opacity: tipVisible ? 1 : 0 }}
              >
                {resolvedHintText}
              </span>
            ) : (
              <span />
            )}
            {footerRight}
          </div>
        ) : null}
        {isOpen && dropdownPosition ? (
          <div className="absolute left-0 z-50 w-full" style={{ top: `${dropdownPosition.top}px` }}>
            <MentionSuggestionList
              suggestions={effectiveSuggestions}
              selectedIndex={effectiveIndex}
              onSelect={enableFiles ? handleMergedSelect : selectSuggestion}
              query={query}
              hasFileSearch={enableFiles}
              filesLoading={enableFiles && filesLoading}
            />
          </div>
        ) : null}
      </div>
    );
  }
);
MentionableTextarea.displayName = 'MentionableTextarea';
