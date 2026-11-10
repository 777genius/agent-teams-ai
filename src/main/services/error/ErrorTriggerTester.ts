/**
 * ErrorTriggerTester service - Testing functionality for trigger preview.
 *
 * Provides utilities for:
 * - Testing trigger configurations against historical session data
 * - Running single trigger detection for preview functionality
 */

import { type ParsedMessage } from '@main/types';
import { parseJsonlFile } from '@main/utils/jsonl';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import {
  buildToolResultMap,
  buildToolUseMap,
  type ToolResultInfo,
  type ToolUseInfo,
} from '../analysis/ToolResultExtractor';
import { ProjectScanner } from '../discovery/ProjectScanner';
import { type NotificationTrigger } from '../infrastructure/ConfigManager';

const logger = createLogger('Service:ErrorTriggerTester');

import { type DetectedError } from './ErrorMessageBuilder';
import {
  checkTokenThresholdTrigger,
  checkToolResultTrigger,
  checkToolUseTrigger,
  matchesRepositoryScope,
  preResolveRepositoryIds,
} from './ErrorTriggerChecker';

// =============================================================================
// Trigger Testing (Preview Feature)
// =============================================================================

/**
 * Safety limits to prevent resource exhaustion from faulty triggers.
 *
 * Strategy: Stop as soon as we find enough results, not after scanning N sessions.
 * This allows finding rare patterns (like .env) while still being fast for common patterns.
 */
const TEST_LIMITS = {
  /** Maximum number of errors to return (primary stop condition) */
  MAX_ERRORS: 50,
  /** Maximum totalCount to track (prevents indefinite counting) */
  MAX_TOTAL_COUNT: 10_000,
  /** Maximum time in ms before aborting (30 seconds) - main safety limit */
  TIMEOUT_MS: 30_000,
} as const;

/**
 * State object used during trigger testing to track progress and limits.
 */
interface TestState {
  errors: DetectedError[];
  totalCount: number;
  sessionsScanned: number;
  truncated: boolean;
  startTime: number;
  effectiveLimit: number;
}

/**
 * Checks if the test should stop due to hitting safety limits.
 * Returns a reason string if should stop, null if should continue.
 *
 * Stop conditions (in order of priority):
 * 1. Found enough errors (effectiveLimit) - success, no warning
 * 2. Timeout (30s) - safety limit
 * 3. Total count limit (10k) - prevent counting forever
 */
function shouldStopTest(state: TestState): string | null {
  // Primary stop condition: found enough errors
  if (state.errors.length >= state.effectiveLimit) {
    return null; // Stop but don't log - we have enough errors (success case)
  }

  // Safety limits
  if (Date.now() - state.startTime > TEST_LIMITS.TIMEOUT_MS) {
    return 'Trigger test timed out after 30 seconds';
  }
  if (state.totalCount >= TEST_LIMITS.MAX_TOTAL_COUNT) {
    return 'Trigger test stopped after reaching count limit';
  }

  return null;
}

/**
 * Tests a trigger configuration against historical session data.
 * Returns a list of errors that would have been detected.
 *
 * Strategy: Scan sessions until we find enough results or hit safety limits.
 * This allows finding rare patterns while staying fast for common patterns.
 *
 * Stop conditions:
 * - Found enough errors (limit) - primary success condition
 * - Timeout (30s) - safety limit
 * - Total count reached (10k) - prevents infinite counting
 *
 * @param trigger - The trigger configuration to test
 * @param limit - Maximum number of results to return (default 50, capped at MAX_ERRORS)
 */
export async function testTrigger(
  trigger: NotificationTrigger,
  limit: number = TEST_LIMITS.MAX_ERRORS
): Promise<{
  totalCount: number;
  errors: DetectedError[];
  /** True if results were truncated due to safety limits */
  truncated?: boolean;
}> {
  const projectScanner = new ProjectScanner();

  const state: TestState = {
    errors: [],
    totalCount: 0,
    sessionsScanned: 0,
    truncated: false,
    startTime: Date.now(),
    effectiveLimit: Math.min(limit, TEST_LIMITS.MAX_ERRORS),
  };

  try {
    // Get list of all projects
    const projects = await projectScanner.scan();

    // Process each project to find session files
    for (const project of projects) {
      // Check safety limits before processing project
      const stopReason = shouldStopTest(state);
      if (stopReason) {
        logger.warn(stopReason);
        state.truncated = true;
        break;
      }

      // Early exit if we have enough errors (no truncation warning needed)
      if (state.errors.length >= state.effectiveLimit) break;

      const sessionFiles = await projectScanner.listSessionFiles(project.id);

      // Pre-resolve repository ID for this project.
      await preResolveRepositoryIds([{ projectId: project.id, cwdHint: project.path }]);

      // Process each session file (most recent first)
      const shouldBreakOuter = await processSessionFiles(
        sessionFiles,
        trigger,
        project.id,
        state,
        parseJsonlFile
      );

      if (shouldBreakOuter) break;
    }

    return { totalCount: state.totalCount, errors: state.errors, truncated: state.truncated };
  } catch (error) {
    logger.error('Error testing trigger:', error);
    return { totalCount: 0, errors: [] };
  }
}

/**
 * Processes session files for a single project.
 * Returns true if outer loop should break, false otherwise.
 */
async function processSessionFiles(
  sessionFiles: string[],
  trigger: NotificationTrigger,
  projectId: string,
  state: TestState,
  parseFile: (path: string) => Promise<ParsedMessage[]>
): Promise<boolean> {
  for (const filePath of sessionFiles) {
    // Check safety limits
    const stopReason = shouldStopTest(state);
    if (stopReason) {
      logger.warn(stopReason);
      state.truncated = true;
      return true; // Break outer loop
    }

    // Early exit if we have enough errors
    if (state.errors.length >= state.effectiveLimit) return false;

    try {
      state.sessionsScanned++;

      // Parse session file
      const messages = await parseFile(filePath);

      // Extract sessionId from file path
      const filename = path.basename(filePath);
      const sessionId = filename.replace(/\.jsonl$/, '');

      // Test the trigger against each message
      const sessionErrors = detectErrorsWithTrigger(
        messages,
        trigger,
        sessionId,
        projectId,
        filePath
      );

      // Update totalCount but cap it
      const newTotal = state.totalCount + sessionErrors.length;
      if (newTotal >= TEST_LIMITS.MAX_TOTAL_COUNT) {
        state.totalCount = TEST_LIMITS.MAX_TOTAL_COUNT;
        state.truncated = true;
      } else {
        state.totalCount = newTotal;
      }

      // Add errors up to limit
      for (const error of sessionErrors) {
        if (state.errors.length >= state.effectiveLimit) break;
        state.errors.push(error);
      }
    } catch (error) {
      // Skip files that can't be parsed
      logger.error(`Error parsing session file ${filePath}:`, error);
      continue;
    }
  }

  return false; // Don't break outer loop
}

/**
 * Detects errors from messages using a single trigger.
 * Used by testTrigger for preview functionality.
 */
function detectErrorsWithTrigger(
  messages: ParsedMessage[],
  trigger: NotificationTrigger,
  sessionId: string,
  projectId: string,
  filePath: string
): DetectedError[] {
  const errors: DetectedError[] = [];

  // Build tool_use map for linking results to calls
  const toolUseMap = buildToolUseMap(messages);
  // Build tool_result map for estimating output tokens
  const toolResultMap = buildToolResultMap(messages);

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const lineNumber = i + 1; // 1-based line numbers for JSONL

    const triggerErrors = checkTrigger(
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

  return errors;
}

/**
 * Checks if a message matches a specific trigger.
 * Internal helper for detectErrorsWithTrigger.
 */
function checkTrigger(
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
    const error = checkToolUseTrigger(message, trigger, sessionId, projectId, filePath, lineNumber);
    return error ? [error] : [];
  }

  return [];
}
