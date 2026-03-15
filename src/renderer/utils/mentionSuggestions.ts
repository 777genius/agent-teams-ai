import type { MentionSuggestion } from '@renderer/types/mention';

export function getSuggestionTriggerChar(suggestion: MentionSuggestion): '@' | '#' {
  return suggestion.type === 'task' ? '#' : '@';
}

export function getSuggestionInsertionText(suggestion: MentionSuggestion): string {
  return suggestion.insertText ?? suggestion.name;
}

export function doesSuggestionMatchQuery(suggestion: MentionSuggestion, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const haystacks = [
    suggestion.name,
    suggestion.subtitle,
    suggestion.relativePath,
    suggestion.searchText,
    suggestion.teamDisplayName,
    suggestion.teamName,
  ]
    .filter(Boolean)
    .map((value) => value!.toLowerCase());

  return haystacks.some((value) => value.includes(normalizedQuery));
}
