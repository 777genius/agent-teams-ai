/**
 * Utilities for parsing JSONL (JSON Lines) files used by Claude Code sessions.
 *
 * JSONL format: One JSON object per line
 * - Each line is a complete, valid JSON object
 * - Lines are separated by newline characters
 * - Empty lines should be skipped
 */

import { isCommandOutputContent, sanitizeDisplayContent } from '@shared/utils/contentSanitizer';
import { createLogger } from '@shared/utils/logger';
import { calculateMessageCost } from '@shared/utils/pricing';
import * as readline from 'readline';

import { LocalFileSystemProvider } from '../services/infrastructure/LocalFileSystemProvider';
import {
  type ChatHistoryEntry,
  type ContentBlock,
  EMPTY_METRICS,
  isConversationalEntry,
  isParsedUserChunkMessage,
  isTextContent,
  type MessageType,
  type ParsedMessage,
  type SessionMetrics,
  type TokenUsage,
  type ToolCall,
} from '../types';

import { yieldToEventLoop } from './asyncYield';
import { extractFirstUserMessagePreview } from './metadataExtraction';
// Import from extracted modules
import { extractToolCalls, extractToolResults } from './toolExtraction';

import type { FileSystemProvider } from '../services/infrastructure/FileSystemProvider';
import type { PhaseTokenBreakdown } from '../types/domain';
import type { Readable } from 'stream';

const logger = createLogger('Util:jsonl');

const defaultProvider = new LocalFileSystemProvider();

// Re-export for backwards compatibility
export { extractCwd, extractFirstUserMessagePreview } from './metadataExtraction';
export { checkMessagesOngoing } from './sessionStateDetection';

// =============================================================================
// Core Parsing Functions
// =============================================================================

export interface JsonlParseResult {
  messages: ParsedMessage[];
  parsedLineCount: number;
  consumedBytes: number;
}

/**
 * Parse a JSONL file line by line using streaming.
 * This avoids loading the entire file into memory.
 */
export async function parseJsonlFile(
  filePath: string,
  fsProvider: FileSystemProvider = defaultProvider
): Promise<ParsedMessage[]> {
  if (!(await fsProvider.exists(filePath))) {
    return [];
  }

  const result = await parseJsonlStream(fsProvider.createReadStream(filePath), filePath);
  return result.messages;
}

/**
 * Parse a JSONL file and return byte accounting details for incremental readers.
 */
export async function parseJsonlFileWithStats(
  filePath: string,
  fsProvider: FileSystemProvider = defaultProvider
): Promise<JsonlParseResult> {
  if (!(await fsProvider.exists(filePath))) {
    return { messages: [], parsedLineCount: 0, consumedBytes: 0 };
  }

  return parseJsonlStream(fsProvider.createReadStream(filePath), filePath);
}

/**
 * Parse JSONL data from a readable stream while tracking how many bytes were
 * safely consumed as complete lines.
 */
export async function parseJsonlStream(
  stream: Readable,
  filePath?: string
): Promise<JsonlParseResult> {
  const messages: ParsedMessage[] = [];
  let pending = Buffer.alloc(0);
  let parsedLineCount = 0;
  let consumedBytes = 0;
  let completeLineCount = 0;
  let malformedLineCount = 0;
  let skippedNonJsonCount = 0;

  const processLine = (lineBuffer: Buffer): void => {
    let effectiveBuffer = lineBuffer;
    if (effectiveBuffer.length > 0 && effectiveBuffer[effectiveBuffer.length - 1] === 0x0d) {
      effectiveBuffer = effectiveBuffer.subarray(0, -1);
    }

    const line = effectiveBuffer.toString('utf8');
    if (!line.trim()) {
      return;
    }

    const normalized = normalizeJsonlLine(line);
    if (!looksLikeJsonObjectLine(normalized)) {
      skippedNonJsonCount += 1;
      return;
    }

    try {
      const parsed = parseJsonlLine(normalized);
      if (parsed) {
        messages.push(parsed);
        parsedLineCount += 1;
      }
    } catch {
      malformedLineCount += 1;
    }
  };

  for await (const chunk of stream) {
    const chunkBuffer =
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array);
    pending =
      pending.length === 0
        ? chunkBuffer
        : Buffer.concat([pending, chunkBuffer], pending.length + chunkBuffer.length);

    while (true) {
      const newlineIndex = pending.indexOf(0x0a);
      if (newlineIndex === -1) {
        break;
      }

      const lineBuffer = pending.subarray(0, newlineIndex);
      pending = pending.subarray(newlineIndex + 1);
      consumedBytes += lineBuffer.length + 1;
      completeLineCount += 1;
      processLine(lineBuffer);

      if (completeLineCount % 250 === 0) {
        await yieldToEventLoop();
      }
    }
  }

  if (pending.length > 0) {
    try {
      const trailingLine = pending.toString('utf8');
      const normalized = normalizeJsonlLine(trailingLine);
      if (looksLikeJsonObjectLine(normalized)) {
        const parsed = parseJsonlLine(normalized);
        if (parsed) {
          messages.push(parsed);
          parsedLineCount += 1;
          consumedBytes += pending.length;
        }
      } else if (normalized.length > 0) {
        // Treat non-JSON tail text as a complete malformed line and advance.
        consumedBytes += pending.length;
      }
    } catch {
      // Ignore trailing partial JSON. Callers should keep their offset pinned
      // until the line is completed by a future append.
    }
  }

  if (filePath && (malformedLineCount > 0 || skippedNonJsonCount > 0)) {
    logger.debug(
      `Skipped invalid JSONL lines in ${filePath} malformed=${malformedLineCount} nonJson=${skippedNonJsonCount}`
    );
  }

  return {
    messages,
    parsedLineCount,
    consumedBytes,
  };
}

/**
 * Parse a single JSONL line into a ParsedMessage.
 * Returns null for invalid/unsupported lines.
 */
export function parseJsonlLine(line: string): ParsedMessage | null {
  const normalized = normalizeJsonlLine(line);
  if (!normalized) {
    return null;
  }

  if (!looksLikeJsonObjectLine(normalized)) {
    return null;
  }

  const entry = JSON.parse(normalized) as ChatHistoryEntry;
  return parseChatHistoryEntry(entry);
}

function normalizeJsonlLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed;
}

function looksLikeJsonObjectLine(line: string): boolean {
  return line.startsWith('{');
}

// =============================================================================
// Entry Parsing
// =============================================================================

/**
 * Parse a single JSONL entry into a ParsedMessage.
 */
function parseChatHistoryEntry(entry: ChatHistoryEntry): ParsedMessage | null {
  // Skip entries without uuid (usually metadata)
  if (!entry.uuid) {
    return null;
  }

  const type = parseMessageType(entry.type);
  if (!type) {
    return null;
  }

  // Handle different entry types
  let content: string | ContentBlock[] = '';
  let role: string | undefined;
  let usage: TokenUsage | undefined;
  let model: string | undefined;
  let requestId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let agentId: string | undefined;
  let isSidechain = false;
  let isMeta = false;
  let userType: string | undefined;
  let sourceToolUseID: string | undefined;
  let sourceToolAssistantUUID: string | undefined;
  let toolUseResult: Record<string, unknown> | undefined;
  let parentUuid: string | null = null;

  // Extract properties based on entry type
  let isCompactSummary = false;
  if (isConversationalEntry(entry)) {
    // Common properties from ConversationalEntry base
    cwd = entry.cwd;
    gitBranch = entry.gitBranch;
    isSidechain = entry.isSidechain ?? false;
    userType = entry.userType;
    parentUuid = entry.parentUuid ?? null;

    // Type-specific properties
    if (entry.type === 'user') {
      content = entry.message.content ?? '';
      role = entry.message.role;
      agentId = entry.agentId;
      isMeta = entry.isMeta ?? false;
      sourceToolUseID = entry.sourceToolUseID;
      sourceToolAssistantUUID = entry.sourceToolAssistantUUID;
      toolUseResult = entry.toolUseResult;
      // Check for isCompactSummary on user entry (may exist on raw JSONL)
      isCompactSummary = 'isCompactSummary' in entry && entry.isCompactSummary === true;
    } else if (entry.type === 'assistant') {
      content = entry.message.content;
      role = entry.message.role;
      usage = entry.message.usage;
      model = entry.message.model;
      agentId = entry.agentId;
      requestId = entry.requestId;
    } else if (entry.type === 'system') {
      isMeta = entry.isMeta ?? false;
    }
  }

  // Extract tool calls and results
  const toolCalls = extractToolCalls(content);
  const toolResultsList = extractToolResults(content);

  return {
    uuid: entry.uuid,
    parentUuid,
    type,
    timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
    role,
    content,
    usage,
    model,
    // Metadata
    cwd,
    gitBranch,
    agentId,
    isSidechain,
    isMeta,
    userType,
    isCompactSummary,
    // Tool info
    toolCalls,
    toolResults: toolResultsList,
    sourceToolUseID,
    sourceToolAssistantUUID,
    toolUseResult,
    requestId,
  };
}

/**
 * Parse message type string into enum.
 */
function parseMessageType(type?: string): MessageType | null {
  switch (type) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'summary':
      return 'summary';
    case 'file-history-snapshot':
      return 'file-history-snapshot';
    case 'queue-operation':
      return 'queue-operation';
    default:
      // Unknown types are skipped
      return null;
  }
}

// =============================================================================
// Streaming Deduplication
// =============================================================================

/**
 * Deduplicate streaming assistant entries by requestId.
 *
 * Claude Code writes multiple JSONL entries per API response during streaming,
 * each with the same requestId but incrementally increasing output_tokens.
 * Only the last entry per requestId has the final, complete token counts.
 *
 * Messages without a requestId (user, system, etc.) pass through unchanged.
 * Returns a new array with only the last entry per requestId kept.
 */
export function deduplicateByRequestId(messages: ParsedMessage[]): ParsedMessage[] {
  const lastIndexByRequestId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const rid = messages[i].requestId;
    if (rid) {
      lastIndexByRequestId.set(rid, i);
    }
  }

  if (lastIndexByRequestId.size === 0) {
    return messages;
  }

  return messages.filter((msg, i) => {
    if (!msg.requestId) return true;
    return lastIndexByRequestId.get(msg.requestId) === i;
  });
}

// =============================================================================
// Metrics Calculation
// =============================================================================

/**
 * Calculate session metrics from parsed messages.
 * Deduplicates streaming entries by requestId before summing to avoid ~2x cost overcounting.
 */
export function calculateMetrics(messages: ParsedMessage[]): SessionMetrics {
  if (messages.length === 0) {
    return { ...EMPTY_METRICS };
  }

  // Deduplicate streaming entries: keep only the last entry per requestId
  const dedupedMessages = deduplicateByRequestId(messages);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  // Get timestamps for duration from ALL messages (not deduped) for accurate session length
  const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));

  let minTime = 0;
  let maxTime = 0;
  if (timestamps.length > 0) {
    minTime = timestamps[0];
    maxTime = timestamps[0];
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < minTime) minTime = timestamps[i];
      if (timestamps[i] > maxTime) maxTime = timestamps[i];
    }
  }

  // Calculate cost per-message, then sum (tiered pricing applies per-API-call, not to aggregated totals)
  let costUsd = 0;

  for (const msg of dedupedMessages) {
    if (msg.usage) {
      const msgInputTokens = msg.usage.input_tokens ?? 0;
      const msgOutputTokens = msg.usage.output_tokens ?? 0;
      const msgCacheReadTokens = msg.usage.cache_read_input_tokens ?? 0;
      const msgCacheCreationTokens = msg.usage.cache_creation_input_tokens ?? 0;

      inputTokens += msgInputTokens;
      outputTokens += msgOutputTokens;
      cacheReadTokens += msgCacheReadTokens;
      cacheCreationTokens += msgCacheCreationTokens;

      if (msg.model) {
        costUsd += calculateMessageCost(
          msg.model,
          msgInputTokens,
          msgOutputTokens,
          msgCacheReadTokens,
          msgCacheCreationTokens
        );
      }
    }
  }

  return {
    durationMs: maxTime - minTime,
    totalTokens: inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    messageCount: messages.length,
    costUsd,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Extract text content from a message for display.
 * This version applies content sanitization to filter XML-like tags.
 */
export function extractTextContent(message: ParsedMessage): string {
  let rawText: string;

  if (typeof message.content === 'string') {
    rawText = message.content;
  } else {
    rawText = message.content
      .filter(isTextContent)
      .map((block) => block.text)
      .join('\n');
  }

  // Apply sanitization to remove XML-like tags for display
  return sanitizeDisplayContent(rawText);
}

/**
 * Get all Task calls from a list of messages.
 */
export function getTaskCalls(messages: ParsedMessage[]): ToolCall[] {
  return messages.flatMap((m) => m.toolCalls.filter((tc) => tc.isTask));
}

export interface SessionFileMetadata {
  firstUserMessage: { text: string; timestamp: string } | null;
  messageCount: number;
  isOngoing: boolean;
  gitBranch: string | null;
  model?: string | null;
  /** Total context consumed (compaction-aware) */
  contextConsumption?: number;
  /** Number of compaction events */
  compactionCount?: number;
  /** Per-phase token breakdown */
  phaseBreakdown?: PhaseTokenBreakdown[];
}

/**
 * Analyze key session metadata in a single streaming pass.
 * This avoids multiple file scans when listing sessions.
 */
export async function analyzeSessionFileMetadata(
  filePath: string,
  fsProvider: FileSystemProvider = defaultProvider
): Promise<SessionFileMetadata> {
  if (!(await fsProvider.exists(filePath))) {
    return {
      firstUserMessage: null,
      messageCount: 0,
      isOngoing: false,
      gitBranch: null,
      model: null,
    };
  }

  const MAX_DEEP_SCAN_BYTES = 50 * 1024 * 1024; // 50MB
  try {
    const stat = await fsProvider.stat(filePath);
    if (!stat.isFile()) {
      return {
        firstUserMessage: null,
        messageCount: 0,
        isOngoing: false,
        gitBranch: null,
        model: null,
      };
    }
    if (stat.size > MAX_DEEP_SCAN_BYTES) {
      // Too large for deep scan — avoid blocking main/renderer.
      // Prefer a best-effort preview from the head (already size/time bounded).
      try {
        const preview = await extractFirstUserMessagePreview(filePath, fsProvider);
        return {
          firstUserMessage: preview,
          messageCount: 0,
          isOngoing: false,
          gitBranch: null,
          model: null,
        };
      } catch {
        return {
          firstUserMessage: null,
          messageCount: 0,
          isOngoing: false,
          gitBranch: null,
          model: null,
        };
      }
    }
  } catch {
    // best effort — proceed to scan
  }

  const fileStream = fsProvider.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let firstUserMessage: { text: string; timestamp: string } | null = null;
  let firstCommandMessage: { text: string; timestamp: string } | null = null;
  let messageCount = 0;
  // After a UserGroup, await the first main-thread assistant message to count the AIGroup
  let awaitingAIGroup = false;
  let gitBranch: string | null = null;
  let model: string | null = null;

  let activityIndex = 0;
  let lastEndingIndex = -1;
  let hasAnyOngoingActivity = false;
  let hasActivityAfterLastEnding = false;
  // Track tool_use IDs that are shutdown responses so their tool_results are also ending events
  const shutdownToolIds = new Set<string>();

  // Context consumption tracking

  let lastMainAssistantInputTokens = 0;
  const compactionPhases: { pre: number; post: number }[] = [];

  let awaitingPostCompaction = false;

  let lineCount = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    lineCount++;
    if (lineCount % 250 === 0) {
      await yieldToEventLoop();
    }

    let entry: ChatHistoryEntry;
    try {
      entry = JSON.parse(trimmed) as ChatHistoryEntry;
    } catch {
      continue;
    }

    const parsed = parseChatHistoryEntry(entry);
    if (!parsed) {
      continue;
    }

    if (isParsedUserChunkMessage(parsed)) {
      messageCount++;
      awaitingAIGroup = true;
    } else if (
      awaitingAIGroup &&
      parsed.type === 'assistant' &&
      parsed.model !== '<synthetic>' &&
      !parsed.isSidechain
    ) {
      messageCount++;
      awaitingAIGroup = false;
    }

    if (!gitBranch && 'gitBranch' in entry && entry.gitBranch) {
      gitBranch = entry.gitBranch;
    }

    if (parsed.type === 'assistant' && !parsed.isSidechain && parsed.model !== '<synthetic>') {
      model = parsed.model ?? model;
    }

    if (!firstUserMessage && entry.type === 'user') {
      const content = entry.message?.content;
      if (typeof content === 'string') {
        if (isCommandOutputContent(content)) {
          // Skip
        } else if (content.startsWith('[Request interrupted by user')) {
          // Skip interruption messages
        } else if (content.startsWith('<command-name>')) {
          if (!firstCommandMessage) {
            const commandMatch = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
            const commandName = commandMatch ? `/${commandMatch[1]}` : '/command';
            firstCommandMessage = {
              text: commandName,
              timestamp: entry.timestamp ?? new Date().toISOString(),
            };
          }
        } else {
          const sanitized = sanitizeDisplayContent(content);
          if (sanitized.length > 0) {
            firstUserMessage = {
              text: sanitized.substring(0, 500),
              timestamp: entry.timestamp ?? new Date().toISOString(),
            };
          }
        }
      } else if (Array.isArray(content)) {
        const textContent = content
          .filter(isTextContent)
          .map((b) => b.text)
          .join(' ');
        if (
          textContent &&
          !textContent.startsWith('<command-name>') &&
          !textContent.startsWith('[Request interrupted by user')
        ) {
          const sanitized = sanitizeDisplayContent(textContent);
          if (sanitized.length > 0) {
            firstUserMessage = {
              text: sanitized.substring(0, 500),
              timestamp: entry.timestamp ?? new Date().toISOString(),
            };
          }
        }
      }
    }

    // Ongoing detection with one-pass activity tracking.
    if (parsed.type === 'assistant' && Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (block.type === 'thinking' && block.thinking) {
          hasAnyOngoingActivity = true;
          if (lastEndingIndex >= 0) {
            hasActivityAfterLastEnding = true;
          }
          activityIndex++;
        } else if (block.type === 'tool_use' && block.id) {
          if (block.name === 'ExitPlanMode') {
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else if (
            block.name === 'SendMessage' &&
            block.input?.type === 'shutdown_response' &&
            block.input?.approve === true
          ) {
            // SendMessage shutdown_response = agent is shutting down (ending event)
            shutdownToolIds.add(block.id);
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else {
            hasAnyOngoingActivity = true;
            if (lastEndingIndex >= 0) {
              hasActivityAfterLastEnding = true;
            }
            activityIndex++;
          }
        } else if (block.type === 'text' && block.text && String(block.text).trim().length > 0) {
          lastEndingIndex = activityIndex++;
          hasActivityAfterLastEnding = false;
        }
      }
    } else if (parsed.type === 'user' && Array.isArray(parsed.content)) {
      // Check if this is a user-rejected tool use (ending event, not ongoing activity)
      const isRejection =
        'toolUseResult' in entry &&
        (entry as unknown as Record<string, unknown>).toolUseResult === 'User rejected tool use';

      for (const block of parsed.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          if (shutdownToolIds.has(block.tool_use_id) || isRejection) {
            // Shutdown tool result or user rejection = ending event
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else {
            hasAnyOngoingActivity = true;
            if (lastEndingIndex >= 0) {
              hasActivityAfterLastEnding = true;
            }
            activityIndex++;
          }
        } else if (
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.startsWith('[Request interrupted by user')
        ) {
          lastEndingIndex = activityIndex++;
          hasActivityAfterLastEnding = false;
        }
      }
    }

    // Context consumption: track main-thread assistant input tokens
    if (parsed.type === 'assistant' && !parsed.isSidechain && parsed.model !== '<synthetic>') {
      const inputTokens =
        (parsed.usage?.input_tokens ?? 0) +
        (parsed.usage?.cache_read_input_tokens ?? 0) +
        (parsed.usage?.cache_creation_input_tokens ?? 0);
      if (inputTokens > 0) {
        if (awaitingPostCompaction && compactionPhases.length > 0) {
          compactionPhases[compactionPhases.length - 1].post = inputTokens;
          awaitingPostCompaction = false;
        }
        lastMainAssistantInputTokens = inputTokens;
      }
    }

    // Context consumption: detect compaction events
    if (parsed.isCompactSummary) {
      compactionPhases.push({ pre: lastMainAssistantInputTokens, post: 0 });
      awaitingPostCompaction = true;
    }
  }

  // Compute context consumption from tracked phases
  let contextConsumption: number | undefined;
  let phaseBreakdown: PhaseTokenBreakdown[] | undefined;

  if (lastMainAssistantInputTokens > 0) {
    if (compactionPhases.length === 0) {
      // No compaction: just the final input tokens
      contextConsumption = lastMainAssistantInputTokens;
      phaseBreakdown = [
        {
          phaseNumber: 1,
          contribution: lastMainAssistantInputTokens,
          peakTokens: lastMainAssistantInputTokens,
        },
      ];
    } else {
      phaseBreakdown = [];
      let total = 0;

      // Phase 1: tokens up to first compaction
      const phase1Contribution = compactionPhases[0].pre;
      total += phase1Contribution;
      phaseBreakdown.push({
        phaseNumber: 1,
        contribution: phase1Contribution,
        peakTokens: compactionPhases[0].pre,
        postCompaction: compactionPhases[0].post,
      });

      // Middle phases: contribution = pre[i] - post[i-1]
      for (let i = 1; i < compactionPhases.length; i++) {
        const contribution = compactionPhases[i].pre - compactionPhases[i - 1].post;
        total += contribution;
        phaseBreakdown.push({
          phaseNumber: i + 1,
          contribution,
          peakTokens: compactionPhases[i].pre,
          postCompaction: compactionPhases[i].post,
        });
      }

      // Last phase: final tokens - last post-compaction
      // Guard: if the last compaction had no subsequent assistant message, post is 0.
      // In that case, skip the final phase to avoid double-counting.
      const lastPhase = compactionPhases[compactionPhases.length - 1];
      if (lastPhase.post > 0) {
        const lastContribution = lastMainAssistantInputTokens - lastPhase.post;
        total += lastContribution;
        phaseBreakdown.push({
          phaseNumber: compactionPhases.length + 1,
          contribution: lastContribution,
          peakTokens: lastMainAssistantInputTokens,
        });
      }

      contextConsumption = total;
    }
  }

  return {
    firstUserMessage: firstUserMessage ?? firstCommandMessage,
    messageCount,
    isOngoing: lastEndingIndex === -1 ? hasAnyOngoingActivity : hasActivityAfterLastEnding,
    gitBranch,
    model,
    contextConsumption,
    compactionCount: compactionPhases.length > 0 ? compactionPhases.length : undefined,
    phaseBreakdown,
  };
}
