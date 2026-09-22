/**
 * ErrorDetector service - Detects errors from parsed JSONL messages.
 *
 * This is the main orchestrator that coordinates between specialized modules:
 * - ToolSummaryFormatter: Formats tool information for display
 * - TriggerMatcher: Pattern matching utilities
 * - ToolResultExtractor: Extracts tool results from messages
 * - ErrorMessageBuilder: Builds error messages and DetectedError objects
 * - ErrorTriggerChecker: Checks different trigger types
 * - ErrorTriggerTester: Testing functionality for trigger preview
 *
 * Detection criteria:
 * - Uses configurable triggers from ConfigManager
 * - Supports tool_result triggers with requireError, toolName, and matchPattern
 * - Supports tool_use triggers for future expansion
 * - Supports token_threshold triggers for monitoring context usage
 */

import { type ParsedMessage } from '@main/types';

import {
  buildToolResultMap,
  buildToolUseMap,
  type ToolResultInfo,
  type ToolUseInfo,
} from '../analysis/ToolResultExtractor';
import { ConfigManager, type NotificationTrigger } from '../infrastructure/ConfigManager';

import { type DetectedError } from './ErrorMessageBuilder';
import {
  checkTokenThresholdTrigger,
  checkToolResultTrigger,
  checkToolUseTrigger,
  matchesRepositoryScope,
  preResolveRepositoryIds,
} from './ErrorTriggerChecker';
import { testTrigger as testTriggerImpl } from './ErrorTriggerTester';

// =============================================================================
// Error Detector Class
// =============================================================================

class ErrorDetector {
  // ===========================================================================
  // Main Detection Method
  // ===========================================================================

  /**
   * Detects errors from an array of parsed messages using configurable triggers.
   *
   * @param messages - Array of ParsedMessage objects from a session
   * @param sessionId - The session ID
   * @param projectId - The project ID (encoded directory name)
   * @param filePath - Path to the JSONL file
   * @returns Array of DetectedError objects
   */
  async detectErrors(
    messages: ParsedMessage[],
    sessionId: string,
    projectId: string,
    filePath: string
  ): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    // Get enabled triggers from config
    const configManager = ConfigManager.getInstance();
    const triggers = configManager.getEnabledTriggers();

    if (triggers.length === 0) {
      return errors;
    }

    // Pre-resolve repository ID for this project to populate cache.
    const cwdHint =
      messages.find((message) => typeof message.cwd === 'string' && message.cwd.trim().length > 0)
        ?.cwd ?? undefined;
    await preResolveRepositoryIds([{ projectId, cwdHint }]);

    // Build tool_use map for linking results to calls
    const toolUseMap = buildToolUseMap(messages);
    // Build tool_result map for estimating output tokens
    const toolResultMap = buildToolResultMap(messages);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const lineNumber = i + 1; // 1-based line numbers for JSONL

      // Check each trigger against this message
      for (const trigger of triggers) {
        const triggerErrors = this.checkTrigger(
          message,
          trigger,
          toolUseMap,
          toolResultMap,
          sessionId,
          projectId,
          filePath,
          lineNumber
        );

        // Add all detected errors (can be multiple for token_threshold mode)
        errors.push(...triggerErrors);
      }
    }

    return errors;
  }

  // ===========================================================================
  // Trigger Checking (Router)
  // ===========================================================================

  /**
   * Checks if a message matches a specific trigger.
   * Routes to the appropriate trigger checker based on trigger configuration.
   *
   * @param message - The parsed message to check
   * @param trigger - The trigger configuration
   * @param toolUseMap - Map of tool_use_id to tool_use content for linking results to calls
   * @param toolResultMap - Map of tool_use_id to tool_result content for token estimation
   * @param sessionId - Session ID
   * @param projectId - Project ID
   * @param filePath - File path
   * @param lineNumber - Line number in JSONL
   * @returns Array of DetectedError (can be multiple for token_threshold mode)
   */
  private checkTrigger(
    message: ParsedMessage,
    trigger: NotificationTrigger,
    toolUseMap: Map<string, ToolUseInfo>,
    toolResultMap: Map<string, ToolResultInfo>,
    sessionId: string,
    projectId: string,
    filePath: string,
    lineNumber: number
  ): DetectedError[] {
    // Check repository scope first - if repositoryIds is set, only trigger for matching repositories
    if (!matchesRepositoryScope(projectId, trigger.repositoryIds)) {
      return [];
    }

    // Use the mode directly (mode is now required in NotificationTrigger)
    const effectiveMode = trigger.mode;

    // Handle token_threshold mode - check each tool_use individually
    if (effectiveMode === 'token_threshold') {
      return checkTokenThresholdTrigger(
        message,
        trigger,
        toolResultMap,
        sessionId,
        projectId,
        filePath,
        lineNumber
      );
    }

    // Handle tool_result triggers
    if (trigger.contentType === 'tool_result') {
      const error = checkToolResultTrigger(
        message,
        trigger,
        toolUseMap,
        sessionId,
        projectId,
        filePath,
        lineNumber
      );
      return error ? [error] : [];
    }

    // Handle tool_use triggers (for future expansion)
    if (trigger.contentType === 'tool_use') {
      const error = checkToolUseTrigger(
        message,
        trigger,
        sessionId,
        projectId,
        filePath,
        lineNumber
      );
      return error ? [error] : [];
    }

    return [];
  }

  // ===========================================================================
  // Trigger Testing (Preview Feature)
  // ===========================================================================

  /**
   * Tests a trigger configuration against historical session data.
   * Returns a list of errors that would have been detected.
   *
   * Safety features (handled by ErrorTriggerTester):
   * - Limits returned errors to 50
   * - Caps totalCount at 10,000 to prevent indefinite counting
   * - Stops scanning after 100 sessions
   * - Aborts after 30 seconds
   *
   * @param trigger - The trigger configuration to test
   * @param limit - Maximum number of results to return (default 50)
   */
  public async testTrigger(
    trigger: NotificationTrigger,
    limit: number = 50
  ): Promise<{
    totalCount: number;
    errors: DetectedError[];
    /** True if results were truncated due to safety limits */
    truncated?: boolean;
  }> {
    return testTriggerImpl(trigger, limit);
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

export const errorDetector = new ErrorDetector();
