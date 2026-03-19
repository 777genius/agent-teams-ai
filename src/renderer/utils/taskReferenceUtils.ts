import { getSuggestionInsertionText } from '@renderer/utils/mentionSuggestions';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { TaskRef } from '@shared/types';

const TASK_REF_REGEX = /#([A-Za-z0-9-]+)\b/g;
const TASK_META_START = '\u2063';
const TASK_META_END = '\u2064';
const ZERO_WIDTH_ALPHABET = ['\u200B', '\u200C', '\u200D', '\u2060'] as const;
const ZERO_WIDTH_TO_BITS = new Map(
  ZERO_WIDTH_ALPHABET.map((char, index) => [char, index] as const)
);

function isAllowedTaskRefBoundary(char: string | undefined): boolean {
  if (!char) return true;
  return !/\w/.test(char);
}

function buildSuggestionsByRef(
  taskSuggestions: MentionSuggestion[]
): Map<string, MentionSuggestion[]> {
  const suggestionsByRef = new Map<string, MentionSuggestion[]>();

  for (const suggestion of taskSuggestions) {
    if (suggestion.type !== 'task') continue;
    const ref = getSuggestionInsertionText(suggestion).trim().toLowerCase();
    if (!ref) continue;

    const existing = suggestionsByRef.get(ref);
    if (existing) {
      existing.push(suggestion);
    } else {
      suggestionsByRef.set(ref, [suggestion]);
    }
  }

  return suggestionsByRef;
}

function resolveTaskSuggestion(candidates: MentionSuggestion[]): MentionSuggestion | null {
  if (candidates.length === 0) return null;

  const currentTeamCandidate = candidates.find((candidate) => candidate.isCurrentTeamTask);
  if (currentTeamCandidate) return currentTeamCandidate;

  if (candidates.length === 1) return candidates[0];

  return null;
}

export interface TaskReferenceMatch {
  start: number;
  end: number;
  raw: string;
  ref: string;
  suggestion: MentionSuggestion;
  encoded: boolean;
}

interface EncodedTaskMetadata {
  taskId: string;
  teamName: string;
  displayId: string;
}

interface EncodedTaskMetadataMatch {
  metadata: EncodedTaskMetadata;
  end: number;
}

interface ParsedTaskLinkHref {
  taskId: string;
  teamName?: string;
  displayId?: string;
}

function encodeZeroWidthPayload(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = '';

  for (const byte of bytes) {
    encoded += ZERO_WIDTH_ALPHABET[(byte >> 6) & 0b11];
    encoded += ZERO_WIDTH_ALPHABET[(byte >> 4) & 0b11];
    encoded += ZERO_WIDTH_ALPHABET[(byte >> 2) & 0b11];
    encoded += ZERO_WIDTH_ALPHABET[byte & 0b11];
  }

  return encoded;
}

function decodeZeroWidthPayload(value: string): string | null {
  if (value.length % 4 !== 0) return null;

  const bytes = new Uint8Array(value.length / 4);
  for (let i = 0; i < value.length; i += 4) {
    const a = ZERO_WIDTH_TO_BITS.get(value.charAt(i) as (typeof ZERO_WIDTH_ALPHABET)[number]);
    const b = ZERO_WIDTH_TO_BITS.get(value.charAt(i + 1) as (typeof ZERO_WIDTH_ALPHABET)[number]);
    const c = ZERO_WIDTH_TO_BITS.get(value.charAt(i + 2) as (typeof ZERO_WIDTH_ALPHABET)[number]);
    const d = ZERO_WIDTH_TO_BITS.get(value.charAt(i + 3) as (typeof ZERO_WIDTH_ALPHABET)[number]);
    if (a == null || b == null || c == null || d == null) return null;
    bytes[i / 4] = (a << 6) | (b << 4) | (c << 2) | d;
  }

  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function extractEncodedTaskMetadata(
  text: string,
  position: number
): EncodedTaskMetadataMatch | null {
  if (text[position] !== TASK_META_START) return null;

  const end = text.indexOf(TASK_META_END, position + 1);
  if (end === -1) return null;

  const encodedPayload = text.slice(position + 1, end);
  const decodedPayload = decodeZeroWidthPayload(encodedPayload);
  if (!decodedPayload) return null;

  try {
    const parsed = JSON.parse(decodedPayload) as EncodedTaskMetadata;
    if (!parsed.taskId || !parsed.teamName || !parsed.displayId) return null;
    return {
      metadata: parsed,
      end: end + 1,
    };
  } catch {
    return null;
  }
}

function buildTaskSuggestionFromMetadata(
  metadata: EncodedTaskMetadata,
  taskSuggestions: MentionSuggestion[]
): MentionSuggestion {
  return (
    taskSuggestions.find(
      (suggestion) =>
        suggestion.type === 'task' &&
        suggestion.taskId === metadata.taskId &&
        suggestion.teamName === metadata.teamName
    ) ?? {
      id: `task:${metadata.teamName}:${metadata.taskId}`,
      name: metadata.displayId,
      type: 'task',
      taskId: metadata.taskId,
      teamName: metadata.teamName,
      teamDisplayName: metadata.teamName,
    }
  );
}

function buildTaskRefFromSuggestion(
  suggestion: MentionSuggestion,
  displayId: string
): TaskRef | null {
  if (!suggestion.taskId || !suggestion.teamName) {
    return null;
  }
  return {
    taskId: suggestion.taskId,
    displayId,
    teamName: suggestion.teamName,
  };
}

export function createEncodedTaskReference(
  displayId: string,
  taskId: string,
  teamName: string
): string {
  const encodedPayload = encodeZeroWidthPayload(
    JSON.stringify({
      displayId,
      taskId,
      teamName,
    } satisfies EncodedTaskMetadata)
  );
  return `#${displayId}${TASK_META_START}${encodedPayload}${TASK_META_END}`;
}

export function buildTaskLinkHref(taskRef: TaskRef): string {
  return `task://${encodeURIComponent(taskRef.taskId)}?team=${encodeURIComponent(taskRef.teamName)}&display=${encodeURIComponent(taskRef.displayId)}`;
}

export function parseTaskLinkHref(href: string): ParsedTaskLinkHref | null {
  if (!href.startsWith('task://')) return null;
  try {
    const raw = href.slice('task://'.length);
    if (!raw) return null;

    const queryIndex = raw.indexOf('?');
    if (queryIndex === -1) {
      return {
        taskId: decodeURIComponent(raw),
      };
    }

    const taskIdPart = raw.slice(0, queryIndex);
    const search = new URLSearchParams(raw.slice(queryIndex + 1));
    const teamName = search.get('team');
    const displayId = search.get('display');
    return {
      taskId: decodeURIComponent(taskIdPart),
      teamName: teamName ? decodeURIComponent(teamName) : undefined,
      displayId: displayId ? decodeURIComponent(displayId) : undefined,
    };
  } catch {
    return null;
  }
}

export function linkifyTaskIdsInMarkdown(text: string, taskRefs?: TaskRef[]): string {
  if (!text) return text;

  const orderedTaskRefs = taskRefs ?? [];
  let taskRefIndex = 0;
  let result = '';
  let cursor = 0;

  for (const match of text.matchAll(TASK_REF_REGEX)) {
    const raw = match[0];
    const ref = match[1];
    const start = match.index ?? -1;
    if (start < 0) continue;

    result += text.slice(cursor, start);
    const preceding = start > 0 ? text[start - 1] : undefined;
    if (!isAllowedTaskRefBoundary(preceding)) {
      result += raw;
      cursor = start + raw.length;
      continue;
    }

    const structuredTaskRef =
      taskRefIndex < orderedTaskRefs.length &&
      orderedTaskRefs[taskRefIndex]?.displayId.toLowerCase() === ref.toLowerCase()
        ? orderedTaskRefs[taskRefIndex++]
        : undefined;
    const href = structuredTaskRef ? buildTaskLinkHref(structuredTaskRef) : `task://${ref}`;
    result += `[${raw}](${href})`;
    cursor = start + raw.length;
  }

  result += text.slice(cursor);
  return result;
}

export function stripEncodedTaskReferenceMetadata(text: string): string {
  if (!text.includes(TASK_META_START)) return text;

  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(TASK_META_START, cursor);
    if (start === -1) {
      result += text.slice(cursor);
      break;
    }

    result += text.slice(cursor, start);
    const match = extractEncodedTaskMetadata(text, start);
    cursor = match ? match.end : start + 1;
  }

  return result;
}

export function findTaskReferenceMatches(
  text: string,
  taskSuggestions: MentionSuggestion[]
): TaskReferenceMatch[] {
  if (!text) return [];

  const suggestionsByRef = buildSuggestionsByRef(taskSuggestions);

  const matches: TaskReferenceMatch[] = [];
  for (const match of text.matchAll(TASK_REF_REGEX)) {
    const raw = match[0];
    const ref = match[1];
    const start = match.index ?? -1;
    if (start < 0) continue;

    const preceding = start > 0 ? text[start - 1] : undefined;
    if (!isAllowedTaskRefBoundary(preceding)) continue;

    const metadataMatch = extractEncodedTaskMetadata(text, start + raw.length);
    const suggestion = metadataMatch
      ? buildTaskSuggestionFromMetadata(metadataMatch.metadata, taskSuggestions)
      : resolveTaskSuggestion(suggestionsByRef.get(ref.toLowerCase()) ?? []);
    if (!suggestion) continue;

    matches.push({
      start,
      end: metadataMatch?.end ?? start + raw.length,
      raw,
      ref,
      suggestion,
      encoded: metadataMatch != null,
    });
  }

  return matches;
}

export function extractTaskRefsFromText(
  text: string,
  taskSuggestions: MentionSuggestion[]
): TaskRef[] {
  if (!text) return [];

  return findTaskReferenceMatches(text, taskSuggestions)
    .map((match) => {
      if (match.encoded) {
        const metadataMatch = extractEncodedTaskMetadata(text, match.start + match.raw.length);
        if (!metadataMatch) return null;
        return {
          taskId: metadataMatch.metadata.taskId,
          displayId: metadataMatch.metadata.displayId,
          teamName: metadataMatch.metadata.teamName,
        } satisfies TaskRef;
      }

      return buildTaskRefFromSuggestion(match.suggestion, match.ref);
    })
    .filter((taskRef): taskRef is TaskRef => taskRef !== null);
}
