import { useId } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Label } from '@renderer/components/ui/label';
import { Textarea } from '@renderer/components/ui/textarea';

import {
  isHumanApprovalFlow,
  MAX_REVIEW_FLOW_PROMPT_LENGTH,
  REVIEW_FLOWS,
} from '../../core/domain/reviewFlowPolicy';

import { FLOW_TEXT_KEYS } from './reviewFlowText';

import type { ReviewFlowSettings } from '../../contracts/types';

interface ReviewFlowSettingsFormProps {
  value: ReviewFlowSettings;
  onChange: (next: ReviewFlowSettings) => void;
  /** Busy: nothing can be edited right now. */
  disabled?: boolean;
  /** Shows values that are not editable here, for example the inherited default. */
  readOnly?: boolean;
  /** Prefix of the test ids: `<prefix>-<flow>` and `<prefix>-prompt`. */
  testIdPrefix: string;
}

/** The fields of one review-flow configuration. Controlled and free of store or IPC concerns. */
export const ReviewFlowSettingsForm = ({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  testIdPrefix,
}: Readonly<ReviewFlowSettingsFormProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const groupId = useId();
  const locked = disabled || readOnly;

  return (
    <div className={readOnly ? 'space-y-3 opacity-70' : 'space-y-3'}>
      <fieldset className="space-y-1" disabled={locked}>
        <legend className="mb-1 text-sm font-medium text-[var(--color-text)]">
          {t('reviewFlow.flowLegend')}
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
              checked={value.reviewFlow === flow}
              onChange={() => onChange({ ...value, reviewFlow: flow })}
              data-testid={`${testIdPrefix}-${flow}`}
              className="mt-0.5"
            />
            <span className="text-[var(--color-text)]">{t(FLOW_TEXT_KEYS[flow].label)}</span>
            <span className="col-start-2 text-xs text-[var(--color-text-muted)]">
              {t(FLOW_TEXT_KEYS[flow].description)}
            </span>
          </label>
        ))}
      </fieldset>
      {isHumanApprovalFlow(value) ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('reviewFlow.humanApprovalNote')}
        </p>
      ) : null}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={`${groupId}-prompt`}>{t('reviewFlow.promptLabel')}</Label>
          <span className="text-xs tabular-nums text-[var(--color-text-muted)]">
            {value.reviewFlowPrompt.length}/{MAX_REVIEW_FLOW_PROMPT_LENGTH}
          </span>
        </div>
        <Textarea
          id={`${groupId}-prompt`}
          value={value.reviewFlowPrompt}
          maxLength={MAX_REVIEW_FLOW_PROMPT_LENGTH}
          disabled={locked}
          rows={3}
          placeholder={t('reviewFlow.promptPlaceholder')}
          data-testid={`${testIdPrefix}-prompt`}
          onChange={(event) => onChange({ ...value, reviewFlowPrompt: event.target.value })}
        />
        <p className="text-xs text-[var(--color-text-muted)]">{t('reviewFlow.promptHint')}</p>
      </div>
    </div>
  );
};
