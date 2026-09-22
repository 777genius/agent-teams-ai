/**
 * Error services - Error detection and notification triggers.
 *
 * Exports:
 * - ErrorDetector: Detects errors in parsed messages
 * - ErrorTriggerChecker: Checks messages against notification triggers
 * - ErrorTriggerTester: Tests triggers against historical data
 * - ErrorMessageBuilder: Builds error notification messages
 * - TriggerMatcher: Matches content against trigger patterns
 */

export * from './ErrorDetector';
export * from './ErrorMessageBuilder';
export * from './ErrorTriggerChecker';
export * from './ErrorTriggerTester';
export * from './TriggerMatcher';
