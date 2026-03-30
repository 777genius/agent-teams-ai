/**
 * Content sanitization utilities for display.
 *
 * SHARED MODULE: Used by both main and renderer processes.
 * - Main process: Used in jsonl.ts for initial parsing
 * - Renderer process: Used in groupTransformer.ts for display formatting
 *
 * This module handles conversion of raw JSONL content (with XML tags) into
 * human-readable format for the UI.
 *
 * NOTE: This file was previously duplicated in both main/utils and renderer/utils.
 * Consolidated to src/shared/utils to maintain DRY principle while serving both processes.
 */

/**
 * Patterns for noise tags that should be completely removed.
 * These are system-generated metadata that provide no value in display.
 */
const NOISE_TAG_PATTERNS = [
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
];

export interface CommandOutputInfo {
  stream: 'stdout' | 'stderr';
  output: string;
}

/**
 * Extract content from <local-command-stdout> tags.
 * Returns the command output without the wrapper tags.
 */
export function extractCommandOutputInfo(content: string): CommandOutputInfo | null {
  const match = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i.exec(content);
  const matchStderr = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/i.exec(content);
  if (match) {
    return {
      stream: 'stdout',
      output: match[1].trim(),
    };
  }
  if (matchStderr) {
    return {
      stream: 'stderr',
      output: matchStderr[1].trim(),
    };
  }
  return null;
}

/**
 * Extract command info from command XML tags.
 * Returns the slash command in readable format (e.g., "/model sonnet")
 */
function extractCommandDisplay(content: string): string | null {
  const commandNameMatch = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
  const commandArgsMatch = /<command-args>([^<]*)<\/command-args>/.exec(content);

  if (commandNameMatch) {
    const commandName = `/${commandNameMatch[1].trim()}`;
    const args = commandArgsMatch?.[1]?.trim();
    return args ? `${commandName} ${args}` : commandName;
  }

  return null;
}

/**
 * Check if content is primarily a command message.
 * Handles both orderings:
 * - Built-in commands: <command-name> comes first
 * - Skill commands: <command-message> comes first, followed by <command-name>
 */
export function isCommandContent(content: string): boolean {
  return content.startsWith('<command-name>') || content.startsWith('<command-message>');
}

/**
 * Check if content is a command output message.
 */
export function isCommandOutputContent(content: string): boolean {
  return (
    content.startsWith('<local-command-stdout>') || content.startsWith('<local-command-stderr>')
  );
}

/**
 * Sanitize content for display.
 *
 * - Command messages: Converted to readable format (e.g., "/model sonnet")
 * - Command output: Extracted from <local-command-stdout> tags
 * - Noise tags: Completely removed
 * - Regular content: Returned as-is
 */
export function sanitizeDisplayContent(content: string): string {
  // If it's a command output message, extract the output content
  if (isCommandOutputContent(content)) {
    const commandOutput = extractCommandOutputInfo(content);
    if (commandOutput) {
      return commandOutput.output;
    }
  }

  // If it's a command message, extract the command for display
  if (isCommandContent(content)) {
    const commandDisplay = extractCommandDisplay(content);
    if (commandDisplay) {
      return commandDisplay;
    }
  }

  // Remove noise tags
  let sanitized = content;
  for (const pattern of NOISE_TAG_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }

  // Also remove any remaining command tags (in case of mixed content)
  sanitized = sanitized
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '');

  return sanitized.trim();
}

/**
 * Slash info extracted from command XML tags.
 * All slash commands have the same format:
 *   <command-name>/xxx</command-name>
 *   <command-message>xxx</command-message>
 *   <command-args>optional</command-args>
 */
export interface SlashInfo {
  /** Slash name without the leading slash (e.g., "model", "isolate-context") */
  name: string;
  /** Message content from <command-message> */
  message?: string;
  /** Optional arguments from <command-args> */
  args?: string;
}

/**
 * Extract slash information from command XML tags.
 * Works for all slash types: skills, built-in commands, plugins, MCP, user commands.
 * Returns null if not a slash command format.
 */
export function extractSlashInfo(content: string): SlashInfo | null {
  const nameMatch = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
  if (!nameMatch) return null;

  const name = nameMatch[1].trim();

  const messageMatch = /<command-message>([^<]*)<\/command-message>/.exec(content);
  const argsMatch = /<command-args>([^<]*)<\/command-args>/.exec(content);

  return {
    name,
    message: messageMatch?.[1]?.trim() ?? undefined,
    args: argsMatch?.[1]?.trim() ?? undefined,
  };
}
