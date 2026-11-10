import { type RefObject, useLayoutEffect, useRef } from 'react';

import {
  findConversationFooter,
  getConversationVisibleBottom,
} from './conversationVisibleArea';

const BASE_VISIBILITY_RATIO = 0.15;
const HEIGHT_ROUNDING_TOLERANCE_PX = 0.5;

export interface MessageReadVisibilityGeometry {
  rowHeight: number;
  outerViewportHeight: number;
  innerClipHeight?: number;
}

export interface MessageReadVisibilityRequirement {
  availableHeight: number;
  requiredHeight: number;
  requiredRatio: number;
}

export function getMessageReadVisibilityRequirement({
  rowHeight,
  outerViewportHeight,
  innerClipHeight,
}: MessageReadVisibilityGeometry): MessageReadVisibilityRequirement | null {
  if (rowHeight <= 0 || outerViewportHeight <= 0) return null;

  const availableHeight =
    innerClipHeight === undefined
      ? outerViewportHeight
      : Math.min(outerViewportHeight, innerClipHeight);
  if (availableHeight <= 0) return null;

  const requiredHeight = BASE_VISIBILITY_RATIO * Math.min(rowHeight, availableHeight);
  return {
    availableHeight,
    requiredHeight,
    requiredRatio: requiredHeight / rowHeight,
  };
}

export function isMessageReadIntersection(
  entry: Pick<IntersectionObserverEntry, 'isIntersecting' | 'intersectionRect'>,
  requirement: MessageReadVisibilityRequirement | null
): boolean {
  if (!requirement || !entry.isIntersecting) return false;
  return (
    entry.intersectionRect.width > 0 &&
    entry.intersectionRect.height + HEIGHT_ROUNDING_TOLERANCE_PX >= requirement.requiredHeight
  );
}

interface UseMessageReadVisibilityOptions {
  targetRef: RefObject<HTMLElement | null>;
  observerRoot?: RefObject<HTMLElement | null>;
  innerClipRef?: RefObject<HTMLElement | null>;
  observationEnabled: boolean;
  visibilityKey: string;
  onVisible?: () => void;
}

function getElementHeight(element: HTMLElement): number {
  const rectHeight = element.getBoundingClientRect().height;
  return rectHeight > 0 ? rectHeight : element.clientHeight;
}

function getDocumentViewportHeight(): number {
  return document.documentElement.clientHeight || window.innerHeight;
}

function measureVisibility(
  row: HTMLElement,
  root: HTMLElement | null,
  innerClip: HTMLElement | null
): MessageReadVisibilityRequirement | null {
  return getMessageReadVisibilityRequirement({
    rowHeight: getElementHeight(row),
    outerViewportHeight: root
      ? getConversationVisibleBottom(root) - root.getBoundingClientRect().top
      : getDocumentViewportHeight(),
    innerClipHeight: innerClip ? getElementHeight(innerClip) : undefined,
  });
}

function hasUncoveredReadArea(
  row: HTMLElement,
  root: HTMLElement | null,
  innerClip: HTMLElement | null,
  requirement: MessageReadVisibilityRequirement | null
): boolean {
  if (!requirement) return false;
  const rowRect = row.getBoundingClientRect();
  const rootRect = root?.getBoundingClientRect() ?? {
    top: 0,
    bottom: getDocumentViewportHeight(),
    left: 0,
    right: document.documentElement.clientWidth || window.innerWidth,
  };
  const innerRect = innerClip?.getBoundingClientRect();
  const visibleTop = Math.max(rowRect.top, rootRect.top, innerRect?.top ?? rootRect.top);
  const visibleBottom = Math.min(
    rowRect.bottom,
    root ? getConversationVisibleBottom(root) : rootRect.bottom,
    innerRect?.bottom ?? rootRect.bottom
  );
  const visibleLeft = Math.max(rowRect.left, rootRect.left, innerRect?.left ?? rootRect.left);
  const visibleRight = Math.min(rowRect.right, rootRect.right, innerRect?.right ?? rootRect.right);
  return (
    visibleRight > visibleLeft &&
    visibleBottom - visibleTop + HEIGHT_ROUNDING_TOLERANCE_PX >= requirement.requiredHeight
  );
}

function requirementSignature(requirement: MessageReadVisibilityRequirement | null): string {
  if (!requirement) return 'unmeasured';
  return [
    requirement.availableHeight.toFixed(3),
    requirement.requiredHeight.toFixed(3),
    requirement.requiredRatio.toFixed(6),
  ].join(':');
}

/**
 * Reports one concrete message/thought row after enough of that row is visible.
 * The IntersectionObserver always uses the outer conversation viewport. An
 * optional inner clip only adjusts the requirement; browser ancestor clipping
 * still decides the actual intersection.
 */
export function useMessageReadVisibility({
  targetRef,
  observerRoot,
  innerClipRef,
  observationEnabled,
  visibilityKey,
  onVisible,
}: UseMessageReadVisibilityOptions): void {
  const reportState = useRef({ key: visibilityKey, reported: false });

  useLayoutEffect(() => {
    if (reportState.current.key !== visibilityKey) {
      reportState.current = { key: visibilityKey, reported: false };
    }
  }, [visibilityKey]);

  useLayoutEffect(() => {
    const row = targetRef.current;
    if (!row || !onVisible || !observationEnabled) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const root = observerRoot?.current ?? null;
    const innerClip = innerClipRef?.current ?? null;
    let active = true;
    let generation = 0;
    let observer: IntersectionObserver | null = null;
    let measuredSignature = '';
    let listeningForUncover = false;

    const disconnectIntersectionObserver = (): void => {
      generation += 1;
      observer?.disconnect();
      observer = null;
    };

    const connectIntersectionObserver = (): void => {
      disconnectIntersectionObserver();
      if (
        !active ||
        reportState.current.reported ||
        !row.isConnected ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }

      const requirement = measureVisibility(row, root, innerClip);
      measuredSignature = requirementSignature(requirement);
      const observerGeneration = generation;
      const nextObserver = new IntersectionObserver(
        (entries, callbackObserver) => {
          if (
            !active ||
            observerGeneration !== generation ||
            callbackObserver !== observer ||
            reportState.current.reported ||
            !row.isConnected ||
            document.visibilityState === 'hidden'
          ) {
            return;
          }

          const entry = entries.find((candidate) => candidate.target === row) ?? entries[0];
          const currentRequirement = measureVisibility(row, root, innerClip);
          if (!entry || !isMessageReadIntersection(entry, currentRequirement)) return;
          if (!hasUncoveredReadArea(row, root, innerClip, currentRequirement)) {
            listenForUncover();
            return;
          }

          reportState.current.reported = true;
          disconnectIntersectionObserver();
          stopListeningForUncover();
          onVisible();
        },
        {
          root,
          rootMargin: '0px',
          threshold: [0, requirement?.requiredRatio ?? BASE_VISIBILITY_RATIO],
        }
      );
      observer = nextObserver;
      nextObserver.observe(row);
    };

    const handleResize = (): void => {
      const nextSignature = requirementSignature(measureVisibility(row, root, innerClip));
      if (nextSignature !== measuredSignature) connectIntersectionObserver();
      if (
        root &&
        findConversationFooter(root) &&
        active &&
        !reportState.current.reported &&
        row.isConnected &&
        document.visibilityState !== 'hidden' &&
        hasUncoveredReadArea(row, root, innerClip, measureVisibility(row, root, innerClip))
      ) {
        reportState.current.reported = true;
        disconnectIntersectionObserver();
        stopListeningForUncover();
        onVisible();
      }
    };

    const handleScroll = (): void => {
      if (
        !active ||
        reportState.current.reported ||
        !row.isConnected ||
        document.visibilityState === 'hidden' ||
        !hasUncoveredReadArea(row, root, innerClip, measureVisibility(row, root, innerClip))
      ) return;
      reportState.current.reported = true;
      disconnectIntersectionObserver();
      stopListeningForUncover();
      onVisible();
    };

    const listenForUncover = (): void => {
      if (!root || !findConversationFooter(root) || listeningForUncover) return;
      root.addEventListener('scroll', handleScroll, { passive: true });
      listeningForUncover = true;
    };

    const stopListeningForUncover = (): void => {
      if (!listeningForUncover) return;
      root?.removeEventListener('scroll', handleScroll);
      listeningForUncover = false;
    };

    const handleDocumentVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        disconnectIntersectionObserver();
      } else {
        connectIntersectionObserver();
      }
    };

    connectIntersectionObserver();
    document.addEventListener('visibilitychange', handleDocumentVisibilityChange);

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleResize);
    if (resizeObserver) {
      const resizeTargets = new Set<HTMLElement>([
        row,
        root ?? document.documentElement,
        ...(innerClip ? [innerClip] : []),
        ...(root ? [findConversationFooter(root)].filter((node): node is HTMLElement => !!node) : []),
      ]);
      for (const target of resizeTargets) resizeObserver.observe(target);
    }

    return () => {
      active = false;
      disconnectIntersectionObserver();
      resizeObserver?.disconnect();
      document.removeEventListener('visibilitychange', handleDocumentVisibilityChange);
      stopListeningForUncover();
    };
  }, [innerClipRef, observationEnabled, observerRoot, onVisible, targetRef, visibilityKey]);
}
