/**
 * AddTriggerForm - Form to add a new custom trigger.
 */

import { useCallback } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ChevronDown, ChevronUp, Loader2, Plus } from 'lucide-react';

import { useAddTriggerFormHandlers } from '../hooks/useAddTriggerFormHandlers';
import { useAddTriggerFormState } from '../hooks/useAddTriggerFormState';
import { useRepositoryLookup } from '../hooks/useRepositoryLookup';
import { useTriggerForm } from '../hooks/useTriggerForm';
import { generateId } from '../utils/trigger';

import { ColorPaletteSelector } from './ColorPaletteSelector';
import { DynamicConfigSection } from './DynamicConfigSection';
import { GeneralInfoSection } from './GeneralInfoSection';
import { IgnorePatternsSection } from './IgnorePatternsSection';
import { ModeSelector } from './ModeSelector';
import { RepositoryScopeSection } from './RepositoryScopeSection';
import { SectionHeader } from './SectionHeader';
import { TriggerPreview } from './TriggerPreview';

import type { NotificationTrigger } from '@renderer/types/data';

interface AddTriggerFormProps {
  saving: boolean;
  onAdd: (trigger: Omit<NotificationTrigger, 'isBuiltin'>) => Promise<void>;
}

export const AddTriggerForm = ({
  saving,
  onAdd,
}: Readonly<AddTriggerFormProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  // Use form state hook
  const formState = useAddTriggerFormState();
  const {
    name,
    toolName,
    mode,
    contentType,
    matchField,
    matchPattern,
    tokenThreshold,
    tokenType,
    ignorePatterns,
    repositoryIds,
    color,
    isExpanded,
    setName,
    setMatchField,
    setTokenType,
    setColor,
    setIsExpanded,
    resetForm,
  } = formState;

  // Use shared form hook for validation and preview
  const {
    patternError,
    validatePattern,
    previewResult,
    handleTestTrigger,
    handleViewSession,
    clearPreview,
    buildTriggerForTest,
  } = useTriggerForm({});

  // Use handlers hook
  const handlers = useAddTriggerFormHandlers({
    formState,
    validatePattern,
    clearPreview,
  });

  // Convert repositoryIds to RepositoryDropdownItem[] for display
  const selectedRepositoryItems = useRepositoryLookup(repositoryIds);

  // Test trigger using the shared hook
  const handleTest = useCallback(async (): Promise<void> => {
    if (mode === 'content_match' && !validatePattern(matchPattern)) return;

    const testTrigger = buildTriggerForTest({
      name,
      contentType,
      mode,
      matchField,
      matchPattern,
      tokenThreshold,
      tokenType,
      toolName,
      ignorePatterns,
      repositoryIds,
    });

    await handleTestTrigger(testTrigger);
  }, [
    mode,
    matchPattern,
    validatePattern,
    buildTriggerForTest,
    name,
    contentType,
    matchField,
    tokenThreshold,
    tokenType,
    toolName,
    ignorePatterns,
    repositoryIds,
    handleTestTrigger,
  ]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim()) return;
    if (mode === 'content_match' && !validatePattern(matchPattern)) return;

    const newTrigger = handlers.buildNewTrigger(generateId);
    await onAdd(newTrigger);
    resetForm();
    clearPreview();
    setIsExpanded(false);
  };

  return (
    <div className="border-t border-border-subtle">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between py-3 transition-colors hover:bg-surface-raised"
      >
        <div className="flex items-center gap-2">
          <Plus className="size-4 text-indigo-400" />
          <span className="text-sm font-medium text-text">
            {t('notificationTriggers.add.title')}
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp className="size-4 text-text-muted" />
        ) : (
          <ChevronDown className="size-4 text-text-muted" />
        )}
      </button>

      {/* Form */}
      {isExpanded && (
        <form onSubmit={handleSubmit} className="space-y-4 pb-4 pl-4">
          {/* Section 1: General Info */}
          <GeneralInfoSection
            name={name}
            toolName={toolName}
            saving={saving}
            onNameChange={setName}
            onToolNameChange={handlers.handleToolNameChange}
          />

          {/* Dot Color */}
          <div className="space-y-3">
            <SectionHeader title={t('notificationTriggers.sections.dotColor')} />
            <ColorPaletteSelector value={color} onChange={setColor} disabled={saving} />
          </div>

          {/* Section 2: Trigger Condition */}
          <div className="space-y-3">
            <SectionHeader title={t('notificationTriggers.sections.triggerCondition')} />
            <ModeSelector value={mode} onChange={handlers.handleModeChange} disabled={saving} />
          </div>

          {/* Section 3: Dynamic Configuration */}
          <DynamicConfigSection
            mode={mode}
            contentType={contentType}
            toolName={toolName}
            matchField={matchField}
            matchPattern={matchPattern}
            patternError={patternError}
            tokenThreshold={tokenThreshold}
            tokenType={tokenType}
            saving={saving}
            onContentTypeChange={handlers.handleContentTypeChange}
            onMatchFieldChange={setMatchField}
            onMatchPatternChange={handlers.handleMatchPatternChange}
            onTokenThresholdChange={handlers.handleTokenThresholdChange}
            onTokenTypeChange={setTokenType}
          />

          {/* Section 4: Advanced (Collapsible) */}
          <IgnorePatternsSection
            patterns={ignorePatterns}
            onAdd={handlers.handleAddIgnorePattern}
            onRemove={handlers.handleRemoveIgnorePattern}
            disabled={saving}
          />

          {/* Section 5: Repository Scope (Collapsible) */}
          <RepositoryScopeSection
            repositoryIds={repositoryIds}
            selectedItems={selectedRepositoryItems}
            onAdd={handlers.handleAddRepository}
            onRemove={handlers.handleRemoveRepository}
            disabled={saving}
          />

          {/* Preview Section */}
          <TriggerPreview
            previewResult={previewResult}
            onTest={handleTest}
            onViewSession={handleViewSession}
            isFormContext={true}
          />

          {/* Submit button */}
          <div className="flex justify-end gap-2 pt-4">
            <button
              type="button"
              onClick={handlers.handleCancel}
              disabled={saving}
              className={`rounded bg-surface-raised px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-overlay ${saving ? 'cursor-not-allowed opacity-50' : ''} `}
            >
              {t('notificationTriggers.add.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim() || !!patternError}
              className={`flex items-center gap-2 rounded bg-indigo-500 px-3 py-1.5 text-sm text-white transition-colors hover:bg-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-[#141416] ${saving || !name.trim() || !!patternError ? 'cursor-not-allowed opacity-50' : ''} `}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('notificationTriggers.add.submit')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
