import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { AlertTriangle, Check, Copy, FileText, Loader2, Pencil, Trash2 } from 'lucide-react';

import type { ChatAppearance } from '../activity/activityMessagePresentation';
import type { ComposerOutboxItem } from '@renderer/services/composerOutbox';
import type { RestoreRecoveryResult } from '@renderer/types/composerDraft';

interface ComposerOutboxBubbleProps {
  readonly item: ComposerOutboxItem;
  readonly appearance: ChatAppearance;
  readonly continuesPreviousAuthor?: boolean;
  readonly continuesNextAuthor?: boolean;
  readonly onCopy: (item: ComposerOutboxItem) => Promise<void>;
  readonly onRestore: (item: ComposerOutboxItem) => Promise<RestoreRecoveryResult>;
  readonly onDiscard: (
    item: ComposerOutboxItem
  ) => Promise<'discarded' | 'missing' | 'conflict' | 'active' | 'blocked'>;
}

export const ComposerOutboxBubble = ({
  item,
  appearance,
  continuesPreviousAuthor = false,
  continuesNextAuthor = false,
  onCopy,
  onRestore,
  onDiscard,
}: ComposerOutboxBubbleProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const [busy, setBusy] = useState<'restore' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wide = appearance === 'wide-chat';
  const canRestore = item.status !== 'sending' && item.status !== 'syncing';
  const canDiscard = item.status !== 'sending' && item.status !== 'syncing';
  const destructiveLabel =
    item.status === 'delivery-unknown'
      ? t('messages.outbox.actions.removeLocally')
      : t('messages.outbox.actions.delete');
  const restoreLabel =
    item.status === 'not-sent'
      ? t('messages.outbox.actions.edit')
      : item.status === 'recovered-draft'
        ? t('messages.outbox.actions.useDraft')
        : t('messages.outbox.actions.restoreDraft');
  const statusLabel = t(`messages.outbox.status.${item.status}`);
  const statusTone =
    item.status === 'not-sent'
      ? 'text-red-400'
      : item.status === 'delivery-unknown' || item.persistenceStatus === 'memory-only'
        ? 'text-amber-400'
        : 'text-[var(--color-text-muted)]';

  const handleRestore = async (): Promise<void> => {
    if (!canRestore || busy) return;
    setBusy('restore');
    setError(null);
    try {
      const result = await onRestore(item);
      if (result.kind === 'restored') return;
      setError(
        result.kind === 'conflict'
          ? t('messages.outbox.errors.draftOccupied')
          : result.kind === 'blocked'
            ? result.error
            : t('messages.outbox.errors.changed')
      );
    } catch (error) {
      setError(
        error instanceof Error && error.message
          ? error.message
          : t('messages.outbox.errors.changed')
      );
    } finally {
      setBusy(null);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    if (!canDiscard || busy) return;
    const confirmed = await confirm({
      title: destructiveLabel,
      message:
        item.status === 'delivery-unknown'
          ? t('messages.outbox.removeUnknownDescription')
          : t('messages.outbox.deleteDescription'),
      confirmLabel: destructiveLabel,
      cancelLabel: t('messages.outbox.actions.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setBusy('discard');
    setError(null);
    try {
      const result = await onDiscard(item);
      if (result === 'discarded' || result === 'missing') return;
      setError(
        result === 'active'
          ? t('messages.outbox.errors.active')
          : result === 'conflict'
            ? t('messages.outbox.errors.changed')
            : t('messages.outbox.errors.deleteBlocked')
      );
    } catch {
      setError(t('messages.outbox.errors.deleteBlocked'));
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async (): Promise<void> => {
    setError(null);
    try {
      await onCopy(item);
    } catch {
      setError(tCommon('codexLogin.copyFailed'));
    }
  };

  const iconButton = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled = false
  ): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <div
      className={wide ? 'group flex w-full flex-col items-end' : 'group relative min-w-0'}
      data-composer-outbox-id={item.id}
      data-composer-outbox-status={item.status}
    >
      <article
        data-message-presentation={wide ? 'ordinary-user' : undefined}
        data-expanded="true"
        data-has-recipient-route="false"
        data-continues-author={wide && continuesPreviousAuthor ? 'true' : undefined}
        data-continues-next-author={wide && continuesNextAuthor ? 'true' : undefined}
        className={[
          'relative min-w-0 overflow-visible rounded-[14px]',
          wide
            ? 'wide-chat-message'
            : 'border border-[var(--color-border)] bg-[var(--color-surface-raised)]',
        ].join(' ')}
      >
        <div className={wide ? 'wide-chat-message-header' : 'hidden'} />
        <div className={wide ? 'wide-chat-message-body min-w-0 overflow-hidden' : 'px-2.5 py-2'}>
          {item.sourceLabel && item.status === 'recovered-draft' ? (
            <div className="mb-1 text-[10px] font-medium text-[var(--color-text-muted)]">
              {t('messages.outbox.recoveredFor', { target: item.sourceLabel })}
            </div>
          ) : null}
          {item.displayText ? (
            <MarkdownViewer
              content={item.displayText}
              bare
              className="text-sm leading-relaxed [&_p]:my-0 [&_pre]:my-1.5"
            />
          ) : null}
          {item.attachments.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {item.attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="inline-flex max-w-48 items-center gap-1 rounded bg-black/10 px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)] dark:bg-white/5"
                >
                  <FileText size={10} className="shrink-0" />
                  <span className="truncate">{attachment.filename}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </article>

      <div className="mt-1 flex min-h-7 items-center justify-end gap-1" aria-live="polite">
        <span className={`inline-flex items-center gap-1 text-[10px] ${statusTone}`}>
          {item.status === 'sending' ? (
            <Loader2 size={10} className="animate-spin" />
          ) : item.status === 'syncing' ? (
            <Check size={10} />
          ) : item.status === 'delivery-unknown' || item.status === 'not-sent' ? (
            <AlertTriangle size={10} />
          ) : null}
          {statusLabel}
          {item.persistenceStatus === 'memory-only'
            ? ` - ${t('messages.outbox.status.memoryOnly')}`
            : ''}
        </span>
        <div className="flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {canRestore
            ? iconButton(
                restoreLabel,
                busy === 'restore' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Pencil size={13} />
                ),
                () => void handleRestore(),
                busy !== null
              )
            : null}
          {iconButton(
            t('messages.outbox.actions.copy'),
            <Copy size={13} />,
            () => void handleCopy(),
            busy !== null
          )}
          {canDiscard
            ? iconButton(
                destructiveLabel,
                busy === 'discard' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                ),
                () => void handleDiscard(),
                busy !== null
              )
            : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-right text-[10px] text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
};
