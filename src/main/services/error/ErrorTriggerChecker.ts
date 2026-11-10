/**
 * ErrorTriggerChecker service - Checks different trigger types against messages.
 *
 * Provides utilities for:
 * - Checking tool_result triggers
 * - Checking tool_use triggers
 * - Checking token threshold triggers
 * - Validating project scope
 */

import { type ParsedMessage } from '@main/types';
import { extractProjectName } from '@main/utils/pathDecoder';
import * as path from 'path';

import {
  estimateTokens,
  extractToolResults,
  type ToolResultInfo,
  type ToolUseInfo,
} from '../analysis/ToolResultExtractor';
import { formatTokens, getToolSummary } from '../analysis/ToolSummaryFormatter';
import { projectPathResolver } from '../discovery/ProjectPathResolver';
import { type NotificationTrigger } from '../infrastructure/ConfigManager';
import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import {
  createDetectedError,
  type DetectedError,
  extractErrorMessage,
  findToolNameByToolUseId,
} from './ErrorMessageBuilder';
import {
  extractToolUseField,
  getContentBlocks,
  matchesIgnorePatterns,
  matchesPattern,
} from './TriggerMatcher';

// =============================================================================
// Repository Scope Checking
// =============================================================================

// Cache for projectId -> repositoryId mapping to avoid repeated resolution
const repositoryIdCache = new Map<string, string | null>();

interface RepositoryScopeTarget {
  projectId: string;
  cwdHint?: string;
}

/**
 * Resolves a projectId to its repositoryId using GitIdentityResolver.
 * Results are cached for performance.
 * @param projectId - The encoded project ID (e.g., "-Users-username-myproject")
 * @returns Repository ID or null if not resolvable
 */
async function resolveRepositoryId(target: string | RepositoryScopeTarget): Promise<string | null> {
  const projectId = typeof target === 'string' ? target : target.projectId;
  const cwdHint = typeof target === 'string' ? undefined : target.cwdHint;

  // Check cache first
  if (repositoryIdCache.has(projectId)) {
    return repositoryIdCache.get(projectId) ?? null;
  }

  const projectPath = await projectPathResolver.resolveProjectPath(projectId, { cwdHint });

  // Resolve repository identity
  // projectPath can be "C:/..." on Windows (decodePath), but GitIdentityResolver
  // relies on path.sep splitting in a few code paths. Normalize to platform style.
  const identity = await gitIdentityResolver.resolveIdentity(path.normalize(projectPath));
  const repositoryId = identity?.id ?? null;

  // Cache the result
  repositoryIdCache.set(projectId, repositoryId);

  return repositoryId;
}

/**
 * Synchronous version of resolveRepositoryId using cached values only.
 * If not cached, attempts synchronous resolution via path heuristics.
 */
function resolveRepositoryIdSync(projectId: string): string | null {
  // Check cache first
  if (repositoryIdCache.has(projectId)) {
    return repositoryIdCache.get(projectId) ?? null;
  }

  // For sync context, we can't do async resolution
  // The async version should be called during initialization
  return null;
}

/**
 * Checks if the project matches the trigger's repository scope.
 * @param projectId - The encoded project ID (e.g., "-Users-username-myproject")
 * @param repositoryIds - Optional list of repository group IDs to scope the trigger to
 * @returns true if trigger should apply, false if it should be skipped
 */
export function matchesRepositoryScope(projectId: string, repositoryIds?: string[]): boolean {
  // If no repository IDs specified, trigger applies to all repositories
  if (!repositoryIds || repositoryIds.length === 0) {
    return true;
  }

  // Get the repository ID for this project (from cache)
  const repositoryId = resolveRepositoryIdSync(projectId);

  // If we can't resolve the repository ID, don't match
  if (!repositoryId) {
    return false;
  }

  // Check if the repository ID matches any of the configured IDs
  return repositoryIds.includes(repositoryId);
}

/**
 * Pre-resolves repository IDs for a list of project IDs.
 * Call this before checking triggers to populate the cache.
 */
export async function preResolveRepositoryIds(
  targets: (string | RepositoryScopeTarget)[]
): Promise<void> {
  const uniqueTargets = new Map<string, RepositoryScopeTarget>();

  for (const target of targets) {
    if (typeof target === 'string') {
      if (!uniqueTargets.has(target)) {
        uniqueTargets.set(target, { projectId: target });
      }
      continue;
    }

    const existing = uniqueTargets.get(target.projectId);
    if (!existing) {
      uniqueTargets.set(target.projectId, target);
      continue;
    }

    // Prefer a target with cwd hint if one was provided.
    if (!existing.cwdHint && target.cwdHint) {
      uniqueTargets.set(target.projectId, target);
    }
  }

  await Promise.all(
    Array.from(uniqueTargets.values()).map((target) => resolveRepositoryId(target))
  );
}

// =============================================================================
// Tool Result Trigger Checking
// =============================================================================

/**
 * Checks if a tool_result matches a trigger.
 */
export function checkToolResultTrigger(
  message: ParsedMessage,
  trigger: NotificationTrigger,
  toolUseMap: Map<string, ToolUseInfo>,
  sessionId: string,
  projectId: string,
  filePath: string,
  lineNumber: number
): DetectedError | null {
  const toolResults = extractToolResults(message, findToolNameByToolUseId);

  for (const result of toolResults) {
    // If requireError is true, only match when is_error is true
    if (trigger.requireError) {
      if (!result.isError) {
        continue;
      }

      // Extract error message for ignore pattern checking
      const errorMessage = extractErrorMessage(result);

      // Check ignore patterns - if any match, skip this error
      if (matchesIgnorePatterns(errorMessage, trigger.ignorePatterns)) {
        continue;
      }

      // Create detected error
      return createDetectedError({
        sessionId,
        projectId,
        filePath,
        projectName: extractProjectName(projectId, message.cwd),
        lineNumber,
        source: result.toolName ?? 'tool_result',
        message: errorMessage,
        timestamp: message.timestamp,
        cwd: message.cwd,
        toolUseId: result.toolUseId,
        triggerColor: trigger.color,
        triggerId: trigger.id,
        triggerName: trigger.name,
      });
    }

    // Non-error tool_result triggers (if toolName is specified)
    if (trigger.toolName) {
      const toolUse = toolUseMap.get(result.toolUseId);
      if (toolUse?.name !== trigger.toolName) {
        continue;
      }

      // Match against content if matchField is 'content'
      if (trigger.matchField === 'content' && trigger.matchPattern) {
        const content =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
        if (!matchesPattern(content, trigger.matchPattern)) {
          continue;
        }
        if (matchesIgnorePatterns(content, trigger.ignorePatterns)) {
          continue;
        }

        return createDetectedError({
          sessionId,
          projectId,
          filePath,
          projectName: extractProjectName(projectId, message.cwd),
          lineNumber,
          source: trigger.toolName,
          message: `Tool result matched: ${content.slice(0, 200)}`,
          timestamp: message.timestamp,
          cwd: message.cwd,
          toolUseId: result.toolUseId,
          triggerColor: trigger.color,
          triggerId: trigger.id,
          triggerName: trigger.name,
        });
      }
    }
  }

  return null;
}

// =============================================================================
// Tool Use Trigger Checking
// =============================================================================

/**
 * Checks if a tool_use matches a trigger.
 */
export function checkToolUseTrigger(
  message: ParsedMessage,
  trigger: NotificationTrigger,
  sessionId: string,
  projectId: string,
  filePath: string,
  lineNumber: number
): DetectedError | null {
  if (message.type !== 'assistant') return null;

  const contentBlocks = getContentBlocks(message);

  for (const block of contentBlocks) {
    if (block.type !== 'tool_use') continue;

    const toolUse = block as {
      type: 'tool_use';
      id: string;
      name: string;
      input?: Record<string, unknown>;
    };

    // Check tool name if specified
    if (trigger.toolName && toolUse.name !== trigger.toolName) {
      continue;
    }

    // Extract the field to match based on matchField
    // If no matchField specified (e.g., "Any Tool"), match against entire input JSON
    const fieldValue = trigger.matchField
      ? extractToolUseField(toolUse, trigger.matchField)
      : toolUse.input
        ? JSON.stringify(toolUse.input)
        : null;
    if (!fieldValue) continue;

    // Check match pattern
    if (trigger.matchPattern && !matchesPattern(fieldValue, trigger.matchPattern)) {
      continue;
    }

    // Check ignore patterns
    if (matchesIgnorePatterns(fieldValue, trigger.ignorePatterns)) {
      continue;
    }

    // Match found!
    return createDetectedError({
      sessionId,
      projectId,
      filePath,
      projectName: extractProjectName(projectId, message.cwd),
      lineNumber,
      source: toolUse.name,
      message: `${trigger.matchField ?? 'tool_use'}: ${fieldValue.slice(0, 200)}`,
      timestamp: message.timestamp,
      cwd: message.cwd,
      toolUseId: toolUse.id,
      triggerColor: trigger.color,
      triggerId: trigger.id,
      triggerName: trigger.name,
    });
  }

  return null;
}

// =============================================================================
// Token Threshold Trigger Checking
// =============================================================================

/**
 * Check if individual tool_use blocks exceed the token threshold.
 * Returns an array of DetectedError for each tool_use that exceeds the threshold.
 *
 * Token calculation (matches context window impact):
 * - Tool call tokens: estimated from name + JSON.stringify(input) (what enters context)
 * - Tool result tokens: estimated from tool_result.content (what Claude reads)
 * - Total = call + result
 */
export function checkTokenThresholdTrigger(
  message: ParsedMessage,
  trigger: NotificationTrigger,
  toolResultMap: Map<string, ToolResultInfo>,
  sessionId: string,
  projectId: string,
  filePath: string,
  lineNumber: number
): DetectedError[] {
  const errors: DetectedError[] = [];

  // Only check for token_threshold mode
  if (trigger.mode !== 'token_threshold' || !trigger.tokenThreshold) {
    return errors;
  }

  // Only check assistant messages that contain tool_use blocks
  if (message.type !== 'assistant') {
    return errors;
  }

  const tokenType = trigger.tokenType ?? 'total';
  const threshold = trigger.tokenThreshold;

  // Collect all tool_use blocks from message
  const toolUseBlocks: { id: string; name: string; input: Record<string, unknown> }[] = [];

  // Check content array for tool_use blocks
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        const toolUse = block;
        toolUseBlocks.push({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input || {},
        });
      }
    }
  }

  // Also check toolCalls array if present
  if (message.toolCalls) {
    for (const toolCall of message.toolCalls) {
      // Avoid duplicates
      if (!toolUseBlocks.some((t) => t.id === toolCall.id)) {
        toolUseBlocks.push({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input || {},
        });
      }
    }
  }

  if (toolUseBlocks.length === 0) {
    return errors;
  }

  // Check each tool_use block individually
  for (const toolUse of toolUseBlocks) {
    // Check tool name filter if specified
    if (trigger.toolName && toolUse.name !== trigger.toolName) {
      continue;
    }

    // Calculate tool call tokens directly from name + input
    // This reflects what actually enters the context window
    const toolCallTokens = estimateTokens(toolUse.name + JSON.stringify(toolUse.input));

    // Calculate tool result tokens (what Claude reads back)
    let toolResultTokens = 0;
    const toolResult = toolResultMap.get(toolUse.id);
    if (toolResult) {
      toolResultTokens = estimateTokens(toolResult.content);
    }

    // Calculate token count based on tokenType
    // Note: 'input' here means tool CALL tokens (what enters context)
    //       'output' here means tool RESULT tokens (what Claude reads)
    let tokenCount = 0;
    switch (tokenType) {
      case 'input':
        // Tool call tokens (name + input that enters context)
        tokenCount = toolCallTokens;
        break;
      case 'output':
        // Tool result tokens (what Claude reads - success message, file content for Read, etc.)
        tokenCount = toolResultTokens;
        break;
      case 'total':
        // Both: full context impact of the tool operation
        tokenCount = toolCallTokens + toolResultTokens;
        break;
    }

    // Check threshold
    if (tokenCount <= threshold) {
      continue;
    }

    // Build summary for the tool
    const toolSummary = getToolSummary(toolUse.name, toolUse.input);

    // Build message with tool info and token type for clarity
    const tokenTypeLabel = tokenType === 'total' ? '' : ` ${tokenType}`;
    const tokenMessage = `${toolUse.name} - ${toolSummary} : ~${formatTokens(tokenCount)}${tokenTypeLabel} tokens`;

    // Check ignore patterns
    if (matchesIgnorePatterns(tokenMessage, trigger.ignorePatterns)) {
      continue;
    }

    errors.push(
      createDetectedError({
        sessionId,
        projectId,
        filePath,
        projectName: extractProjectName(projectId, message.cwd),
        lineNumber,
        source: toolUse.name,
        message: tokenMessage,
        timestamp: message.timestamp,
        cwd: message.cwd,
        toolUseId: toolUse.id,
        triggerColor: trigger.color,
        triggerId: trigger.id,
        triggerName: trigger.name,
      })
    );
  }

  return errors;
}
