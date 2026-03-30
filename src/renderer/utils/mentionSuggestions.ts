import type { MentionSuggestion } from '@renderer/types/mention';

export function getSuggestionTriggerChar(suggestion: MentionSuggestion): '@' | '#' | '/' {
  if (suggestion.type === 'task') return '#';
  if (suggestion.type === 'command') return '/';
  return '@';
}

export function getSuggestionInsertionText(suggestion: MentionSuggestion): string {
  if (suggestion.type === 'command') {
    return suggestion.command?.slice(1) ?? suggestion.insertText ?? suggestion.name;
  }
  return suggestion.insertText ?? suggestion.name;
}

export function doesSuggestionMatchQuery(suggestion: MentionSuggestion, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const haystacks = [
    suggestion.name,
    suggestion.subtitle,
    suggestion.description,
    suggestion.relativePath,
    suggestion.searchText,
    suggestion.teamDisplayName,
    suggestion.teamName,
    suggestion.command,
  ]
    .filter(Boolean)
    .map((value) => value!.toLowerCase());

  return haystacks.some((value) => value.includes(normalizedQuery));
}
