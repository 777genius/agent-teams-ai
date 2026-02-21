/**
 * Session export utilities for claude-devtools.
 *
 * Provides formatters to export session data as plain text, Markdown, or JSON,
 * and a download trigger for browser-based file saving.
 */

import type { Chunk, SessionDetail } from '@renderer/types/data';
import type { ContentBlock } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

export type ExportFormat = 'markdown' | 'json' | 'plaintext';

interface ExtractOptions {
  includeThinking?: boolean;
}

// =============================================================================
// Helpers (not exported)
// =============================================================================

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCost(cost?: number): string {
  if (cost == null) return 'N/A';
  return `$${cost.toFixed(2)}`;
}

function formatTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function formatDurationForExport(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${remainSecs}s`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

// =============================================================================
// extractTextFromContent
// =============================================================================

/**
 * Extract readable text from message content (string or ContentBlock[]).
 *
 * @param content - String content or array of ContentBlocks
 * @param options - Options controlling extraction behavior
 * @returns Extracted text with newlines between blocks
 */
export function extractTextFromContent(
  content: string | ContentBlock[],
  options?: ExtractOptions
): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }

  const parts: string[] = [];

  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'thinking':
        if (options?.includeThinking) {
          parts.push(block.thinking);
        }
        break;
      case 'tool_use':
        parts.push(`Tool: ${block.name}\nInput: ${JSON.stringify(block.input, null, 2)}`);
        break;
      case 'tool_result': {
        const resultContent = block.content;
        if (typeof resultContent === 'string') {
          parts.push(resultContent);
        } else if (Array.isArray(resultContent)) {
          // Recursively extract from nested content blocks
          const nested = extractTextFromContent(resultContent);
          if (nested) parts.push(nested);
        }
        break;
      }
      case 'image':
        parts.push('[Image]');
        break;
    }
  }

  return parts.join('\n');
}

// =============================================================================
// Plain Text Chunk Formatters
// =============================================================================

function formatToolExecutionPlainText(exec: {
  toolCall: { name: string; input: Record<string, unknown> };
  result?: { content: string | unknown[]; isError: boolean };
}): string[] {
  const lines: string[] = [];
  lines.push(`  TOOL: ${exec.toolCall.name}`);
  lines.push(`  Input: ${JSON.stringify(exec.toolCall.input)}`);
  if (exec.result) {
    const prefix = exec.result.isError ? '  [ERROR] Result: ' : '  Result: ';
    const resultText =
      typeof exec.result.content === 'string'
        ? exec.result.content
        : JSON.stringify(exec.result.content);
    lines.push(`${prefix}${truncate(resultText, 500)}`);
  } else {
    lines.push('  [No result]');
  }
  return lines;
}

function formatChunkPlainText(chunk: Chunk): string[] {
  const lines: string[] = [];

  switch (chunk.chunkType) {
    case 'user': {
      lines.push(`USER: ${extractTextFromContent(chunk.userMessage.content)}`);
      break;
    }
    case 'ai': {
      // Render thinking blocks first, then text
      for (const response of chunk.responses) {
        if (Array.isArray(response.content)) {
          // Check for thinking blocks
          for (const block of response.content) {
            if (block.type === 'thinking') {
              lines.push(`THINKING: ${block.thinking}`);
            }
          }
          // Then text
          const text = extractTextFromContent(response.content);
          if (text) {
            lines.push(`ASSISTANT: ${text}`);
          }
        } else if (typeof response.content === 'string') {
          lines.push(`ASSISTANT: ${response.content}`);
        }
      }

      // Tool executions
      for (const exec of chunk.toolExecutions) {
        lines.push(...formatToolExecutionPlainText(exec));
      }
      break;
    }
    case 'system': {
      lines.push(`SYSTEM: ${chunk.commandOutput}`);
      break;
    }
    case 'compact': {
      lines.push('[Context compacted]');
      break;
    }
  }

  return lines;
}

// =============================================================================
// Markdown Chunk Formatters
// =============================================================================

function formatToolExecutionMarkdown(exec: {
  toolCall: { name: string; input: Record<string, unknown> };
  result?: { content: string | unknown[]; isError: boolean };
}): string[] {
  const lines: string[] = [];
  lines.push(`**Tool:** \`${exec.toolCall.name}\``);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(exec.toolCall.input, null, 2));
  lines.push('```');
  lines.push('');

  if (exec.result) {
    if (exec.result.isError) {
      lines.push('**Error:**');
    } else {
      lines.push('**Result:**');
    }
    lines.push('');
    const resultText =
      typeof exec.result.content === 'string'
        ? exec.result.content
        : JSON.stringify(exec.result.content, null, 2);
    lines.push('```');
    lines.push(truncate(resultText, 2000));
    lines.push('```');
  }

  return lines;
}

function formatChunkMarkdown(chunk: Chunk, turnNum: number): string[] {
  const lines: string[] = [];

  switch (chunk.chunkType) {
    case 'user': {
      lines.push(`### User (Turn ${turnNum})`);
      lines.push('');
      lines.push(extractTextFromContent(chunk.userMessage.content));
      lines.push('');
      break;
    }
    case 'ai': {
      lines.push(`### Assistant (Turn ${turnNum})`);
      lines.push('');

      for (const response of chunk.responses) {
        if (Array.isArray(response.content)) {
          // Thinking blocks as blockquotes
          for (const block of response.content) {
            if (block.type === 'thinking') {
              lines.push('> *Thinking:*');
              for (const thinkLine of block.thinking.split('\n')) {
                lines.push(`> ${thinkLine}`);
              }
              lines.push('');
            }
          }
          // Text content
          const text = extractTextFromContent(response.content);
          if (text) {
            lines.push(text);
            lines.push('');
          }
        } else if (typeof response.content === 'string') {
          lines.push(response.content);
          lines.push('');
        }
      }

      // Tool executions
      for (const exec of chunk.toolExecutions) {
        lines.push(...formatToolExecutionMarkdown(exec));
        lines.push('');
      }
      break;
    }
    case 'system': {
      lines.push(`### System (Turn ${turnNum})`);
      lines.push('');
      lines.push(chunk.commandOutput);
      lines.push('');
      break;
    }
    case 'compact': {
      lines.push('---');
      lines.push('');
      lines.push('*Context compacted*');
      lines.push('');
      break;
    }
  }

  return lines;
}

// =============================================================================
// Export Functions
// =============================================================================

/**
 * Export session as plain text transcript.
 *
 * Produces a flat text format with clear labels (USER:, ASSISTANT:, TOOL:, etc.)
 * and separator lines between sections.
 */
export function exportAsPlainText(detail: SessionDetail): string {
  const { session, metrics, chunks } = detail;
  const lines: string[] = [];

  // Header
  lines.push('═'.repeat(60));
  lines.push('SESSION EXPORT');
  lines.push('═'.repeat(60));
  lines.push(`Session:  ${session.id}`);
  lines.push(`Project:  ${session.projectPath}`);
  if (session.gitBranch) {
    lines.push(`Branch:   ${session.gitBranch}`);
  }
  lines.push(`Date:     ${formatTimestamp(new Date(session.createdAt))}`);
  lines.push('');

  // Metrics
  lines.push('─'.repeat(40));
  lines.push('METRICS');
  lines.push('─'.repeat(40));
  lines.push(`Duration:       ${formatDurationForExport(metrics.durationMs)}`);
  lines.push(`Total Tokens:   ${formatNumber(metrics.totalTokens)}`);
  lines.push(`Input Tokens:   ${formatNumber(metrics.inputTokens)}`);
  lines.push(`Output Tokens:  ${formatNumber(metrics.outputTokens)}`);
  lines.push(`Cache Read:     ${formatNumber(metrics.cacheReadTokens)}`);
  lines.push(`Cache Created:  ${formatNumber(metrics.cacheCreationTokens)}`);
  lines.push(`Messages:       ${formatNumber(metrics.messageCount)}`);
  lines.push(`Cost:           ${formatCost(metrics.costUsd)}`);
  lines.push('');

  // Conversation
  lines.push('═'.repeat(60));
  lines.push('CONVERSATION');
  lines.push('═'.repeat(60));
  lines.push('');

  for (const chunk of chunks) {
    lines.push('─'.repeat(40));
    lines.push(...formatChunkPlainText(chunk));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export session as structured Markdown.
 *
 * Produces Markdown with headings, tables, code blocks, and blockquotes
 * suitable for viewing in any Markdown renderer.
 */
export function exportAsMarkdown(detail: SessionDetail): string {
  const { session, metrics, chunks } = detail;
  const lines: string[] = [];

  // Title
  lines.push('# Session Export');
  lines.push('');

  // Property table
  lines.push('| Property | Value |');
  lines.push('|----------|-------|');
  lines.push(`| Session | \`${session.id}\` |`);
  lines.push(`| Project | \`${session.projectPath}\` |`);
  if (session.gitBranch) {
    lines.push(`| Branch | \`${session.gitBranch}\` |`);
  }
  lines.push(`| Date | ${formatTimestamp(new Date(session.createdAt))} |`);
  lines.push('');

  // Metrics table
  lines.push('## Metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Duration | ${formatDurationForExport(metrics.durationMs)} |`);
  lines.push(`| Total Tokens | ${formatNumber(metrics.totalTokens)} |`);
  lines.push(`| Input Tokens | ${formatNumber(metrics.inputTokens)} |`);
  lines.push(`| Output Tokens | ${formatNumber(metrics.outputTokens)} |`);
  lines.push(`| Cache Read | ${formatNumber(metrics.cacheReadTokens)} |`);
  lines.push(`| Cache Created | ${formatNumber(metrics.cacheCreationTokens)} |`);
  lines.push(`| Messages | ${formatNumber(metrics.messageCount)} |`);
  lines.push(`| Cost | ${formatCost(metrics.costUsd)} |`);
  lines.push('');

  // Conversation
  lines.push('## Conversation');
  lines.push('');

  let turnNum = 0;
  for (const chunk of chunks) {
    turnNum++;
    lines.push(...formatChunkMarkdown(chunk, turnNum));
  }

  return lines.join('\n');
}

/**
 * Export session as pretty-printed JSON.
 */
export function exportAsJson(detail: SessionDetail): string {
  return JSON.stringify(detail, null, 2);
}

/**
 * Trigger a browser file download for the given session in the specified format.
 *
 * Creates a Blob, generates an object URL, and simulates an anchor click
 * to initiate the download.
 */
export function triggerDownload(detail: SessionDetail, format: ExportFormat): void {
  const formatters: Record<
    ExportFormat,
    { fn: (d: SessionDetail) => string; ext: string; mime: string }
  > = {
    markdown: { fn: exportAsMarkdown, ext: 'md', mime: 'text/markdown;charset=utf-8' },
    json: { fn: exportAsJson, ext: 'json', mime: 'application/json;charset=utf-8' },
    plaintext: { fn: exportAsPlainText, ext: 'txt', mime: 'text/plain;charset=utf-8' },
  };

  const { fn, ext, mime } = formatters[format];
  const content = fn(detail);
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `session-${detail.session.id}.${ext}`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
