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
  orientation?: 'horizontal' | 'vertical';
}

interface ToolbarIconButtonProps {
  label: string;
  onClick: () => void;
  tooltipSide: 'left' | 'top';
  children: ReactNode;
}

const ToolbarIconButton = memo(function ToolbarIconButton({
  label,
  onClick,
  tooltipSide,
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
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
});

export const ActivityMessageHoverToolbar = memo(function ActivityMessageHoverToolbar({
  copyText,
  canRevise = false,
  onRevise,
  onReply,
  onCreateTask,
  orientation = 'vertical',
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
      data-orientation={orientation}
      className={`flex items-center gap-1 ${orientation === 'vertical' ? 'flex-col' : 'flex-row'}`}
    >
      {canRevise && onRevise ? (
        <ToolbarIconButton
          label={t('activity.actions.editMessage')}
          onClick={onRevise}
          tooltipSide={orientation === 'vertical' ? 'left' : 'top'}
        >
          <Pencil size={14} />
        </ToolbarIconButton>
      ) : null}
      {onReply ? (
        <ToolbarIconButton
          label={t('activity.actions.replyToMessage')}
          onClick={onReply}
          tooltipSide={orientation === 'vertical' ? 'left' : 'top'}
        >
          <Reply size={14} />
        </ToolbarIconButton>
      ) : null}
      {onCreateTask ? (
        <ToolbarIconButton
          label={t('activity.actions.createTaskFromMessage')}
          onClick={onCreateTask}
          tooltipSide={orientation === 'vertical' ? 'left' : 'top'}
        >
          <ListPlus size={14} />
        </ToolbarIconButton>
      ) : null}
      <ToolbarIconButton
        label={tCommon('actions.copyToClipboard')}
        onClick={handleCopy}
        tooltipSide={orientation === 'vertical' ? 'left' : 'top'}
      >
        {copied ? (
          <Check className="size-3.5" style={{ color: 'var(--badge-success-bg)' }} />
        ) : (
          <Copy size={14} />
        )}
      </ToolbarIconButton>
    </div>
  );
});
