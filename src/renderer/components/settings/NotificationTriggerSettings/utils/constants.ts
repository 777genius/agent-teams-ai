/**
 * Constants for NotificationTriggerSettings.
 */

import { Activity, AlertCircle, Search } from 'lucide-react';

import type { ModeConfig } from '../types';
import type { TriggerContentType, TriggerToolName } from '@renderer/types/data';

export const CONTENT_TYPE_LABEL_KEYS = {
  tool_result: 'notificationTriggers.options.contentTypes.tool_result',
  tool_use: 'notificationTriggers.options.contentTypes.tool_use',
  thinking: 'notificationTriggers.options.contentTypes.thinking',
  text: 'notificationTriggers.options.contentTypes.text',
} as const satisfies Record<TriggerContentType, string>;

export const MATCH_FIELD_LABEL_KEYS = {
  args: 'notificationTriggers.options.matchFields.args',
  command: 'notificationTriggers.options.matchFields.command',
  content: 'notificationTriggers.options.matchFields.content',
  description: 'notificationTriggers.options.matchFields.description',
  file_path: 'notificationTriggers.options.matchFields.file_path',
  fullInput: 'notificationTriggers.options.matchFields.fullInput',
  glob: 'notificationTriggers.options.matchFields.glob',
  new_string: 'notificationTriggers.options.matchFields.new_string',
  old_string: 'notificationTriggers.options.matchFields.old_string',
  path: 'notificationTriggers.options.matchFields.path',
  pattern: 'notificationTriggers.options.matchFields.pattern',
  prompt: 'notificationTriggers.options.matchFields.prompt',
  query: 'notificationTriggers.options.matchFields.query',
  skill: 'notificationTriggers.options.matchFields.skill',
  subagent_type: 'notificationTriggers.options.matchFields.subagent_type',
  text: 'notificationTriggers.options.matchFields.text',
  thinking: 'notificationTriggers.options.matchFields.thinking',
  url: 'notificationTriggers.options.matchFields.url',
} as const;

export const MODE_LABEL_KEYS = {
  content_match: 'notificationTriggers.options.modes.content_match',
  error_status: 'notificationTriggers.options.modes.error_status',
  token_threshold: 'notificationTriggers.options.modes.token_threshold',
} as const;

/**
 * Content type options for dropdown.
 */
export const CONTENT_TYPE_OPTIONS: { value: TriggerContentType; label: string }[] = [
  { value: 'tool_result', label: 'Tool Result' },
  { value: 'tool_use', label: 'Tool Use' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'text', label: 'Text Output' },
];

/**
 * Tool name options for dropdown.
 */
export const TOOL_NAME_OPTIONS: { value: TriggerToolName; label: string }[] = [
  { value: '', label: 'Any Tool' },
  { value: 'Bash', label: 'Bash' },
  { value: 'Task', label: 'Task' },
  { value: 'Read', label: 'Read' },
  { value: 'Write', label: 'Write' },
  { value: 'Edit', label: 'Edit' },
  { value: 'Grep', label: 'Grep' },
  { value: 'Glob', label: 'Glob' },
  { value: 'WebFetch', label: 'WebFetch' },
  { value: 'WebSearch', label: 'WebSearch' },
  { value: 'LSP', label: 'LSP' },
  { value: 'TodoWrite', label: 'TodoWrite' },
  { value: 'Skill', label: 'Skill' },
  { value: 'NotebookEdit', label: 'NotebookEdit' },
  { value: 'AskUserQuestion', label: 'AskUserQuestion' },
  { value: 'KillShell', label: 'KillShell' },
  { value: 'TaskOutput', label: 'TaskOutput' },
];

/**
 * Mode options for the trigger mode selector.
 */
export const MODE_OPTIONS: ModeConfig[] = [
  {
    value: 'error_status',
    label: 'Execution Error',
    labelKey: MODE_LABEL_KEYS.error_status,
    icon: AlertCircle,
  },
  {
    value: 'content_match',
    label: 'Content Pattern',
    labelKey: MODE_LABEL_KEYS.content_match,
    icon: Search,
  },
  {
    value: 'token_threshold',
    label: 'High Token Usage',
    labelKey: MODE_LABEL_KEYS.token_threshold,
    icon: Activity,
  },
];

export function getContentTypeLabelKey(contentType: TriggerContentType) {
  return CONTENT_TYPE_LABEL_KEYS[contentType];
}

export function getMatchFieldLabelKey(matchField: string) {
  return (
    MATCH_FIELD_LABEL_KEYS[matchField as keyof typeof MATCH_FIELD_LABEL_KEYS] ??
    MATCH_FIELD_LABEL_KEYS.fullInput
  );
}

export function getModeLabelKey(mode: keyof typeof MODE_LABEL_KEYS) {
  return MODE_LABEL_KEYS[mode];
}
