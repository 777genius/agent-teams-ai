/**
 * Inline Code Chip types and pure functions.
 *
 * A chip is a visual badge representing a code selection from the editor,
 * displayed inline in textareas alongside @mentions.
 */

import { getCodeFenceLanguage } from '@renderer/utils/buildSelectionAction';
import { stripEncodedTaskReferenceMetadata } from '@renderer/utils/taskReferenceUtils';

// =============================================================================
// Types
// =============================================================================

export interface InlineChip {
  id: string;
  /** Absolute file path */
  filePath: string;
  /** Basename (e.g. "auth.ts") */
  fileName: string;
  /** 1-based start line, or null for file-level mentions */
  fromLine: number | null;
  /** 1-based end line, or null for file-level mentions */
  toLine: number | null;
  /** Selected source code text (empty for file mentions) */
  codeText: string;
  /** Language identifier (e.g. "typescript", "python") */
  language: string;
  /** Relative display path for file-level mentions */
  displayPath?: string;
  /** Whether this chip represents a folder (not a file) */
  isFolder?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Unicode marker character used as chip prefix in textarea text */
export const CHIP_MARKER = '\u{1F4C4}'; // 📄
/** Unicode marker for folder chips */
export const FOLDER_CHIP_MARKER = '\u{1F4C1}'; // 📁

// =============================================================================
// Pure functions
// =============================================================================

/**
 * Display label for a chip: "auth.ts:10-15", "auth.ts:42" for single-line,
 * "auth.ts" for file-level mentions, or "docker/" for folder mentions.
 */
export function chipDisplayLabel(chip: InlineChip): string {
  if (chip.isFolder) {
    return chip.displayPath ?? chip.fileName;
  }
  if (chip.fromLine == null || chip.toLine == null) {
    return chip.fileName;
  }
  if (chip.fromLine === chip.toLine) {
    return `${chip.fileName}:${chip.fromLine}`;
  }
  return `${chip.fileName}:${chip.fromLine}-${chip.toLine}`;
}

/**
 * Token string inserted into textarea text.
 * Must match EXACTLY in textarea and overlay for pixel-perfect alignment.
 */
export function chipToken(chip: InlineChip): string {
  const marker = chip.isFolder ? FOLDER_CHIP_MARKER : CHIP_MARKER;
  return `${marker}${chipDisplayLabel(chip)}`;
}

/**
 * Converts a chip to markdown: code fence for code chips, file/folder reference for mentions.
 */
export function chipToMarkdown(chip: InlineChip): string {
  // Folder mention
  if (chip.isFolder) {
    const path = chip.displayPath ?? chip.filePath;
    return `**${path}** (folder)`;
  }
  // File-level mention — no code fence
  if (chip.fromLine == null || chip.toLine == null) {
    const path = chip.displayPath ?? chip.filePath;
    return `**${chip.fileName}** (\`${path}\`)`;
  }
  const lang = chip.language || getCodeFenceLanguage(chip.fileName);
  const lineRef =
    chip.fromLine === chip.toLine
      ? `line ${chip.fromLine}`
      : `lines ${chip.fromLine}-${chip.toLine}`;
  return `**${chip.fileName}** (${lineRef}):\n\`\`\`${lang}\n${chip.codeText}\n\`\`\``;
}

/**
 * Serializes text with chip tokens back to markdown code fences for sending.
 * Replaces each chip token in the text with its markdown representation.
 */
export function serializeChipsWithText(text: string, chips: InlineChip[]): string {
  const strippedText = stripEncodedTaskReferenceMetadata(text);
  if (chips.length === 0) return strippedText;

  let result = strippedText;
  for (const chip of chips) {
    const token = chipToken(chip);
    result = result.split(token).join(chipToMarkdown(chip));
  }
  return result;
}
