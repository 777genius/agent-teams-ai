import type {
  MemberLogPreviewItem,
  MemberLogPreviewItemKind,
  MemberLogPreviewItemTone,
  MemberLogStreamProvider,
} from '../../../contracts';

export type MemberLogPreviewContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: 'image'; source?: unknown }
  | { type: string; [key: string]: unknown };

export interface MemberLogPreviewParsedMessage {
  uuid?: string;
  type?: string;
  role?: string;
  timestamp: Date | string;
  content: string | MemberLogPreviewContentBlock[];
  isMeta?: boolean;
  toolCalls?: readonly {
    id?: string;
    name?: string;
    callId?: string;
    toolName?: string;
    input?: unknown;
    isTask?: boolean;
  }[];
  toolResults?: readonly {
    toolUseId: string;
    content: unknown;
    isError?: boolean;
  }[];
  sourceToolUseID?: string;
  toolUseResult?: Record<string, unknown>;
  sessionId?: string;
}

export interface ExtractMemberLogPreviewInput {
  messages: readonly MemberLogPreviewParsedMessage[];
  provider: MemberLogStreamProvider;
  maxItems: number;
  textLimit: number;
  sourceId?: string;
  sourceLabel?: string;
  sessionId?: string;
  laneId?: string;
}

export interface ExtractMemberLogPreviewResult {
  items: MemberLogPreviewItem[];
  truncated: boolean;
  overflowCount: number;
}

interface Candidate {
  item: MemberLogPreviewItem;
  timestampMs: number;
  order: number;
  textTruncated: boolean;
  toolUseKey?: string;
  supersededByResult?: boolean;
}

const UNKNOWN_TIMESTAMP_MS = 0;
const TOOL_INPUT_PRIORITY_KEYS = [
  'command',
  'description',
  'summary',
  'text',
  'message',
  'comment',
  'prompt',
  'to',
  'filePath',
  'file_path',
  'path',
  'url',
  'query',
] as const;
const TOOL_RESULT_PRIORITY_KEYS = [
  'error',
  'stderr',
  'stdout',
  'content',
  'result',
  'summary',
  'message',
  'status',
] as const;

interface ValuePreview {
  preview: string;
  truncated: boolean;
  title?: string;
}

interface KnownPayloadPreview {
  title?: string;
  text: string;
}

interface ToolUseContext {
  id: string;
  name: string;
  canonicalName: string;
  input?: unknown;
}

interface ToolCallLike {
  id?: string;
  name?: string;
  callId?: string;
  toolName?: string;
  input?: unknown;
}

interface NormalizedToolCall {
  id: string;
  name: string;
  input?: unknown;
}

function timestampMs(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : UNKNOWN_TIMESTAMP_MS;
}

function timestampIso(value: Date | string): string {
  const time = timestampMs(value);
  return new Date(time || 0).toISOString();
}

function stripAngleTags(value: string): string {
  let result = '';
  let insideTag = false;
  for (const char of value) {
    if (char === '<') {
      insideTag = true;
      result += ' ';
      continue;
    }
    if (char === '>') {
      insideTag = false;
      result += ' ';
      continue;
    }
    if (!insideTag) {
      result += char;
    }
  }
  return result;
}

function compactWhitespace(value: string): string {
  return stripAngleTags(value).replace(/\s+/g, ' ').trim();
}

function removeHiddenInstructionBlocks(value: string): string {
  let result = value;
  for (const tag of [
    'info_for_agent',
    'opencode_runtime_identity',
    'opencode_app_message_delivery',
    'system-reminder',
  ]) {
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return result;
}

function looksLikeJsonPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function parseJsonLikeString(value: string): unknown {
  if (!looksLikeJsonPayload(value)) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncatePreview(value: string, limit: number): { preview: string; truncated: boolean } {
  const compact = compactWhitespace(value);
  if (compact.length <= limit) {
    return { preview: compact, truncated: false };
  }
  const allowed = Math.max(1, limit - 3);
  return { preview: `${compact.slice(0, allowed)}...`, truncated: true };
}

function stringifyPrimitive(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textFromTextContentBlocks(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const text = value
    .map((item) => {
      const record = asRecord(item);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join(' ');
  return text.trim().length > 0 ? text : null;
}

function textFromPreviewContent(content: string | MemberLogPreviewContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is Extract<MemberLogPreviewContentBlock, { type: 'text' }> => {
      return block.type === 'text' && typeof block.text === 'string';
    })
    .map((block) => block.text)
    .join(' ');
}

function unwrapAgentTeamsResponsePayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  wrapperKey?: string;
} {
  const wrapperKey = Object.keys(payload).find(
    (key) => key.startsWith('agent_teams_') && key.endsWith('_response')
  );
  if (!wrapperKey) {
    return { payload };
  }
  const nested = payload[wrapperKey];
  return { payload: asRecord(nested) ?? payload, wrapperKey };
}

function recordFromUnknownWithWrapper(
  value: unknown
): { payload: Record<string, unknown>; wrapperKey?: string } | null {
  const textBlocks = textFromTextContentBlocks(value);
  if (textBlocks) {
    return recordFromUnknownWithWrapper(textBlocks);
  }

  if (typeof value === 'string') {
    const parsed = parseJsonLikeString(value);
    const record = asRecord(parsed);
    return record ? unwrapAgentTeamsResponsePayload(record) : null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const nestedContent =
    typeof record.content === 'string' ? record.content : textFromTextContentBlocks(record.content);
  if (nestedContent) {
    const nested = recordFromUnknownWithWrapper(nestedContent);
    if (nested) {
      return nested;
    }
  }

  return unwrapAgentTeamsResponsePayload(record);
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return recordFromUnknownWithWrapper(value)?.payload ?? null;
}

function unknownPayloadLooksLikeError(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(unknownPayloadLooksLikeError);
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }

  const type = stringField(record, 'type')?.toLowerCase();
  if (type === 'error' || type?.endsWith('_error')) {
    return true;
  }
  if (
    record.ok === false ||
    record.success === false ||
    record.isError === true ||
    record.is_error === true
  ) {
    return true;
  }

  const error = record.error;
  if (typeof error === 'string' && error.trim().length > 0) {
    return true;
  }
  if (error === true) {
    return true;
  }
  const errorRecord = asRecord(error);
  if (
    errorRecord &&
    (stringField(errorRecord, 'type') ||
      stringField(errorRecord, 'message') ||
      stringField(errorRecord, 'code'))
  ) {
    return true;
  }

  return typeof record.errorMessage === 'string' && record.errorMessage.trim().length > 0;
}

function payloadErrorMessage(payload: Record<string, unknown>): string | null {
  const direct =
    stringField(payload, 'error') ??
    stringField(payload, 'errorMessage') ??
    stringField(payload, 'stderr') ??
    stringField(payload, 'message');
  if (direct) {
    return direct;
  }

  const nestedError = asRecord(payload.error);
  if (!nestedError) {
    return null;
  }
  const nestedType = stringField(nestedError, 'type')?.replace(/_/g, ' ');
  const nestedCode = stringField(nestedError, 'code');
  const nestedMessage = stringField(nestedError, 'message');
  if (nestedMessage) {
    return nestedMessage;
  }
  if (nestedType && nestedCode) {
    return `${nestedType} ${nestedCode}`;
  }
  return nestedType ?? nestedCode;
}

function parseJsonObjectFromText(value: string): Record<string, unknown> | null {
  const parsed = parseJsonLikeString(value);
  const direct = asRecord(parsed);
  if (direct) {
    return direct;
  }

  const jsonStart = value.indexOf('{');
  if (jsonStart <= 0) {
    return null;
  }
  return asRecord(parseJsonLikeString(value.slice(jsonStart)));
}

function runtimeErrorTitle(value: string, payload: Record<string, unknown> | null): string {
  const labelMatch = /^(api error|runtime error|provider error|tool error)\b/i.exec(value);
  if (labelMatch?.[1]) {
    const label = labelMatch[1].toLowerCase();
    if (label === 'api error') return 'API error';
    return `${label[0]?.toUpperCase()}${label.slice(1)}`;
  }
  const type = stringField(payload, 'type') ?? stringField(asRecord(payload?.error), 'type');
  if (type?.toLowerCase().includes('api')) {
    return 'API error';
  }
  return 'Runtime error';
}

function formatRuntimeErrorText(
  value: string,
  limit: number
): (ValuePreview & { title: string }) | null {
  const compact = compactWhitespace(value);
  if (!compact) {
    return null;
  }

  const payload = parseJsonObjectFromText(compact);
  const hasErrorSignal =
    /^(api error|runtime error|provider error|tool error)\b/i.test(compact) ||
    /\b(api|codex|claude|openai|anthropic)\s+api\s+error\b/i.test(compact) ||
    /\b(api|codex|claude|openai|anthropic|provider)\s+error\s*:\s*\d{3}\b/i.test(compact) ||
    unknownPayloadLooksLikeError(payload);

  if (!hasErrorSignal) {
    return null;
  }

  const title = runtimeErrorTitle(compact, payload);
  const jsonStart = compact.indexOf('{');
  const header = jsonStart > 0 ? compact.slice(0, jsonStart).trim() : '';
  const payloadMessage = payload ? payloadErrorMessage(payload) : null;
  const text =
    payloadMessage && header && !header.toLowerCase().includes(payloadMessage.toLowerCase())
      ? `${header} - ${payloadMessage}`
      : (payloadMessage ?? header);
  return { ...truncatePreview(text || 'Runtime error', limit), title };
}

function findPriorityValue(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = stringifyPrimitive(record[key]);
    if (value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function canonicalToolName(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  const doubleUnderscoreName = lower.split('__').at(-1) ?? lower;
  return doubleUnderscoreName
    .replace(/^agent-teams_/, '')
    .replace(/^agent_teams_/, '')
    .replace(/^mcp_/, '');
}

function canonicalToolNameFromWrapperKey(value: string | undefined): string | null {
  if (!value) return null;
  return (
    value
      .replace(/^agent_teams_/, '')
      .replace(/_response$/, '')
      .trim()
      .toLowerCase() || null
  );
}

function humanizeFallbackToolName(toolName: string): string {
  const stripped = canonicalToolName(toolName);
  if (!stripped) return 'Tool use';
  const compact = stripped.replace(/[_-]+/g, ' ').trim();
  if (!compact) return toolName.trim() || 'Tool use';
  const lower = compact.toLowerCase();
  if (lower === 'bash' || lower === 'shell') return 'Bash';
  if (lower === 'read') return 'Read';
  if (lower === 'write') return 'Write';
  if (lower === 'edit') return 'Edit';
  if (lower === 'grep') return 'Grep';
  if (lower === 'glob') return 'Glob';
  if (lower === 'ls') return 'List files';
  return compact
    .split(' ')
    .map((part) => (part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part))
    .join(' ');
}

function formatToolTitle(toolName: string): string {
  const canonical = canonicalToolName(toolName);
  if (canonical === 'sendmessage' || canonical === 'message_send') return 'Send message';
  if (canonical === 'cross_team_send') return 'Cross-team message';
  if (canonical === 'runtime_deliver_message') return 'Runtime delivery';
  if (canonical === 'runtime_task_event') return 'Runtime task event';
  if (canonical === 'runtime_heartbeat') return 'Runtime heartbeat';
  if (canonical === 'task_create' || canonical === 'task_create_from_message') return 'Create task';
  if (canonical === 'task_complete') return 'Complete task';
  if (canonical === 'task_add_comment') return 'Add comment';
  if (canonical === 'task_get_comment') return 'Read comment';
  if (canonical === 'task_get') return 'Read task';
  if (canonical === 'task_list') return 'List tasks';
  if (canonical === 'task_briefing') return 'Task briefing';
  if (canonical === 'task_start') return 'Start task';
  if (canonical === 'task_set_status') return 'Set status';
  if (canonical === 'task_set_owner') return 'Set owner';
  if (canonical === 'task_set_clarification') return 'Set clarification';
  if (canonical === 'task_attach_file') return 'Attach file';
  if (canonical === 'task_attach_comment_file') return 'Attach comment file';
  if (canonical === 'task_link') return 'Link tasks';
  if (canonical === 'task_unlink') return 'Unlink tasks';
  if (canonical === 'task_restore') return 'Restore task';
  if (canonical === 'review_request') return 'Request review';
  if (canonical === 'review_start') return 'Start review';
  if (canonical === 'review_approve') return 'Approve review';
  if (canonical === 'review_request_changes') return 'Request changes';
  if (canonical === 'runtime_bootstrap_checkin') return 'Runtime check-in';
  if (canonical === 'member_briefing') return 'Member briefing';
  if (canonical === 'member_work_sync_status') return 'Work sync status';
  if (canonical === 'member_work_sync_report') return 'Work sync report';
  if (canonical === 'task_add') return 'Add task';
  if (canonical === 'task_update') return 'Update task';
  if (canonical === 'task_delete') return 'Delete task';
  if (canonical === 'process_list') return 'List processes';
  return humanizeFallbackToolName(toolName);
}

function formatGenericToolResultTitle(
  toolContext: ToolUseContext | undefined,
  isError: boolean
): string {
  if (!toolContext) {
    return isError ? 'Tool error' : 'Tool result';
  }
  return `${formatToolTitle(toolContext.name)} ${isError ? 'error' : 'result'}`;
}

function buildToolUseKey(input: {
  provider: MemberLogStreamProvider;
  sourceId: string;
  toolUseId: string;
}): string {
  return [input.provider, input.sourceId, input.toolUseId.trim()].join(':');
}

function isToolUseSupersededBySuccessResult(toolName: string): boolean {
  const canonical = canonicalToolName(toolName);
  return (
    canonical === 'sendmessage' ||
    canonical === 'message_send' ||
    canonical === 'cross_team_send' ||
    canonical === 'runtime_deliver_message' ||
    canonical === 'runtime_bootstrap_checkin' ||
    canonical === 'runtime_heartbeat' ||
    canonical === 'runtime_task_event' ||
    canonical === 'member_briefing' ||
    canonical === 'member_work_sync_status' ||
    canonical === 'member_work_sync_report' ||
    canonical.startsWith('task_') ||
    canonical.startsWith('review_')
  );
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function formatTaskRef(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const shortRef =
    withoutHash.includes('-') && withoutHash.length > 12 ? withoutHash.slice(0, 8) : withoutHash;
  return `#${shortRef}`;
}

function taskRefFromPayload(
  payload: Record<string, unknown>,
  fallbackInput?: Record<string, unknown> | null
): string | null {
  const task = asRecord(payload.task);
  return formatTaskRef(
    stringField(payload, 'displayId') ??
      stringField(task, 'displayId') ??
      stringField(payload, 'taskId') ??
      stringField(fallbackInput ?? undefined, 'taskId') ??
      stringField(payload, 'id') ??
      stringField(task, 'id')
  );
}

function shortTaskSummary(task: Record<string, unknown> | undefined): string | null {
  const title =
    stringField(task, 'title') ?? stringField(task, 'subject') ?? stringField(task, 'name');
  const status = stringField(task, 'status');
  const owner = stringField(task, 'owner');
  const parts = [title, status ? `status ${status}` : null, owner ? `owner ${owner}` : null].filter(
    Boolean
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

function formatTaskStatusPayload(
  payload: Record<string, unknown>,
  fallbackInput?: Record<string, unknown> | null
): string | null {
  const taskRef = taskRefFromPayload(payload, fallbackInput);
  const status = stringField(payload, 'status') ?? stringField(asRecord(payload.task), 'status');
  if (!taskRef || !status) {
    return null;
  }
  return `Task ${taskRef} ${status}`;
}

function formatTaskCommentPayload(
  payload: Record<string, unknown>,
  fallbackInput?: Record<string, unknown> | null
): string | null {
  const commentRecord = asRecord(payload.comment) ?? undefined;
  const commentText =
    stringField(commentRecord, 'text') ??
    stringField(payload, 'text') ??
    stringField(payload, 'comment') ??
    stringField(fallbackInput ?? undefined, 'text');
  const taskRef = taskRefFromPayload(payload, fallbackInput);
  if (!commentText) {
    return taskRef ? `Comment added to ${taskRef}` : null;
  }

  const author =
    stringField(commentRecord, 'author') ??
    stringField(payload, 'author') ??
    stringField(fallbackInput ?? undefined, 'from') ??
    stringField(fallbackInput ?? undefined, 'author');
  if (author && taskRef) return `Comment by ${author} on ${taskRef}: ${commentText}`;
  if (author) return `Comment by ${author}: ${commentText}`;
  if (taskRef) return `Comment on ${taskRef}: ${commentText}`;
  return `Comment: ${commentText}`;
}

function countArrayField(payload: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return null;
}

function formatTaskCollectionItem(task: Record<string, unknown>): string | null {
  const taskRef = taskRefFromPayload(task);
  const taskSummary = shortTaskSummary(task);
  if (taskRef && taskSummary) return `${taskRef}: ${taskSummary}`;
  if (taskRef) return taskRef;
  return taskSummary;
}

function formatTaskCollectionArrayPayload(
  items: readonly unknown[],
  canonicalToolNameValue: string | null
): KnownPayloadPreview | null {
  const canonical = canonicalToolNameValue ?? '';
  if (canonical !== 'task_list' && canonical !== 'task_briefing') {
    return null;
  }

  const tasks = items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
  if (tasks.length === 0) {
    return {
      title: canonical === 'task_briefing' ? 'Task briefing' : 'Task list',
      text: '0 tasks',
    };
  }

  const taskSummaries = tasks.slice(0, 3).map(formatTaskCollectionItem).filter(Boolean);
  const remainingTaskCount = Math.max(0, tasks.length - taskSummaries.length);
  const moreText = remainingTaskCount > 0 ? `; +${remainingTaskCount} more` : '';
  const countText = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`;
  return {
    title: canonical === 'task_briefing' ? 'Task briefing' : 'Task list',
    text:
      taskSummaries.length > 0
        ? `${countText} - ${taskSummaries.join('; ')}${moreText}`
        : countText,
  };
}

function formatTaskCollectionPayload(payload: Record<string, unknown>): KnownPayloadPreview | null {
  for (const key of ['tasks', 'items', 'actionable'] as const) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    const collection = formatTaskCollectionArrayPayload(value, 'task_list');
    if (collection) {
      return collection;
    }
  }

  const taskCount = countArrayField(payload, ['tasks', 'items', 'actionable']);
  const summary =
    stringField(payload, 'summary') ??
    stringField(payload, 'message') ??
    stringField(payload, 'text');
  if (taskCount != null) {
    return {
      title: 'Task list',
      text: summary ? `${taskCount} tasks - ${summary}` : `${taskCount} tasks`,
    };
  }
  return summary ? { title: 'Task list', text: summary } : null;
}

function formatProcessCollectionPayload(
  payload: Record<string, unknown>
): KnownPayloadPreview | null {
  const rawProcesses =
    (Array.isArray(payload.processes) ? payload.processes : null) ??
    (Array.isArray(payload.items) ? payload.items : null);
  if (rawProcesses) {
    const processes = rawProcesses
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
    const processSummaries = processes
      .slice(0, 3)
      .map((process) => {
        const label =
          stringField(process, 'label') ??
          stringField(process, 'name') ??
          stringField(process, 'command') ??
          stringField(process, 'pid');
        const status = stringField(process, 'status');
        if (label && status) return `${label} ${status}`;
        return label ?? status;
      })
      .filter(Boolean);
    const remainingCount = Math.max(0, processes.length - processSummaries.length);
    const moreText = remainingCount > 0 ? `; +${remainingCount} more` : '';
    const countText = `${processes.length} ${processes.length === 1 ? 'process' : 'processes'}`;
    return {
      title: 'Process list',
      text:
        processSummaries.length > 0
          ? `${countText} - ${processSummaries.join('; ')}${moreText}`
          : countText,
    };
  }

  const processCount = countArrayField(payload, ['processes', 'items']);
  if (processCount != null) {
    return { title: 'Process list', text: `${processCount} processes` };
  }
  return null;
}

function formatProcessCollectionArrayPayload(items: readonly unknown[]): KnownPayloadPreview {
  const processes = items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const processSummaries = processes
    .slice(0, 3)
    .map((process) => {
      const label =
        stringField(process, 'label') ??
        stringField(process, 'name') ??
        stringField(process, 'command') ??
        stringifyPrimitive(process.pid);
      const status = stringField(process, 'status');
      if (label && status) return `${label} ${status}`;
      return label || status;
    })
    .filter(Boolean);
  const remainingCount = Math.max(0, processes.length - processSummaries.length);
  const moreText = remainingCount > 0 ? `; +${remainingCount} more` : '';
  const countText = `${processes.length} ${processes.length === 1 ? 'process' : 'processes'}`;
  return {
    title: 'Process list',
    text:
      processSummaries.length > 0
        ? `${countText} - ${processSummaries.join('; ')}${moreText}`
        : countText,
  };
}

function formatRelationshipPayload(
  payload: Record<string, unknown>,
  fallbackInput?: Record<string, unknown> | null
): string | null {
  const sourceRef = taskRefFromPayload(payload, fallbackInput);
  const targetRef = formatTaskRef(
    stringField(payload, 'targetId') ??
      stringField(payload, 'targetTaskId') ??
      stringField(fallbackInput ?? undefined, 'targetId') ??
      stringField(fallbackInput ?? undefined, 'targetTaskId')
  );
  const relationship =
    stringField(payload, 'relationship') ?? stringField(fallbackInput ?? undefined, 'relationship');
  if (sourceRef && targetRef && relationship) return `${sourceRef} ${relationship} ${targetRef}`;
  if (sourceRef && targetRef) return `${sourceRef} -> ${targetRef}`;
  if (sourceRef) return sourceRef;
  return targetRef;
}

function formatReviewChangesText(
  payload: Record<string, unknown>,
  fallbackInput?: Record<string, unknown> | null
): string | null {
  return (
    stringField(payload, 'comment') ??
    stringField(payload, 'note') ??
    stringField(payload, 'message') ??
    stringField(fallbackInput ?? undefined, 'comment') ??
    stringField(fallbackInput ?? undefined, 'note') ??
    stringField(fallbackInput ?? undefined, 'message')
  );
}

function formatTaskToolPayload(
  payload: Record<string, unknown>,
  canonicalToolNameValue: string | null,
  fallbackInput?: Record<string, unknown> | null
): KnownPayloadPreview | null {
  const canonical = canonicalToolNameValue ?? '';
  const taskRef = taskRefFromPayload(payload, fallbackInput);
  const task = asRecord(payload.task) ?? undefined;
  const taskSummary = shortTaskSummary(task);
  const status = stringField(payload, 'status') ?? stringField(task, 'status');
  const owner =
    stringField(payload, 'owner') ??
    stringField(task, 'owner') ??
    stringField(fallbackInput ?? undefined, 'owner');
  const clarification =
    stringField(payload, 'clarification') ??
    stringField(fallbackInput ?? undefined, 'clarification');
  const filename =
    stringField(payload, 'filename') ??
    stringField(payload, 'fileName') ??
    stringField(payload, 'path') ??
    stringField(payload, 'filePath') ??
    stringField(fallbackInput ?? undefined, 'filename') ??
    stringField(fallbackInput ?? undefined, 'fileName') ??
    stringField(fallbackInput ?? undefined, 'path') ??
    stringField(fallbackInput ?? undefined, 'filePath');

  if (canonical === 'task_add_comment') {
    const text = formatTaskCommentPayload(payload, fallbackInput);
    return text ? { title: 'Comment added', text } : null;
  }
  if (canonical === 'task_get_comment') {
    const text = formatTaskCommentPayload(payload, fallbackInput);
    if (text) return { title: 'Comment loaded', text };
    const commentId =
      stringField(payload, 'commentId') ?? stringField(fallbackInput ?? undefined, 'commentId');
    if (taskRef && commentId) {
      return { title: 'Comment loaded', text: `${commentId} on ${taskRef}` };
    }
    return taskRef ? { title: 'Comment loaded', text: `Loaded comment on ${taskRef}` } : null;
  }
  if (canonical === 'task_create' || canonical === 'task_create_from_message') {
    if (taskRef && taskSummary) {
      return { title: 'Task created', text: `${taskRef}: ${taskSummary}` };
    }
    if (taskRef) return { title: 'Task created', text: `Created ${taskRef}` };
  }
  if (canonical === 'task_add') {
    if (taskRef && taskSummary) return { title: 'Task added', text: `${taskRef}: ${taskSummary}` };
    if (taskRef) return { title: 'Task added', text: `Added ${taskRef}` };
  }
  if (canonical === 'task_update') {
    if (taskRef && status) return { title: 'Task updated', text: `${taskRef} -> ${status}` };
    if (taskRef && taskSummary)
      return { title: 'Task updated', text: `${taskRef}: ${taskSummary}` };
    if (taskRef) return { title: 'Task updated', text: `Updated ${taskRef}` };
  }
  if (canonical === 'task_delete') {
    return taskRef ? { title: 'Task deleted', text: `Deleted ${taskRef}` } : null;
  }
  if (canonical === 'task_list' || canonical === 'task_briefing') {
    const collectionText = formatTaskCollectionPayload(payload);
    if (collectionText) {
      return {
        title: canonical === 'task_briefing' ? 'Task briefing' : collectionText.title,
        text: collectionText.text,
      };
    }
  }
  if (canonical === 'task_start') {
    return taskRef ? { title: 'Task started', text: `Started ${taskRef}` } : null;
  }
  if (canonical === 'task_complete') {
    return taskRef ? { title: 'Task completed', text: `Completed ${taskRef}` } : null;
  }
  if (canonical === 'task_get') {
    if (taskRef && taskSummary) return { title: 'Task loaded', text: `${taskRef}: ${taskSummary}` };
    return taskRef ? { title: 'Task loaded', text: `Loaded ${taskRef}` } : null;
  }
  if (canonical === 'task_set_status') {
    if (taskRef && status) return { title: 'Task status', text: `${taskRef} -> ${status}` };
    return taskRef ? { title: 'Task status', text: `Updated ${taskRef}` } : null;
  }
  if (canonical === 'task_set_owner') {
    if (taskRef && owner) return { title: 'Task owner', text: `${taskRef} -> ${owner}` };
    return taskRef ? { title: 'Task owner', text: `Updated ${taskRef}` } : null;
  }
  if (canonical === 'task_set_clarification') {
    if (taskRef && clarification) {
      return { title: 'Clarification', text: `${taskRef} -> ${clarification}` };
    }
    return taskRef ? { title: 'Clarification', text: `Updated ${taskRef}` } : null;
  }
  if (canonical === 'task_attach_comment_file') {
    if (taskRef && filename) return { title: 'Comment file', text: `${filename} on ${taskRef}` };
    return taskRef ? { title: 'Comment file', text: `Attached file to ${taskRef}` } : null;
  }
  if (canonical === 'task_attach_file') {
    if (taskRef && filename) return { title: 'Task file', text: `${filename} on ${taskRef}` };
    return taskRef ? { title: 'Task file', text: `Attached file to ${taskRef}` } : null;
  }
  if (canonical === 'task_link' || canonical === 'task_unlink') {
    const relationshipText = formatRelationshipPayload(payload, fallbackInput);
    if (relationshipText) {
      return {
        title: canonical === 'task_link' ? 'Tasks linked' : 'Tasks unlinked',
        text: relationshipText,
      };
    }
  }
  if (canonical === 'review_request') {
    const reviewer =
      stringField(payload, 'reviewer') ?? stringField(fallbackInput ?? undefined, 'reviewer');
    if (taskRef && reviewer)
      return { title: 'Review requested', text: `${taskRef} -> ${reviewer}` };
    return taskRef ? { title: 'Review requested', text: `Requested review for ${taskRef}` } : null;
  }
  if (canonical === 'review_start') {
    return taskRef ? { title: 'Review started', text: `Started review for ${taskRef}` } : null;
  }
  if (canonical === 'review_approve') {
    const note = formatReviewChangesText(payload, fallbackInput);
    if (taskRef && note) return { title: 'Review approved', text: `${taskRef}: ${note}` };
    return taskRef ? { title: 'Review approved', text: `Approved ${taskRef}` } : null;
  }
  if (canonical === 'review_request_changes') {
    const comment = formatReviewChangesText(payload, fallbackInput);
    if (taskRef && comment) return { title: 'Changes requested', text: `${taskRef}: ${comment}` };
    return taskRef
      ? { title: 'Changes requested', text: `Requested changes for ${taskRef}` }
      : null;
  }
  if (canonical === 'task_restore') {
    return taskRef ? { title: 'Task restored', text: `Restored ${taskRef}` } : null;
  }
  if (taskRef && status) {
    return { title: 'Task update', text: `Task ${taskRef} ${status}` };
  }
  if (taskRef && taskSummary) {
    return { title: 'Task update', text: `${taskRef}: ${taskSummary}` };
  }
  return null;
}

function formatRuntimePayload(
  payload: Record<string, unknown>,
  canonicalToolNameValue: string | null,
  fallbackInput?: Record<string, unknown> | null
): KnownPayloadPreview | null {
  const canonical = canonicalToolNameValue ?? '';
  const memberName =
    stringField(payload, 'memberName') ??
    stringField(payload, 'fromMemberName') ??
    stringField(fallbackInput ?? undefined, 'memberName') ??
    stringField(fallbackInput ?? undefined, 'fromMemberName');
  if (canonical === 'runtime_bootstrap_checkin') {
    return {
      title: 'Runtime check-in',
      text: memberName ? `${memberName} checked in` : 'Runtime checked in',
    };
  }
  if (canonical === 'runtime_heartbeat') {
    return {
      title: 'Runtime heartbeat',
      text: memberName ? `${memberName} heartbeat` : 'Runtime heartbeat',
    };
  }
  if (canonical === 'runtime_task_event') {
    const taskRef = taskRefFromPayload(payload, fallbackInput);
    const event =
      stringField(payload, 'event') ??
      stringField(payload, 'kind') ??
      stringField(fallbackInput ?? undefined, 'event') ??
      stringField(fallbackInput ?? undefined, 'kind');
    const actor = memberName ? `${memberName} ` : '';
    if (taskRef && event) {
      return { title: 'Runtime task event', text: `${actor}${event} ${taskRef}` };
    }
    if (taskRef) return { title: 'Runtime task event', text: `${actor}${taskRef}` };
    if (event) return { title: 'Runtime task event', text: `${actor}${event}` };
  }
  if (canonical === 'member_briefing') {
    return {
      title: 'Member briefing',
      text: memberName ? `Loaded briefing for ${memberName}` : 'Loaded member briefing',
    };
  }
  return null;
}

function formatWorkSyncPayload(
  payload: Record<string, unknown>,
  canonicalToolNameValue: string | null,
  fallbackInput?: Record<string, unknown> | null
): KnownPayloadPreview | null {
  const canonical = canonicalToolNameValue ?? '';
  if (canonical !== 'member_work_sync_status' && canonical !== 'member_work_sync_report') {
    return null;
  }

  const state =
    stringField(payload, 'state') ??
    stringField(payload, 'status') ??
    stringField(fallbackInput ?? undefined, 'state') ??
    stringField(fallbackInput ?? undefined, 'status');
  const memberName =
    stringField(payload, 'memberName') ?? stringField(fallbackInput ?? undefined, 'memberName');
  const rawTaskIds = Array.isArray(payload.taskIds)
    ? payload.taskIds
    : Array.isArray(fallbackInput?.taskIds)
      ? fallbackInput.taskIds
      : [];
  const taskRefs = [
    ...new Set(
      rawTaskIds
        .map((taskId) => (typeof taskId === 'string' ? formatTaskRef(taskId) : null))
        .filter((taskRef): taskRef is string => Boolean(taskRef))
    ),
  ].slice(0, 3);
  const taskText = taskRefs.length > 0 ? ` ${taskRefs.join(', ')}` : '';
  const memberText = memberName ? `${memberName} ` : '';
  const stateText = state ? `${state}${taskText}` : `updated${taskText}`;

  return {
    title: canonical === 'member_work_sync_status' ? 'Work sync status' : 'Work sync report',
    text: `${memberText}${stateText}`.trim(),
  };
}

function formatErrorPayload(payload: Record<string, unknown>): KnownPayloadPreview | null {
  if (unknownPayloadLooksLikeError(payload)) {
    return { title: 'Tool error', text: payloadErrorMessage(payload) ?? 'Tool reported failure' };
  }
  return null;
}

function formatMessageSendPayload(payload: Record<string, unknown>): string | null {
  const routing = asRecord(payload.routing) ?? undefined;
  const messageRecord = asRecord(payload.message) ?? undefined;
  const deliveryMessage = stringField(payload, 'message');
  const summary = stringField(messageRecord, 'summary') ?? stringField(routing, 'summary');
  const target = stringField(messageRecord, 'to') ?? stringField(routing, 'target');
  const messageText =
    stringField(messageRecord, 'text') ??
    stringField(messageRecord, 'content') ??
    stringField(routing, 'content');

  if (deliveryMessage && summary) return `${deliveryMessage} - ${summary}`;
  if (summary && target) return `Message sent to ${target} - ${summary}`;
  if (summary) return summary;
  if (deliveryMessage) return deliveryMessage;
  if (messageText && target) return `Message sent to ${target} - ${messageText}`;
  if (messageText) return messageText;
  if (target) return `Message sent to ${target}`;
  return null;
}

function looksLikeMessageSendPayload(payload: Record<string, unknown>): boolean {
  const routing = asRecord(payload.routing);
  const messageRecord = asRecord(payload.message);
  if (payload.deliveredToInbox === true || routing) {
    return true;
  }
  return Boolean(
    messageRecord &&
    (stringField(messageRecord, 'to') ||
      stringField(messageRecord, 'from') ||
      stringField(messageRecord, 'summary') ||
      stringField(messageRecord, 'text') ||
      stringField(messageRecord, 'content'))
  );
}

function formatMessageSendResultFromInput(payload: Record<string, unknown>): string | null {
  const target = stringField(payload, 'to') ?? stringField(payload, 'target');
  const summary =
    stringField(payload, 'summary') ??
    stringField(payload, 'text') ??
    stringField(payload, 'message') ??
    stringField(payload, 'content');
  if (target && summary) return `Message sent to ${target} - ${summary}`;
  if (target) return `Message sent to ${target}`;
  if (summary) return summary;
  return null;
}

function formatMessageSendInputPayload(payload: Record<string, unknown>): string | null {
  const target = stringField(payload, 'to') ?? stringField(payload, 'target');
  const summary =
    stringField(payload, 'summary') ??
    stringField(payload, 'text') ??
    stringField(payload, 'message') ??
    stringField(payload, 'content');
  if (target && summary) return `to ${target}: ${summary}`;
  if (summary) return summary;
  if (target) return `to ${target}`;
  return null;
}

function formatCrossTeamPayload(payload: Record<string, unknown>): string | null {
  const routing = asRecord(payload.routing) ?? undefined;
  const target =
    stringField(payload, 'toTeam') ??
    stringField(payload, 'targetTeam') ??
    stringField(routing, 'toTeam') ??
    stringField(routing, 'targetTeam') ??
    stringField(routing, 'target');
  const summary =
    stringField(payload, 'summary') ??
    stringField(payload, 'message') ??
    stringField(payload, 'text') ??
    stringField(payload, 'content') ??
    stringField(routing, 'summary') ??
    stringField(routing, 'content');
  if (target && summary) return `to ${target}: ${summary}`;
  if (target) return `to ${target}`;
  if (summary) return summary;
  return null;
}

function formatPlainToolResultStatus(
  value: string,
  toolContext: ToolUseContext | undefined
): KnownPayloadPreview | null {
  if (!toolContext) {
    return null;
  }
  if (toolContext.canonicalName === 'member_briefing') {
    const memberMatch = /^member briefing for\s+([^\s]+)\s+on team\b/i.exec(
      compactWhitespace(value)
    );
    const memberName =
      memberMatch?.[1] ??
      stringField(asRecord(toolContext.input), 'memberName') ??
      stringField(asRecord(toolContext.input), 'member');
    return {
      title: 'Member briefing',
      text: memberName ? `Loaded briefing for ${memberName}` : 'Loaded member briefing',
    };
  }
  const normalized = compactWhitespace(value).toLowerCase();
  if (!['ok', 'done', 'success', 'comment added', 'message sent'].includes(normalized)) {
    return null;
  }
  const fallbackInput = asRecord(toolContext.input);
  if (toolContext.canonicalName === 'sendmessage' || toolContext.canonicalName === 'message_send') {
    const text = fallbackInput ? formatMessageSendResultFromInput(fallbackInput) : null;
    return text ? { title: 'Message sent', text } : null;
  }
  if (toolContext.canonicalName === 'cross_team_send') {
    const text = fallbackInput ? formatCrossTeamPayload(fallbackInput) : null;
    return text ? { title: 'Cross-team message', text } : null;
  }
  if (
    toolContext.canonicalName === 'member_work_sync_status' ||
    toolContext.canonicalName === 'member_work_sync_report'
  ) {
    return formatWorkSyncPayload({}, toolContext.canonicalName, fallbackInput);
  }
  return (
    formatTaskToolPayload({}, toolContext.canonicalName, fallbackInput) ??
    formatRuntimePayload({}, toolContext.canonicalName, fallbackInput)
  );
}

function formatPlainToolErrorText(value: string, limit: number): ValuePreview | null {
  const compact = compactWhitespace(value);
  if (!compact) {
    return null;
  }

  const looksLikeError =
    /\bexecution failed\b/i.test(compact) ||
    /\bfailed without output\b/i.test(compact) ||
    /\btool\b[^.]{0,80}\bfailed\b/i.test(compact) ||
    /\btask not found\b/i.test(compact) ||
    /\bpermission denied\b/i.test(compact) ||
    /\b(error|exception|traceback)\s*:/i.test(compact);

  return looksLikeError ? { ...truncatePreview(compact, limit), title: 'Tool error' } : null;
}

function formatTaskToolInputPayload(
  canonicalToolNameValue: string,
  payload: Record<string, unknown>
): string | null {
  const taskRef = taskRefFromPayload(payload, payload);
  const text = stringField(payload, 'text') ?? stringField(payload, 'comment');
  const status = stringField(payload, 'status');
  const owner = stringField(payload, 'owner');
  const clarification = stringField(payload, 'clarification');
  const reviewer = stringField(payload, 'reviewer');
  const commentId = stringField(payload, 'commentId');
  const filename =
    stringField(payload, 'filename') ??
    stringField(payload, 'fileName') ??
    stringField(payload, 'filePath');
  const relationship = formatRelationshipPayload(payload, payload);
  const reviewText = formatReviewChangesText(payload, payload);

  if (canonicalToolNameValue === 'task_add_comment') {
    if (taskRef && text) return `on ${taskRef}: ${text}`;
    if (taskRef) return `on ${taskRef}`;
    if (text) return text;
    return null;
  }
  if (canonicalToolNameValue === 'task_get_comment') {
    if (taskRef && commentId) return `${commentId} on ${taskRef}`;
    if (taskRef) return `comment on ${taskRef}`;
  }
  if (canonicalToolNameValue === 'task_set_status') {
    if (taskRef && status) return `${taskRef} -> ${status}`;
  }
  if (canonicalToolNameValue === 'task_set_owner') {
    if (taskRef && owner) return `${taskRef} -> ${owner}`;
  }
  if (canonicalToolNameValue === 'task_set_clarification') {
    if (taskRef && clarification) return `${taskRef} -> ${clarification}`;
  }
  if (canonicalToolNameValue === 'review_request') {
    if (taskRef && reviewer) return `${taskRef} -> ${reviewer}`;
  }
  if (
    canonicalToolNameValue === 'review_approve' ||
    canonicalToolNameValue === 'review_request_changes'
  ) {
    if (taskRef && reviewText) return `${taskRef}: ${reviewText}`;
  }
  if (
    canonicalToolNameValue === 'task_attach_file' ||
    canonicalToolNameValue === 'task_attach_comment_file'
  ) {
    if (taskRef && filename) return `${filename} on ${taskRef}`;
  }
  if (canonicalToolNameValue === 'task_link' || canonicalToolNameValue === 'task_unlink') {
    if (relationship) return relationship;
  }
  if (taskRef) return taskRef;
  return null;
}

function formatKnownPayloadPreview(
  value: unknown,
  toolContext?: ToolUseContext
): KnownPayloadPreview | null {
  const record = recordFromUnknownWithWrapper(value);
  if (!record) {
    return null;
  }
  const payload = record.payload;
  const fallbackInput = asRecord(toolContext?.input);
  const canonical =
    toolContext?.canonicalName ?? canonicalToolNameFromWrapperKey(record.wrapperKey) ?? null;

  const errorText = formatErrorPayload(payload);
  if (errorText) {
    return errorText;
  }
  const taskToolText = formatTaskToolPayload(payload, canonical, fallbackInput);
  if (taskToolText) {
    return taskToolText;
  }
  const runtimeText = formatRuntimePayload(payload, canonical, fallbackInput);
  if (runtimeText) {
    return runtimeText;
  }
  const workSyncText = formatWorkSyncPayload(payload, canonical, fallbackInput);
  if (workSyncText) {
    return workSyncText;
  }
  if (canonical === 'process_list') {
    const processText = formatProcessCollectionPayload(payload);
    if (processText) {
      return processText;
    }
  }
  if (canonical === 'cross_team_send') {
    const crossTeamText = formatCrossTeamPayload(payload);
    if (crossTeamText) {
      return { title: 'Cross-team message', text: crossTeamText };
    }
  }
  const messageText =
    canonical === 'sendmessage' ||
    canonical === 'message_send' ||
    looksLikeMessageSendPayload(payload)
      ? formatMessageSendPayload(payload)
      : null;
  if (messageText) {
    return { title: 'Message sent', text: messageText };
  }
  const commentText = formatTaskCommentPayload(payload);
  if (commentText) {
    return { title: 'Comment', text: commentText };
  }
  const taskText = formatTaskStatusPayload(payload, fallbackInput);
  if (taskText) {
    return { title: 'Task update', text: taskText };
  }
  return null;
}

function previewUnknownValue(
  value: unknown,
  limit: number,
  priorityKeys: readonly string[],
  toolContext?: ToolUseContext
): ValuePreview {
  if (typeof value === 'string') {
    const known = formatKnownPayloadPreview(value, toolContext);
    if (known) {
      return { ...truncatePreview(known.text, limit), title: known.title };
    }
    const plainError = formatPlainToolErrorText(value, limit);
    if (plainError) {
      return plainError;
    }
    const plainStatus = formatPlainToolResultStatus(value, toolContext);
    if (plainStatus) {
      return { ...truncatePreview(plainStatus.text, limit), title: plainStatus.title };
    }
    const parsed = parseJsonLikeString(value);
    if (parsed != null) {
      return previewUnknownValue(parsed, limit, priorityKeys, toolContext);
    }
    return truncatePreview(value, limit);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { preview: String(value), truncated: false };
  }
  if (Array.isArray(value)) {
    const textBlocks = textFromTextContentBlocks(value);
    if (textBlocks) {
      return previewUnknownValue(textBlocks, limit, priorityKeys, toolContext);
    }
    const knownCollection = formatTaskCollectionArrayPayload(
      value,
      toolContext?.canonicalName ?? null
    );
    if (knownCollection) {
      return { ...truncatePreview(knownCollection.text, limit), title: knownCollection.title };
    }
    if (toolContext?.canonicalName === 'process_list') {
      const processCollection = formatProcessCollectionArrayPayload(value);
      return { ...truncatePreview(processCollection.text, limit), title: processCollection.title };
    }
    const parts = value
      .slice(0, 3)
      .map((item) => previewUnknownValue(item, limit, priorityKeys, toolContext).preview)
      .filter(Boolean);
    return truncatePreview(parts.join(' '), limit);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const known = formatKnownPayloadPreview(record, toolContext);
    if (known) {
      return { ...truncatePreview(known.text, limit), title: known.title };
    }
    for (const key of ['content', 'message', 'result'] as const) {
      if (!(key in record)) continue;
      const nested = previewUnknownValue(record[key], limit, priorityKeys, toolContext);
      if (nested.preview.trim().length > 0) {
        return nested;
      }
    }
    const priority = findPriorityValue(record, priorityKeys);
    if (priority) {
      return truncatePreview(priority, limit);
    }
    const parts = Object.entries(record)
      .filter(([, item]) => item != null && typeof item !== 'object')
      .slice(0, 4)
      .map(([key, item]) => `${key}: ${String(item)}`);
    if (parts.length > 0) {
      return truncatePreview(parts.join(', '), limit);
    }
    const keys = Object.keys(record).slice(0, 5);
    return truncatePreview(keys.length > 0 ? `fields: ${keys.join(', ')}` : '', limit);
  }
  return { preview: '', truncated: false };
}

function previewToolInputValue(toolName: string, value: unknown, limit: number): ValuePreview {
  const canonical = canonicalToolName(toolName);
  if (canonical === 'sendmessage' || canonical === 'message_send') {
    const payload = recordFromUnknown(value);
    const formatted = payload ? formatMessageSendInputPayload(payload) : null;
    if (formatted) {
      return truncatePreview(formatted, limit);
    }
  }
  if (canonical === 'cross_team_send') {
    const payload = recordFromUnknown(value);
    const formatted = payload ? formatCrossTeamPayload(payload) : null;
    if (formatted) {
      return truncatePreview(formatted, limit);
    }
  }
  const payload = recordFromUnknown(value);
  if (payload) {
    const runtimeFormatted = formatRuntimePayload(payload, canonical, payload);
    if (runtimeFormatted) {
      return truncatePreview(runtimeFormatted.text, limit);
    }
    const workSyncFormatted = formatWorkSyncPayload(payload, canonical, payload);
    if (workSyncFormatted) {
      return truncatePreview(workSyncFormatted.text, limit);
    }
    const taskFormatted = formatTaskToolInputPayload(canonical, payload);
    if (taskFormatted) {
      return truncatePreview(taskFormatted, limit);
    }
  }
  return previewUnknownValue(value, limit, TOOL_INPUT_PRIORITY_KEYS);
}

function extractTextPreview(
  content: string | MemberLogPreviewContentBlock[],
  textLimit: number
): { preview: string; truncated: boolean } | null {
  const text = textFromPreviewContent(content);
  const preview = truncatePreview(text, textLimit);
  return preview.preview.length > 0 ? preview : null;
}

function firstQuotedLine(value: string): string | null {
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith('>'));
  return line ? line.replace(/^>\s*/, '').trim() || null : null;
}

function findLineByPrefix(value: string, prefix: string): string | null {
  const normalizedPrefix = prefix.toLowerCase();
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(normalizedPrefix)) {
      return trimmed;
    }
  }
  return null;
}

function parseTaskAssignmentLine(line: string): { taskRef: string; subject?: string } | null {
  const prefix = 'New task assigned to you:';
  if (!line.toLowerCase().startsWith(prefix.toLowerCase())) {
    return null;
  }
  const rest = line.slice(prefix.length).trim();
  const [taskRefCandidate = '', ...restParts] = rest.split(/\s+/);
  if (!taskRefCandidate.startsWith('#')) {
    return null;
  }
  const restText = restParts.join(' ').trim();
  const firstStar = restText.indexOf('*');
  const secondStar = firstStar >= 0 ? restText.indexOf('*', firstStar + 1) : -1;
  const subject =
    firstStar >= 0 && secondStar > firstStar
      ? restText.slice(firstStar + 1, secondStar).trim()
      : restText.replaceAll('*', '').trim();
  return {
    taskRef: taskRefCandidate,
    ...(subject ? { subject } : {}),
  };
}

function parseCommentHeadingLine(line: string): { taskRef: string; subject?: string } | null {
  const prefix = '**Comment on task ';
  if (!line.toLowerCase().startsWith(prefix.toLowerCase())) {
    return null;
  }
  const afterPrefix = line.slice(prefix.length);
  const endRef = afterPrefix.indexOf('**');
  if (endRef <= 0) {
    return null;
  }
  const taskRef = afterPrefix.slice(0, endRef).trim();
  if (!taskRef.startsWith('#')) {
    return null;
  }
  const afterRef = afterPrefix.slice(endRef + 2).trim();
  const firstUnderscore = afterRef.indexOf('_');
  const secondUnderscore = firstUnderscore >= 0 ? afterRef.indexOf('_', firstUnderscore + 1) : -1;
  const subject =
    firstUnderscore >= 0 && secondUnderscore > firstUnderscore
      ? afterRef.slice(firstUnderscore + 1, secondUnderscore).trim()
      : undefined;
  return {
    taskRef,
    ...(subject ? { subject } : {}),
  };
}

function extractInboundTextPreview(
  content: string | MemberLogPreviewContentBlock[],
  textLimit: number
): { title: string; preview: string; truncated: boolean } | null {
  const raw =
    typeof content === 'string'
      ? content
      : content
          .filter((block): block is Extract<MemberLogPreviewContentBlock, { type: 'text' }> => {
            return block.type === 'text' && typeof block.text === 'string';
          })
          .map((block) => block.text)
          .join('\n');
  const visibleRaw = removeHiddenInstructionBlocks(raw);
  const compact = compactWhitespace(visibleRaw);
  if (!compact) {
    return null;
  }

  const assigned = parseTaskAssignmentLine(
    findLineByPrefix(visibleRaw, 'New task assigned to you:') ?? ''
  );
  if (assigned) {
    const taskRef = assigned.taskRef;
    const subject = assigned.subject;
    const preview = truncatePreview(subject ? `${taskRef} ${subject}` : taskRef, textLimit);
    return { title: 'Task assigned', ...preview };
  }

  const comment = parseCommentHeadingLine(findLineByPrefix(visibleRaw, '**Comment on task ') ?? '');
  if (comment) {
    const taskRef = comment.taskRef;
    const quoted = firstQuotedLine(visibleRaw);
    const subject = comment.subject;
    const text = quoted ?? subject ?? 'Comment received';
    const preview = truncatePreview(`${taskRef}: ${text}`, textLimit);
    return { title: 'Comment received', ...preview };
  }

  const preview = truncatePreview(compact, textLimit);
  return preview.preview ? { title: 'Message', ...preview } : null;
}

function isToolUseBlock(
  block: MemberLogPreviewContentBlock
): block is Extract<MemberLogPreviewContentBlock, { type: 'tool_use' }> {
  return (
    block.type === 'tool_use' &&
    typeof (block as { id?: unknown }).id === 'string' &&
    typeof (block as { name?: unknown }).name === 'string'
  );
}

function isToolResultBlock(
  block: MemberLogPreviewContentBlock
): block is Extract<MemberLogPreviewContentBlock, { type: 'tool_result' }> {
  return (
    block.type === 'tool_result' &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
  );
}

function normalizeToolCall(toolCall: ToolCallLike): NormalizedToolCall | null {
  const id =
    typeof toolCall.id === 'string'
      ? toolCall.id.trim()
      : typeof toolCall.callId === 'string'
        ? toolCall.callId.trim()
        : '';
  const name =
    typeof toolCall.name === 'string'
      ? toolCall.name.trim()
      : typeof toolCall.toolName === 'string'
        ? toolCall.toolName.trim()
        : '';
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    input: toolCall.input,
  };
}

function buildToolUseContexts(
  messages: readonly MemberLogPreviewParsedMessage[]
): Map<string, ToolUseContext> {
  const contexts = new Map<string, ToolUseContext>();
  const addContext = (tool: NormalizedToolCall): void => {
    const id = tool.id;
    if (!id || contexts.has(id)) return;
    contexts.set(id, {
      id,
      name: tool.name,
      canonicalName: canonicalToolName(tool.name),
      input: tool.input,
    });
  };

  for (const message of messages) {
    message.toolCalls?.forEach((toolCall) => {
      const normalized = normalizeToolCall(toolCall);
      if (normalized) {
        addContext(normalized);
      }
    });
    if (!Array.isArray(message.content)) continue;
    message.content.forEach((block) => {
      if (!isToolUseBlock(block)) return;
      addContext({
        id: block.id,
        name: block.name,
        input: block.input,
      });
    });
  }
  return contexts;
}

function extractThinkingPreview(
  content: string | MemberLogPreviewContentBlock[],
  textLimit: number
): { preview: string; truncated: boolean } | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .filter((block): block is Extract<MemberLogPreviewContentBlock, { type: 'thinking' }> => {
      return block.type === 'thinking' && typeof block.thinking === 'string';
    })
    .map((block) => block.thinking)
    .join(' ');
  const preview = truncatePreview(text, textLimit);
  return preview.preview.length > 0 ? preview : null;
}

function resolveMessageRole(message: MemberLogPreviewParsedMessage): string {
  return message.role ?? message.type ?? '';
}

function messageHasToolResult(message: MemberLogPreviewParsedMessage): boolean {
  if ((message.toolResults?.length ?? 0) > 0) {
    return true;
  }
  return Array.isArray(message.content) && message.content.some(isToolResultBlock);
}

function buildItemId(input: {
  provider: MemberLogStreamProvider;
  sourceId: string;
  messageId: string;
  kind: MemberLogPreviewItemKind;
  token: string;
}): string {
  return [
    input.provider,
    input.sourceId.replace(/\s+/g, '_'),
    input.messageId.replace(/\s+/g, '_'),
    input.kind,
    input.token.replace(/\s+/g, '_'),
  ].join(':');
}

function buildCandidate(input: {
  provider: MemberLogStreamProvider;
  sourceId: string;
  message: MemberLogPreviewParsedMessage;
  messageIndex: number;
  blockIndex: number;
  kind: MemberLogPreviewItemKind;
  title: string;
  preview?: string;
  tone?: MemberLogPreviewItemTone;
  toolName?: string;
  sourceLabel?: string;
  sessionId?: string;
  laneId?: string;
  token: string;
  textTruncated: boolean;
  toolUseKey?: string;
  supersededByResult?: boolean;
}): Candidate {
  const timestamp = timestampIso(input.message.timestamp);
  const messageId = input.message.uuid ?? `message-${input.messageIndex}`;
  return {
    item: {
      id: buildItemId({
        provider: input.provider,
        sourceId: input.sourceId,
        messageId,
        kind: input.kind,
        token: input.token,
      }),
      kind: input.kind,
      provider: input.provider,
      timestamp,
      title: input.title,
      ...(input.preview ? { preview: input.preview } : {}),
      tone: input.tone ?? 'neutral',
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.laneId ? { laneId: input.laneId } : {}),
    },
    timestampMs: timestampMs(input.message.timestamp),
    order: input.messageIndex * 1_000 + input.blockIndex,
    textTruncated: input.textTruncated,
    ...(input.toolUseKey ? { toolUseKey: input.toolUseKey } : {}),
    ...(input.supersededByResult ? { supersededByResult: true } : {}),
  };
}

function collectToolUseCandidates(input: {
  message: MemberLogPreviewParsedMessage;
  messageIndex: number;
  provider: MemberLogStreamProvider;
  sourceId: string;
  sourceLabel?: string;
  sessionId?: string;
  laneId?: string;
  textLimit: number;
}): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const addTool = (
    tool: { id: string; name: string; input?: unknown },
    blockIndex: number
  ): void => {
    const id = tool.id || `${tool.name}:${blockIndex}`;
    if (seen.has(id)) return;
    seen.add(id);
    const preview = previewToolInputValue(tool.name, tool.input, input.textLimit);
    const toolUseKey = buildToolUseKey({
      provider: input.provider,
      sourceId: input.sourceId,
      toolUseId: id,
    });
    candidates.push(
      buildCandidate({
        provider: input.provider,
        sourceId: input.sourceId,
        message: input.message,
        messageIndex: input.messageIndex,
        blockIndex,
        kind: 'tool_use',
        title: formatToolTitle(tool.name),
        preview: preview.preview,
        tone: 'warning',
        toolName: tool.name,
        sourceLabel: input.sourceLabel,
        sessionId: input.sessionId ?? input.message.sessionId,
        laneId: input.laneId,
        token: id,
        textTruncated: preview.truncated,
        toolUseKey,
        supersededByResult: isToolUseSupersededBySuccessResult(tool.name),
      })
    );
  };

  input.message.toolCalls?.forEach((toolCall, index) => {
    const normalized = normalizeToolCall(toolCall);
    if (normalized) {
      addTool(normalized, 100 + index);
    }
  });
  if (Array.isArray(input.message.content)) {
    input.message.content.forEach((block, index) => {
      if (!isToolUseBlock(block)) return;
      addTool(
        {
          id: block.id,
          name: block.name,
          input: block.input,
        },
        index
      );
    });
  }

  return candidates;
}

function collectToolResultCandidates(input: {
  message: MemberLogPreviewParsedMessage;
  messageIndex: number;
  provider: MemberLogStreamProvider;
  sourceId: string;
  sourceLabel?: string;
  sessionId?: string;
  laneId?: string;
  textLimit: number;
  toolUseContexts: ReadonlyMap<string, ToolUseContext>;
}): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const addResult = (
    result: { toolUseId: string; content: unknown; isError?: boolean },
    blockIndex: number
  ): void => {
    const id = result.toolUseId || `result:${blockIndex}`;
    if (seen.has(id)) return;
    seen.add(id);
    const toolContext = input.toolUseContexts.get(id);
    const toolUseKey = buildToolUseKey({
      provider: input.provider,
      sourceId: input.sourceId,
      toolUseId: id,
    });
    const preview = previewUnknownValue(
      result.content,
      input.textLimit,
      TOOL_RESULT_PRIORITY_KEYS,
      toolContext
    );
    const isError = result.isError === true || preview.title === 'Tool error';
    const title =
      preview.title === 'Tool error'
        ? formatGenericToolResultTitle(toolContext, true)
        : (preview.title ?? formatGenericToolResultTitle(toolContext, isError));
    candidates.push(
      buildCandidate({
        provider: input.provider,
        sourceId: input.sourceId,
        message: input.message,
        messageIndex: input.messageIndex,
        blockIndex,
        kind: 'tool_result',
        title,
        preview: preview.preview,
        tone: isError ? 'error' : 'success',
        toolName: toolContext?.name,
        sourceLabel: input.sourceLabel,
        sessionId: input.sessionId ?? input.message.sessionId,
        laneId: input.laneId,
        token: id,
        textTruncated: preview.truncated,
        toolUseKey,
      })
    );
  };

  input.message.toolResults?.forEach((result, index) =>
    addResult(
      {
        toolUseId: result.toolUseId,
        content: result.content,
        isError: result.isError,
      },
      200 + index
    )
  );
  if (input.message.sourceToolUseID && input.message.toolUseResult) {
    addResult(
      {
        toolUseId: input.message.sourceToolUseID,
        content: input.message.toolUseResult,
        isError: input.message.toolUseResult.isError === true,
      },
      240
    );
  }
  if (Array.isArray(input.message.content)) {
    input.message.content.forEach((block, index) => {
      if (!isToolResultBlock(block)) return;
      addResult(
        {
          toolUseId: block.tool_use_id,
          content: block.content,
          isError: block.is_error === true,
        },
        index
      );
    });
  }

  return candidates;
}

export function extractMemberLogPreviewItems(
  input: ExtractMemberLogPreviewInput
): ExtractMemberLogPreviewResult {
  const maxItems = Math.max(1, Math.min(3, Math.floor(input.maxItems)));
  const textLimit = Math.max(80, Math.min(240, Math.floor(input.textLimit)));
  const sourceId = input.sourceId ?? input.sourceLabel ?? input.provider;
  const candidates: Candidate[] = [];
  const toolUseContexts = buildToolUseContexts(input.messages);

  input.messages.forEach((message, messageIndex) => {
    candidates.push(
      ...collectToolUseCandidates({
        message,
        messageIndex,
        provider: input.provider,
        sourceId,
        sourceLabel: input.sourceLabel,
        sessionId: input.sessionId,
        laneId: input.laneId,
        textLimit,
      }),
      ...collectToolResultCandidates({
        message,
        messageIndex,
        provider: input.provider,
        sourceId,
        sourceLabel: input.sourceLabel,
        sessionId: input.sessionId,
        laneId: input.laneId,
        textLimit,
        toolUseContexts,
      })
    );

    const role = resolveMessageRole(message);
    if (role === 'assistant') {
      const textPreview = extractTextPreview(message.content, textLimit);
      if (textPreview) {
        const runtimeErrorPreview = formatRuntimeErrorText(
          textFromPreviewContent(message.content),
          textLimit
        );
        candidates.push(
          buildCandidate({
            provider: input.provider,
            sourceId,
            message,
            messageIndex,
            blockIndex: 10,
            kind: 'text',
            title: runtimeErrorPreview?.title ?? 'Assistant',
            preview: runtimeErrorPreview?.preview ?? textPreview.preview,
            tone: runtimeErrorPreview ? 'error' : 'neutral',
            sourceLabel: input.sourceLabel,
            sessionId: input.sessionId ?? message.sessionId,
            laneId: input.laneId,
            token: 'assistant-text',
            textTruncated: runtimeErrorPreview?.truncated ?? textPreview.truncated,
          })
        );
      }

      const thinkingPreview = extractThinkingPreview(message.content, textLimit);
      if (thinkingPreview) {
        candidates.push(
          buildCandidate({
            provider: input.provider,
            sourceId,
            message,
            messageIndex,
            blockIndex: 9,
            kind: 'thinking',
            title: 'Thinking',
            preview: thinkingPreview.preview,
            tone: 'neutral',
            sourceLabel: input.sourceLabel,
            sessionId: input.sessionId ?? message.sessionId,
            laneId: input.laneId,
            token: 'thinking',
            textTruncated: thinkingPreview.truncated,
          })
        );
      }
    }

    if (role === 'user' && message.isMeta !== true && !messageHasToolResult(message)) {
      const inboundPreview = extractInboundTextPreview(message.content, textLimit);
      if (inboundPreview) {
        candidates.push(
          buildCandidate({
            provider: input.provider,
            sourceId,
            message,
            messageIndex,
            blockIndex: 8,
            kind: 'text',
            title: inboundPreview.title,
            preview: inboundPreview.preview,
            tone: 'neutral',
            sourceLabel: input.sourceLabel,
            sessionId: input.sessionId ?? message.sessionId,
            laneId: input.laneId,
            token: 'inbound-text',
            textTruncated: inboundPreview.truncated,
          })
        );
      }
    }
  });

  const successfulResultToolKeys = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.item.kind === 'tool_result' &&
          candidate.item.tone !== 'error' &&
          Boolean(candidate.item.preview?.trim())
      )
      .map((candidate) => candidate.toolUseKey)
      .filter((toolUseKey): toolUseKey is string => Boolean(toolUseKey))
  );
  const compactCandidates = candidates.filter((candidate) => {
    if (candidate.item.kind !== 'tool_use') return true;
    if (!candidate.supersededByResult || !candidate.toolUseKey) return true;
    return !successfulResultToolKeys.has(candidate.toolUseKey);
  });

  const sorted = [...compactCandidates];
  sorted.sort((left, right) => {
    const byTime = right.timestampMs - left.timestampMs;
    if (byTime !== 0) return byTime;
    const byOrder = right.order - left.order;
    if (byOrder !== 0) return byOrder;
    return left.item.id.localeCompare(right.item.id);
  });
  const items = sorted.slice(0, maxItems).map((candidate) => candidate.item);
  const overflowCount = Math.max(0, sorted.length - items.length);
  return {
    items,
    truncated: overflowCount > 0 || sorted.some((candidate) => candidate.textTruncated),
    overflowCount,
  };
}
