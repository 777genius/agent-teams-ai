/**
 * Hook for TriggerCard local state and callback handlers.
 * Extracts state management logic from TriggerCard component.
 */

import { useCallback, useState } from 'react';

import { deriveMode, getAvailableMatchFields } from '../utils/trigger';

import type { RepositoryDropdownItem } from '@renderer/components/settings/hooks/useSettingsConfig';
import type {
  NotificationTrigger,
  TriggerContentType,
  TriggerMatchField,
  TriggerMode,
  TriggerTokenType,
} from '@renderer/types/data';
import type { TriggerColor } from '@shared/constants/triggerColors';

interface UseTriggerCardStateOptions {
  trigger: NotificationTrigger;
  onUpdate: (updates: Partial<NotificationTrigger>) => Promise<void>;
  validatePattern: (pattern: string) => boolean;
}

interface UseTriggerCardStateReturn {
  // UI state
  isExpanded: boolean;
  setIsExpanded: (value: boolean) => void;
  editingName: boolean;
  setEditingName: (value: boolean) => void;

  // Local form values
  localName: string;
  setLocalName: (value: string) => void;
  localPattern: string;
  localMode: TriggerMode;
  localTokenThreshold: number;
  localTokenType: TriggerTokenType;

  // Handlers
  handleToggleEnabled: () => void;
  handleNameSave: () => void;
  handlePatternBlur: () => void;
  handlePatternChange: (value: string) => void;
  handleContentTypeChange: (value: TriggerContentType) => void;
  handleToolNameChange: (value: string) => void;
  handleMatchFieldChange: (value: string) => void;
  handleModeChange: (newMode: TriggerMode) => void;
  handleTokenThresholdChange: (value: number) => void;
  handleTokenThresholdBlur: () => void;
  handleTokenTypeChange: (value: TriggerTokenType) => void;
  handleAddIgnorePattern: (pattern: string) => void;
  handleRemoveIgnorePattern: (index: number) => void;
  handleAddRepository: (item: RepositoryDropdownItem) => void;
  handleRemoveRepository: (index: number) => void;
  handleColorChange: (color: TriggerColor) => void;
}

/**
 * Manages TriggerCard local state and provides memoized callback handlers.
 */
export function useTriggerCardState({
  trigger,
  onUpdate,
  validatePattern,
}: UseTriggerCardStateOptions): UseTriggerCardStateReturn {
  // UI state
  const [isExpanded, setIsExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);

  // Local form values
  const [localName, setLocalName] = useState(trigger.name);
  const [localPattern, setLocalPattern] = useState(trigger.matchPattern ?? '');
  const [localMode, setLocalMode] = useState<TriggerMode>(deriveMode(trigger));
  const [localTokenThreshold, setLocalTokenThreshold] = useState<number>(
    trigger.tokenThreshold ?? 1000
  );
  const [localTokenType, setLocalTokenType] = useState<TriggerTokenType>(
    trigger.tokenType ?? 'total'
  );

  // Toggle enabled/disabled
  const handleToggleEnabled = useCallback(() => {
    void onUpdate({ enabled: !trigger.enabled });
  }, [trigger.enabled, onUpdate]);

  // Save name on blur or Enter
  const handleNameSave = useCallback(() => {
    if (localName.trim() && localName !== trigger.name) {
      void onUpdate({ name: localName.trim() });
    }
    setEditingName(false);
  }, [localName, trigger.name, onUpdate]);

  // Save pattern on blur
  const handlePatternBlur = useCallback(() => {
    if (validatePattern(localPattern) && localPattern !== trigger.matchPattern) {
      void onUpdate({ matchPattern: localPattern });
    }
  }, [localPattern, trigger.matchPattern, onUpdate, validatePattern]);

  // Update local pattern and validate
  const handlePatternChange = useCallback(
    (value: string) => {
      setLocalPattern(value);
      validatePattern(value);
    },
    [validatePattern]
  );

  // Content type change - reset matchField to first available
  const handleContentTypeChange = useCallback(
    (value: TriggerContentType) => {
      const newMatchFields = getAvailableMatchFields(value, trigger.toolName ?? undefined);
      const newMatchField = newMatchFields[0]?.value ?? '';
      const updates: Partial<NotificationTrigger> = {
        contentType: value,
        matchField: (newMatchField as TriggerMatchField) || undefined,
      };
      // Reset tool name if not applicable
      if (value !== 'tool_use' && value !== 'tool_result') {
        updates.toolName = undefined;
      }
      void onUpdate(updates);
    },
    [onUpdate, trigger.toolName]
  );

  // Tool name change - reset matchField to first available
  const handleToolNameChange = useCallback(
    (value: string) => {
      const newMatchFields = getAvailableMatchFields(trigger.contentType, value || undefined);
      const newMatchField = newMatchFields[0]?.value ?? '';
      void onUpdate({
        toolName: value || undefined,
        matchField: (newMatchField as TriggerMatchField) || undefined,
      });
    },
    [onUpdate, trigger.contentType]
  );

  // Match field change
  const handleMatchFieldChange = useCallback(
    (value: string) => {
      void onUpdate({ matchField: value as TriggerMatchField });
    },
    [onUpdate]
  );

  // Mode change with appropriate defaults
  const handleModeChange = useCallback(
    (newMode: TriggerMode) => {
      setLocalMode(newMode);
      const updates: Partial<NotificationTrigger> = { mode: newMode };

      if (newMode === 'error_status') {
        updates.requireError = true;
        updates.contentType = 'tool_result';
      } else if (newMode === 'content_match') {
        // Ensure matchField is set for validation
        const contentType = trigger.contentType ?? 'tool_result';
        const matchFields = getAvailableMatchFields(contentType, trigger.toolName ?? undefined);
        if (!trigger.matchField && matchFields.length > 0) {
          updates.matchField = matchFields[0].value as TriggerMatchField;
        }
      } else if (newMode === 'token_threshold') {
        updates.tokenThreshold = localTokenThreshold;
        updates.tokenType = localTokenType;
      }

      void onUpdate(updates);
    },
    [
      onUpdate,
      localTokenThreshold,
      localTokenType,
      trigger.contentType,
      trigger.toolName,
      trigger.matchField,
    ]
  );

  // Token threshold change — local only, commit on blur
  const handleTokenThresholdChange = useCallback((value: number) => {
    setLocalTokenThreshold(value);
  }, []);

  // Commit token threshold to config
  const handleTokenThresholdBlur = useCallback(() => {
    if (localTokenThreshold !== (trigger.tokenThreshold ?? 1000)) {
      void onUpdate({ tokenThreshold: localTokenThreshold });
    }
  }, [localTokenThreshold, trigger.tokenThreshold, onUpdate]);

  // Token type change
  const handleTokenTypeChange = useCallback(
    (value: TriggerTokenType) => {
      setLocalTokenType(value);
      void onUpdate({ tokenType: value });
    },
    [onUpdate]
  );

  // Add ignore pattern
  const handleAddIgnorePattern = useCallback(
    (pattern: string) => {
      const newPatterns = [...(trigger.ignorePatterns ?? []), pattern];
      void onUpdate({ ignorePatterns: newPatterns });
    },
    [trigger.ignorePatterns, onUpdate]
  );

  // Remove ignore pattern
  const handleRemoveIgnorePattern = useCallback(
    (index: number) => {
      const newPatterns = [...(trigger.ignorePatterns ?? [])];
      newPatterns.splice(index, 1);
      void onUpdate({ ignorePatterns: newPatterns });
    },
    [trigger.ignorePatterns, onUpdate]
  );

  // Add repository
  const handleAddRepository = useCallback(
    (item: RepositoryDropdownItem) => {
      const currentIds = trigger.repositoryIds ?? [];
      if (!currentIds.includes(item.id)) {
        void onUpdate({ repositoryIds: [...currentIds, item.id] });
      }
    },
    [trigger.repositoryIds, onUpdate]
  );

  // Remove repository
  const handleRemoveRepository = useCallback(
    (index: number) => {
      const newIds = [...(trigger.repositoryIds ?? [])];
      newIds.splice(index, 1);
      void onUpdate({ repositoryIds: newIds });
    },
    [trigger.repositoryIds, onUpdate]
  );

  // Color change
  const handleColorChange = useCallback(
    (color: TriggerColor) => {
      void onUpdate({ color });
    },
    [onUpdate]
  );

  return {
    isExpanded,
    setIsExpanded,
    editingName,
    setEditingName,
    localName,
    setLocalName,
    localPattern,
    localMode,
    localTokenThreshold,
    localTokenType,
    handleToggleEnabled,
    handleNameSave,
    handlePatternBlur,
    handlePatternChange,
    handleContentTypeChange,
    handleToolNameChange,
    handleMatchFieldChange,
    handleModeChange,
    handleTokenThresholdChange,
    handleTokenThresholdBlur,
    handleTokenTypeChange,
    handleAddIgnorePattern,
    handleRemoveIgnorePattern,
    handleAddRepository,
    handleRemoveRepository,
    handleColorChange,
  };
}
