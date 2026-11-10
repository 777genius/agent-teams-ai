/**
 * Slash Command Extractor - Handle slash command extraction from AI Group responses
 *
 * Extracts and processes slash command invocations and their follow-up instructions.
 */

import { extractSlashInfo, isCommandContent } from '@shared/utils/contentSanitizer';

import { estimateTokens, toDate } from './aiGroupHelpers';

import type { ParsedMessage } from '@renderer/types/data';
import type { SlashItem } from '@renderer/types/groups';

/**
 * Info about the preceding user message's slash invocation.
 * This is passed from the UserGroup to help link slash outputs to slash names.
 */
export interface PrecedingSlashInfo {
  /** Slash name (e.g., "claude-hud:setup", "isolate-context", "model") */
  name: string;
  /** Message content from <command-message> */
  message?: string;
  /** Arguments from <command-args> */
  args?: string;
  /** UUID of the slash command message */
  commandMessageUuid: string;
  /** Timestamp of the slash command message */
  timestamp: Date;
}

/**
 * Extract slash items from AI group responses.
 *
 * All slash invocations follow the same format:
 *   <command-name>/xxx</command-name>
 *   <command-message>xxx</command-message>
 *   <command-args>optional</command-args>
 *
 * Strategy:
 * 1. Build a map of follow-up messages (isMeta:true with parentUuid) by their parentUuid
 * 2. If precedingSlash is provided, create a SlashItem with its follow-up instructions
 * 3. Also check for any slash invocations in responses (fallback)
 *
 * @param responses - All response messages in the AI group
 * @param precedingSlash - Optional slash info from the preceding UserGroup
 * @returns Array of SlashItem objects ready for display
 */
export function extractSlashes(
  responses: ParsedMessage[],
  precedingSlash?: PrecedingSlashInfo
): SlashItem[] {
  const slashes: SlashItem[] = [];

  // Build a map of follow-up messages by their parentUuid
  // These are isMeta:true messages that contain slash instructions/output
  const followUpsByParentUuid = new Map<
    string,
    {
      text: string;
      timestamp: Date;
    }
  >();

  // Also build a map of potential slash messages from responses (fallback)
  const slashMessagesById = new Map<
    string,
    {
      uuid: string;
      name: string;
      message?: string;
      args?: string;
      timestamp: Date;
    }
  >();

  for (const msg of responses) {
    // Look for slash messages (user messages with string content containing <command-name>)
    // This is a fallback in case the slash invocation is somehow in responses
    if (msg.type === 'user' && typeof msg.content === 'string' && isCommandContent(msg.content)) {
      const slashInfo = extractSlashInfo(msg.content);
      if (slashInfo) {
        slashMessagesById.set(msg.uuid, {
          uuid: msg.uuid,
          name: slashInfo.name,
          message: slashInfo.message,
          args: slashInfo.args,
          timestamp: toDate(msg.timestamp),
        });
      }
    }

    // Look for follow-up isMeta messages with parentUuid
    if (
      msg.type === 'user' &&
      msg.isMeta === true &&
      msg.parentUuid &&
      !msg.sourceToolUseID && // Exclude tool-call related messages
      Array.isArray(msg.content)
    ) {
      // Extract text from the message
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          const text = block.text;
          followUpsByParentUuid.set(msg.parentUuid, {
            text,
            timestamp: toDate(msg.timestamp),
          });
          break; // Only need the first text block
        }
      }
    }
  }

  // Strategy 1: If we have precedingSlash info, create a SlashItem with its follow-up
  if (precedingSlash) {
    const followUp = followUpsByParentUuid.get(precedingSlash.commandMessageUuid);

    slashes.push({
      id: `slash-${precedingSlash.commandMessageUuid}`,
      name: precedingSlash.name,
      message: precedingSlash.message,
      args: precedingSlash.args,
      commandMessageUuid: precedingSlash.commandMessageUuid,
      instructions: followUp?.text,
      instructionsTokenCount: followUp ? estimateTokens(followUp.text) : undefined,
      // Use follow-up timestamp if available (sorts with other AI items),
      // otherwise fall back to slash invocation timestamp
      timestamp: followUp?.timestamp ?? precedingSlash.timestamp,
    });
  }

  // Strategy 2: Fallback - match slash messages found in responses to their follow-ups
  for (const [uuid, slashMsg] of slashMessagesById.entries()) {
    // Skip if we already added this slash via precedingSlash
    if (uuid === precedingSlash?.commandMessageUuid) {
      continue;
    }

    const followUp = followUpsByParentUuid.get(uuid);

    slashes.push({
      id: `slash-${uuid}`,
      name: slashMsg.name,
      message: slashMsg.message,
      args: slashMsg.args,
      commandMessageUuid: uuid,
      instructions: followUp?.text,
      instructionsTokenCount: followUp ? estimateTokens(followUp.text) : undefined,
      timestamp: slashMsg.timestamp,
    });
  }

  return slashes;
}
