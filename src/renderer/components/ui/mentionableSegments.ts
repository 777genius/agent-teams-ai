import { getSuggestionInsertionText } from '@renderer/utils/mentionSuggestions';

import type { MentionSuggestion } from '@renderer/types/mention';

type MentionTextSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; value: string; suggestion: MentionSuggestion };

/** Tokenize plain text and direct @mentions, separate from the editor UI. */
export function parseMentionSegments(text: string, suggestions: MentionSuggestion[]): MentionTextSegment[] {
  if (!text || suggestions.length === 0) return [{ type: 'text', value: text }];

  // Sort by name length descending for greedy matching
  const sorted = [...suggestions]
    .filter((suggestion) => suggestion.type !== 'task')
    .sort((a, b) => b.name.length - a.name.length);

  const segments: MentionTextSegment[] = [];
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

