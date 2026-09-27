import { useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { agentAvatarUrl, buildMemberAvatarMap } from '@renderer/utils/memberHelpers';

import { collectScrollMarginObserverTargets } from './wideChatTimelinePresentation';

import type { TimelineRow } from './timelineRows';
import type { ResolvedTeamMember } from '@shared/types';

interface StickyAvatarPlacement {
  author: string;
  src: string;
  left: number;
  top: number;
}

function samePlacement(
  previous: StickyAvatarPlacement | null,
  next: StickyAvatarPlacement
): boolean {
  return (
    previous?.author === next.author &&
    previous.src === next.src &&
    Math.abs(previous.left - next.left) < 0.5 &&
    Math.abs(previous.top - next.top) < 0.5
  );
}

interface StickyChatAvatarProps {
  enabled: boolean;
  rows: readonly TimelineRow[];
  continuesPreviousAvatarAuthor: readonly boolean[];
  scrollElement: HTMLElement | null;
  timelineRoot: React.RefObject<HTMLDivElement | null>;
  members?: readonly ResolvedTeamMember[];
}

/** One viewport-pinned copy for a sender group at either visible edge. */
export const StickyChatAvatar = ({
  enabled,
  rows,
  continuesPreviousAvatarAuthor,
  scrollElement,
  timelineRoot,
  members,
}: StickyChatAvatarProps): React.JSX.Element | null => {
  const [placement, setPlacement] = useState<StickyAvatarPlacement | null>(null);
  const avatarMap = useMemo(() => buildMemberAvatarMap(members ?? []), [members]);

  useLayoutEffect(() => {
    const root = timelineRoot.current;
    if (!enabled || !root || !scrollElement) {
      setPlacement(null);
      return;
    }

    let frame = 0;
    let hiddenNative: HTMLElement | null = null;
    const revealNative = (): void => {
      hiddenNative?.removeAttribute('data-sticky-native-hidden');
      hiddenNative = null;
    };
    const hideNative = (avatar: HTMLElement | null): void => {
      if (hiddenNative === avatar) return;
      revealNative();
      if (avatar) {
        avatar.setAttribute('data-sticky-native-hidden', 'true');
        hiddenNative = avatar;
      }
    };
    const measure = (): void => {
      frame = 0;
      const scrollRect = scrollElement.getBoundingClientRect();
      const footer = scrollElement
        .closest('[data-messages-thread-layout]')
        ?.querySelector<HTMLElement>('[data-messages-thread-footer]');
      const footerTop = footer?.getBoundingClientRect().top ?? scrollRect.bottom;
      const visibleBottom = Math.min(scrollRect.bottom, footerTop) - 8;
      const rowElements = root.querySelectorAll<HTMLElement>('[data-timeline-row-index]');
      const topRow = [...rowElements].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > scrollRect.top && rect.top < visibleBottom;
      });
      const topIndex = Number(topRow?.dataset.timelineRowIndex);
      const topArticle = topRow?.querySelector<HTMLElement>(
        '.wide-chat-message[data-wide-agent="true"]:not([data-hide-direct-avatar="true"])'
      );
      const topRowData = rows[topIndex];
      if (topArticle && topRowData?.kind === 'message-row') {
        const topRect = topRow!.getBoundingClientRect();
        let firstIndex = topIndex;
        while (firstIndex > 0 && continuesPreviousAvatarAuthor[firstIndex]) firstIndex -= 1;
        let endIndex = topIndex;
        while (continuesPreviousAvatarAuthor[endIndex + 1]) endIndex += 1;
        const finalAvatar = topRow?.querySelector<HTMLElement>(
          '.wide-chat-message[data-wide-agent="true"] [data-chat-sender="true"] img'
        );
        const avatarRect = finalAvatar?.getBoundingClientRect();
        const nativeAvatarVisible =
          endIndex === topIndex &&
          avatarRect !== undefined &&
          avatarRect.top >= scrollRect.top &&
          avatarRect.bottom <= visibleBottom;
        const nextRow = root.querySelector<HTMLElement>(
          `[data-timeline-row-index="${endIndex + 1}"]`
        );
        const nextAvatarEntering =
          nextRow !== null && nextRow.getBoundingClientRect().top <= scrollRect.top + 32;
        if (
          (firstIndex !== topIndex || topRect.top < scrollRect.top) &&
          !nativeAvatarVisible &&
          !nextAvatarEntering
        ) {
          revealNative();
          const author = topRowData.message.from;
          const next: StickyAvatarPlacement = {
            author,
            src: avatarMap.get(author) ?? agentAvatarUrl(author),
            left: topArticle.getBoundingClientRect().left,
            top: scrollRect.top,
          };
          setPlacement((previous) => (samePlacement(previous, next) ? previous : next));
          return;
        }
      }
      let candidate: HTMLElement | null = null;
      let candidateIndex = -1;
      let candidateTop = -Infinity;

      for (const element of rowElements) {
        const rect = element.getBoundingClientRect();
        if (
          rect.top + 32 > visibleBottom ||
          rect.bottom <= scrollRect.top ||
          rect.top < candidateTop
        ) {
          continue;
        }
        const index = Number(element.dataset.timelineRowIndex);
        if (!Number.isInteger(index)) continue;
        candidate = element;
        candidateIndex = index;
        candidateTop = rect.top;
      }

      const row = rows[candidateIndex];
      const article = candidate?.querySelector<HTMLElement>(
        '.wide-chat-message[data-wide-agent="true"]:not([data-hide-direct-avatar="true"])'
      );
      if (!article || row?.kind !== 'message-row') {
        revealNative();
        setPlacement(null);
        return;
      }

      const articleRect = article.getBoundingClientRect();
      if (articleRect.top + 32 > visibleBottom) {
        revealNative();
        setPlacement(null);
        return;
      }

      let endIndex = candidateIndex;
      while (continuesPreviousAvatarAuthor[endIndex + 1]) endIndex += 1;
      const endRow = root.querySelector<HTMLElement>(`[data-timeline-row-index="${endIndex}"]`);
      const finalAvatar = endRow?.querySelector<HTMLElement>(
        '.wide-chat-message[data-wide-agent="true"] [data-chat-sender="true"] img'
      );
      if (finalAvatar) {
        const avatarRect = finalAvatar.getBoundingClientRect();
        if (avatarRect.bottom <= visibleBottom && avatarRect.top >= scrollRect.top) {
          revealNative();
          setPlacement(null);
          return;
        }
        hideNative(finalAvatar);
      } else {
        revealNative();
      }

      const author = row.message.from;
      const next: StickyAvatarPlacement = {
        author,
        src: avatarMap.get(author) ?? agentAvatarUrl(author),
        left: articleRect.left,
        top: visibleBottom - 32,
      };
      setPlacement((previous) => (samePlacement(previous, next) ? previous : next));
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    schedule();
    scrollElement.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const resizeObserver = new ResizeObserver(schedule);
    collectScrollMarginObserverTargets(root, scrollElement).forEach((target) =>
      resizeObserver.observe(target)
    );
    const footer = scrollElement
      .closest('[data-messages-thread-layout]')
      ?.querySelector<HTMLElement>('[data-messages-thread-footer]');
    if (footer) resizeObserver.observe(footer);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollElement.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      resizeObserver.disconnect();
      revealNative();
    };
  }, [avatarMap, continuesPreviousAvatarAuthor, enabled, rows, scrollElement, timelineRoot]);

  if (!placement) return null;
  return createPortal(
    <img
      data-sticky-chat-avatar={placement.author}
      src={placement.src}
      alt=""
      aria-hidden="true"
      className="pointer-events-none fixed z-30 size-8 rounded-full bg-[var(--color-surface-raised)] shadow-sm"
      style={{ left: placement.left, top: placement.top }}
    />,
    document.body
  );
};
