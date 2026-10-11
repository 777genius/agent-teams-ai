import { useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Textarea } from '@renderer/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { MAX_TEXT_LENGTH } from '@shared/constants/teamLimits';
import { ArrowUp, Copy, History, ListOrdered, Loader2, Pencil, Trash2 } from 'lucide-react';

import { queueTextValid } from '../../core/domain/queue';

import type { QueueItem } from '../../core/domain/queue';
import type { LucideIcon } from 'lucide-react';
import type { JSX } from 'react';

export interface QueueListProps {
  readonly items: readonly QueueItem[];
  readonly busy: boolean;
  readonly error?: string | null;
  readonly blockedReason: (item: QueueItem) => string | null;
  readonly onSend: (item: QueueItem) => Promise<void>;
  readonly onEdit: (item: QueueItem, text: string) => Promise<void>;
  readonly onRemove: (item: QueueItem) => Promise<void>;
  readonly onCheck: (item: QueueItem) => Promise<void>;
  readonly onCopy: (item: QueueItem) => Promise<void>;
}

const QueueAction = ({
  label,
  icon,
  disabled,
  onClick,
  buttonRef,
  visibleLabel,
}: {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onClick: () => void;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  visibleLabel?: boolean;
}): JSX.Element => {
  const Icon = icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-1.5 text-[var(--color-text-secondary)]"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {visibleLabel && <span className="hidden sm:inline">{label}</span>}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
};

export const QueueList = ({
  items,
  busy,
  error,
  blockedReason,
  onSend,
  onEdit,
  onRemove,
  onCheck,
  onCopy,
}: QueueListProps): JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [editor, setEditor] = useState<{ item: QueueItem; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pencils = useRef(new Map<string, HTMLButtonElement>());
  const rows = useRef(new Map<string, HTMLLIElement>());
  const pendingRef = useRef(false);
  const editingId = editor?.item.queueItemId;
  useEffect(() => {
    if (editingId) editorRef.current?.focus();
  }, [editingId]);

  const cancel = (): void => {
    const id = editor?.item.queueItemId;
    setEditor(null);
    setLocalError(null);
    if (id) queueMicrotask(() => pencils.current.get(id)?.focus());
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setLocalError(null);
    try {
      await action();
    } catch (cause) {
      setLocalError(
        cause instanceof Error ? cause.message : t('messages.manualQueue.operationFailed')
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const save = (): void => {
    if (!editor || busy || !queueTextValid(editor.text, MAX_TEXT_LENGTH)) return;
    const snapshot = editor;
    void run(async () => {
      await onEdit(snapshot.item, snapshot.text);
      setEditor(null);
      rows.current.get(snapshot.item.queueItemId)?.focus();
    });
  };
  if (items.length === 0 && !editor && !error && !localError) return null;
  const disabled = busy || pending;
  // Keep unsaved text reachable if another view removes this record during editing.
  const orphaned = !!editor && !items.some((item) => item.queueItemId === editingId);
  const visibleItems = orphaned && editor ? [...items, editor.item] : items;
  return (
    <section
      aria-label={t('messages.manualQueue.title')}
      className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <ul className="m-0 max-h-56 min-w-0 list-none overflow-y-auto p-1">
        {visibleItems.map((item) => {
          const editing = editingId === item.queueItemId;
          const frozen = item.state !== 'queued';
          const reason = blockedReason(item);
          const recipient =
            item.route.kind === 'group'
              ? (item.route.recipientName ?? t('messages.manualQueue.all'))
              : item.route.participant;
          return (
            <li
              key={item.queueItemId}
              tabIndex={-1}
              ref={(node) => {
                if (node) rows.current.set(item.queueItemId, node);
                else rows.current.delete(item.queueItemId);
              }}
              className="min-w-0 rounded-lg px-2 py-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-border-emphasis)]"
            >
              <div className="flex min-w-0 items-center gap-2">
                {item.state === 'sending' ? (
                  <Loader2
                    aria-label={t('messages.manualQueue.sending')}
                    className="size-3.5 shrink-0 animate-spin text-[var(--color-text-muted)]"
                  />
                ) : (
                  <ListOrdered
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-[var(--color-text-muted)]"
                  />
                )}
                <div className="min-w-0 flex-1 truncate text-xs text-[var(--color-text)]">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="mr-1 text-[var(--color-text-muted)]">{recipient} ·</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {item.route.kind === 'group' && item.route.recipientName === null
                        ? t('messages.manualQueue.allHint')
                        : recipient}
                    </TooltipContent>
                  </Tooltip>
                  {item.route.kind === 'direct' && (
                    <span className="mr-1 text-[var(--color-text-muted)]">
                      {t(
                        item.actionMode === 'ask'
                          ? 'messages.manualQueue.ask'
                          : 'messages.manualQueue.do'
                      )}{' '}
                      ·
                    </span>
                  )}
                  {item.text.replace(/\s+/g, ' ')}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <QueueAction
                    label={
                      reason
                        ? `${t('messages.manualQueue.send')}: ${reason}`
                        : t('messages.manualQueue.send')
                    }
                    icon={ArrowUp}
                    visibleLabel={!reason}
                    disabled={disabled || frozen || editing || !!reason}
                    onClick={() => {
                      void run(() => onSend(item));
                    }}
                  />
                  {item.state === 'unknown' && (
                    <>
                      <QueueAction
                        label={t('messages.manualQueue.copy')}
                        icon={Copy}
                        disabled={disabled}
                        onClick={() => {
                          void run(() => onCopy(item));
                        }}
                      />
                      <QueueAction
                        label={t('messages.manualQueue.checkHistory')}
                        icon={History}
                        disabled={disabled}
                        onClick={() => {
                          void run(() => onCheck(item));
                        }}
                      />
                    </>
                  )}
                  <QueueAction
                    label={t(
                      item.state === 'unknown'
                        ? 'messages.manualQueue.removeRecord'
                        : 'messages.manualQueue.delete'
                    )}
                    icon={Trash2}
                    disabled={disabled || item.state === 'sending' || editing}
                    onClick={() => {
                      void run(() => onRemove(item));
                    }}
                  />
                  <QueueAction
                    label={t('messages.manualQueue.edit')}
                    icon={Pencil}
                    disabled={disabled || frozen || editor !== null}
                    buttonRef={(node) => {
                      if (node) pencils.current.set(item.queueItemId, node);
                      else pencils.current.delete(item.queueItemId);
                    }}
                    onClick={() => {
                      setEditor({ item, text: item.text });
                      setLocalError(null);
                    }}
                  />
                </div>
              </div>
              {item.state === 'unknown' && (
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  {t('messages.manualQueue.unknownWarning')}
                </p>
              )}
              {(reason || item.detail) && (
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {reason || item.detail}
                </p>
              )}
              {editing && orphaned && (
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  {t('messages.manualQueue.conflict')}
                </p>
              )}
              {editing && editor && (
                <div className="mt-2 space-y-2">
                  <Textarea
                    ref={editorRef}
                    aria-label={t('messages.manualQueue.editorLabel')}
                    value={editor.text}
                    disabled={disabled || frozen}
                    className="min-h-20 text-xs"
                    onChange={(event) => {
                      const text = event.target.value;
                      setEditor((current) => (current ? { ...current, text } : null));
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.nativeEvent.isComposing ||
                        event.nativeEvent.keyCode === 229 ||
                        event.repeat
                      )
                        return;
                      if (event.key === 'Escape' && !disabled) {
                        event.preventDefault();
                        event.stopPropagation();
                        cancel();
                      }
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        event.stopPropagation();
                        save();
                      }
                    }}
                  />
                  {!queueTextValid(editor.text, MAX_TEXT_LENGTH) && (
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {t('messages.manualQueue.invalidText', { maximum: MAX_TEXT_LENGTH })}
                    </p>
                  )}
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={cancel}
                    >
                      {t('messages.manualQueue.cancel')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={disabled || frozen || !queueTextValid(editor.text, MAX_TEXT_LENGTH)}
                      onClick={save}
                    >
                      {t('messages.manualQueue.save')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {(error || localError) && (
        <p role="alert" className="px-3 pb-2 text-xs text-[var(--color-text-secondary)]">
          {localError || error}
        </p>
      )}
    </section>
  );
};
