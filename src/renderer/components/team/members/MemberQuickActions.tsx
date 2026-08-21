import { memo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { MessageSquare, Pencil, Plus } from 'lucide-react';

interface MemberActionButtonProps {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}

export const MemberActionButton = memo(function MemberActionButton({
  label,
  children,
  disabled = false,
  onClick,
}: MemberActionButtonProps): React.JSX.Element {
  const [tooltipOpen, setTooltipOpen] = useState(false);

  return (
    <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={(event) => {
            event.stopPropagation();
            onClick?.();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {children}
        </button>
      </TooltipTrigger>
      {tooltipOpen ? <TooltipContent side="bottom">{label}</TooltipContent> : null}
    </Tooltip>
  );
});

interface MemberQuickActionsProps {
  onSendMessage?: () => void;
  onAssignTask?: () => void;
  onEditMember?: () => void;
  editDisabled?: boolean;
}

export const MemberQuickActions = memo(function MemberQuickActions({
  onSendMessage,
  onAssignTask,
  onEditMember,
  editDisabled = false,
}: MemberQuickActionsProps): React.JSX.Element {
  const { t } = useAppTranslation('team');

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <MemberActionButton label={t('members.actions.sendMessage')} onClick={onSendMessage}>
        <MessageSquare size={13} />
      </MemberActionButton>
      <MemberActionButton label={t('members.actions.assignTask')} onClick={onAssignTask}>
        <Plus size={13} />
      </MemberActionButton>
      {onEditMember ? (
        <MemberActionButton
          label={
            editDisabled
              ? t('detail.tooltips.editUnavailableProvisioning')
              : t('toolApproval.settings')
          }
          disabled={editDisabled}
          onClick={onEditMember}
        >
          <Pencil size={13} />
        </MemberActionButton>
      ) : null}
    </div>
  );
});
