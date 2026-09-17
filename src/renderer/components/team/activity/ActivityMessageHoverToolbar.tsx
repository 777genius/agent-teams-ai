import { memo, type ReactNode, useCallback, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { Check, Copy, ListPlus, Pencil, Reply } from 'lucide-react';

interface ActivityMessageHoverToolbarProps {
  copyText: string;
  canRevise?: boolean;
  onRevise?: () => void;
  onReply?: () => void;
  onCreateTask?: () => void;
}

interface ToolbarIconButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
}

const ToolbarIconButton = memo(function ToolbarIconButton({
  label,
  onClick,
  children,
}: ToolbarIconButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-overlay)]"
          style={{ color: CARD_ICON_MUTED }}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
});

export const ActivityMessageHoverToolbar = memo(function ActivityMessageHoverToolbar({
  copyText,
  canRevise = false,
  onRevise,
  onReply,
  onCreateTask,
}: ActivityMessageHoverToolbarProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((): void => {
    void navigator.clipboard.writeText(copyText).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Clipboard API may be unavailable in some test or host environments.
      }
    );
  }, [copyText]);

  return (
    <div
      data-activity-message-toolbar="true"
      data-orientation="vertical"
      className="flex flex-col items-center gap-1"
    >
      {canRevise && onRevise ? (
        <ToolbarIconButton label={t('activity.actions.editMessage')} onClick={onRevise}>
          <Pencil size={14} />
        </ToolbarIconButton>
      ) : null}
      {onReply ? (
        <ToolbarIconButton label={t('activity.actions.replyToMessage')} onClick={onReply}>
          <Reply size={14} />
        </ToolbarIconButton>
      ) : null}
      {onCreateTask ? (
        <ToolbarIconButton
          label={t('activity.actions.createTaskFromMessage')}
          onClick={onCreateTask}
        >
          <ListPlus size={14} />
        </ToolbarIconButton>
      ) : null}
      <ToolbarIconButton label={tCommon('actions.copyToClipboard')} onClick={handleCopy}>
        {copied ? (
          <Check className="size-3.5" style={{ color: 'var(--badge-success-bg)' }} />
        ) : (
          <Copy size={14} />
        )}
      </ToolbarIconButton>
    </div>
  );
});
