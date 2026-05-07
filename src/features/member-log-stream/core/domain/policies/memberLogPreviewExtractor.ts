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
  toolCalls?: readonly {
    id: string;
    name: string;
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

  if (typeof record.content === 'string') {
    const nested = recordFromUnknownWithWrapper(record.content);
    if (nested) {
      return nested;
    }
  }

  return unwrapAgentTeamsResponsePayload(record);
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return recordFromUnknownWithWrapper(value)?.payload ?? null;
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

function formatToolTitle(toolName: string): string {
  const canonical = canonicalToolName(toolName);
  if (canonical === 'sendmessage' || canonical === 'message_send') return 'Send message';
  if (canonical === 'task_complete') return 'Complete task';
  if (canonical === 'task_add_comment') return 'Add comment';
  if (canonical === 'task_get_comment') return 'Read comment';
  if (canonical === 'task_get') return 'Read task';
  if (canonical === 'task_start') return 'Start task';
  if (canonical === 'task_set_status') return 'Set status';
  if (canonical === 'task_set_owner') return 'Set owner';
  if (canonical === 'task_set_clarification') return 'Set clarification';
  if (canonical === 'task_attach_comment_file') return 'Attach comment file';
  if (canonical === 'review_request') return 'Request review';
  if (canonical === 'review_start') return 'Start review';
  if (canonical === 'runtime_bootstrap_checkin') return 'Runtime check-in';
  if (canonical === 'member_briefing') return 'Member briefing';
  if (canonical === 'task_add') return 'Add task';
  return toolName.trim() || 'Tool use';
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
  const title = stringField(task, 'title') ?? stringField(task, 'name');
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
    stringField(fallbackInput ?? undefined, 'filename') ??
    stringField(fallbackInput ?? undefined, 'fileName');

  if (canonical === 'task_add_comment') {
    const text = formatTaskCommentPayload(payload, fallbackInput);
    return text ? { title: 'Comment added', text } : null;
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
  if (canonical === 'runtime_bootstrap_checkin') {
    const memberName =
      stringField(payload, 'memberName') ?? stringField(fallbackInput ?? undefined, 'memberName');
    return {
      title: 'Runtime check-in',
      text: memberName ? `${memberName} checked in` : 'Runtime checked in',
    };
  }
  if (canonical === 'member_briefing') {
    const memberName =
      stringField(payload, 'memberName') ?? stringField(fallbackInput ?? undefined, 'memberName');
    return {
      title: 'Member briefing',
      text: memberName ? `Loaded briefing for ${memberName}` : 'Loaded member briefing',
    };
  }
  return null;
}

function formatErrorPayload(payload: Record<string, unknown>): KnownPayloadPreview | null {
  const error =
    stringField(payload, 'error') ??
    stringField(payload, 'errorMessage') ??
    stringField(payload, 'message');
  if (
    error &&
    (payload.ok === false || payload.success === false || payload.error || payload.errorMessage)
  ) {
    return { title: 'Tool error', text: error };
  }
  if (payload.ok === false || payload.success === false) {
    return { title: 'Tool error', text: 'Tool reported failure' };
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

function formatPlainToolResultStatus(
  value: string,
  toolContext: ToolUseContext | undefined
): KnownPayloadPreview | null {
  if (!toolContext) {
    return null;
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
  return (
    formatTaskToolPayload({}, toolContext.canonicalName, fallbackInput) ??
    formatRuntimePayload({}, toolContext.canonicalName, fallbackInput)
  );
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

  if (canonicalToolNameValue === 'task_add_comment') {
    if (taskRef && text) return `on ${taskRef}: ${text}`;
    if (taskRef) return `on ${taskRef}`;
    if (text) return text;
    return null;
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
  const messageText = formatMessageSendPayload(payload);
  if (messageText) {
    return { title: 'Message sent', text: messageText };
  }
  const commentText = formatTaskCommentPayload(payload);
  if (commentText) {
    return { title: 'Comment added', text: commentText };
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
    const plainStatus = formatPlainToolResultStatus(value, toolContext);
    if (plainStatus) {
      return { ...truncatePreview(plainStatus.text, limit), title: plainStatus.title };
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
  const payload = recordFromUnknown(value);
  if (payload) {
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
  if (typeof content === 'string') {
    const text = truncatePreview(content, textLimit);
    return text.preview.length > 0 ? text : null;
  }
  const text = content
    .filter((block): block is Extract<MemberLogPreviewContentBlock, { type: 'text' }> => {
      return block.type === 'text' && typeof block.text === 'string';
    })
    .map((block) => block.text)
    .join(' ');
  const preview = truncatePreview(text, textLimit);
  return preview.preview.length > 0 ? preview : null;
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

function buildToolUseContexts(
  messages: readonly MemberLogPreviewParsedMessage[]
): Map<string, ToolUseContext> {
  const contexts = new Map<string, ToolUseContext>();
  const addContext = (tool: { id: string; name: string; input?: unknown }): void => {
    const id = tool.id.trim();
    if (!id || contexts.has(id)) return;
    contexts.set(id, {
      id,
      name: tool.name,
      canonicalName: canonicalToolName(tool.name),
      input: tool.input,
    });
  };

  for (const message of messages) {
    message.toolCalls?.forEach((toolCall) => addContext(toolCall));
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
      })
    );
  };

  input.message.toolCalls?.forEach((toolCall, index) => addTool(toolCall, 100 + index));
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
    const preview = previewUnknownValue(
      result.content,
      input.textLimit,
      TOOL_RESULT_PRIORITY_KEYS,
      toolContext
    );
    const isError = result.isError === true || preview.title === 'Tool error';
    candidates.push(
      buildCandidate({
        provider: input.provider,
        sourceId: input.sourceId,
        message: input.message,
        messageIndex: input.messageIndex,
        blockIndex,
        kind: 'tool_result',
        title: isError ? 'Tool error' : (preview.title ?? 'Tool result'),
        preview: preview.preview,
        tone: isError ? 'error' : 'success',
        toolName: toolContext?.name,
        sourceLabel: input.sourceLabel,
        sessionId: input.sessionId ?? input.message.sessionId,
        laneId: input.laneId,
        token: id,
        textTruncated: preview.truncated,
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
        candidates.push(
          buildCandidate({
            provider: input.provider,
            sourceId,
            message,
            messageIndex,
            blockIndex: 10,
            kind: 'text',
            title: 'Assistant',
            preview: textPreview.preview,
            tone: 'neutral',
            sourceLabel: input.sourceLabel,
            sessionId: input.sessionId ?? message.sessionId,
            laneId: input.laneId,
            token: 'assistant-text',
            textTruncated: textPreview.truncated,
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
  });

  const sorted = [...candidates];
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
