import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Textarea } from '@renderer/components/ui/textarea';

import type { TeamGroupChatDTO } from '../../contracts';
import type { useGroupChatComposer } from '../hooks/useGroupChatComposer';

export const GroupChatComposer = ({
  group,
  composer,
  controls,
  savedResult,
}: {
  group?: TeamGroupChatDTO;
  composer: ReturnType<typeof useGroupChatComposer>;
  controls?: React.ReactNode;
  savedResult?: ReturnType<typeof useGroupChatComposer>['result'];
}) => {
  const { t } = useAppTranslation('team');
  const blocked = !group?.canSend || !!group.archivedAt;
  const lastResult = composer.result ?? savedResult;
  return (
    <div
      className="space-y-2 border-t border-[var(--color-border)] p-3"
      data-testid="group-chat-composer"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {group?.name ?? t('messages.groups.unavailable')}
        </span>
        {controls}
      </div>
      <Textarea
        aria-label={t('messages.groups.message')}
        value={composer.text}
        readOnly={!!group?.archivedAt || composer.pending || !!composer.attemptId}
        disabled={!composer.ready}
        onChange={(event) => composer.change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !blocked) {
            event.preventDefault();
            void composer.send();
          }
        }}
        placeholder={t('messages.groups.message')}
      />
      {blocked ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {group?.archivedAt ? t('messages.groups.archivedHint') : t('messages.groups.restartHint')}
        </p>
      ) : null}
      {composer.error ? (
        <p role="alert" className="text-xs text-red-400">
          {composer.error}
        </p>
      ) : null}
      {lastResult ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {lastResult.deliverySummary?.recipients
            .map(
              (recipient) =>
                `${recipient.memberName}: ${t(`messages.groups.delivery.${recipient.status}`)}`
            )
            .join(', ') || t('messages.groups.unknownDelivery')}
        </p>
      ) : null}
      <Button
        size="sm"
        disabled={blocked || !composer.ready || composer.pending || !composer.text.trim()}
        onClick={() => void composer.send()}
      >
        {composer.pending
          ? t('messages.groups.sending')
          : composer.attemptId
            ? t('messages.groups.retrySend')
            : t('messages.groups.send')}
      </Button>
    </div>
  );
};
