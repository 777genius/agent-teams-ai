import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ChatListRow } from '@features/team-direct-chats/renderer';
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
  const [taskLimit, setTaskLimit] = useState(50);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const chats = model?.chats ?? [];
  const rows = useMemo(
    () => chats.map((chat) => ({ chat, item: toAttentionChatRow(chat) })),
    [chats]
  );
  const tasks = model?.tasks ?? [];
  const shownTasks = variant === 'compact' ? tasks.slice(0, 4) : tasks.slice(0, taskLimit);
  const empty = !loading && !error && model?.complete &&
    tasks.length === 0 && chats.length === 0;

  return (
    <section
      aria-label={t('attention.title')}
      className="rounded-xl border border-border bg-surface-raised/50 p-4"
      data-testid="user-attention-inbox"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Inbox size={17} className="shrink-0 text-text-secondary" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-text">{t('attention.title')}</h2>
          {model && (model.taskCount > 0 || model.chatCount > 0) ? (
            <span data-testid="attention-counts"
              className="inline-flex flex-wrap items-center gap-1 text-[11px] font-medium text-red-400 tabular-nums">
              {model.taskCount > 0 && (
                <span data-testid="attention-task-count" className="inline-flex items-center gap-0.5">
                  <AlertCircle size={12} aria-hidden="true" />
                  <span className="sr-only">{t('attention.tasks')}: </span>
                  {model.taskCount}
                </span>
              )}
              {model.chatCount > 0 && (
                <span data-testid="attention-chat-count" className="inline-flex items-center gap-0.5">
                  <MessageCircle size={12} aria-hidden="true" />
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
          <button type="button" onClick={onRetry} aria-label={t('attention.refresh')}
            className="rounded-md p-1.5 text-text-secondary hover:bg-surface-overlay hover:text-text">
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {loading && !model && <p role="status" className="py-4 text-xs text-text-muted">{t('attention.loading')}</p>}
      {error && (
        <p role="alert" className="mb-3 text-xs text-red-400">
          {t('attention.loadFailed')} <button type="button" onClick={onRetry} className="underline">{t('attention.retry')}</button>
        </p>
      )}
      {model && !model.complete && (
        <p role="status" className="mb-3 text-xs text-amber-500">
          {t('attention.partial')}
        </p>
      )}
      {empty && <p className="py-4 text-xs text-text-muted">{t('attention.nothing')}</p>}

      {tasks.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
            <AlertCircle size={14} aria-hidden="true" />
            {t('attention.tasks')} · {tasks.length}
          </h3>
          <div className="flex flex-col gap-1">
            {shownTasks.map((task) => (
              <button type="button" key={`${task.teamName}:${task.taskId}`}
                onClick={() => onOpenTask(task)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-overlay"
                aria-label={t('attention.openTask', { subject: task.subject, team: task.teamDisplayName })}>
                <span className="size-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-text">{task.subject}</span>
                  <span className="block truncate text-[11px] text-text-muted">
                    {task.teamDisplayName} · {relativeAttentionAge(task.requestedAt, now, resolvedLanguage, t('attention.timeUnknown'))}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {tasks.length > shownTasks.length && (
            variant === 'compact' ? (
              <button type="button" onClick={onOpenFull}
                className="mt-2 text-xs text-text-secondary hover:text-text">
                +{tasks.length - shownTasks.length} {t('attention.viewAll')}
              </button>
            ) : (
              <button type="button" onClick={() => setTaskLimit((limit) => limit + 50)}
                className="mt-2 text-xs text-text-secondary hover:text-text">
                {t('attention.viewAll')} (+{Math.min(50, tasks.length - shownTasks.length)})
              </button>
            )
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
            <MessageCircle size={14} aria-hidden="true" />
            {t('attention.chats')} · {rows.length}
          </h3>
          <div className={variant === 'compact' ? 'max-h-[238px] overflow-y-auto' : 'overflow-y-auto'}>
            {rows.map(({ chat, item }) => (
              <div key={`${chat.teamName}:${item.scope.kind}:${'groupChatId' in item.scope ? item.scope.groupChatId : 'participant' in item.scope ? item.scope.participant : ''}`}>
                <div className="px-2 text-[10px] text-text-muted">
                  {chat.teamDisplayName} · {relativeAttentionAge(chat.latestUnread.timestamp, now, resolvedLanguage, t('attention.timeUnknown'))}
                </div>
                <ChatListRow item={item} teamName={chat.teamName}
                  onOpen={(scope) => onOpenChat(chat, scope)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
