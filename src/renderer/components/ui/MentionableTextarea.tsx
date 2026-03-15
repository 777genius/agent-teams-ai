import * as React from 'react';

import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { PROSE_LINK } from '@renderer/constants/cssVariables';
import { useFileSuggestions } from '@renderer/hooks/useFileSuggestions';
import { useMentionDetection } from '@renderer/hooks/useMentionDetection';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { chipToken } from '@renderer/types/inlineChip';
import {
  doesSuggestionMatchQuery,
  getSuggestionInsertionText,
} from '@renderer/utils/mentionSuggestions';
import { nameColorSet } from '@renderer/utils/projectColor';
import { findTaskReferenceMatches } from '@renderer/utils/taskReferenceUtils';
import {
  createChipFromSelection,
  findChipBoundary,
  reconcileChips,
  removeChipTokenFromText,
} from '@renderer/utils/chipUtils';
import {
  findUrlBoundary,
  findUrlMatches,
  removeUrlMatchFromText,
} from '@renderer/utils/urlMatchUtils';

import { AutoResizeTextarea } from './auto-resize-textarea';
import { ChipInteractionLayer } from './ChipInteractionLayer';
import { CodeChipBadge } from './CodeChipBadge';
import { MentionInteractionLayer } from './MentionInteractionLayer';
import { MentionSuggestionList } from './MentionSuggestionList';
import { TaskReferenceInteractionLayer } from './TaskReferenceInteractionLayer';
import { UrlInteractionLayer } from './UrlInteractionLayer';

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

interface TaskSegment {
  type: 'task';
  value: string;
  suggestion: MentionSuggestion;
  encoded: boolean;
  /** Zero-width metadata chars rendered in backdrop for caret alignment */
  hiddenSuffix?: string;
}

interface UrlSegment {
  type: 'url';
  value: string;
}

interface ChipSegment {
  type: 'chip';
  value: string;
  chip: InlineChip;
}

type Segment = TextSegment | MentionSegment | TaskSegment | UrlSegment | ChipSegment;

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
  const sorted = [...suggestions]
    .filter((suggestion) => suggestion.type !== 'task')
    .sort((a, b) => b.name.length - a.name.length);

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
      const insertionText = getSuggestionInsertionText(suggestion);
      const end = i + 1 + insertionText.length;
      if (end > text.length) continue;
      if (text.slice(i + 1, end).toLowerCase() !== insertionText.toLowerCase()) continue;

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

function parseSuggestionSegments(
  text: string,
  mentionSuggestions: MentionSuggestion[],
  taskSuggestions: MentionSuggestion[]
): Segment[] {
  if (!text) return [{ type: 'text', value: text }];

  const urlMatches = findUrlMatches(text);
  if (urlMatches.length > 0) {
    const segments: Segment[] = [];
    let lastEnd = 0;

    for (const match of urlMatches) {
      if (match.start > lastEnd) {
        segments.push(
          ...parseSuggestionSegments(
            text.slice(lastEnd, match.start),
            mentionSuggestions,
            taskSuggestions
          )
        );
      }
      segments.push({
        type: 'url',
        value: match.value,
      });
      lastEnd = match.end;
    }

    if (lastEnd < text.length) {
      segments.push(
        ...parseSuggestionSegments(text.slice(lastEnd), mentionSuggestions, taskSuggestions)
      );
    }

    return segments;
  }

  const taskMatches = findTaskReferenceMatches(text, taskSuggestions);
  if (taskMatches.length === 0) {
    return parseMentionSegments(text, mentionSuggestions);
  }

  const segments: Segment[] = [];
  let lastEnd = 0;

  for (const match of taskMatches) {
    if (match.start > lastEnd) {
      segments.push(...parseMentionSegments(text.slice(lastEnd, match.start), mentionSuggestions));
    }
    // Compute hidden suffix: zero-width metadata chars between visible text and match.end
    const visibleEnd = match.start + match.raw.length;
    const hiddenSuffix =
      match.encoded && match.end > visibleEnd ? text.slice(visibleEnd, match.end) : undefined;
    segments.push({
      type: 'task',
      value: match.raw,
      suggestion: match.suggestion,
      encoded: match.encoded,
      hiddenSuffix,
    });
    lastEnd = match.end;
  }

  if (lastEnd < text.length) {
    segments.push(...parseMentionSegments(text.slice(lastEnd), mentionSuggestions));
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
  mentionSuggestions: MentionSuggestion[],
  taskSuggestions: MentionSuggestion[],
  chips: InlineChip[]
): Segment[] {
  if (!text) return [{ type: 'text', value: text }];
  if (chips.length === 0) return parseSuggestionSegments(text, mentionSuggestions, taskSuggestions);

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

  if (chipPositions.length === 0) {
    return parseSuggestionSegments(text, mentionSuggestions, taskSuggestions);
  }

  const segments: Segment[] = [];
  let lastEnd = 0;

  for (const pos of chipPositions) {
    // Text before this chip → parse for mentions
    if (pos.start > lastEnd) {
      const fragment = text.slice(lastEnd, pos.start);
      segments.push(...parseSuggestionSegments(fragment, mentionSuggestions, taskSuggestions));
    }
    segments.push({ type: 'chip', value: pos.token, chip: pos.chip });
    lastEnd = pos.end;
  }

  // Remaining text after last chip → parse for mentions
  if (lastEnd < text.length) {
    segments.push(
      ...parseSuggestionSegments(text.slice(lastEnd), mentionSuggestions, taskSuggestions)
    );
  }

  return segments;
}

// Default fallback color for mentions without a team color
const DEFAULT_MENTION_BG = 'rgba(59, 130, 246, 0.15)';
const DEFAULT_MENTION_TEXT = '#60a5fa';
const URL_BADGE_BG = 'var(--url-badge-bg)';
const URL_BADGE_BORDER = 'var(--url-badge-border)';
const URL_BADGE_TEXT = 'var(--url-badge-text)';

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
  /** Content rendered at the right side of the footer row (e.g. "Saved") */
  footerRight?: React.ReactNode;
  /** Content rendered in the bottom-right corner inside the textarea (e.g. send button) */
  cornerAction?: React.ReactNode;
  /** Content rendered in the bottom-left corner inside the textarea (e.g. mode selector) */
  cornerActionLeft?: React.ReactNode;
  /** Inline code chips to display as badges */
  chips?: InlineChip[];
  /** Called when a chip is removed (by X button, backspace, or reconciliation) */
  onChipRemove?: (chipId: string) => void;
  /** Project path for @file search. When provided, enables file suggestions alongside members. */
  projectPath?: string | null;
  /** Called when a file chip is created via @ selection. Parent must add chip to state. */
  onFileChipInsert?: (chip: InlineChip) => void;
  /** Team suggestions for cross-team @mentions */
  teamSuggestions?: MentionSuggestion[];
  /** Task suggestions for #task references */
  taskSuggestions?: MentionSuggestion[];
  /** Called when Enter (without Shift) is pressed. */
  onModEnter?: () => void;
  /** Called when Shift+Tab is pressed. */
  onShiftTab?: () => void;
  /** Ref that receives the dismiss callback to close mention dropdown from outside */
  dismissMentionsRef?: React.MutableRefObject<(() => void) | null>;
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
      cornerActionLeft,
      chips = [],
      onChipRemove,
      projectPath,
      onFileChipInsert,
      teamSuggestions = [],
      taskSuggestions = [],
      onModEnter,
      onShiftTab,
      dismissMentionsRef,
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
    const enableTaskSearch = taskSuggestions.length > 0;

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
      activeTriggerChar,
      query,
      selectedIndex,
      setSelectedIndex,
      dropdownPosition,
      selectSuggestion,
      dismiss,
      getTriggerIndex,
      handleKeyDown: mentionHandleKeyDown,
      handleChange: mentionHandleChange,
      handleSelect: mentionHandleSelect,
    } = useMentionDetection({
      value,
      onValueChange,
      textareaRef: internalRef,
      triggerChars: enableTaskSearch ? ['@', '#'] : ['@'],
      isTriggerEnabled: (triggerChar) => {
        if (triggerChar === '#') return enableTaskSearch;
        return suggestions.length > 0 || enableFiles || teamSuggestions.length > 0;
      },
    });

    // Expose dismiss to parent via ref for external close (e.g. Send button click)
    React.useEffect(() => {
      if (dismissMentionsRef) dismissMentionsRef.current = dismiss;
    }, [dismiss, dismissMentionsRef]);

    // --- File suggestions ---
    const { suggestions: fileSuggestions, loading: filesLoading } = useFileSuggestions(
      enableFiles ? projectPath : null,
      activeTriggerChar === '@' ? query : '',
      isOpen && enableFiles && activeTriggerChar === '@'
    );

    const isAtTrigger = activeTriggerChar !== '#';

    const memberSuggestions = React.useMemo(() => {
      if (!isOpen || !isAtTrigger) return [];
      if (!query) return suggestions;
      return suggestions.filter((member) => doesSuggestionMatchQuery(member, query));
    }, [isAtTrigger, isOpen, query, suggestions]);

    // --- Team suggestions filtered by query ---
    const filteredTeamSuggestions = React.useMemo(() => {
      if (teamSuggestions.length === 0 || !isOpen || !isAtTrigger) return [];
      if (!query) return teamSuggestions;
      return teamSuggestions.filter((team) => doesSuggestionMatchQuery(team, query));
    }, [teamSuggestions, isAtTrigger, isOpen, query]);

    const filteredTaskSuggestions = React.useMemo(() => {
      if (taskSuggestions.length === 0 || !isOpen || activeTriggerChar !== '#') return [];
      if (!query) return taskSuggestions;
      return taskSuggestions.filter((task) => doesSuggestionMatchQuery(task, query));
    }, [taskSuggestions, activeTriggerChar, isOpen, query]);

    // Merged suggestion list: members → online teams → offline teams → files
    const atSuggestions = React.useMemo(() => {
      const onlineTeams = filteredTeamSuggestions.filter((t) => t.isOnline);
      const offlineTeams = filteredTeamSuggestions.filter((t) => !t.isOnline);
      const merged = [...memberSuggestions, ...onlineTeams, ...offlineTeams];
      if (!enableFiles) return merged;
      if (fileSuggestions.length === 0) return merged;
      return [...merged, ...fileSuggestions];
    }, [memberSuggestions, filteredTeamSuggestions, enableFiles, fileSuggestions]);
    const effectiveSuggestions =
      activeTriggerChar === '#' ? filteredTaskSuggestions : atSuggestions;

    React.useEffect(() => {
      if (!isOpen) return;
      if (effectiveSuggestions.length === 0) {
        setSelectedIndex(0);
        return;
      }
      if (selectedIndex >= effectiveSuggestions.length) {
        setSelectedIndex(0);
      }
    }, [effectiveSuggestions.length, isOpen, selectedIndex, setSelectedIndex]);

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

    // --- Folder selection handler (inserts folder as chip with folder icon) ---
    const handleFolderSelect = React.useCallback(
      (s: MentionSuggestion) => {
        const textarea = internalRef.current;
        const triggerIdx = getTriggerIndex();
        if (!textarea || triggerIdx < 0) return;

        const replaceStart = triggerIdx;
        const replaceEnd = triggerIdx + 1 + query.length;
        const before = value.slice(0, replaceStart);
        const after = value.slice(replaceEnd);

        if (onFileChipInsert && onChipRemove) {
          // Chip mode: create folder InlineChip
          const chip = createChipFromSelection(
            {
              type: 'sendMessage',
              filePath: s.filePath ?? '',
              fromLine: null,
              toLine: null,
              selectedText: '',
              formattedContext: '',
              displayPath: s.relativePath,
              isFolder: true,
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
            dismiss();
          }
        } else {
          // Text mode fallback: insert backtick-wrapped relative path
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

    // --- Active selection handler ---
    const handleActiveSelect = React.useCallback(
      (s: MentionSuggestion) => {
        if (s.type === 'file') {
          handleFileSelect(s);
        } else if (s.type === 'folder') {
          handleFolderSelect(s);
        } else {
          selectSuggestion(s);
        }
      },
      [handleFileSelect, handleFolderSelect, selectSuggestion]
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
    const hasOverlay =
      value.includes('http://') ||
      value.includes('https://') ||
      suggestions.length > 0 ||
      teamSuggestions.length > 0 ||
      taskSuggestions.length > 0 ||
      chips.length > 0;

    // Combine member + team suggestions for overlay parsing
    const mentionOverlaySuggestions = React.useMemo(
      () => (teamSuggestions.length > 0 ? [...suggestions, ...teamSuggestions] : suggestions),
      [suggestions, teamSuggestions]
    );

    const segments = React.useMemo(
      () =>
        hasOverlay ? parseSegments(value, mentionOverlaySuggestions, taskSuggestions, chips) : [],
      [hasOverlay, value, mentionOverlaySuggestions, taskSuggestions, chips]
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
    const findEncodedTaskBoundary = React.useCallback(
      (cursorPos: number) => {
        const boundary = findTaskReferenceMatches(value, taskSuggestions).find(
          (match) => match.encoded && cursorPos >= match.start && cursorPos <= match.end
        );
        return boundary ? { start: boundary.start, end: boundary.end } : null;
      },
      [taskSuggestions, value]
    );

    const findUrlTokenBoundary = React.useCallback(
      (cursorPos: number) => findUrlBoundary(value, cursorPos),
      [value]
    );

    const handleChipKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const textarea = internalRef.current;
        if (!textarea) return;

        const { selectionStart, selectionEnd } = textarea;
        // Only act on collapsed cursor
        if (selectionStart !== selectionEnd && !e.shiftKey) return;

        const cursorPos = selectionStart;

        if (e.key === 'Backspace') {
          const urlBoundary = findUrlTokenBoundary(cursorPos);
          if (urlBoundary && cursorPos === urlBoundary.end) {
            e.preventDefault();
            const newText = removeUrlMatchFromText(value, urlBoundary);
            onValueChange(newText);
            requestAnimationFrame(() => {
              textarea.setSelectionRange(urlBoundary.start, urlBoundary.start);
            });
            return;
          }
          const taskBoundary = findEncodedTaskBoundary(cursorPos);
          if (taskBoundary && cursorPos === taskBoundary.end) {
            e.preventDefault();
            const newText = value.slice(0, taskBoundary.start) + value.slice(taskBoundary.end);
            onValueChange(newText);
            requestAnimationFrame(() => {
              textarea.setSelectionRange(taskBoundary.start, taskBoundary.start);
            });
            return;
          }
          if (chips.length === 0 || !onChipRemove) return;
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
          const urlBoundary = findUrlTokenBoundary(cursorPos);
          if (urlBoundary && cursorPos === urlBoundary.start) {
            e.preventDefault();
            const newText = removeUrlMatchFromText(value, urlBoundary);
            onValueChange(newText);
            requestAnimationFrame(() => {
              textarea.setSelectionRange(urlBoundary.start, urlBoundary.start);
            });
            return;
          }
          const taskBoundary = findEncodedTaskBoundary(cursorPos);
          if (taskBoundary && cursorPos === taskBoundary.start) {
            e.preventDefault();
            const newText = value.slice(0, taskBoundary.start) + value.slice(taskBoundary.end);
            onValueChange(newText);
            requestAnimationFrame(() => {
              textarea.setSelectionRange(taskBoundary.start, taskBoundary.start);
            });
            return;
          }
          if (chips.length === 0 || !onChipRemove) return;
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
          const urlBoundary = findUrlTokenBoundary(cursorPos);
          if (urlBoundary && cursorPos === urlBoundary.end) {
            e.preventDefault();
            textarea.setSelectionRange(urlBoundary.start, urlBoundary.start);
            return;
          }
          const taskBoundary = findEncodedTaskBoundary(cursorPos);
          if (taskBoundary && cursorPos === taskBoundary.end) {
            e.preventDefault();
            textarea.setSelectionRange(taskBoundary.start, taskBoundary.start);
            return;
          }
          if (chips.length === 0 || !onChipRemove) return;
          // If cursor is at chip end → jump to chip start
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.end) {
            e.preventDefault();
            textarea.setSelectionRange(boundary.start, boundary.start);
          }
        } else if (e.key === 'ArrowRight' && !e.shiftKey) {
          const urlBoundary = findUrlTokenBoundary(cursorPos);
          if (urlBoundary && cursorPos === urlBoundary.start) {
            e.preventDefault();
            textarea.setSelectionRange(urlBoundary.end, urlBoundary.end);
            return;
          }
          const taskBoundary = findEncodedTaskBoundary(cursorPos);
          if (taskBoundary && cursorPos === taskBoundary.start) {
            e.preventDefault();
            textarea.setSelectionRange(taskBoundary.end, taskBoundary.end);
            return;
          }
          if (chips.length === 0 || !onChipRemove) return;
          // If cursor is at chip start → jump to chip end
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.start) {
            e.preventDefault();
            textarea.setSelectionRange(boundary.end, boundary.end);
          }
        } else if (e.key === 'ArrowLeft' && e.shiftKey) {
          const urlBoundary = findUrlTokenBoundary(cursorPos);
          if (urlBoundary && cursorPos === urlBoundary.end) {
            e.preventDefault();
            textarea.setSelectionRange(urlBoundary.start, selectionEnd);
            return;
          }
          const taskBoundary = findEncodedTaskBoundary(cursorPos);
          if (taskBoundary && cursorPos === taskBoundary.end) {
            e.preventDefault();
            textarea.setSelectionRange(taskBoundary.start, selectionEnd);
            return;
          }
          if (chips.length === 0 || !onChipRemove) return;
          // Extend selection past chip atomically
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.end) {
            e.preventDefault();
            textarea.setSelectionRange(boundary.start, selectionEnd);
          }
        } else if (e.key === 'ArrowRight' && e.shiftKey) {
          const urlBoundary = findUrlTokenBoundary(cursorPos);
          if (urlBoundary && cursorPos === urlBoundary.start) {
            e.preventDefault();
            textarea.setSelectionRange(selectionStart, urlBoundary.end);
            return;
          }
          const taskBoundary = findEncodedTaskBoundary(cursorPos);
          if (taskBoundary && cursorPos === taskBoundary.start) {
            e.preventDefault();
            textarea.setSelectionRange(selectionStart, taskBoundary.end);
            return;
          }
          if (chips.length === 0 || !onChipRemove) return;
          const boundary = findChipBoundary(value, chips, cursorPos);
          if (cursorPos === boundary?.start) {
            e.preventDefault();
            textarea.setSelectionRange(selectionStart, boundary.end);
          }
        }
      },
      [chips, findEncodedTaskBoundary, findUrlTokenBoundary, onChipRemove, value, onValueChange]
    );

    // Composed key handler: suggestion logic first (when open) → Mod+Enter submit → chip logic
    const composedHandleKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // When the suggestion dropdown is open, let it consume Enter/Arrow keys first
        if (isOpen && effectiveSuggestions.length > 0) {
          mentionHandleKeyDown(e, effectiveSuggestions.length, (index) => {
            const next = effectiveSuggestions[index];
            if (next) handleActiveSelect(next);
          });
          if (e.defaultPrevented) return;
        }
        // Shift+Tab → cycle action mode
        if (e.key === 'Tab' && e.shiftKey && onShiftTab) {
          e.preventDefault();
          onShiftTab();
          return;
        }
        // Enter (without Shift) → submit; Shift+Enter → newline
        if (e.key === 'Enter' && !e.shiftKey && onModEnter) {
          e.preventDefault();
          e.stopPropagation();
          dismiss();
          onModEnter();
          return;
        }
        handleChipKeyDown(e);
      },
      [
        onModEnter,
        onShiftTab,
        handleChipKeyDown,
        mentionHandleKeyDown,
        isOpen,
        effectiveSuggestions.length,
        effectiveSuggestions,
        handleActiveSelect,
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

        const textarea = internalRef.current;
        if (!textarea) return;
        const { selectionStart, selectionEnd } = textarea;
        if (selectionStart !== selectionEnd) return;
        const taskBoundary = findEncodedTaskBoundary(selectionStart);
        if (
          taskBoundary &&
          selectionStart > taskBoundary.start &&
          selectionStart < taskBoundary.end
        ) {
          const distToStart = selectionStart - taskBoundary.start;
          const distToEnd = taskBoundary.end - selectionStart;
          const snapTo = distToStart <= distToEnd ? taskBoundary.start : taskBoundary.end;
          requestAnimationFrame(() => {
            textarea.setSelectionRange(snapTo, snapTo);
          });
          return;
        }

        const urlBoundary = findUrlTokenBoundary(selectionStart);
        if (urlBoundary && selectionStart > urlBoundary.start && selectionStart < urlBoundary.end) {
          const distToStart = selectionStart - urlBoundary.start;
          const distToEnd = urlBoundary.end - selectionStart;
          const snapTo = distToStart <= distToEnd ? urlBoundary.start : urlBoundary.end;
          requestAnimationFrame(() => {
            textarea.setSelectionRange(snapTo, snapTo);
          });
        }
      },
      [mentionHandleSelect, chips, value, findEncodedTaskBoundary, findUrlTokenBoundary]
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
        'Tip: Use @ for members/files and # for tasks',
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
    const showHintRow =
      showHint &&
      (suggestions.length > 0 || enableFiles || teamSuggestions.length > 0 || enableTaskSearch);
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
                (cornerAction || cornerActionLeft) && 'pb-12'
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
                if (seg.type === 'task') {
                  return (
                    <React.Fragment key={idx}>
                      <span
                        className={seg.encoded ? 'rounded' : 'underline decoration-transparent'}
                        style={
                          seg.encoded
                            ? {
                                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                                color: PROSE_LINK,
                                // Only vertical padding (doesn't affect inline text flow).
                                // No horizontal padding/margin/box-shadow spread to avoid
                                // caret drift or visual overlap with adjacent text.
                                padding: '2px 0',
                              }
                            : { color: PROSE_LINK }
                        }
                      >
                        {seg.value}
                      </span>
                      {seg.hiddenSuffix}
                    </React.Fragment>
                  );
                }
                if (seg.type === 'url') {
                  return (
                    <span
                      key={idx}
                      style={{
                        backgroundColor: URL_BADGE_BG,
                        color: URL_BADGE_TEXT,
                        borderRadius: '4px',
                        boxShadow: `inset 0 0 0 1px ${URL_BADGE_BORDER}`,
                      }}
                    >
                      {seg.value}
                    </span>
                  );
                }
                // mention (member or team)
                const isTeamMention = seg.suggestion.type === 'team';
                const colorSet = seg.suggestion.color
                  ? getTeamColorSet(seg.suggestion.color)
                  : isTeamMention
                    ? nameColorSet(seg.suggestion.name, isLight)
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

          {taskSuggestions.length > 0 ? (
            <TaskReferenceInteractionLayer
              taskSuggestions={taskSuggestions}
              value={value}
              textareaRef={internalRef}
              scrollTop={scrollTop}
            />
          ) : null}

          {value.includes('http://') || value.includes('https://') ? (
            <UrlInteractionLayer
              value={value}
              textareaRef={internalRef}
              scrollTop={scrollTop}
              onRemove={(match) => {
                const newText = removeUrlMatchFromText(value, match);
                onValueChange(newText);
                requestAnimationFrame(() => {
                  internalRef.current?.setSelectionRange(match.start, match.start);
                });
              }}
            />
          ) : null}

          {mentionOverlaySuggestions.length > 0 ? (
            <MentionInteractionLayer
              suggestions={mentionOverlaySuggestions}
              value={value}
              textareaRef={internalRef}
              scrollTop={scrollTop}
            />
          ) : null}

          <AutoResizeTextarea
            ref={setRefs}
            value={value}
            onChange={composedHandleChange}
            onKeyDown={composedHandleKeyDown}
            onSelect={composedHandleSelect}
            {...textareaProps}
            className={cn(className, (cornerAction || cornerActionLeft) && 'pb-12')}
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

          {/* Gradient fade overlay before corner action buttons */}
          {cornerAction || cornerActionLeft ? (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 z-[15] rounded-b-md"
              style={{
                height: 48,
                background:
                  'linear-gradient(to bottom, transparent 0%, var(--color-surface-raised) 75%)',
              }}
            />
          ) : null}

          {cornerAction ? (
            <div className="pointer-events-none absolute bottom-2 right-2 z-20 flex items-end justify-end">
              <div className="pointer-events-auto">{cornerAction}</div>
            </div>
          ) : null}

          {cornerActionLeft ? (
            <div className="pointer-events-none absolute bottom-2 left-2 z-20 flex items-end justify-start">
              <div className="pointer-events-auto">{cornerActionLeft}</div>
            </div>
          ) : null}
        </div>

        {showFooter ? (
          <div className="mt-1 flex items-start justify-between gap-2">
            {showHintRow ? (
              <span
                className="block min-h-6 flex-1 overflow-hidden text-[10px] leading-3 text-[var(--color-text-muted)] transition-opacity duration-300"
                style={{ opacity: tipVisible ? 1 : 0, maxHeight: '1.5rem' }}
              >
                {resolvedHintText}
              </span>
            ) : (
              <span className="min-h-6 flex-1" />
            )}
            {footerRight}
          </div>
        ) : null}
        {isOpen && dropdownPosition ? (
          <div className="absolute left-0 z-50 w-full" style={{ top: `${dropdownPosition.top}px` }}>
            <MentionSuggestionList
              suggestions={effectiveSuggestions}
              selectedIndex={selectedIndex}
              onSelect={handleActiveSelect}
              query={query}
              hasFileSearch={enableFiles}
              filesLoading={enableFiles && filesLoading && activeTriggerChar === '@'}
            />
          </div>
        ) : null}
      </div>
    );
  }
);
MentionableTextarea.displayName = 'MentionableTextarea';
