import { extractMarkdownPlainText } from '@shared/utils/markdownTextSearch';

import type { TaskRef } from '@shared/types';

const MAX_ACTIVITY_RENDER_CACHE_ENTRIES = 500;

type StringCache = Map<string, string>;

const taskRefsSignatureCache = new WeakMap<readonly TaskRef[], string>();
const stringArraySignatureCache = new WeakMap<readonly string[], string>();
const stringMapSignatureCache = new WeakMap<ReadonlyMap<string, string>, string>();

export function getCachedString(cache: StringCache, key: string, buildValue: () => string): string {
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) return cached ?? '';

  const value = buildValue();
  if (cache.size >= MAX_ACTIVITY_RENDER_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
  return value;
}

export function encodeCacheParts(parts: readonly string[]): string {
  let encoded = '';
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) encoded += '|';
    const part = parts[index];
    encoded += `${part.length}:${part}`;
  }
  return encoded;
}

export function taskRefsCacheSignature(taskRefs?: readonly TaskRef[]): string {
  if (!taskRefs || taskRefs.length === 0) return '';
  const cached = taskRefsSignatureCache.get(taskRefs);
  if (cached !== undefined) return cached;

  let encoded = '';
  let hasPart = false;
  for (const ref of taskRefs) {
    const parts = [ref.taskId, ref.displayId, ref.teamName ?? ''];
    for (const part of parts) {
      if (hasPart) encoded += '|';
      encoded += `${part.length}:${part}`;
      hasPart = true;
    }
  }
  taskRefsSignatureCache.set(taskRefs, encoded);
  return encoded;
}

export function stringArrayCacheSignature(values?: readonly string[]): string {
  if (!values || values.length === 0) return '';
  const cached = stringArraySignatureCache.get(values);
  if (cached !== undefined) return cached;
  const signature = encodeCacheParts(values);
  stringArraySignatureCache.set(values, signature);
  return signature;
}

export function stringMapCacheSignature(map?: ReadonlyMap<string, string>): string {
  if (!map || map.size === 0) return '';
  const cached = stringMapSignatureCache.get(map);
  if (cached !== undefined) return cached;

  const entries = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  let encoded = '';
  let hasPart = false;
  for (const [key, value] of entries) {
    if (hasPart) encoded += '|';
    encoded += `${key.length}:${key}`;
    hasPart = true;
    encoded += `|${value.length}:${value}`;
  }
  stringMapSignatureCache.set(map, encoded);
  return encoded;
}

const markdownPlainTextCache: StringCache = new Map();

export function extractMarkdownPlainTextCached(markdown: string): string {
  if (!markdown) return '';
  return getCachedString(markdownPlainTextCache, markdown, () =>
    extractMarkdownPlainText(markdown)
  );
}
