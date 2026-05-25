/**
 * TriggerConfiguration - Mode-specific configuration sections for TriggerCard.
 * Handles error status, content match, and token threshold mode configurations.
 */

import { useAppTranslation } from '@features/localization/renderer';
import {
  getCursorClass,
  SELECT_INPUT_BASE,
  SELECT_OPTION_BG,
} from '@renderer/constants/cssVariables';
import { AlertCircle } from 'lucide-react';

import {
  CONTENT_TYPE_OPTIONS,
  getContentTypeLabelKey,
  getMatchFieldLabelKey,
  TOOL_NAME_OPTIONS,
} from '../utils/constants';
import { getAvailableMatchFields } from '../utils/trigger';

import { ColorPaletteSelector } from './ColorPaletteSelector';
import { ModeSelector } from './ModeSelector';
import { SectionHeader } from './SectionHeader';

import type {
  NotificationTrigger,
  TriggerContentType,
  TriggerMode,
  TriggerTokenType,
} from '@renderer/types/data';
import type { TriggerColor } from '@shared/constants/triggerColors';

interface TriggerConfigurationProps {
  trigger: NotificationTrigger;
  saving: boolean;
  localMode: TriggerMode;
  localPattern: string;
  localTokenThreshold: number;
  localTokenType: TriggerTokenType;
  patternError: string | null;
  onModeChange: (mode: TriggerMode) => void;
  onContentTypeChange: (value: TriggerContentType) => void;
  onToolNameChange: (value: string) => void;
  onMatchFieldChange: (value: string) => void;
  onPatternChange: (value: string) => void;
  onPatternBlur: () => void;
  onTokenThresholdChange: (value: number) => void;
  onTokenThresholdBlur?: () => void;
  onTokenTypeChange: (value: TriggerTokenType) => void;
  onColorChange: (color: TriggerColor) => void;
}

export const TriggerConfiguration = ({
  trigger,
  saving,
  localMode,
  localPattern,
  localTokenThreshold,
  localTokenType,
  patternError,
  onModeChange,
  onContentTypeChange,
  onToolNameChange,
  onMatchFieldChange,
  onPatternChange,
  onPatternBlur,
  onTokenThresholdChange,
  onTokenThresholdBlur,
  onTokenTypeChange,
  onColorChange,
}: Readonly<TriggerConfigurationProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const availableMatchFields = getAvailableMatchFields(trigger.contentType, trigger.toolName);

  return (
    <>
      {/* Section 1: General Info */}
      <div className="space-y-3">
        <SectionHeader title={t('notificationTriggers.sections.generalInfo')} />

        {/* Scope/Tool Name */}
        {(trigger.contentType === 'tool_use' || trigger.contentType === 'tool_result') && (
          <div className="flex items-center justify-between border-b border-border-subtle py-2">
            <label
              htmlFor={`trigger-${trigger.id}-tool-name`}
              className="text-sm text-text-secondary"
            >
              {t('notificationTriggers.fields.scopeToolName')}
            </label>
            <select
              id={`trigger-${trigger.id}-tool-name`}
              value={trigger.toolName ?? ''}
              onChange={(e) => onToolNameChange(e.target.value)}
              disabled={saving}
              className={`${SELECT_INPUT_BASE} ${getCursorClass(saving)}`}
            >
              {TOOL_NAME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className={SELECT_OPTION_BG}>
                  {option.value
                    ? option.label
                    : t('notificationTriggers.options.toolNames.anyTool')}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Dot Color */}
      <div className="space-y-3">
        <SectionHeader title={t('notificationTriggers.sections.dotColor')} />
        <ColorPaletteSelector value={trigger.color} onChange={onColorChange} disabled={saving} />
      </div>

      {/* Section 2: Trigger Condition (Mode Selector) */}
      <div className="space-y-3">
        <SectionHeader title={t('notificationTriggers.sections.triggerCondition')} />
        <ModeSelector value={localMode} onChange={onModeChange} disabled={saving} />
      </div>

      {/* Section 3: Dynamic Configuration */}
      <div className="space-y-3">
        <SectionHeader title={t('notificationTriggers.sections.configuration')} />

        {/* Error Status Mode */}
        {localMode === 'error_status' && (
          <div className="py-2">
            <p className="text-sm text-text-muted">
              {t('notificationTriggers.configuration.errorStatusDescription')}
            </p>
          </div>
        )}

        {/* Content Match Mode */}
        {localMode === 'content_match' && (
          <>
            {/* Content Type */}
            <div className="flex items-center justify-between border-b border-border-subtle py-2">
              <label
                htmlFor={`trigger-${trigger.id}-content-type`}
                className="text-sm text-text-secondary"
              >
                {t('notificationTriggers.fields.contentType')}
              </label>
              <select
                id={`trigger-${trigger.id}-content-type`}
                value={trigger.contentType}
                onChange={(e) => onContentTypeChange(e.target.value as TriggerContentType)}
                disabled={saving}
                className={`${SELECT_INPUT_BASE} ${getCursorClass(saving)}`}
              >
                {CONTENT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} className={SELECT_OPTION_BG}>
                    {t(getContentTypeLabelKey(option.value))}
                  </option>
                ))}
              </select>
            </div>
            <ContentMatchConfig
              triggerId={trigger.id}
              matchField={trigger.matchField}
              availableMatchFields={availableMatchFields}
              localPattern={localPattern}
              patternError={patternError}
              saving={saving}
              onMatchFieldChange={onMatchFieldChange}
              onPatternChange={onPatternChange}
              onPatternBlur={onPatternBlur}
            />
          </>
        )}

        {/* Token Threshold Mode */}
        {localMode === 'token_threshold' && (
          <TokenThresholdConfig
            triggerId={trigger.id}
            localTokenType={localTokenType}
            localTokenThreshold={localTokenThreshold}
            saving={saving}
            onTokenTypeChange={onTokenTypeChange}
            onTokenThresholdChange={onTokenThresholdChange}
            onTokenThresholdBlur={onTokenThresholdBlur}
          />
        )}
      </div>
    </>
  );
};

// =============================================================================
// Content Match Configuration
// =============================================================================

interface ContentMatchConfigProps {
  triggerId: string;
  matchField?: string;
  availableMatchFields: { value: string; label: string }[];
  localPattern: string;
  patternError: string | null;
  saving: boolean;
  onMatchFieldChange: (value: string) => void;
  onPatternChange: (value: string) => void;
  onPatternBlur: () => void;
}

const ContentMatchConfig = ({
  triggerId,
  matchField,
  availableMatchFields,
  localPattern,
  patternError,
  saving,
  onMatchFieldChange,
  onPatternChange,
  onPatternBlur,
}: Readonly<ContentMatchConfigProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');

  return (
    <div className="space-y-3">
      {/* Match Field */}
      {availableMatchFields.length > 0 && (
        <div className="flex items-center justify-between border-b border-border-subtle py-2">
          <label
            htmlFor={`trigger-${triggerId}-match-field`}
            className="text-sm text-text-secondary"
          >
            {t('notificationTriggers.fields.matchField')}
          </label>
          <select
            id={`trigger-${triggerId}-match-field`}
            value={matchField ?? availableMatchFields[0]?.value ?? ''}
            onChange={(e) => onMatchFieldChange(e.target.value)}
            disabled={saving}
            className={`${SELECT_INPUT_BASE} ${getCursorClass(saving)}`}
          >
            {availableMatchFields.map((option) => (
              <option key={option.value} value={option.value} className={SELECT_OPTION_BG}>
                {t(getMatchFieldLabelKey(option.value))}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Match Pattern */}
      <div className="border-b border-border-subtle py-2">
        <div className="mb-2 flex items-center justify-between">
          <label
            htmlFor={`trigger-${triggerId}-match-pattern`}
            className="text-sm text-text-secondary"
          >
            {t('notificationTriggers.fields.matchPattern')}
          </label>
        </div>
        <input
          id={`trigger-${triggerId}-match-pattern`}
          type="text"
          value={localPattern}
          onChange={(e) => onPatternChange(e.target.value)}
          onBlur={onPatternBlur}
          placeholder={t('notificationTriggers.configuration.matchPatternPlaceholder')}
          disabled={saving}
          className={`w-full rounded border bg-transparent px-2 py-1.5 font-mono text-sm text-text placeholder:text-text-muted focus:border-transparent focus:outline-none focus:ring-1 focus:ring-indigo-500 ${patternError ? 'border-red-500' : 'border-border'} ${saving ? 'cursor-not-allowed opacity-50' : ''} `}
        />
        {patternError && (
          <p className="mt-1 flex items-center gap-1 text-xs text-red-400">
            <AlertCircle className="size-3" />
            {patternError}
          </p>
        )}
        <p className="mt-1 text-xs text-text-muted">
          {t('notificationTriggers.configuration.emptyPatternHint')}
        </p>
      </div>
    </div>
  );
};

// =============================================================================
// Token Threshold Configuration
// =============================================================================

interface TokenThresholdConfigProps {
  triggerId: string;
  localTokenType: TriggerTokenType;
  localTokenThreshold: number;
  saving: boolean;
  onTokenTypeChange: (value: TriggerTokenType) => void;
  onTokenThresholdChange: (value: number) => void;
  onTokenThresholdBlur?: () => void;
}

const TokenThresholdConfig = ({
  triggerId,
  localTokenType,
  localTokenThreshold,
  saving,
  onTokenTypeChange,
  onTokenThresholdChange,
  onTokenThresholdBlur,
}: Readonly<TokenThresholdConfigProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b border-border-subtle py-2">
        <label htmlFor={`trigger-${triggerId}-token-type`} className="text-sm text-text-secondary">
          {t('notificationTriggers.fields.tokenType')}
        </label>
        <select
          id={`trigger-${triggerId}-token-type`}
          value={localTokenType}
          onChange={(e) => onTokenTypeChange(e.target.value as TriggerTokenType)}
          disabled={saving}
          className={`${SELECT_INPUT_BASE} ${getCursorClass(saving)}`}
        >
          <option value="total" className={SELECT_OPTION_BG}>
            {t('notificationTriggers.options.tokenTypes.total')}
          </option>
          <option value="input" className={SELECT_OPTION_BG}>
            {t('notificationTriggers.options.tokenTypes.input')}
          </option>
          <option value="output" className={SELECT_OPTION_BG}>
            {t('notificationTriggers.options.tokenTypes.output')}
          </option>
        </select>
      </div>
      <div className="flex items-center justify-between border-b border-border-subtle py-2">
        <label htmlFor={`trigger-${triggerId}-threshold`} className="text-sm text-text-secondary">
          {t('notificationTriggers.fields.threshold')}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">
            {t('notificationTriggers.configuration.alertIfGreaterThan')}
          </span>
          <input
            id={`trigger-${triggerId}-threshold`}
            type="text"
            inputMode="numeric"
            value={localTokenThreshold || ''}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '');
              onTokenThresholdChange(parseInt(val) || 0);
            }}
            onBlur={onTokenThresholdBlur}
            placeholder="0"
            disabled={saving}
            className={`w-20 rounded border border-border bg-transparent px-2 py-1 text-right text-sm text-text focus:border-transparent focus:outline-none focus:ring-1 focus:ring-indigo-500 ${saving ? 'cursor-not-allowed opacity-50' : ''} `}
          />
          <span className="text-xs text-text-muted">
            {t('notificationTriggers.configuration.tokensUnit')}
          </span>
        </div>
      </div>
    </div>
  );
};
