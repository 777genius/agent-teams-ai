/**
 * SessionContentFilter - Filters noise messages from sessions.
 *
 * Responsibilities:
 * - Check if session files contain displayable content
 * - Categorize messages as displayable or noise
 * - Filter out system-generated and meta messages
 *
 * A session is displayable if it contains at least one:
 * - Real user message (creates UserChunk)
 * - System output message (creates SystemChunk)
 * - Assistant message (creates AIChunk)
 * - Compact boundary message (creates CompactChunk)
 *
 * Filtered out (hard noise):
 * - system entries
 * - summary entries
 * - file-history-snapshot entries
 * - queue-operation entries
 * - user messages with ONLY <local-command-caveat> or <system-reminder>
 * - synthetic assistant messages (model='<synthetic>')
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import { type ChatHistoryEntry, type ContentBlock } from '@main/types';
import { createLogger } from '@shared/utils/logger';
import * as readline from 'readline';

import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

const logger = createLogger('Service:SessionContentFilter');

const defaultProvider = new LocalFileSystemProvider();

const SESSION_SCAN_TIMEOUT_MS = 2500;
const SESSION_SCAN_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_SCAN_MAX_LINES = 2000;

function byteLen(chunk: string): number {
  return Buffer.byteLength(chunk, 'utf8');
}

/**
 * Hard noise tags - user messages with ONLY these tags are filtered out.
 */
const HARD_NOISE_TAGS = ['<local-command-caveat>', '<system-reminder>'];

/**
 * Hard noise entry types - these types are always filtered out.
 */
const HARD_NOISE_TYPES = ['system', 'summary', 'file-history-snapshot', 'queue-operation'];

/**
 * SessionContentFilter provides static methods for filtering noise messages.
 */
export class SessionContentFilter {
  /**
   * Checks if a session file contains any displayable conversation items.
   * Returns true if the session has at least one message that would create
   * a visible chunk (UserChunk, SystemChunk, AIChunk, or CompactChunk).
   *
   * Uses the same logic as ChunkBuilder to ensure consistency with ChatHistory:
   * - Sessions that pass this check will have non-empty conversation.items
   * - Sessions that fail will show "No conversation history" in ChatHistory
   *
   * @param filePath - Path to the session JSONL file
   * @returns Promise resolving to true if session has displayable content
   */
  static async hasNonNoiseMessages(
    filePath: string,
    fsProvider: FileSystemProvider = defaultProvider
  ): Promise<boolean> {
    if (!(await fsProvider.exists(filePath))) {
      return false;
    }

    try {
      const stat = await fsProvider.stat(filePath);
      if (!stat.isFile()) {
        return false;
      }
    } catch {
      return false;
    }

    const fileStream = fsProvider.createReadStream(filePath, { encoding: 'utf8' });
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      fileStream.destroy();
    }, SESSION_SCAN_TIMEOUT_MS);
    fileStream.on('data', (chunk: string) => {
      bytes += byteLen(chunk);
      if (bytes > SESSION_SCAN_MAX_BYTES) {
        fileStream.destroy();
      }
    });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    try {
      let lines = 0;
      for await (const line of rl) {
        if (++lines > SESSION_SCAN_MAX_LINES) {
          break;
        }
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line) as ChatHistoryEntry;

          // Skip entries without uuid (queue-operation, etc.)
          if (!entry.uuid) {
            continue;
          }

          // Check if this entry would create a displayable chunk
          // This aligns with ChunkBuilder.categorizeMessage() logic
          if (SessionContentFilter.isDisplayableEntry(entry)) {
            rl.close();
            fileStream.destroy();
            return true;
          }
        } catch {
          // Skip malformed lines
          continue;
        }
      }
    } catch (error) {
      if (!timedOut) {
        logger.debug(`Error checking displayable messages in ${filePath}:`, error);
      }
    } finally {
      clearTimeout(timer);
      rl.close();
      fileStream.destroy();
    }

    // If we hit limits/timeouts, be conservative: treat as having content so we
    // don't accidentally hide sessions due to partial reads.
    if (timedOut || bytes > SESSION_SCAN_MAX_BYTES) {
      return true;
    }

    return false;
  }

  /**
   * Checks if a JSONL entry would create a displayable chunk.
   * Mirrors the logic in ChunkBuilder.categorizeMessage() and isParsed*Message() guards.
   *
   * @param entry - The parsed JSONL entry
   * @returns true if the entry would create a displayable chunk
   */
  static isDisplayableEntry(entry: ChatHistoryEntry): boolean {
    const entryType = entry.type;

    // Hard noise types - never displayed
    if (HARD_NOISE_TYPES.includes(entryType)) {
      return false;
    }

    // Sidechain messages are subagent messages - not part of main conversation
    if ('isSidechain' in entry && entry.isSidechain === true) {
      return false;
    }

    // Assistant messages - displayable (creates AIChunk)
    // Filter synthetic messages (model='<synthetic>')
    if (entryType === 'assistant') {
      const assistantEntry = entry as { message?: { model?: string } };
      return assistantEntry.message?.model !== '<synthetic>';
    }

    // User messages - check for real user input vs noise
    if (entryType === 'user') {
      return SessionContentFilter.isDisplayableUserEntry(entry);
    }

    return false;
  }

  /**
   * Checks if a user entry is displayable.
   *
   * @param entry - The user entry to check
   * @returns true if the user entry would create a displayable chunk
   */
  private static isDisplayableUserEntry(entry: ChatHistoryEntry): boolean {
    const userEntry = entry as {
      message?: { content?: string | ContentBlock[] };
      isMeta?: boolean;
    };
    const content = userEntry.message?.content;
    const isMeta = userEntry.isMeta;

    // Internal user messages (tool results) - part of AI response flow
    // These ARE displayable as they're part of AIChunks
    if (isMeta === true) {
      return true;
    }

    // String content
    if (typeof content === 'string') {
      return SessionContentFilter.isDisplayableStringContent(content);
    }

    // Array content (newer format)
    if (Array.isArray(content)) {
      return SessionContentFilter.isDisplayableArrayContent(content);
    }

    return false;
  }

  /**
   * Checks if string content is displayable.
   *
   * @param content - The string content to check
   * @returns true if displayable
   */
  private static isDisplayableStringContent(content: string): boolean {
    const trimmed = content.trim();

    // Check for hard noise tags - user messages with ONLY these tags
    for (const tag of HARD_NOISE_TAGS) {
      const openTag = tag;
      const closeTag = tag.replace('<', '</');
      if (trimmed.startsWith(openTag) && trimmed.endsWith(closeTag)) {
        return false;
      }
    }

    // System output (creates SystemChunk) - displayable
    if (
      trimmed.startsWith('<local-command-stdout>') ||
      trimmed.startsWith('<local-command-stderr>')
    ) {
      return true;
    }

    // Real user input (creates UserChunk) - displayable
    if (trimmed.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Checks if array content is displayable.
   *
   * @param content - The array content to check
   * @returns true if displayable
   */
  private static isDisplayableArrayContent(content: ContentBlock[]): boolean {
    // Check for tool_result blocks (part of AI response flow)
    const hasToolResult = content.some((block: ContentBlock) => block.type === 'tool_result');
    if (hasToolResult) {
      return true;
    }

    // Check for text/image blocks (real user input)
    const hasUserContent = content.some(
      (block: ContentBlock) => block.type === 'text' || block.type === 'image'
    );

    if (hasUserContent) {
      // Filter user interruption messages - but these are still displayable
      if (
        content.length === 1 &&
        content[0].type === 'text' &&
        typeof content[0].text === 'string' &&
        content[0].text.startsWith('[Request interrupted by user')
      ) {
        // Interruptions are part of AI flow, still displayable
        return true;
      }

      // Check text blocks for hard noise tags
      for (const block of content) {
        if (block.type === 'text') {
          const textBlock = block;
          for (const tag of HARD_NOISE_TAGS) {
            const closeTag = tag.replace('<', '</');
            if (textBlock.text.startsWith(tag) && textBlock.text.trim().endsWith(closeTag)) {
              return false;
            }
          }
        }
      }

      return true;
    }

    return false;
  }
}
