import { type RefObject, useLayoutEffect, useMemo, useRef } from 'react';

import { isUserUnreadMessage } from '@features/team-direct-chats/renderer';
import { toMessageKey } from '@renderer/utils/teamMessageKey';

import { findConversationFooter, getConversationVisibleBottom } from './conversationVisibleArea';

import type { TimelineRow } from './timelineRows';
import type { InboxMessage } from '@shared/types';

interface UnreadCandidate {
  rowKey: string;
  index: number;
}

function collectUnreadCandidates(
  rows: readonly TimelineRow[],
  readSet: ReadonlySet<string>
): UnreadCandidate[] {
  const seen = new Set<string>();
  const candidates: UnreadCandidate[] = [];
  rows.forEach((row, index) => {
    const messages: readonly InboxMessage[] =
      row.kind === 'message-row'
        ? [row.message]
        : row.kind === 'lead-thought-group'
          ? row.group.thoughts
          : [];
    for (const message of messages) {
      const key = toMessageKey(message);
      if (!seen.has(key) && isUserUnreadMessage(message, readSet, toMessageKey)) {
        seen.add(key);
        candidates.push({ rowKey: row.key, index });
      }
    }
  });
  return candidates;
}

function countCandidatesBelowViewport(
  candidates: readonly UnreadCandidate[],
  visibleBottom: number,
  rowBounds: (rowKey: string, index: number) => { top: number; bottom: number } | null
): number {
  let count = 0;
  for (const { rowKey, index } of candidates) {
    const bounds = rowBounds(rowKey, index);
    if (bounds && bounds.bottom > visibleBottom) count++;
  }
  return count;
}

export function countUnreadBelowViewport(
  rows: readonly TimelineRow[],
  readSet: ReadonlySet<string>,
  visibleBottom: number,
  rowBounds: (row: TimelineRow, index: number) => { top: number; bottom: number } | null
): number {
  return countCandidatesBelowViewport(
    collectUnreadCandidates(rows, readSet),
    visibleBottom,
    (_, index) => rowBounds(rows[index], index)
  );
}

const BELOW_VIEWPORT = { top: Infinity, bottom: Infinity };

export function resolveVirtualRowBounds(
  key: string,
  index: number,
  mountedBounds: ReadonlyMap<string, { top: number; bottom: number }>,
  lastMountedIndex: number,
  virtual: boolean
): { top: number; bottom: number } | null {
  return (
    mountedBounds.get(key) ??
    (virtual && lastMountedIndex >= 0 && index > lastMountedIndex ? BELOW_VIEWPORT : null)
  );
}

interface UnreadBelowViewportOptions {
  enabled: boolean;
  identity: string;
  rows: readonly TimelineRow[];
  readSet: ReadonlySet<string>;
  scroll: HTMLElement | null;
  contentRef: RefObject<HTMLDivElement | null>;
  virtual: boolean;
  onChange?: (count: number) => void;
}

export function useUnreadBelowViewport({
  enabled,
  identity,
  rows,
  readSet,
  scroll,
  contentRef,
  virtual,
  onChange,
}: UnreadBelowViewportOptions): void {
  const lastPublished = useRef<{ identity: string; count: number } | null>(null);
  const unreadCandidates = useMemo(() => collectUnreadCandidates(rows, readSet), [rows, readSet]);
  const rowIndexByKey = useMemo(
    () => new Map(rows.map((row, index) => [row.key, index])),
    [rows]
  );

  useLayoutEffect(() => {
    if (!onChange) return;
    const publish = (count: number): void => {
      if (lastPublished.current?.identity === identity && lastPublished.current.count === count) {
        return;
      }
      lastPublished.current = { identity, count };
      onChange(count);
    };
    const content = contentRef.current;
    if (!enabled || !scroll || !content) {
      publish(0);
      return;
    }

    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      const mountedBounds = new Map<string, { top: number; bottom: number }>();
      let lastMountedIndex = -1;
      for (const node of content.querySelectorAll<HTMLElement>('[data-timeline-row-key]')) {
        const key = node.dataset.timelineRowKey;
        if (key) {
          const { top, bottom } = node.getBoundingClientRect();
          mountedBounds.set(key, { top, bottom });
          lastMountedIndex = Math.max(lastMountedIndex, rowIndexByKey.get(key) ?? -1);
        }
      }
      publish(
        countCandidatesBelowViewport(
          unreadCandidates,
          getConversationVisibleBottom(scroll),
          (rowKey, index) =>
            resolveVirtualRowBounds(rowKey, index, mountedBounds, lastMountedIndex, virtual)
        )
      );
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(measure);
    };
    measure();
    scroll.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(scroll);
    resizeObserver?.observe(content);
    const footer = findConversationFooter(scroll);
    if (footer) resizeObserver?.observe(footer);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scroll.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      resizeObserver?.disconnect();
    };
  }, [contentRef, enabled, identity, onChange, rowIndexByKey, scroll, unreadCandidates, virtual]);
}
