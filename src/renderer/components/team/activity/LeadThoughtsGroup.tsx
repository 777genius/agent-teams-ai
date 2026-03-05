import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import {
  CARD_BG,
  CARD_BORDER_STYLE,
  CARD_ICON_MUTED,
  CARD_TEXT_LIGHT,
} from '@renderer/constants/cssVariables';
import { getTeamColorSet } from '@renderer/constants/teamColors';

import type { InboxMessage } from '@shared/types';

export interface LeadThoughtGroup {
  type: 'lead-thoughts';
  thoughts: InboxMessage[];
}

/**
 * Check if a message is an intermediate lead "thought" (assistant text) rather than
 * an official message (SendMessage, direct reply, inbox, etc.).
 */
export function isLeadThought(msg: InboxMessage): boolean {
  if (msg.source === 'lead_session') return true;
  if (msg.source === 'lead_process' && msg.messageId?.startsWith('lead-text-')) return true;
  return false;
}

export type TimelineItem =
  | { type: 'message'; message: InboxMessage; originalIndex: number }
  | { type: 'lead-thoughts'; group: LeadThoughtGroup; originalIndices: number[] };

/**
 * Group consecutive lead thoughts into collapsible blocks.
 * Single thoughts remain as regular messages.
 */
export function groupTimelineItems(messages: InboxMessage[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  let pendingThoughts: InboxMessage[] = [];
  let pendingIndices: number[] = [];

  const flushThoughts = (): void => {
    if (pendingThoughts.length === 0) return;
    if (pendingThoughts.length === 1) {
      result.push({
        type: 'message',
        message: pendingThoughts[0],
        originalIndex: pendingIndices[0],
      });
    } else {
      result.push({
        type: 'lead-thoughts',
        group: { type: 'lead-thoughts', thoughts: pendingThoughts },
        originalIndices: pendingIndices,
      });
    }
    pendingThoughts = [];
    pendingIndices = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isLeadThought(msg)) {
      pendingThoughts.push(msg);
      pendingIndices.push(i);
    } else {
      flushThoughts();
      result.push({ type: 'message', message: msg, originalIndex: i });
    }
  }
  flushThoughts();
  return result;
}

const VIEWPORT_THRESHOLD = 0.15;
const LIVE_WINDOW_MS = 10_000;
const AUTO_SCROLL_THRESHOLD = 30;

interface LeadThoughtsGroupRowProps {
  group: LeadThoughtGroup;
  memberColor?: string;
  isNew?: boolean;
  onVisible?: (message: InboxMessage) => void;
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimeWithSec(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isRecentTimestamp(timestamp: string): boolean {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= LIVE_WINDOW_MS;
}

export const LeadThoughtsGroupRow = ({
  group,
  memberColor,
  isNew,
  onVisible,
}: LeadThoughtsGroupRowProps): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);

  const colors = getTeamColorSet(memberColor ?? '');
  const { thoughts } = group;
  // thoughts is newest-first; first=newest, last=oldest
  const newest = thoughts[0];
  const oldest = thoughts[thoughts.length - 1];
  const leadName = newest.from;

  // Chronological order for rendering (oldest at top, newest at bottom)
  const chronologicalThoughts = useMemo(() => [...thoughts].reverse(), [thoughts]);

  // Live indicator: newest thought is from lead_process and recent
  const computeIsLive = useCallback(
    () => newest.source === 'lead_process' && isRecentTimestamp(newest.timestamp),
    [newest.source, newest.timestamp]
  );
  const [isLive, setIsLive] = useState(computeIsLive);

  useEffect(() => {
    setIsLive(computeIsLive());
    const id = window.setInterval(() => setIsLive(computeIsLive()), 1000);
    return () => window.clearInterval(id);
  }, [computeIsLive]);

  // Track how many thoughts have been reported as visible so far.
  const reportedCountRef = useRef(0);

  useEffect(() => {
    if (!onVisible) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        const alreadyReported = reportedCountRef.current;
        if (alreadyReported >= thoughts.length) return;
        for (let i = alreadyReported; i < thoughts.length; i++) {
          onVisible(thoughts[i]);
        }
        reportedCountRef.current = thoughts.length;
      },
      { threshold: VIEWPORT_THRESHOLD, rootMargin: '0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible, thoughts]);

  // Auto-scroll to bottom when new thoughts arrive
  useEffect(() => {
    if (isUserScrolledUpRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [thoughts.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isUserScrolledUpRef.current = distanceFromBottom > AUTO_SCROLL_THRESHOLD;
  }, []);

  return (
    <div ref={ref} className={isNew ? 'message-enter-animate min-h-px' : 'min-h-px'}>
      <article
        className="group rounded-md [overflow:clip]"
        style={{
          backgroundColor: CARD_BG,
          border: CARD_BORDER_STYLE,
          borderLeft: `3px solid ${colors.border}`,
          opacity: isLive ? undefined : 0.75,
        }}
      >
        {/* Header */}
        <div className="flex select-none items-center gap-2 px-3 py-1.5">
          {/* Live / offline indicator */}
          {isLive ? (
            <span className="pointer-events-none relative inline-flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
            </span>
          ) : (
            <span className="inline-flex size-2 shrink-0 rounded-full bg-zinc-500" />
          )}
          <MemberBadge name={leadName} color={memberColor} hideAvatar />
          <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
            {thoughts.length} thoughts
          </span>
          <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
            {formatTime(oldest.timestamp)}–{formatTime(newest.timestamp)}
          </span>
        </div>

        {/* Scrollable body — fixed height, always visible */}
        <div
          ref={scrollRef}
          className="space-y-px border-t px-3 py-1.5"
          style={{
            borderColor: 'var(--color-border-subtle)',
            maxHeight: '200px',
            overflowY: 'auto',
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--scrollbar-thumb) transparent',
          }}
          onScroll={handleScroll}
        >
          {chronologicalThoughts.map((thought, idx) => (
            <div key={thought.messageId ?? idx} className="flex gap-2 py-0.5 text-[11px]">
              <span className="shrink-0 font-mono" style={{ color: CARD_ICON_MUTED }}>
                {formatTimeWithSec(thought.timestamp)}
              </span>
              <span className="flex-1 leading-relaxed" style={{ color: CARD_TEXT_LIGHT }}>
                {thought.text.length > 300 ? thought.text.slice(0, 297) + '...' : thought.text}
              </span>
            </div>
          ))}
        </div>
      </article>
    </div>
  );
};
