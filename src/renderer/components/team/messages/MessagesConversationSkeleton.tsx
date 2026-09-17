import { GroupChatAvatar } from '@features/team-direct-chats/renderer';
import { cn } from '@renderer/lib/utils';
import { ArrowLeft, MoreHorizontal, Paperclip } from 'lucide-react';

import type { ConversationScope, ConversationSurface } from '@features/team-direct-chats/renderer';
import type { JSX } from 'react';

const CHAT_LIST_MEMBER_ACCENTS = ['#46d93b', '#3b82f6', '#facc15', '#14b8a6'] as const;

type SkeletonClassNameProps = Readonly<{ className?: string }>;

const SkeletonPill = ({ className }: SkeletonClassNameProps): JSX.Element => (
  <div
    aria-hidden="true"
    className={cn('animate-pulse rounded-full bg-[var(--color-surface-raised)]', className)}
  />
);

const ChatListRowSkeleton = ({
  isTeamFeed,
  accent,
  nameWidth,
  previewWidth,
}: {
  isTeamFeed: boolean;
  accent?: string;
  nameWidth: string;
  previewWidth: string;
}): JSX.Element => (
  <div className="flex w-full items-start gap-2.5 overflow-visible rounded-md px-2 py-2">
    <span className="mt-0.5 shrink-0">
      {isTeamFeed ? (
        <GroupChatAvatar />
      ) : (
        <span className="relative inline-flex shrink-0">
          <span className="rounded-full border-2 p-px" style={{ borderColor: accent }}>
            <span className="block size-7 rounded-full bg-[var(--color-surface-raised)]" />
          </span>
          <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--color-surface)] bg-[var(--color-text-muted)]" />
        </span>
      )}
    </span>
    <span className="min-w-0 flex-1 overflow-hidden">
      <SkeletonPill className={cn('h-4', nameWidth)} />
      <span className="mt-0.5 flex min-w-0 items-center gap-1">
        {isTeamFeed ? null : (
          <span className="size-3.5 shrink-0 rounded-full bg-[var(--color-surface-raised)]" />
        )}
        <SkeletonPill className={cn('h-3', previewWidth)} />
      </span>
    </span>
    <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
      <SkeletonPill className="h-2.5 w-10" />
    </span>
  </div>
);

const TeamLoadingMessageComposerSkeleton = ({
  lockedRecipient,
}: {
  lockedRecipient: boolean;
}): JSX.Element => (
  <div className="message-composer-flat-layout relative mb-2" aria-hidden="true">
    <div className="message-composer-flat-toolbar grid min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center gap-2 pl-2">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] opacity-70">
        <Paperclip size={14} />
      </span>
      <div className="flex h-full min-w-0 items-stretch justify-end">
        {lockedRecipient ? (
          <div className="flex min-w-0 items-center justify-end px-1">
            <SkeletonPill className="h-5 w-16" />
          </div>
        ) : (
          <div className="grid w-full min-w-0 max-w-[430px] grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] items-stretch overflow-hidden">
            <div className="flex min-w-0 items-center justify-end gap-1 border-r border-[var(--color-border)] px-1">
              <SkeletonPill className="size-2 bg-[var(--skeleton-base-dim)]" />
              <SkeletonPill className="h-3 w-14 rounded bg-[var(--skeleton-base-dim)]" />
              <SkeletonPill className="size-3 rounded bg-[var(--skeleton-base-dim)]" />
            </div>
            <div className="flex min-w-0 items-center justify-end gap-1 px-1">
              <SkeletonPill className="size-5 bg-[var(--skeleton-base-dim)]" />
              <SkeletonPill className="h-3 w-10 rounded bg-[var(--skeleton-base-dim)]" />
              <SkeletonPill className="size-3 rounded bg-[var(--skeleton-base-dim)]" />
            </div>
          </div>
        )}
      </div>
    </div>
    <div className="message-composer-flat-body relative h-[96px]">
      <SkeletonPill className="absolute left-3 top-3 h-3 w-[62%] rounded bg-[var(--skeleton-base-dim)]" />
      <SkeletonPill className="absolute left-3 top-8 h-3 w-[42%] rounded bg-[var(--skeleton-base-dim)]" />
      <div className="message-composer-action-modes absolute bottom-2 left-2 flex h-7 w-[124px] overflow-hidden rounded-md border border-[var(--color-border)]">
        <SkeletonPill className="h-full flex-1 rounded-none bg-[var(--skeleton-base-dim)]" />
        <SkeletonPill className="h-full flex-1 rounded-none border-l border-[var(--color-border)] bg-[var(--skeleton-base-dim)]" />
        <SkeletonPill className="h-full flex-1 rounded-none border-l border-[var(--color-border)] bg-yellow-500/20" />
      </div>
      <div className="absolute bottom-2 right-2 flex items-center">
        <SkeletonPill className="size-8 rounded-md bg-[var(--skeleton-base-dim)]" />
      </div>
    </div>
    <div className="message-composer-flat-footer flex items-center justify-between gap-3">
      <SkeletonPill className="h-3 w-[58%] rounded bg-[var(--skeleton-base-dim)]" />
      <SkeletonPill className="h-3 w-10 shrink-0 rounded bg-[var(--skeleton-base-dim)]" />
    </div>
  </div>
);

const ThreadMessageCardSkeleton = (): JSX.Element => (
  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sidebar)] p-3">
    <div className="flex items-center gap-2">
      <SkeletonPill className="h-5 w-12" />
      <SkeletonPill className="h-3 w-16" />
      <SkeletonPill className="ml-auto h-3 w-12" />
    </div>
    <SkeletonPill className="mt-5 h-4 w-[88%]" />
    <SkeletonPill className="mt-2 h-4 w-[72%]" />
  </div>
);

export interface MessagesConversationSkeletonProps {
  surface: ConversationSurface;
  scope: ConversationScope;
  title: string;
}

export const MessagesConversationSkeleton = ({
  surface,
  scope,
  title,
}: MessagesConversationSkeletonProps): JSX.Element => (
  <div
    className="flex size-full flex-col overflow-hidden bg-[var(--color-surface-sidebar)]"
    data-messages-skeleton={surface}
    data-messages-skeleton-title={title}
    aria-busy="true"
  >
    <div className="flex shrink-0 items-center gap-2 overflow-visible border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-3 py-2">
      {surface === 'thread' ? (
        <span className="inline-flex size-7 shrink-0 items-center justify-center text-[var(--color-text-muted)] opacity-70">
          <ArrowLeft size={15} />
        </span>
      ) : null}
      {surface === 'thread' && scope.kind === 'direct' ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="size-5 shrink-0 rounded-full bg-[var(--color-surface-raised)]" />
          <span className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">
            {title}
          </span>
        </span>
      ) : (
        <span className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">
          {title}
        </span>
      )}
      <span className="ml-auto inline-flex size-7 items-center justify-center rounded text-[var(--color-text-muted)] opacity-70">
        <MoreHorizontal size={15} />
      </span>
    </div>
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden pb-14 pr-3 pt-2">
      {surface === 'list' ? (
        <div className="flex flex-col gap-0.5 overflow-visible px-1 pb-3">
          <ChatListRowSkeleton isTeamFeed nameWidth="w-20" previewWidth="w-[78%]" />
          {CHAT_LIST_MEMBER_ACCENTS.map((accent, index) => (
            <ChatListRowSkeleton
              key={accent}
              isTeamFeed={false}
              accent={accent}
              nameWidth={index === 0 ? 'w-14' : index === 2 ? 'w-16' : 'w-12'}
              previewWidth={index === 1 ? 'w-[64%]' : 'w-[72%]'}
            />
          ))}
        </div>
      ) : (
        <>
          <div className="pl-3">
            <TeamLoadingMessageComposerSkeleton lockedRecipient={scope.kind === 'direct'} />
          </div>
          <div className="space-y-3 overflow-hidden pl-3">
            <ThreadMessageCardSkeleton />
            <ThreadMessageCardSkeleton />
            <ThreadMessageCardSkeleton />
          </div>
        </>
      )}
    </div>
  </div>
);
