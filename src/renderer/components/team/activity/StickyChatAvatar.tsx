import { useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { agentAvatarUrl, buildMemberAvatarMap } from '@renderer/utils/memberHelpers';

import type { TimelineRow } from './timelineRows';
import type { ResolvedTeamMember } from '@shared/types';

interface StickyAvatarPlacement {
  author: string;
  src: string;
  left: number;
  top: number;
}

interface StickyChatAvatarProps {
  enabled: boolean;
  rows: readonly TimelineRow[];
  continuesPreviousAvatarAuthor: readonly boolean[];
  scrollElement: HTMLElement | null;
  timelineRoot: React.RefObject<HTMLDivElement | null>;
  members?: readonly ResolvedTeamMember[];
}

/** One viewport-pinned copy while the avatar on the run's final row is still below the composer. */
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
        hideNative(
          avatarRect.top < visibleBottom && avatarRect.bottom > visibleBottom ? finalAvatar : null
        );
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
      setPlacement((previous) =>
        previous?.author === next.author &&
        previous.src === next.src &&
        Math.abs(previous.left - next.left) < 0.5 &&
        Math.abs(previous.top - next.top) < 0.5
          ? previous
          : next
      );
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    schedule();
    scrollElement.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(root);
    resizeObserver.observe(scrollElement);
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
