/**
 * Hook for shared form state and validation logic used by TriggerCard and AddTriggerForm.
 */

import { useCallback, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Component:TriggerForm');

import { generateId, validateRegexPattern } from '../utils/trigger';

import type { PreviewResult } from '../types';
import type {
  NotificationTrigger,
  TriggerMatchField,
  TriggerMode,
  TriggerTestResult,
  TriggerTokenType,
} from '@renderer/types/data';

interface UseTriggerFormOptions {
  /** Initial trigger for editing mode, or undefined for new trigger creation */
  trigger?: NotificationTrigger;
  /** Callback when trigger is updated (for edit mode) */
  onUpdate?: (updates: Partial<NotificationTrigger>) => Promise<void>;
}

interface UseTriggerFormReturn {
  // Pattern validation
  patternError: string | null;
  validatePattern: (pattern: string) => boolean;

  // Preview/test functionality
  previewResult: PreviewResult | null;
  handleTestTrigger: (trigger: NotificationTrigger) => Promise<void>;
  handleViewSession: (error: TriggerTestResult['errors'][0]) => void;
  clearPreview: () => void;

  // Build trigger for testing (used by AddTriggerForm)
  buildTriggerForTest: (formState: {
    name: string;
    contentType: NotificationTrigger['contentType'];
    mode: TriggerMode;
    matchField?: string;
    matchPattern?: string;
    tokenThreshold?: number;
    tokenType?: TriggerTokenType;
    toolName?: string;
    ignorePatterns?: string[];
    repositoryIds?: string[];
  }) => NotificationTrigger;
}

/**
 * Shared form state and validation logic for trigger forms.
 */
export function useTriggerForm(_options: UseTriggerFormOptions = {}): UseTriggerFormReturn {
  const { t } = useAppTranslation('settings');
  const [patternError, setPatternError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);

  // Get navigateToError from store for View Session functionality
  const navigateToError = useStore((state) => state.navigateToError);

  /**
   * Validate a regex pattern.
   */
  const validatePattern = useCallback(
    (pattern: string): boolean => {
      const error = validateRegexPattern(pattern);
      setPatternError(error ? t('notificationTriggers.errors.invalidRegexPattern') : null);
      return error === null;
    },
    [t]
  );

  /**
   * Clear the preview result.
   */
  const clearPreview = useCallback(() => {
    setPreviewResult(null);
  }, []);

  /**
   * Test trigger against historical data.
   * Results are automatically limited by the main process to prevent resource exhaustion:
   * - Max 50 errors returned
   * - Max 10,000 totalCount
   * - Max 100 sessions scanned
   * - 30 second timeout
   */
  const handleTestTrigger = useCallback(async (trigger: NotificationTrigger) => {
    setPreviewResult({ loading: true, totalCount: 0, errors: [] });

    try {
      const result = await api.config.testTrigger(trigger);
      setPreviewResult({
        loading: false,
        totalCount: result.totalCount,
        errors: result.errors,
        truncated: result.truncated,
      });
    } catch (error) {
      logger.error('Failed to test trigger:', error);
      setPreviewResult(null);
    }
  }, []);

  /**
   * Handle View Session click - navigate to the error location.
   */
  const handleViewSession = useCallback(
    (error: TriggerTestResult['errors'][0]) => {
      navigateToError({
        id: error.id,
        sessionId: error.sessionId,
        projectId: error.projectId,
        message: error.message,
        timestamp: error.timestamp,
        source: error.source,
        filePath: '',
        context: error.context,
        isRead: true,
        createdAt: error.timestamp,
        // Deep linking data for exact error position
        toolUseId: error.toolUseId,
        subagentId: error.subagentId,
        lineNumber: error.lineNumber,
      });
    },
    [navigateToError]
  );

  /**
   * Build a trigger object from form state for testing.
   */
  const buildTriggerForTest = useCallback(
    (formState: {
      name: string;
      contentType: NotificationTrigger['contentType'];
      mode: TriggerMode;
      matchField?: string;
      matchPattern?: string;
      tokenThreshold?: number;
      tokenType?: TriggerTokenType;
      toolName?: string;
      ignorePatterns?: string[];
      repositoryIds?: string[];
    }): NotificationTrigger => {
      return {
        id: `test-${generateId()}`,
        name: formState.name.trim() || t('notificationTriggers.preview.defaultTestTriggerName'),
        enabled: true,
        contentType: formState.contentType,
        mode: formState.mode,
        isBuiltin: false,
        ...(formState.mode === 'error_status' && { requireError: true }),
        ...(formState.mode === 'content_match' &&
          formState.matchField && { matchField: formState.matchField as TriggerMatchField }),
        ...(formState.mode === 'content_match' &&
          formState.matchPattern && { matchPattern: formState.matchPattern }),
        ...(formState.mode === 'token_threshold' && {
          tokenThreshold: formState.tokenThreshold,
          tokenType: formState.tokenType,
        }),
        ...((formState.contentType === 'tool_use' || formState.contentType === 'tool_result') &&
          formState.toolName && { toolName: formState.toolName }),
        ...(formState.ignorePatterns &&
          formState.ignorePatterns.length > 0 && { ignorePatterns: formState.ignorePatterns }),
        ...(formState.repositoryIds &&
          formState.repositoryIds.length > 0 && { repositoryIds: formState.repositoryIds }),
      };
    },
    [t]
  );

  return {
    patternError,
    validatePattern,
    previewResult,
    handleTestTrigger,
    handleViewSession,
    clearPreview,
    buildTriggerForTest,
  };
}
