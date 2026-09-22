/**
 * Utility functions for working with inline code chip tokens in text.
 */

import { chipToken } from '@renderer/types/inlineChip';
import { getCodeFenceLanguage } from '@renderer/utils/buildSelectionAction';
import { getSuggestionInsertionText } from '@renderer/utils/mentionSuggestions';
import { getBasename } from '@shared/utils/platformPath';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { EditorSelectionAction } from '@shared/types/editor';

// =============================================================================
// Chip creation
// =============================================================================

let chipCounter = 0;

/**
 * Creates an InlineChip from an EditorSelectionAction.
 * Returns null if a chip with the same filePath + line range already exists.
 */
export function createChipFromSelection(
  action: EditorSelectionAction,
  existingChips: InlineChip[]
): InlineChip | null {
  const isFileMention = !action.selectedText || action.fromLine == null || action.toLine == null;

  if (isFileMention) {
    // File/folder-level mention: deduplicate by filePath + null lines
    const isDuplicate = existingChips.some(
      (c) => c.filePath === action.filePath && c.fromLine == null
    );
    if (isDuplicate) return null;

    const fileName = getBasename(action.filePath) || (action.isFolder ? 'folder' : 'file');
    return {
      id: `chip-${++chipCounter}-${Date.now()}`,
      filePath: action.filePath,
      fileName,
      fromLine: null,
      toLine: null,
      codeText: '',
      language: action.isFolder ? '' : getCodeFenceLanguage(fileName),
      displayPath: action.displayPath,
      isFolder: action.isFolder,
    };
  }

  // Code selection chip
  const isDuplicate = existingChips.some(
    (c) =>
      c.filePath === action.filePath && c.fromLine === action.fromLine && c.toLine === action.toLine
  );
  if (isDuplicate) return null;

  const fileName = getBasename(action.filePath) || 'file';
  const language = getCodeFenceLanguage(fileName);

  return {
    id: `chip-${++chipCounter}-${Date.now()}`,
    filePath: action.filePath,
    fileName,
    fromLine: action.fromLine,
    toLine: action.toLine,
    codeText: action.selectedText,
    language,
  };
}

// =============================================================================
// Chip boundary detection
// =============================================================================

export interface ChipBoundary {
  start: number;
  end: number;
  chip: InlineChip;
}

/**
 * Finds the chip token boundary that contains or is adjacent to the cursor position.
 * Returns null if cursor is not at/inside any chip token.
 */
export function findChipBoundary(
  text: string,
  chips: InlineChip[],
  cursorPos: number
): ChipBoundary | null {
  for (const chip of chips) {
    const token = chipToken(chip);
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const idx = text.indexOf(token, searchFrom);
      if (idx === -1) break;
      const end = idx + token.length;
      if (cursorPos >= idx && cursorPos <= end) {
        return { start: idx, end, chip };
      }
      searchFrom = idx + 1;
    }
  }
  return null;
}

/**
 * Returns true if cursor is strictly inside a chip token (not at boundaries).
 */
export function isInsideChip(text: string, chips: InlineChip[], cursorPos: number): boolean {
  const boundary = findChipBoundary(text, chips, cursorPos);
  if (!boundary) return false;
  return cursorPos > boundary.start && cursorPos < boundary.end;
}

/**
 * Snaps cursor to the nearest chip boundary (start or end) if inside a chip.
 * Returns the original position if not inside any chip.
 */
export function snapCursorToChipBoundary(
  text: string,
  chips: InlineChip[],
  cursorPos: number
): number {
  const boundary = findChipBoundary(text, chips, cursorPos);
  if (!boundary) return cursorPos;
  if (cursorPos <= boundary.start || cursorPos >= boundary.end) return cursorPos;

  const distToStart = cursorPos - boundary.start;
  const distToEnd = boundary.end - cursorPos;
  return distToStart <= distToEnd ? boundary.start : boundary.end;
}

// =============================================================================
// Reconciliation
// =============================================================================

/**
 * Returns only those chips whose tokens are still present in the text.
 * Used to keep chip state in sync after paste/cut/undo operations.
 */
export function reconcileChips(oldChips: InlineChip[], newText: string): InlineChip[] {
  return oldChips.filter((chip) => newText.includes(chipToken(chip)));
}

/**
 * Removes a chip token from text, including a trailing newline if present.
 * This prevents orphan blank lines after chip removal.
 */
export function removeChipTokenFromText(text: string, chip: InlineChip): string {
  const token = chipToken(chip);
  const idx = text.indexOf(token);
  if (idx === -1) return text;

  const end = idx + token.length;
  // Remove trailing newline if present
  const removeEnd = end < text.length && text[end] === '\n' ? end + 1 : end;
  return text.slice(0, idx) + text.slice(removeEnd);
}

// =============================================================================
// Chip position calculation (mirror div technique)
// =============================================================================

export interface ChipPosition {
  chip: InlineChip;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface InlineMatch<T> {
  item: T;
  start: number;
  end: number;
  token: string;
}

export interface InlineMatchPosition<T> extends InlineMatch<T> {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function calculateInlineMatchPositions<T>(
  textarea: HTMLTextAreaElement,
  text: string,
  matches: InlineMatch<T>[]
): InlineMatchPosition<T>[] {
  if (matches.length === 0) return [];

  const cs = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');

  // Copy all relevant styles to mirror div
  mirror.style.font = cs.font;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.wordSpacing = cs.wordSpacing;
  mirror.style.textIndent = cs.textIndent;
  mirror.style.textTransform = cs.textTransform;
  mirror.style.tabSize = cs.tabSize;
  mirror.style.whiteSpace = cs.whiteSpace;
  mirror.style.overflowWrap = cs.overflowWrap;
  mirror.style.paddingTop = cs.paddingTop;
  mirror.style.paddingRight = cs.paddingRight;
  mirror.style.paddingBottom = cs.paddingBottom;
  mirror.style.paddingLeft = cs.paddingLeft;
  mirror.style.borderTopWidth = cs.borderTopWidth;
  mirror.style.borderRightWidth = cs.borderRightWidth;
  mirror.style.borderBottomWidth = cs.borderBottomWidth;
  mirror.style.borderLeftWidth = cs.borderLeftWidth;
  mirror.style.boxSizing = cs.boxSizing;
  mirror.style.width = cs.width;
  mirror.style.lineHeight = cs.lineHeight;

  mirror.style.position = 'absolute';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.height = 'auto';

  const sortedMatches = [...matches].sort((a, b) => a.start - b.start);
  const tokenSpans = new Map<number, HTMLSpanElement>();

  let lastEnd = 0;
  sortedMatches.forEach((match, index) => {
    if (match.start > lastEnd) {
      mirror.appendChild(document.createTextNode(text.slice(lastEnd, match.start)));
    }

    const span = document.createElement('span');
    span.textContent = text.slice(match.start, match.end);
    mirror.appendChild(span);
    tokenSpans.set(index, span);

    lastEnd = match.end;
  });

  if (lastEnd < text.length) {
    mirror.appendChild(document.createTextNode(text.slice(lastEnd)));
  }

  document.body.appendChild(mirror);

  const positions: InlineMatchPosition<T>[] = [];
  sortedMatches.forEach((match, index) => {
    const span = tokenSpans.get(index);
    if (!span) return;
    positions.push({
      ...match,
      top: span.offsetTop,
      left: span.offsetLeft,
      width: span.offsetWidth,
      height: span.offsetHeight,
    });
  });

  document.body.removeChild(mirror);
  return positions;
}

/**
 * Calculates screen positions of @mention tokens in textarea using the mirror div technique.
 */
export interface MentionPosition {
  suggestion: MentionSuggestion;
  top: number;
  left: number;
  width: number;
  height: number;
}

export function calculateMentionPositions(
  textarea: HTMLTextAreaElement,
  text: string,
  suggestions: MentionSuggestion[]
): MentionPosition[] {
  if (suggestions.length === 0 || !text) return [];

  // Filter to member/team suggestions only (not tasks/files)
  const mentionSuggestions = suggestions.filter(
    (s) => s.type !== 'task' && s.type !== 'file' && s.type !== 'folder'
  );
  if (mentionSuggestions.length === 0) return [];

  // Sort by name length descending for greedy matching
  const sorted = [...mentionSuggestions].sort((a, b) => {
    const aText = getSuggestionInsertionText(a);
    const bText = getSuggestionInsertionText(b);
    return bText.length - aText.length;
  });

  const matches: InlineMatch<MentionSuggestion>[] = [];
  let i = 0;
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
        if (!/[\s,.:;!?)\]}-]/.test(after)) continue;
      }
      matches.push({ item: suggestion, start: i, end, token: text.slice(i, end) });
      i = end;
      matched = true;
      break;
    }
    if (!matched) i++;
  }

  return calculateInlineMatchPositions(textarea, text, matches).map((pos) => ({
    suggestion: pos.item,
    top: pos.top,
    left: pos.left,
    width: pos.width,
    height: pos.height,
  }));
}

/**
 * Calculates screen positions of chip tokens in textarea using the mirror div technique.
 * Creates a temporary mirror div that replicates textarea layout and measures chip spans.
 */
export function calculateChipPositions(
  textarea: HTMLTextAreaElement,
  text: string,
  chips: InlineChip[]
): ChipPosition[] {
  if (chips.length === 0) return [];
  const tokenMatches: InlineMatch<InlineChip>[] = [];
  for (const chip of chips) {
    const token = chipToken(chip);
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const idx = text.indexOf(token, searchFrom);
      if (idx === -1) break;
      tokenMatches.push({
        item: chip,
        start: idx,
        end: idx + token.length,
        token,
      });
      searchFrom = idx + token.length;
    }
  }
  return calculateInlineMatchPositions(textarea, text, tokenMatches).map((position) => ({
    chip: position.item,
    top: position.top,
    left: position.left,
    width: position.width,
    height: position.height,
  }));
}
