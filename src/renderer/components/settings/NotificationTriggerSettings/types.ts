/**
 * Local type definitions for NotificationTriggerSettings components.
 */

import type { NotificationTrigger, TriggerMode, TriggerTestResult } from '@renderer/types/data';

/**
 * Preview result state for a trigger test.
 */
export interface PreviewResult {
  loading: boolean;
  totalCount: number;
  errors: TriggerTestResult['errors'];
  /**
   * True if results were truncated due to safety limits.
   * When truncated, totalCount may be capped at 10,000.
   */
  truncated?: boolean;
}

/**
 * Mode configuration for the segmented control.
 */
export interface ModeConfig {
  value: TriggerMode;
  label: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Props for the main NotificationTriggerSettings component.
 */
export interface NotificationTriggerSettingsProps {
  triggers: NotificationTrigger[];
  saving: boolean;
  onUpdateTrigger: (triggerId: string, updates: Partial<NotificationTrigger>) => Promise<void>;
  onAddTrigger: (trigger: Omit<NotificationTrigger, 'isBuiltin'>) => Promise<void>;
  onRemoveTrigger: (triggerId: string) => Promise<void>;
}
