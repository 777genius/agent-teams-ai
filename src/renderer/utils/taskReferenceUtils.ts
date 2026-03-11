import { getSuggestionInsertionText } from '@renderer/utils/mentionSuggestions';

import type { MentionSuggestion } from '@renderer/types/mention';

const TASK_REF_REGEX = /#([A-Za-z0-9-]+)\b/g;

export interface TaskReferenceMatch {
  start: number;
  end: number;
  raw: string;
  ref: string;
  suggestion: MentionSuggestion;
}

export function linkifyTaskIdsInMarkdown(text: string): string {
  return text.replace(TASK_REF_REGEX, '[#$1](task://$1)');
}

export function findTaskReferenceMatches(
  text: string,
  taskSuggestions: MentionSuggestion[]
): TaskReferenceMatch[] {
  if (!text || taskSuggestions.length === 0) return [];

  const suggestionByRef = new Map<string, MentionSuggestion>();
  for (const suggestion of taskSuggestions) {
    if (suggestion.type !== 'task') continue;
    const ref = getSuggestionInsertionText(suggestion).trim().toLowerCase();
    if (!ref || suggestionByRef.has(ref)) continue;
    suggestionByRef.set(ref, suggestion);
  }

  if (suggestionByRef.size === 0) return [];

  const matches: TaskReferenceMatch[] = [];
  for (const match of text.matchAll(TASK_REF_REGEX)) {
    const raw = match[0];
    const ref = match[1];
    const start = match.index ?? -1;
    if (start < 0) continue;

    if (start > 0) {
      const preceding = text[start - 1];
      if (preceding !== ' ' && preceding !== '\t' && preceding !== '\n' && preceding !== '\r') {
        continue;
      }
    }

    const suggestion = suggestionByRef.get(ref.toLowerCase());
    if (!suggestion) continue;

    matches.push({
      start,
      end: start + raw.length,
      raw,
      ref,
      suggestion,
    });
  }

  return matches;
}
