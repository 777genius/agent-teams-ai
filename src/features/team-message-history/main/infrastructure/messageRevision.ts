import { createHash } from 'node:crypto';

import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';

import {
  canonicalSemanticValue,
  messageSemanticEntry,
  orderedSourceSemantics,
  sourceSemanticEntry,
} from '../../core/domain/messageSemantics';

import type { HistoryFailureReason } from '../../contracts';
import type { SourceSemanticEntry } from '../../core/domain/messageSemantics';
import type { InboxMessage } from '@shared/types';

export class TeamHistoryError extends Error {
  constructor(public readonly reason: HistoryFailureReason) {
    // This bounded text survives the existing worker Error rehydration boundary.
    super(`TEAM_HISTORY_UNAVAILABLE:${reason}`);
    this.name = 'TeamHistoryError';
  }
}

export function sourceEntriesRevision(entries: readonly SourceSemanticEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of orderedSourceSemantics(entries)) hash.update(entry).update('\n');
  return hash.digest('hex').slice(0, 24);
}

export function toFeedRevision(messages: readonly InboxMessage[]): string {
  const hash = createHash('sha256');
  for (const message of messages) hash.update(messageSemanticEntry(message)).update('\n');
  return hash.digest('hex').slice(0, 24);
}

export function toSourceRevision(
  sources: Record<string, readonly InboxMessage[]>,
  precomputed: Record<string, string> = {},
  normalizationContext: unknown = null
): string {
  const hash = createHash('sha256').update(canonicalSemanticValue(normalizationContext));
  const names = [...new Set([...Object.keys(sources), ...Object.keys(precomputed)])].sort();
  for (const name of names) {
    const revision =
      precomputed[name] ??
      sourceEntriesRevision(
        (sources[name] ?? [])
          .filter((message) => !isTeamInternalControlMessageEnvelope(message))
          .map(sourceSemanticEntry)
      );
    hash.update(canonicalSemanticValue([name, revision]));
  }
  return hash.digest('hex').slice(0, 24);
}
