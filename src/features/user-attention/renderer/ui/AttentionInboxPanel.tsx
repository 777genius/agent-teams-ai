import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ChatListRow } from '@features/team-direct-chats/renderer';
import { Input } from '@renderer/components/ui/input';
import { AlertCircle, Inbox, MessageCircle, RefreshCw } from 'lucide-react';

import { relativeAttentionAge, toAttentionChatRow } from '../view-models/toAttentionChatRow';

import type { AttentionTaskCandidate } from '../../contracts';
import type { AttentionChat, AttentionModel } from '../../core/domain/buildAttention';
import type { ConversationScope } from '@features/team-direct-chats/renderer';

export interface AttentionInboxPanelProps {
  variant: 'compact' | 'full';
  model: AttentionModel | null;
  loading: boolean;
  error: string | null;
  onRetry(): void;
  onOpenTask(task: AttentionTaskCandidate): void;
  onOpenChat(chat: AttentionChat, scope: ConversationScope): void;
  onOpenFull?(): void;
}

export function AttentionInboxPanel({
  variant, model, loading, error, onRetry, onOpenTask, onOpenChat, onOpenFull,
}: Readonly<AttentionInboxPanelProps>): React.JSX.Element {
  const { t, resolvedLanguage } = useAppTranslation('common');
  const [now, setNow] = useState(() => Date.now());
  const [taskLimit, setTaskLimit] = useState(variant === 'compact' ? 8 : 50);
  const [chatLimit, setChatLimit] = useState(variant === 'compact' ? 8 : 50);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  // Tasks are decisions: prioritize the longest known wait. Chats are updates:
  // newest unread first. Separate caps prevent either type hiding the other.
  const { tasks, chats } = useMemo(() => {
    const search = variant === 'full' ? searchQuery.trim().toLocaleLowerCase() : '';
    const matches = (...values: Array<string | undefined>): boolean =>
      !search || values.some((value) => value?.toLocaleLowerCase().includes(search));
    return {
      tasks: (model?.tasks ?? []).filter((task) =>
        matches(task.subject, task.teamName, task.teamDisplayName)),
      chats: (model?.chats ?? []).filter((chat) =>
        matches(chat.name, chat.teamName, chat.teamDisplayName,
          chat.latestUnread.from, chat.latestUnread.text)),
    };
  }, [model, searchQuery, variant]);
  const shownTasks = tasks.slice(0, taskLimit);
  const shownChats = chats.slice(0, chatLimit);
  const empty = !loading && !error && model?.complete &&
    model.tasks.length === 0 && model.chats.length === 0;
  const compactEmpty = Boolean(empty && variant === 'compact');

  return (
    <section
      aria-label={t('attention.title')}
      className={'rounded-xl border border-border bg-surface-raised/50 ' +
        (compactEmpty ? 'px-3 py-2' : 'p-4')}
      data-testid="user-attention-inbox"
    >
      <header className={(compactEmpty ? '' : 'mb-3 ') +
        'flex flex-wrap items-center justify-between gap-x-3 gap-y-1'}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <Inbox size={17} className="shrink-0 text-text-secondary" aria-hidden="true" />
          <h2 className="shrink-0 text-sm font-semibold text-text">{t('attention.title')}</h2>
          {compactEmpty && (
            <span className="text-xs leading-5 text-text-secondary">{t('attention.nothing')}</span>
          )}
          {model && (model.taskCount > 0 || model.chatCount > 0) ? (
            <span data-testid="attention-counts"
              className="inline-flex flex-wrap items-center gap-1 text-xs font-medium text-red-400 tabular-nums">
              {model.taskCount > 0 && (
                <span data-testid="attention-task-count" className="inline-flex items-center gap-0.5">
                  <AlertCircle size={13} aria-hidden="true" />
                  <span className="sr-only">{t('attention.tasks')}: </span>
                  {model.taskCount}
                </span>
              )}
              {model.chatCount > 0 && (
                <span data-testid="attention-chat-count" className="inline-flex items-center gap-0.5">
                  <MessageCircle size={13} aria-hidden="true" />
                  <span className="sr-only">{t('attention.chats')}: </span>
                  {model.chatCount}
                </span>
              )}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {variant === 'compact' && onOpenFull && (
            <button type="button" onClick={onOpenFull}
              className="text-xs text-text-secondary hover:text-text">{t('attention.viewAll')}</button>
          )}
          <button type="button" onClick={onRetry} disabled={loading}
            aria-label={t('attention.refresh')}
            className="rounded-md p-1.5 text-text-secondary hover:bg-surface-overlay hover:text-text disabled:opacity-50">
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {variant === 'full' && model && (model.taskCount > 0 || model.chatCount > 0) && (
        <Input type="search" aria-label={t('search.placeholder')}
          placeholder={t('search.placeholder')} value={searchQuery}
          onChange={(event) => {
            setSearchQuery(event.target.value);
            setTaskLimit(50);
            setChatLimit(50);
          }}
          className="mb-4" />
      )}

      {loading && !model && <p role="status" className="py-4 text-xs text-text-muted">{t('attention.loading')}</p>}
      {error && (
        <p role="alert" className="mb-3 text-xs text-red-400">
          {t('attention.loadFailed')} <button type="button" onClick={onRetry} className="underline">{t('attention.retry')}</button>
        </p>
      )}
      {model && !model.complete && (
        <p role="status" className="mb-3 text-xs text-amber-500">{t('attention.partial')}</p>
      )}
      {empty && variant === 'full' && (
        <p className="py-2 text-sm text-text-secondary">{t('attention.nothing')}</p>
      )}
      {variant === 'full' && searchQuery.trim() && tasks.length === 0 && chats.length === 0 && model?.complete &&
        <p className="py-4 text-xs text-text-secondary">{t('search.noResults')}</p>}

      <div data-testid="attention-sections"
        className={tasks.length > 0 && chats.length > 0
          ? 'grid grid-cols-1 gap-5 xl:grid-cols-2 xl:gap-6'
          : 'flex flex-col gap-5'}>
        {tasks.length > 0 && (
          <div className="min-w-0">
            <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
              <AlertCircle size={14} aria-hidden="true" />
              {t('attention.tasks')} · {tasks.length}
            </h3>
            <div className="flex flex-col gap-1">
              {shownTasks.map((task) => {
                const age = relativeAttentionAge(task.requestedAt, now, resolvedLanguage, '');
                return (
                  <button type="button" key={['task', task.teamName, task.taskId].join(':')}
                    onClick={() => onOpenTask(task)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-emphasis"
                    aria-label={t('attention.openTask', { subject: task.subject, team: task.teamDisplayName })}>
                    <AlertCircle size={16} className="shrink-0 text-red-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-text">{task.subject}</span>
                      <span className="block truncate text-xs text-text-secondary">
                        {task.teamDisplayName}{age ? ' · ' + age : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {tasks.length > shownTasks.length && (
              <button type="button" data-testid="attention-tasks-more"
                onClick={() => setTaskLimit((limit) => limit + (variant === 'compact' ? 8 : 50))}
                className="mt-2 w-full rounded-md py-2 text-center text-sm text-text-secondary hover:bg-surface-overlay hover:text-text">
                {t('actions.showMore')} (+{Math.min(variant === 'compact' ? 8 : 50, tasks.length - shownTasks.length)})
              </button>
            )}
          </div>
        )}

        {chats.length > 0 && (
          <div className="min-w-0">
            <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
              <MessageCircle size={14} aria-hidden="true" />
              {t('attention.chats')} · {chats.length}
            </h3>
            <div className="flex flex-col gap-2">
              {shownChats.map((chat) => {
                const item = toAttentionChatRow(chat);
                const age = relativeAttentionAge(chat.latestUnread.timestamp, now, resolvedLanguage, '');
                const scopeKey = item.scope.kind === 'group' ? item.scope.groupChatId :
                  item.scope.kind === 'direct' ? item.scope.participant : 'team-feed';
                return (
                  <div key={['chat', chat.teamName, item.scope.kind, scopeKey].join(':')}>
                    <div className="px-2 text-xs text-text-secondary">
                      {chat.teamDisplayName}{age ? ' · ' + age : ''}
                    </div>
                    <ChatListRow item={item} teamName={chat.teamName}
                      onOpen={(scope) => onOpenChat(chat, scope)} />
                  </div>
                );
              })}
            </div>
            {chats.length > shownChats.length && (
              <button type="button" data-testid="attention-chats-more"
                onClick={() => setChatLimit((limit) => limit + (variant === 'compact' ? 8 : 50))}
                className="mt-2 w-full rounded-md py-2 text-center text-sm text-text-secondary hover:bg-surface-overlay hover:text-text">
                {t('actions.showMore')} (+{Math.min(variant === 'compact' ? 8 : 50, chats.length - shownChats.length)})
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
