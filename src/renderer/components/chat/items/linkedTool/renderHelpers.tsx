/**
 * Render Helpers
 *
 * Shared rendering functions for tool input and output.
 */

import React from 'react';

import {
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  DIFF_ADDED_TEXT,
  DIFF_REMOVED_TEXT,
} from '@renderer/constants/cssVariables';
import { highlightLines } from '@renderer/utils/syntaxHighlighter';
import { getAgentToolDisplayDetails } from '@shared/utils/toolSummary';

export interface RenderInputLabels {
  replaceAll: string;
  agentAction: string;
  agentTeammate: string;
  agentTeam: string;
  agentRuntime: string;
  agentType: string;
  startupInstructionsHidden: string;
  noInputRecorded: string;
}

/**
 * Renders the input section based on tool type with theme-aware styling.
 */
export function renderInput(
  toolName: string,
  input: Record<string, unknown>,
  labels: RenderInputLabels
): React.ReactElement {
  const normalizedToolName = toolName.toLowerCase();
  // Special rendering for Edit tool - show diff-like format
  if (normalizedToolName === 'edit') {
    const filePath = readInputString(input, ['file_path', 'filePath', 'path']);
    const oldString = readInputString(input, ['old_string', 'oldString']);
    const newString = readInputString(input, ['new_string', 'newString']);
    const replaceAll = input.replace_all as boolean | undefined;

    return (
      <div className="space-y-2">
        {filePath && (
          <div className="mb-2 text-xs" style={{ color: COLOR_TEXT_MUTED }}>
            {filePath}
            {replaceAll && (
              <span className="ml-2" style={{ color: COLOR_TEXT_MUTED }}>
                {labels.replaceAll}
              </span>
            )}
          </div>
        )}
        {oldString && (
          <div className="whitespace-pre-wrap break-all" style={{ color: DIFF_REMOVED_TEXT }}>
            {oldString.split('\n').map((line, i) => (
              <div key={i}>- {line}</div>
            ))}
          </div>
        )}
        {newString && (
          <div className="whitespace-pre-wrap break-all" style={{ color: DIFF_ADDED_TEXT }}>
            {newString.split('\n').map((line, i) => (
              <div key={i}>+ {line}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Special rendering for Bash tool
  if (normalizedToolName === 'bash') {
    const command = readInputString(input, ['command']);
    const description = readInputString(input, ['description']);
    const highlighted = command ? highlightLines(command, 'command.sh') : null;

    return (
      <div className="space-y-2">
        {description && (
          <div className="mb-1 text-xs" style={{ color: COLOR_TEXT_MUTED }}>
            {description}
          </div>
        )}
        {highlighted ? (
          <code className="hljs block whitespace-pre-wrap break-all">
            {highlighted.map((html, i) => (
              <div key={i} dangerouslySetInnerHTML={{ __html: html || ' ' }} />
            ))}
          </code>
        ) : null}
      </div>
    );
  }

  // Special rendering for Read tool
  if (normalizedToolName === 'read') {
    const filePath = readInputString(input, ['file_path', 'filePath', 'path']);
    const offset = input.offset as number | undefined;
    const limit = input.limit as number | undefined;

    return (
      <div style={{ color: COLOR_TEXT }}>
        <div>{filePath}</div>
        {(offset !== undefined || limit !== undefined) && (
          <div className="mt-1 text-xs" style={{ color: COLOR_TEXT_MUTED }}>
            {offset !== undefined && `offset: ${offset}`}
            {offset !== undefined && limit !== undefined && ', '}
            {limit !== undefined && `limit: ${limit}`}
          </div>
        )}
      </div>
    );
  }

  // Special rendering for Agent tool - do not leak full bootstrap prompts in UI logs.
  if (toolName === 'Agent') {
    const details = getAgentToolDisplayDetails(input);

    return (
      <div className="space-y-3" style={{ color: COLOR_TEXT }}>
        <div className="space-y-2">
          <div>
            <div className="text-xs" style={{ color: COLOR_TEXT_MUTED }}>
              {labels.agentAction}
            </div>
            <div className="whitespace-pre-wrap break-all">{details.action}</div>
          </div>

          {details.teammateName && (
            <div>
              <div className="text-xs" style={{ color: COLOR_TEXT_MUTED }}>
                {labels.agentTeammate}
              </div>
              <div>{details.teammateName}</div>
            </div>
          )}

          {details.teamName && (
            <div>
              <div className="text-xs" style={{ color: COLOR_TEXT_MUTED }}>
                {labels.agentTeam}
              </div>
              <div>{details.teamName}</div>
            </div>
          )}

          {details.runtime && (
            <div>
              <div className="text-xs" style={{ color: COLOR_TEXT_MUTED }}>
                {labels.agentRuntime}
              </div>
              <div>{details.runtime}</div>
            </div>
          )}

          {details.subagentType && (
            <div>
              <div className="text-xs" style={{ color: COLOR_TEXT_MUTED }}>
                {labels.agentType}
              </div>
              <div>{details.subagentType}</div>
            </div>
          )}
        </div>

        <div
          className="rounded px-3 py-2 text-[11px]"
          style={{
            backgroundColor: 'rgba(250, 204, 21, 0.08)',
            border: '1px solid rgba(250, 204, 21, 0.22)',
            color: COLOR_TEXT_MUTED,
          }}
        >
          {labels.startupInstructionsHidden}
        </div>
      </div>
    );
  }

  // Default: key-value format with readable string values
  return (
    <div className="space-y-2" style={{ color: COLOR_TEXT }}>
      {Object.entries(input).length > 0 ? (
        Object.entries(input).map(([key, value]) => (
          <div key={key}>
            <div className="text-xs" style={{ color: COLOR_TEXT_MUTED }}>
              {key}
            </div>
            <pre className="whitespace-pre-wrap break-all">{formatInputValue(value)}</pre>
          </div>
        ))
      ) : (
        <div className="italic" style={{ color: COLOR_TEXT_MUTED }}>
          {labels.noInputRecorded}
        </div>
      )}
    </div>
  );
}

function readInputString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function formatInputValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

/**
 * Renders the output section with theme-aware styling.
 */
/**
 * Extracts display text from tool output content.
 * Handles content block arrays from the API by extracting text fields
 * and pretty-printing JSON when possible.
 */
export function extractOutputText(content: string | unknown[]): string {
  let displayText: string;

  // Normalize: if content is a string that parses to an array of content blocks, treat as array
  let normalizedContent: string | unknown[] = content;
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0 && isContentBlock(parsed[0])) {
        normalizedContent = parsed as unknown[];
      }
    } catch {
      // Not JSON, keep as string
    }
  }

  if (typeof normalizedContent === 'string') {
    displayText = normalizedContent;
  } else if (Array.isArray(normalizedContent)) {
    // Extract text from content blocks (e.g. [{"type":"text","text":"..."}])
    displayText = normalizedContent
      .map((block) =>
        typeof block === 'object' && block !== null && 'text' in block
          ? (block as { text: string }).text
          : JSON.stringify(block, null, 2)
      )
      .join('\n');
  } else {
    displayText = JSON.stringify(normalizedContent, null, 2);
  }

  // Try to pretty-print if the extracted text is valid JSON
  try {
    const parsed: unknown = JSON.parse(displayText);
    displayText = JSON.stringify(parsed, null, 2);
  } catch {
    // Not JSON, use as-is
  }

  return displayText;
}

export function formatToolOutputForDisplay(
  toolName: string,
  content: string | unknown[]
): string | unknown[] {
  if (!isAgentTeamsToolName(toolName)) {
    return content;
  }

  const parsed = parseJsonObject(extractOutputText(content));
  if (!parsed) {
    return content;
  }

  const unwrapped = unwrapAgentTeamsResponse(parsed);
  if (!unwrapped) {
    return content;
  }

  const lines = formatAgentTeamsResponse(toolName, unwrapped.wrapperKey, unwrapped.payload);
  return lines.length > 0 ? lines.join('\n') : content;
}

function isAgentTeamsToolName(toolName: string): boolean {
  return (
    toolName.startsWith('agent-teams_') ||
    toolName.startsWith('agent_teams_') ||
    toolName.startsWith('mcp__agent-teams__') ||
    toolName.startsWith('mcp__agent_teams__')
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function unwrapAgentTeamsResponse(
  parsed: Record<string, unknown>
): { wrapperKey: string | null; payload: Record<string, unknown> } | null {
  const wrapperKey =
    Object.keys(parsed).find(
      (key) => key.startsWith('agent_teams_') && key.endsWith('_response')
    ) ?? null;
  const payload = wrapperKey ? asRecord(parsed[wrapperKey]) : parsed;
  return payload ? { wrapperKey, payload } : null;
}

function formatAgentTeamsResponse(
  toolName: string,
  wrapperKey: string | null,
  payload: Record<string, unknown>
): string[] {
  if (hasErrorPayload(payload)) {
    return [];
  }

  const lines: string[] = [getAgentTeamsResponseTitle(toolName, wrapperKey)];
  appendField(lines, 'Team', readString(payload.teamName));
  appendField(lines, 'Task ID', readString(payload.taskId));
  appendField(lines, 'Message ID', readString(payload.messageId));

  const comment = asRecord(payload.comment);
  if (comment) {
    appendField(lines, 'Comment ID', readString(comment.id));
    appendField(lines, 'Author', readString(comment.author));
    appendField(lines, 'Created', readString(comment.createdAt));
    appendBody(lines, readString(comment.text));
    return lines;
  }

  const message = asRecord(payload.message);
  if (message) {
    appendField(lines, 'From', readString(message.from));
    appendField(lines, 'To', readString(message.to));
    appendField(lines, 'Created', readString(message.createdAt));
    appendBody(lines, readString(message.text) ?? readString(message.summary));
    return lines;
  }

  const task = asRecord(payload.task);
  if (task) {
    appendField(lines, 'Task', readString(task.title) ?? readString(task.name));
    appendField(lines, 'Status', readString(task.status));
    appendField(lines, 'Owner', readString(task.owner));
    appendBody(lines, readString(task.description));
    return lines;
  }

  appendField(lines, 'Status', readString(payload.status));
  appendBody(lines, readString(payload.text) ?? readString(payload.summary));
  return lines.length > 1 ? lines : [];
}

function hasErrorPayload(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.error === 'string' ||
    typeof payload.errorMessage === 'string' ||
    payload.ok === false ||
    payload.success === false
  );
}

function getAgentTeamsResponseTitle(toolName: string, wrapperKey: string | null): string {
  const key = `${toolName} ${wrapperKey ?? ''}`;
  if (key.includes('task_add_comment')) return 'Task comment added';
  if (key.includes('task_complete')) return 'Task completed';
  if (key.includes('task_start')) return 'Task started';
  if (key.includes('task_set_owner')) return 'Task owner updated';
  if (key.includes('task_set_clarification')) return 'Task clarification updated';
  if (key.includes('task_attach_comment_file')) return 'Task comment file attached';
  if (key.includes('message_send')) return 'Message sent';
  if (key.includes('task_get')) return 'Task loaded';
  return 'Agent Teams tool result';
}

function appendField(lines: string[], label: string, value: string | null | undefined): void {
  if (!value || value.trim().length === 0) {
    return;
  }
  lines.push(`${label}: ${value.trim()}`);
}

function appendBody(lines: string[], value: string | null | undefined): void {
  if (!value || value.trim().length === 0) {
    return;
  }
  lines.push('');
  lines.push(value.trim());
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isContentBlock(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as Record<string, unknown>).type === 'string'
  );
}

export function renderOutput(content: string | unknown[]): React.ReactElement {
  const displayText = extractOutputText(content);
  return (
    <pre className="whitespace-pre-wrap break-all" style={{ color: COLOR_TEXT }}>
      {displayText}
    </pre>
  );
}
