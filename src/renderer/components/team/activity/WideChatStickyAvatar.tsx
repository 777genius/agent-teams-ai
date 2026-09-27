import { useEffect, useMemo, useState } from 'react';

import { agentAvatarUrl, buildMemberAvatarMap } from '@renderer/utils/memberHelpers';

import { classifyActivityMessagePresentation } from './activityMessagePresentation';
import { isDirectParticipantSender } from './activityRecipientRoute';

import type { TimelineRow } from './timelineRows';
import type { ResolvedTeamMember } from '@shared/types';
import type { RefObject } from 'react';

interface WideChatStickyAvatarProps {
  rows: readonly TimelineRow[];
  continuesPreviousAuthor: readonly boolean[];
  teamName: string;
  members?: readonly ResolvedTeamMember[];
  localMemberNames?: Set<string>;
  directParticipant?: string;
  scrollElement: HTMLElement | null;
  rootRef: RefObject<HTMLDivElement | null>;
}

interface StickyAvatar {
  name: string;
  src: string;
}

export const WideChatStickyAvatar = ({
  rows,
  continuesPreviousAuthor,
  teamName,
  members,
  localMemberNames,
  directParticipant,
  scrollElement,
  rootRef,
}: WideChatStickyAvatarProps): React.JSX.Element | null => {
  const [avatar, setAvatar] = useState<StickyAvatar | null>(null);
  const avatarMap = useMemo(() => buildMemberAvatarMap(members ?? []), [members]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !scrollElement) return;
    let frame: number | null = null;
    const update = (): void => {
      frame = null;
      const top = scrollElement.getBoundingClientRect().top;
      let next: StickyAvatar | null = null;
      for (const element of root.querySelectorAll<HTMLElement>(
        '[data-timeline-row-key][data-index]'
      )) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= top) continue;
        const index = Number(element.dataset.index);
        const row = rows[index];
        if (row?.kind === 'message-row') {
          const presentation = classifyActivityMessagePresentation(
            row.message,
            teamName,
            localMemberNames
          );
          if (
            presentation.kind === 'ordinary-agent' &&
            !isDirectParticipantSender(presentation.author, directParticipant)
          ) {
            let first = index;
            while (first > 0 && continuesPreviousAuthor[first]) first -= 1;
            const inlineAvatar = element.querySelector<HTMLImageElement>(
              ".wide-chat-message-header [data-chat-sender='true'] img"
            );
            const inlineAvatarVisible =
              first === index && inlineAvatar && inlineAvatar.getBoundingClientRect().bottom > top;
            let nextGroup = index + 1;
            while (nextGroup < rows.length && continuesPreviousAuthor[nextGroup]) nextGroup += 1;
            const nextGroupElement = root.querySelector<HTMLElement>(
              `[data-timeline-row-key][data-index="${nextGroup}"]`
            );
            const nextGroupAvatarEntering =
              nextGroupElement && nextGroupElement.getBoundingClientRect().top <= top + 32;
            if (
              (first !== index || rect.top < top) &&
              !inlineAvatarVisible &&
              !nextGroupAvatarEntering
            ) {
              const name = presentation.author;
              next = { name, src: avatarMap.get(name) ?? agentAvatarUrl(name, 32) };
            }
          }
        }
        break;
      }
      setAvatar((previous) =>
        previous?.name === next?.name && previous?.src === next?.src ? previous : next
      );
    };
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    schedule();
    scrollElement.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scrollElement.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [
    avatarMap,
    continuesPreviousAuthor,
    directParticipant,
    localMemberNames,
    rootRef,
    rows,
    scrollElement,
    teamName,
  ]);

  return avatar ? (
    <div
      className="pointer-events-none sticky top-0 z-20 -mb-8 size-8 shrink-0 self-start"
      aria-hidden
    >
      <img
        src={avatar.src}
        alt=""
        className="size-8 rounded-full bg-[var(--color-surface-raised)] shadow-[0_2px_8px_rgb(0_0_0_/_18%)]"
      />
    </div>
  ) : null;
};
