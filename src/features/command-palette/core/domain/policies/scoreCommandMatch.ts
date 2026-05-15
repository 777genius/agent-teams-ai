import type { CommandItem } from '../models/CommandItem';

const FIELD_WEIGHTS = {
  title: 100,
  subtitle: 70,
  detail: 45,
  badge: 40,
  keyword: 80,
} as const;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function wordStartsWith(value: string, query: string): boolean {
  return value
    .split(/[\s./:_-]+/)
    .filter(Boolean)
    .some((part) => part.startsWith(query));
}

function scoreSubsequence(query: string, value: string): number | null {
  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  let gapCount = 0;

  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex++) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatch === -1) {
      firstMatch = valueIndex;
    }
    if (lastMatch !== -1) {
      gapCount += Math.max(0, valueIndex - lastMatch - 1);
    }
    lastMatch = valueIndex;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) {
    return null;
  }

  return 300 - firstMatch * 6 - gapCount;
}

function scoreField(query: string, value: string | undefined, weight: number): number | null {
  if (!value) {
    return null;
  }

  const normalized = normalize(value);
  if (!normalized) {
    return null;
  }

  if (normalized === query) {
    return 1000 + weight;
  }
  if (normalized.startsWith(query)) {
    return 850 + weight - normalized.length / 100;
  }
  if (wordStartsWith(normalized, query)) {
    return 700 + weight - normalized.length / 100;
  }
  if (normalized.includes(query)) {
    return 550 + weight - normalized.indexOf(query) / 10;
  }

  const subsequenceScore = scoreSubsequence(query, normalized);
  return subsequenceScore == null ? null : subsequenceScore + weight;
}

export function scoreCommandMatch(query: string, item: CommandItem): number | null {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return item.priority ?? 0;
  }

  const scores: number[] = [];
  const titleScore = scoreField(normalizedQuery, item.title, FIELD_WEIGHTS.title);
  if (titleScore != null) scores.push(titleScore);

  const subtitleScore = scoreField(normalizedQuery, item.subtitle, FIELD_WEIGHTS.subtitle);
  if (subtitleScore != null) scores.push(subtitleScore);

  const detailScore = scoreField(normalizedQuery, item.detail, FIELD_WEIGHTS.detail);
  if (detailScore != null) scores.push(detailScore);

  const badgeScore = scoreField(normalizedQuery, item.badge, FIELD_WEIGHTS.badge);
  if (badgeScore != null) scores.push(badgeScore);

  for (const keyword of item.keywords ?? []) {
    const keywordScore = scoreField(normalizedQuery, keyword, FIELD_WEIGHTS.keyword);
    if (keywordScore != null) scores.push(keywordScore);
  }

  if (scores.length === 0) {
    return null;
  }

  return Math.max(...scores) + (item.priority ?? 0);
}
