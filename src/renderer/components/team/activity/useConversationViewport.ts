import { type RefObject, useLayoutEffect, useRef, useState } from 'react';

import { toMessageKey } from '@renderer/utils/teamMessageKey';

import type { TimelineRow } from './timelineRows';
import type { Virtualizer } from '@tanstack/react-virtual';

export interface ConversationViewportHandle {
  prepareLayoutChange: () => void;
  revealLatest: () => void;
  prepareHistory: () => void;
}

interface Anchor {
  key: string;
  memberKey?: string;
  offset: number;
}
interface Snapshot {
  anchors: Anchor[];
  scrollTop: number;
}
interface Options {
  enabled: boolean;
  identity: string;
  active: boolean;
  rows: readonly TimelineRow[];
  scrollRef?: RefObject<HTMLElement | null>;
  scrollElement?: HTMLElement | null;
  contentRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLElement, Element>;
  virtual: boolean;
  handleRef?: RefObject<ConversationViewportHandle | null>;
  onLatestAvailable?: (available: boolean) => void;
}

const rowNodes = (element: HTMLElement): HTMLElement[] =>
  Array.from(element.querySelectorAll<HTMLElement>('[data-timeline-row-key]'));
const maximum = (element: HTMLElement): number =>
  Math.max(0, element.scrollHeight - element.clientHeight);
const rowMember = (row?: TimelineRow): string | undefined =>
  row?.kind === 'lead-thought-group' ? toMessageKey(row.group.thoughts[0]) : undefined;

/** Sole DOM scroll writer for conversation. No virtualizer scrollTo lifecycle. */
export function useConversationViewport(options: Options): {
  observationEnabled: boolean;
  initialPending: boolean;
} {
  const latest = useRef(options);
  const owner = useRef<{ reconcile: () => void } | null>(null);
  const [gate, setGate] = useState({ identity: options.identity, ready: false, initial: true });
  useLayoutEffect(() => {
    latest.current = options;
  });

  useLayoutEffect(() => {
    if (!options.enabled) return;
    const scroll = options.scrollElement ?? options.scrollRef?.current;
    const content = options.contentRef.current;
    if (!scroll || !content) return;
    let alive = true;
    let following = true;
    let initial = true;
    let hasPlacedRows = false;
    let repositioning = false;
    let snapshot: Snapshot = { anchors: [], scrollTop: 0 };
    let frame: number | null = null;
    let fallbackTimer: number | null = null;
    let correctionScheduled = false;
    let generation = 0;
    let expected: number | null = null;
    let remaining = 0;
    let virtualSeekRetries = 0;
    const previousAdjustment = options.virtualizer.shouldAdjustScrollPositionOnItemSizeChange;
    options.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    const previousOverflow = scroll.style.overflowAnchor;
    scroll.style.overflowAnchor = 'none';
    const measurable = (): boolean =>
      !document.hidden &&
      latest.current.active &&
      scroll.clientHeight > 0 &&
      scroll.getBoundingClientRect().width > 0;
    const publish = (ready: boolean): void => {
      if (!alive) return;
      ready = ready && !repositioning;
      setGate((prev) =>
        prev.identity === options.identity && prev.ready === ready && prev.initial === initial
          ? prev
          : { identity: options.identity, ready, initial }
      );
      latest.current.onLatestAvailable?.(
        measurable() && maximum(scroll) > 0 && maximum(scroll) - scroll.scrollTop > 32
      );
    };
    const capture = (): void => {
      const top = scroll.getBoundingClientRect().top;
      const rows = latest.current.rows;
      snapshot = {
        scrollTop: scroll.scrollTop,
        anchors: rowNodes(scroll)
          .filter(
            (node) =>
              node.getBoundingClientRect().bottom > top &&
              node.getBoundingClientRect().top < top + scroll.clientHeight
          )
          .slice(0, 2)
          .map((node) => ({
            key: node.dataset.timelineRowKey!,
            memberKey: rowMember(rows.find((row) => row.key === node.dataset.timelineRowKey)),
            offset: node.getBoundingClientRect().top - top,
          })),
      };
    };
    const stop = (): void => {
      generation++;
      correctionScheduled = false;
      if (frame !== null) cancelAnimationFrame(frame);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      frame = null;
      fallbackTimer = null;
      remaining = 0;
      virtualSeekRetries = 0;
      repositioning = false;
    };
    const scheduleCorrection = (callback: FrameRequestCallback): void => {
      correctionScheduled = true;
      frame = requestAnimationFrame(callback);
      // A visible but fully occluded Electron window can suspend rAF. Keep the
      // bounded three-pass placement moving without running work while hidden.
      fallbackTimer = window.setTimeout(() => callback(performance.now()), 100);
    };
    const write = (offset: number): void => {
      const target = Math.max(0, Math.min(offset, maximum(scroll)));
      if (Math.abs(scroll.scrollTop - target) < 0.5) return;
      expected = target;
      scroll.scrollTop = target;
    };
    const correct = (): void => {
      if (!measurable()) {
        stop();
        publish(false);
        return;
      }
      if (following) {
        write(maximum(scroll));
        return;
      }
      const rows = latest.current.rows;
      let found: { anchor: Anchor; index: number } | undefined;
      for (const anchor of snapshot.anchors) {
        const index = rows.findIndex(
          (row) =>
            row.key === anchor.key ||
            (anchor.memberKey &&
              row.kind === 'lead-thought-group' &&
              row.group.thoughts.some((message) => toMessageKey(message) === anchor.memberKey))
        );
        if (index >= 0) {
          found = { anchor, index };
          break;
        }
      }
      if (!found) {
        write(snapshot.scrollTop);
        return;
      }
      const { anchor, index } = found;
      const node = rowNodes(scroll).find(
        (candidate) => candidate.dataset.timelineRowKey === rows[index].key
      );
      if (node) {
        const rect = node.getBoundingClientRect();
        const offset = Math.max(anchor.offset, -Math.max(0, rect.height - 4));
        write(scroll.scrollTop + rect.top - scroll.getBoundingClientRect().top - offset);
      } else if (latest.current.virtual) {
        repositioning = true;
        publish(false);
        const target = latest.current.virtualizer.getOffsetForIndex(index, 'start');
        if (target) {
          write(target[0] - anchor.offset);
        }
      }
    };
    const reconcile = (): void => {
      if (!alive) return;
      if (!measurable()) {
        stop();
        if (document.hidden) initial = false;
        publish(false);
        return;
      }
      if (correctionScheduled) return;
      if (!hasPlacedRows && following && latest.current.rows.length > 0) {
        initial = true;
        publish(false);
      }
      const operation = generation;
      remaining = 3;
      correct();
      const tick = (): void => {
        if (!correctionScheduled) return;
        correctionScheduled = false;
        if (frame !== null) cancelAnimationFrame(frame);
        if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
        frame = null;
        fallbackTimer = null;
        if (!alive || generation !== operation) return;
        if (!measurable()) {
          stop();
          if (document.hidden) initial = false;
          publish(false);
          return;
        }
        correct();
        remaining--;
        if (remaining > 0) {
          scheduleCorrection(tick);
          return;
        }
        initial = false;
        hasPlacedRows ||= latest.current.rows.length > 0;
        if (repositioning && virtualSeekRetries < 2) {
          virtualSeekRetries++;
          repositioning = false;
          reconcile();
          return;
        }
        virtualSeekRetries = 0;
        repositioning = false;
        capture();
        publish(true);
      };
      scheduleCorrection(tick);
    };
    const read = (): void => {
      stop();
      expected = null;
      following = false;
      initial = false;
      hasPlacedRows = true;
      capture();
      publish(measurable());
    };
    const interruptCorrection = (): void => {
      stop();
      expected = null;
      capture();
    };
    const handle: ConversationViewportHandle = {
      prepareLayoutChange: () => {
        if (!alive) return;
        stop();
        capture();
        reconcile();
      },
      prepareHistory: () => {
        if (alive) read();
      },
      revealLatest: () => {
        if (!alive) return;
        stop();
        following = true;
        reconcile();
      },
    };
    if (options.handleRef) options.handleRef.current = handle;
    owner.current = { reconcile };
    const onScroll = (): void => {
      if (!measurable()) return;
      if (expected !== null && Math.abs(scroll.scrollTop - expected) <= 2) {
        expected = null;
        publish(!initial);
        return;
      }
      // A browser clamp after shrink can reach the end without user intent.
      // Resume reading -> following only on actual progress toward the end;
      // equality also covers a clamp event delivered after resize reconciliation.
      const resumesFollowing = following || scroll.scrollTop > snapshot.scrollTop + 0.5;
      read();
      following = resumesFollowing && maximum(scroll) - scroll.scrollTop <= 32;
    };
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0) return;
      let node = event.target instanceof HTMLElement ? event.target : null;
      while (node && node !== scroll) {
        if (
          node.scrollHeight > node.clientHeight &&
          node.scrollTop > 0 &&
          /auto|scroll/.test(getComputedStyle(node).overflowY)
        )
          return;
        node = node.parentElement;
      }
      read();
    };
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches('input,textarea') || target.isContentEditable)
      )
        return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) read();
    };
    const onPointer = (): void => {
      interruptCorrection();
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        stop();
        initial = false;
        publish(false);
        return;
      }
      reconcile();
    };
    scroll.addEventListener('scroll', onScroll);
    scroll.addEventListener('wheel', onWheel, { passive: true });
    scroll.addEventListener('pointerdown', onPointer);
    scroll.addEventListener('touchstart', onPointer, { passive: true });
    scroll.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibilityChange);
    let width = scroll.clientWidth;
    const resize = new ResizeObserver(() => {
      if (width !== scroll.clientWidth) {
        width = scroll.clientWidth;
        if (latest.current.virtual) latest.current.virtualizer.measure();
      }
      reconcile();
    });
    resize.observe(scroll);
    resize.observe(content);
    // Individual row height changes can leave the total virtual spacer unchanged.
    let observedRows = new Set<HTMLElement>();
    const observeRows = (): void => {
      const next = new Set(rowNodes(scroll));
      observedRows.forEach((node) => {
        if (!next.has(node)) resize.unobserve(node);
      });
      next.forEach((node) => {
        if (!observedRows.has(node)) resize.observe(node);
      });
      observedRows = next;
    };
    observeRows();
    owner.current = {
      reconcile: () => {
        observeRows();
        reconcile();
      },
    };
    reconcile();
    return () => {
      alive = false;
      stop();
      resize.disconnect();
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener('wheel', onWheel);
      scroll.removeEventListener('pointerdown', onPointer);
      scroll.removeEventListener('touchstart', onPointer);
      scroll.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      scroll.style.overflowAnchor = previousOverflow;
      options.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = previousAdjustment;
      if (options.handleRef?.current === handle) options.handleRef.current = null;
      owner.current = null;
    };
  }, [
    options.enabled,
    options.identity,
    options.scrollElement,
    options.scrollRef,
    options.contentRef,
    options.handleRef,
    options.virtualizer,
  ]);

  useLayoutEffect(() => {
    owner.current?.reconcile();
  }, [options.rows, options.active, options.virtual]);
  const matching = gate.identity === options.identity;
  return {
    observationEnabled: !options.enabled || (matching && gate.ready && options.active),
    initialPending: options.enabled && (!matching || gate.initial),
  };
}
