import { toMessageKey } from './teamMessageKey';

import type { InboxMessage } from '@shared/types';

const MAX_LEAD_FRAGMENT_GAP_MS = 2_000;
const MAX_LEAD_FRAGMENT_AVG_LENGTH = 14;
const MIN_LEAD_FRAGMENT_RUN_LENGTH = 3;

function compareMessages(a: InboxMessage, b: InboxMessage): number {
  const diff = Date.parse(b.timestamp) - Date.parse(a.timestamp);
  if (diff !== 0) return diff;
  return toMessageKey(a).localeCompare(toMessageKey(b));
}

function isLeadThoughtFragmentCandidate(message: InboxMessage): boolean {
  if (typeof message.to === 'string' && message.to.trim().length > 0) {
    return false;
  }
  if (message.messageKind || message.toolCalls?.length || message.toolSummary) {
    return false;
  }
  return message.source === 'lead_process' || message.source === 'lead_session';
}

function canJoinLeadThoughtFragments(older: InboxMessage, newer: InboxMessage): boolean {
  if (!isLeadThoughtFragmentCandidate(older) || !isLeadThoughtFragmentCandidate(newer)) {
    return false;
  }
  if (older.from !== newer.from) {
    return false;
  }
  if ((older.leadSessionId ?? null) !== (newer.leadSessionId ?? null)) {
    return false;
  }
  if (older.source !== newer.source) {
    return false;
  }

  const olderMs = Date.parse(older.timestamp);
  const newerMs = Date.parse(newer.timestamp);
  if (!Number.isFinite(olderMs) || !Number.isFinite(newerMs)) {
    return false;
  }

  return newerMs >= olderMs && newerMs - olderMs <= MAX_LEAD_FRAGMENT_GAP_MS;
}

function shouldCoalesceLeadThoughtRun(runNewestFirst: InboxMessage[]): boolean {
  if (runNewestFirst.length < MIN_LEAD_FRAGMENT_RUN_LENGTH) {
    return false;
  }

  const totalTrimmedLength = runNewestFirst.reduce(
    (total, message) => total + message.text.trim().length,
    0
  );
  return totalTrimmedLength / runNewestFirst.length <= MAX_LEAD_FRAGMENT_AVG_LENGTH;
}

function coalesceLeadThoughtRun(runNewestFirst: InboxMessage[]): InboxMessage[] {
  if (!shouldCoalesceLeadThoughtRun(runNewestFirst)) {
    return runNewestFirst;
  }

  const chronological = [...runNewestFirst].reverse();
  const combinedText = chronological
    .map((message) => message.text)
    .join('')
    .trim();
  if (!combinedText) {
    return runNewestFirst;
  }

  const newest = runNewestFirst[0];
  const oldest = chronological[0];
  return [
    {
      ...newest,
      text: combinedText,
      summary: combinedText.length > 60 ? `${combinedText.slice(0, 57)}...` : combinedText,
      messageId: `lead-thought-coalesced-${toMessageKey(oldest)}-${runNewestFirst.length}`,
    },
  ];
}

function coalesceLeadThoughtFragments(messagesNewestFirst: InboxMessage[]): InboxMessage[] {
  const result: InboxMessage[] = [];
  let run: InboxMessage[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    result.push(...coalesceLeadThoughtRun(run));
    run = [];
  };

  for (const message of messagesNewestFirst) {
    if (!isLeadThoughtFragmentCandidate(message)) {
      flushRun();
      result.push(message);
      continue;
    }

    const currentOldest = run[run.length - 1];
    if (!currentOldest || canJoinLeadThoughtFragments(message, currentOldest)) {
      run.push(message);
      continue;
    }

    flushRun();
    run.push(message);
  }

  flushRun();
  return result;
}

/**
 * Merge multiple message arrays into one newest-first list with stable deduplication.
 *
 * Later arrays win for duplicate keys so callers can overlay fresher/live message data
 * on top of paginated history without losing already-loaded older pages.
 */
export function mergeTeamMessages(...messageLists: readonly InboxMessage[][]): InboxMessage[] {
  const merged = new Map<string, InboxMessage>();

  for (const list of messageLists) {
    for (const message of list) {
      merged.set(toMessageKey(message), message);
    }
  }

  return coalesceLeadThoughtFragments(Array.from(merged.values()).sort(compareMessages));
}
