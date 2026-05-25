import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';

import type { ToolApprovalSettings } from '@shared/types';

const VALID_TIMEOUT_ACTIONS: ReadonlySet<ToolApprovalSettings['timeoutAction']> = new Set([
  'allow',
  'deny',
  'wait',
]);

export function parseToolApprovalSettings(raw: string | null): ToolApprovalSettings {
  if (!raw) return DEFAULT_TOOL_APPROVAL_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const d = DEFAULT_TOOL_APPROVAL_SETTINGS;
    return {
      autoAllowAll: typeof parsed.autoAllowAll === 'boolean' ? parsed.autoAllowAll : d.autoAllowAll,
      autoAllowFileEdits:
        typeof parsed.autoAllowFileEdits === 'boolean'
          ? parsed.autoAllowFileEdits
          : d.autoAllowFileEdits,
      autoAllowSafeBash:
        typeof parsed.autoAllowSafeBash === 'boolean'
          ? parsed.autoAllowSafeBash
          : d.autoAllowSafeBash,
      timeoutAction:
        typeof parsed.timeoutAction === 'string' &&
        VALID_TIMEOUT_ACTIONS.has(parsed.timeoutAction as ToolApprovalSettings['timeoutAction'])
          ? (parsed.timeoutAction as ToolApprovalSettings['timeoutAction'])
          : d.timeoutAction,
      timeoutSeconds:
        typeof parsed.timeoutSeconds === 'number' &&
        Number.isFinite(parsed.timeoutSeconds) &&
        parsed.timeoutSeconds >= 5 &&
        parsed.timeoutSeconds <= 300
          ? parsed.timeoutSeconds
          : d.timeoutSeconds,
    };
  } catch {
    return DEFAULT_TOOL_APPROVAL_SETTINGS;
  }
}
