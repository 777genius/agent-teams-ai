import type { Tab } from '@renderer/types/tabs';

const TAB_TYPES: Record<Tab['type'], true> = {
  session: true,
  dashboard: true,
  notifications: true,
  settings: true,
  teams: true,
  organizations: true,
  team: true,
  report: true,
  extensions: true,
  schedules: true,
  graph: true,
  'token-usage': true,
};
const COUNT_FIELDS = [
  'paneCount',
  'tabCount',
  'memberCount',
  'taskCount',
  'dialogCount',
  'listboxCount',
  'textareaCount',
  'codeMirrorCount',
] as const;

// A displayName can contain user data. Only names owned by static application/dependency code may leave the renderer.
const COMPONENT_NAMES = new Set([
  'App',
  'ErrorBoundary',
  'ErrorBoundaryInner',
  'TeamDetailView',
  'TaskDetailDialog',
  'MemberDetailDialog',
  'MemberCard',
  'MemberList',
  'CurrentTaskIndicator',
  'MentionableTextarea',
  'AutoResizeTextarea',
  'MentionSuggestionsPopup',
  'MentionSuggestionList',
  'MentionInteractionLayer',
  'TaskReferenceInteractionLayer',
  'ChipInteractionLayer',
  'MessageComposer',
  'MessagesPanel',
  'MessagesThreadView',
  'ChangeReviewDialog',
  'DiffErrorBoundary',
  'EditorErrorBoundary',
  'LaunchTeamDialog',
  'TeamSidebarHost',
  'TeamSidebarPortalSource',
  'TeamSidebarPortalManager',
  'TabBar',
  'Tooltip',
  'TooltipTrigger',
  'TooltipContent',
  'TooltipProvider',
  'Popover',
  'PopoverAnchor',
  'PopoverContent',
  'Portal',
  'Presence',
  'DismissableLayer',
  'FocusScope',
  'PopperAnchor',
  'PopperContent',
  'Slot',
  'SlotClone',
]);

export function sanitizeSentryTabType(value: unknown): Tab['type'] | 'unknown' {
  return typeof value === 'string' && Object.hasOwn(TAB_TYPES, value)
    ? (value as Tab['type'])
    : 'unknown';
}

export function sanitizeRendererUiContext(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const context: Record<string, unknown> = {
    schemaVersion: 1,
    activeTabType: sanitizeSentryTabType(value.activeTabType),
    hasReview: value.hasReview === true,
    hasTaskDetail: value.hasTaskDetail === true,
  };
  for (const key of COUNT_FIELDS) {
    const count = value[key];
    context[key] =
      typeof count === 'number' && Number.isFinite(count)
        ? Math.min(10_000, Math.max(0, Math.floor(count)))
        : null;
  }
  return context;
}

export function sanitizeRendererReactContext(
  context?: Record<string, unknown>
): Record<string, unknown> | null {
  if (!context) return null;
  const stack = typeof context.componentStack === 'string' ? context.componentStack : '';
  const componentNames: string[] = [];
  for (const line of stack.slice(0, 16_384).split('\n').slice(0, 128)) {
    const name = /^\s*at ([A-Za-z_$][\w$]*)(?:\s+\(|\s*$)/.exec(line)?.[1];
    if (name && COMPONENT_NAMES.has(name)) componentNames.push(name);
    if (componentNames.length === 32) break;
  }
  return {
    activeTabType: sanitizeSentryTabType(context.activeTabType),
    hasComponentStack: stack.length > 0,
    componentNames,
  };
}

export function isMaximumUpdateDepthEvent(event: {
  type?: unknown;
  message?: unknown;
  exception?: { values?: { value?: unknown }[] };
}): boolean {
  if (event.type === 'transaction') return false;
  const values = [event.message, ...(event.exception?.values ?? []).map((value) => value.value)];
  return values.some(
    (value) =>
      typeof value === 'string' &&
      /Maximum update depth exceeded|Minified React error #185\b/i.test(value)
  );
}
