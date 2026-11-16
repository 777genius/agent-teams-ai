import { useId, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Label } from '@renderer/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Textarea } from '@renderer/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { MAX_REVIEW_FLOW_PROMPT_LENGTH, REVIEW_FLOWS } from '@shared/constants/kanban';
import { Settings2 } from 'lucide-react';

import type { ReviewFlow, ReviewFlowSettings } from '@shared/types';

interface KanbanApprovedSettingsMenuProps {
  reviewFlow: ReviewFlow;
  reviewFlowPrompt: string;
  onSave: (settings: ReviewFlowSettings) => Promise<void>;
}

const FLOW_I18N_KEYS = {
  agent_approval: {
    label: 'kanban.approvalSettings.flows.agent_approval.label',
    description: 'kanban.approvalSettings.flows.agent_approval.description',
  },
  human_approval: {
    label: 'kanban.approvalSettings.flows.human_approval.label',
    description: 'kanban.approvalSettings.flows.human_approval.description',
  },
} as const satisfies Record<ReviewFlow, { label: string; description: string }>;

export const KanbanApprovedSettingsMenu = ({
  reviewFlow,
  reviewFlowPrompt,
  onSave,
}: Readonly<KanbanApprovedSettingsMenuProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const groupId = useId();
  const [open, setOpen] = useState(false);
  const [draftFlow, setDraftFlow] = useState<ReviewFlow>(reviewFlow);
  const [draftPrompt, setDraftPrompt] = useState(reviewFlowPrompt);
  const [pending, setPending] = useState(false);

  const dirty = draftFlow !== reviewFlow || draftPrompt.trim() !== reviewFlowPrompt;

  const handleOpenChange = (nextOpen: boolean): void => {
    if (pending) return;
    // Always start from the persisted policy so a cancelled or failed edit never lingers.
    setDraftFlow(reviewFlow);
    setDraftPrompt(reviewFlowPrompt);
    setOpen(nextOpen);
  };

  const handleSave = (): void => {
    setPending(true);
    void onSave({ reviewFlow: draftFlow, reviewFlowPrompt: draftPrompt })
      .then(() => setOpen(false))
      .catch(() => {
        // The store reports the failure; the draft is reloaded from the persisted policy on reopen.
      })
      .finally(() => setPending(false));
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('kanban.approvalSettings.title')}
              data-testid="kanban-approved-settings"
              className="kanban-grid-no-drag h-6 w-6 p-0 text-[var(--color-text-muted)]"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Settings2 size={13} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t('kanban.approvalSettings.title')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="kanban-grid-no-drag w-80 space-y-3"
        data-testid="kanban-review-flow-panel"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <fieldset className="space-y-2" disabled={pending}>
          <legend className="mb-1 text-sm font-medium text-[var(--color-text)]">
            {t('kanban.approvalSettings.flowLegend')}
          </legend>
          {REVIEW_FLOWS.map((flow) => (
            <label
              key={flow}
              className="grid cursor-pointer grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded-md p-1.5 text-sm hover:bg-[var(--color-surface-raised)]"
            >
              <input
                type="radio"
                name={groupId}
                value={flow}
                checked={draftFlow === flow}
                onChange={() => setDraftFlow(flow)}
                data-testid={`kanban-review-flow-${flow}`}
                className="mt-0.5"
              />
              <span className="text-[var(--color-text)]">{t(FLOW_I18N_KEYS[flow].label)}</span>
              <span className="col-start-2 text-xs text-[var(--color-text-muted)]">
                {t(FLOW_I18N_KEYS[flow].description)}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="space-y-1">
          <Label htmlFor={`${groupId}-prompt`}>{t('kanban.approvalSettings.promptLabel')}</Label>
          <Textarea
            id={`${groupId}-prompt`}
            value={draftPrompt}
            maxLength={MAX_REVIEW_FLOW_PROMPT_LENGTH}
            disabled={pending}
            rows={3}
            placeholder={t('kanban.approvalSettings.promptPlaceholder')}
            data-testid="kanban-review-flow-prompt"
            onChange={(event) => setDraftPrompt(event.target.value)}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('kanban.approvalSettings.promptHint')}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => handleOpenChange(false)}
          >
            {t('kanban.approvalSettings.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || pending}
            data-testid="kanban-review-flow-save"
            onClick={handleSave}
          >
            {t('kanban.approvalSettings.save')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
