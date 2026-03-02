/**
 * Utility functions for working with inline code chip tokens in text.
 */

import { chipToken } from '@renderer/types/inlineChip';
import { getCodeFenceLanguage } from '@renderer/utils/buildSelectionAction';
import { getBasename } from '@shared/utils/platformPath';

import type { InlineChip } from '@renderer/types/inlineChip';
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
    // File-level mention: deduplicate by filePath + null lines
    const isDuplicate = existingChips.some(
      (c) => c.filePath === action.filePath && c.fromLine == null
    );
    if (isDuplicate) return null;

    const fileName = getBasename(action.filePath) || 'file';
    return {
      id: `chip-${++chipCounter}-${Date.now()}`,
      filePath: action.filePath,
      fileName,
      fromLine: null,
      toLine: null,
      codeText: '',
      language: getCodeFenceLanguage(fileName),
      displayPath: action.displayPath,
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

  // Build content with chip tokens wrapped in spans
  const chipSpans = new Map<string, HTMLSpanElement>();
  const tokenPositions: { chip: InlineChip; token: string; index: number }[] = [];

  // Find all chip token positions in text
  for (const chip of chips) {
    const token = chipToken(chip);
    const idx = text.indexOf(token);
    if (idx !== -1) {
      tokenPositions.push({ chip, token, index: idx });
    }
  }

  // Sort by position in text
  tokenPositions.sort((a, b) => a.index - b.index);

  // Build mirror content
  let lastEnd = 0;
  for (const { chip, token, index } of tokenPositions) {
    // Text before this chip
    if (index > lastEnd) {
      const textNode = document.createTextNode(text.slice(lastEnd, index));
      mirror.appendChild(textNode);
    }

    // Chip span
    const span = document.createElement('span');
    span.textContent = token;
    mirror.appendChild(span);
    chipSpans.set(chip.id, span);

    lastEnd = index + token.length;
  }

  // Text after last chip
  if (lastEnd < text.length) {
    mirror.appendChild(document.createTextNode(text.slice(lastEnd)));
  }

  document.body.appendChild(mirror);

  const positions: ChipPosition[] = [];
  for (const { chip } of tokenPositions) {
    const span = chipSpans.get(chip.id);
    if (!span) continue;
    positions.push({
      chip,
      top: span.offsetTop,
      left: span.offsetLeft,
      width: span.offsetWidth,
      height: span.offsetHeight,
    });
  }

  document.body.removeChild(mirror);
  return positions;
}
