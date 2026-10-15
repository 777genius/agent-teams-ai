import { getTaskDisplayId } from '@shared/utils/taskIdentity';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { TaskRef, TeamTask } from '@shared/types';

const TASK_REF_REGEX = /#([A-Za-z0-9-]+)\b/g;
const EXACT_TASK_REF_REGEX = /^#([A-Za-z0-9-]+)$/;
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
    const ref = suggestion.name.trim().replace(/^#/, '').toLowerCase();
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

export type TaskReferenceClickKind = 'canonical' | 'display';
export type TaskIdClickHandler = (
  taskId: string,
  targetTeamName?: string,
  referenceKind?: TaskReferenceClickKind
) => void;

/** Callers supply only the originating or explicitly addressed team's tasks. */
export function resolveTaskReferenceCandidate<T extends Pick<TeamTask, 'id' | 'displayId'>>(
  tasks: readonly T[],
  taskId: string,
  kind?: TaskReferenceClickKind
): T | undefined {
  const canonical = tasks.find((task) => task.id === taskId);
  if (kind === 'canonical') return canonical;
  const display = tasks.find((task) => getTaskDisplayId(task) === taskId.trim());
  return kind === 'display' ? (display ?? canonical) : (canonical ?? display);
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

interface TaskReferenceOccurrence {
  start: number;
  end: number;
  raw: string;
  ref: string;
  encodedMetadata: EncodedTaskMetadata | null;
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
      teamName: teamName ?? undefined,
      displayId: displayId ?? undefined,
    };
  } catch {
    return null;
  }
}

function findClosingBacktickRun(text: string, start: number, runLength: number): number {
  const marker = '`'.repeat(runLength);
  return text.indexOf(marker, start + runLength);
}

function findClosingFence(text: string, start: number, fence: string): number {
  let lineStart = text.indexOf('\n', start);
  while (lineStart !== -1) {
    lineStart += 1;
    if (text.startsWith(fence, lineStart)) {
      const lineEnd = text.indexOf('\n', lineStart);
      return lineEnd === -1 ? text.length : lineEnd + 1;
    }
    lineStart = text.indexOf('\n', lineStart);
  }
  return -1;
}

function findMarkdownLinkEnd(text: string, start: number): number {
  const closeBracket = text.indexOf(']', start + 1);
  if (closeBracket === -1 || text[closeBracket + 1] !== '(') return -1;

  let index = closeBracket + 2;
  let parenDepth = 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
    } else if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) return index + 1;
    }
    index += 1;
  }

  return -1;
}

function isEscapedMarkdownPosition(text: string, position: number): boolean {
  let backslashCount = 0;
  for (let index = position - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function findTaskReferenceOccurrences(text: string): TaskReferenceOccurrence[] {
  const occurrences: TaskReferenceOccurrence[] = [];
  for (const match of text.matchAll(TASK_REF_REGEX)) {
    const raw = match[0];
    const ref = match[1];
    const start = match.index ?? -1;
    if (start < 0) continue;

    const preceding = start > 0 ? text[start - 1] : undefined;
    if (!isAllowedTaskRefBoundary(preceding) || isEscapedMarkdownPosition(text, start)) continue;

    const metadataMatch = extractEncodedTaskMetadata(text, start + raw.length);
    occurrences.push({
      start,
      end: metadataMatch?.end ?? start + raw.length,
      raw,
      ref,
      encodedMetadata: metadataMatch?.metadata ?? null,
    });
  }
  return occurrences;
}

export function linkifyTaskIdsInMarkdown(text: string, taskRefs?: TaskRef[]): string {
  if (!text) return text;

  const orderedTaskRefs = taskRefs ?? [];
  let taskRefIndex = 0;

  const consumeStructuredTaskRef = (): TaskRef | undefined => {
    return orderedTaskRefs[taskRefIndex++];
  };

  const matchingStructuredTaskRef = (
    pairedTaskRef: TaskRef | undefined,
    ref: string
  ): TaskRef | undefined => {
    return pairedTaskRef?.displayId.toLowerCase() === ref.toLowerCase() ? pairedTaskRef : undefined;
  };

  const buildLink = (raw: string, ref: string, encodedTaskRef?: EncodedTaskMetadata): string => {
    const pairedTaskRef = consumeStructuredTaskRef();
    const structuredTaskRef = encodedTaskRef ?? matchingStructuredTaskRef(pairedTaskRef, ref);
    const href = structuredTaskRef ? buildTaskLinkHref(structuredTaskRef) : `task://${ref}`;
    return `[${raw}](${href})`;
  };

  const linkifyPlainText = (value: string): string => {
    let result = '';
    let cursor = 0;

    for (const occurrence of findTaskReferenceOccurrences(value)) {
      const { raw, ref, start, end, encodedMetadata } = occurrence;
      result += value.slice(cursor, start);
      result += buildLink(raw, ref, encodedMetadata ?? undefined);
      cursor = end;
    }

    result += value.slice(cursor);
    return result;
  };

  let result = '';
  let cursor = 0;

  while (cursor < text.length) {
    const char = text[cursor];

    if (char === '[') {
      const linkEnd = findMarkdownLinkEnd(text, cursor);
      if (linkEnd !== -1) {
        const closeBracket = text.indexOf(']', cursor + 1);
        const label = text.slice(cursor + 1, closeBracket);
        const labelOccurrences = findTaskReferenceOccurrences(label).map((occurrence) => {
          const pairedTaskRef = consumeStructuredTaskRef();
          return {
            ...occurrence,
            pairedTaskRef: matchingStructuredTaskRef(pairedTaskRef, occurrence.ref),
          };
        });
        const hrefStart = closeBracket + 2;
        const href = text.slice(hrefStart, linkEnd - 1);
        const parsedHref = parseTaskLinkHref(href);
        const legacyTaskId =
          parsedHref && parsedHref.teamName === undefined && parsedHref.displayId === undefined
            ? parsedHref.taskId
            : undefined;
        const legacyLabelOccurrence = legacyTaskId
          ? labelOccurrences.find(
              (occurrence) =>
                occurrence.pairedTaskRef &&
                occurrence.ref.toLowerCase() === legacyTaskId.toLowerCase()
            )
          : undefined;
        if (legacyLabelOccurrence?.pairedTaskRef) {
          result += text.slice(cursor, hrefStart);
          result += buildTaskLinkHref(legacyLabelOccurrence.pairedTaskRef);
          result += text.slice(linkEnd - 1, linkEnd);
        } else {
          result += text.slice(cursor, linkEnd);
        }
        cursor = linkEnd;
        continue;
      }
    }

    if (char === '`') {
      const run = /^`+/.exec(text.slice(cursor))?.[0] ?? '`';

      if (
        run.length >= 3 &&
        (cursor === 0 || text[cursor - 1] === '\n') &&
        (text[cursor + run.length] === undefined || /\s/.test(text[cursor + run.length]))
      ) {
        const fenceEnd = findClosingFence(text, cursor, run);
        if (fenceEnd !== -1) {
          result += text.slice(cursor, fenceEnd);
          cursor = fenceEnd;
          continue;
        }
      }

      const codeEnd = findClosingBacktickRun(text, cursor, run.length);
      if (codeEnd !== -1) {
        const code = text.slice(cursor + run.length, codeEnd);
        const codeMatch = EXACT_TASK_REF_REGEX.exec(code.trim());
        if (codeMatch) {
          result += buildLink(code.trim(), codeMatch[1]);
        } else {
          result += text.slice(cursor, codeEnd + run.length);
        }
        cursor = codeEnd + run.length;
        continue;
      }
    }

    let nextSpecial = text.length;
    const nextLink = text.indexOf('[', cursor + 1);
    const nextCode = text.indexOf('`', cursor + 1);
    if (nextLink !== -1) nextSpecial = Math.min(nextSpecial, nextLink);
    if (nextCode !== -1) nextSpecial = Math.min(nextSpecial, nextCode);

    result += linkifyPlainText(text.slice(cursor, nextSpecial));
    cursor = nextSpecial;
  }

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
  for (const occurrence of findTaskReferenceOccurrences(text)) {
    const suggestion = occurrence.encodedMetadata
      ? buildTaskSuggestionFromMetadata(occurrence.encodedMetadata, taskSuggestions)
      : resolveTaskSuggestion(suggestionsByRef.get(occurrence.ref.toLowerCase()) ?? []);
    if (!suggestion) continue;

    matches.push({
      start: occurrence.start,
      end: occurrence.end,
      raw: occurrence.raw,
      ref: occurrence.ref,
      suggestion,
      encoded: occurrence.encodedMetadata != null,
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
