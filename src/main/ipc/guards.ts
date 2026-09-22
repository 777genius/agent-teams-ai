/**
 * IPC guard utilities for runtime validation and coercion.
 *
 * Main goals:
 * - Reject malformed IDs and unbounded inputs at IPC boundaries
 * - Keep validation logic consistent across handlers
 */

import { isValidProjectId } from '@main/utils/pathDecoder';
import { isWindowsReservedFileName } from '@main/utils/pathValidation';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SUBAGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const NOTIFICATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TRIGGER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const FROM_FIELD_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const MAX_QUERY_LENGTH = 512;
const MAX_RESULTS = 200;
const MAX_PAGE_LIMIT = 200;

interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  error?: string;
}

export {
  validateMemberName,
  validateTeammateName,
  validateTeamName,
} from '@main/services/team/TeamIdentifierValidation';

function validateString(
  value: unknown,
  fieldName: string,
  maxLength: number = 256
): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }

  if (trimmed.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds max length (${maxLength})` };
  }

  return { valid: true, value: trimmed };
}

function rejectWindowsReserved(value: string, fieldName: string): ValidationResult<never> | null {
  return isWindowsReservedFileName(value)
    ? { valid: false, error: `${fieldName} is reserved on Windows` }
    : null;
}

export function validateProjectId(projectId: unknown): ValidationResult<string> {
  const basic = validateString(projectId, 'projectId');
  if (!basic.valid) {
    return basic;
  }

  if (!isValidProjectId(basic.value!)) {
    return { valid: false, error: 'projectId is not a valid encoded Claude project path' };
  }

  return { valid: true, value: basic.value };
}

export function validateSessionId(sessionId: unknown): ValidationResult<string> {
  const basic = validateString(sessionId, 'sessionId', 128);
  if (!basic.valid) {
    return basic;
  }

  if (!SESSION_ID_PATTERN.test(basic.value!)) {
    return { valid: false, error: 'sessionId contains invalid characters' };
  }

  return { valid: true, value: basic.value };
}

export function validateSubagentId(subagentId: unknown): ValidationResult<string> {
  const basic = validateString(subagentId, 'subagentId', 128);
  if (!basic.valid) {
    return basic;
  }

  if (!SUBAGENT_ID_PATTERN.test(basic.value!)) {
    return { valid: false, error: 'subagentId contains invalid characters' };
  }

  return { valid: true, value: basic.value };
}

export function validateNotificationId(notificationId: unknown): ValidationResult<string> {
  const basic = validateString(notificationId, 'notificationId', 128);
  if (!basic.valid) {
    return basic;
  }

  if (!NOTIFICATION_ID_PATTERN.test(basic.value!)) {
    return { valid: false, error: 'notificationId contains invalid characters' };
  }

  return { valid: true, value: basic.value };
}

export function validateTriggerId(triggerId: unknown): ValidationResult<string> {
  const basic = validateString(triggerId, 'triggerId', 128);
  if (!basic.valid) {
    return basic;
  }

  if (!TRIGGER_ID_PATTERN.test(basic.value!)) {
    return { valid: false, error: 'triggerId contains invalid characters' };
  }

  return { valid: true, value: basic.value };
}

export function validateTaskId(taskId: unknown): ValidationResult<string> {
  const basic = validateString(taskId, 'taskId', 64);
  if (!basic.valid) {
    return basic;
  }

  if (!TASK_ID_PATTERN.test(basic.value!)) {
    return { valid: false, error: 'taskId contains invalid characters' };
  }

  const reserved = rejectWindowsReserved(basic.value!, 'taskId');
  if (reserved) {
    return reserved;
  }

  return { valid: true, value: basic.value };
}

export function validateFromField(from: unknown): ValidationResult<string> {
  const basic = validateString(from, 'from', 128);
  if (!basic.valid) {
    return basic;
  }

  if (!FROM_FIELD_PATTERN.test(basic.value!)) {
    return { valid: false, error: 'from contains invalid characters' };
  }

  return { valid: true, value: basic.value };
}

export function validateSearchQuery(query: unknown): ValidationResult<string> {
  if (typeof query !== 'string') {
    return { valid: false, error: 'query must be a string' };
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'query cannot be empty' };
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    return { valid: false, error: `query exceeds max length (${MAX_QUERY_LENGTH})` };
  }

  return { valid: true, value: trimmed };
}

function coerceLimit(value: unknown, defaultValue: number, maxValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultValue;
  }

  const normalized = Math.floor(value);
  if (normalized <= 0) {
    return defaultValue;
  }

  return Math.min(normalized, maxValue);
}

export function coerceSearchMaxResults(value: unknown, defaultValue: number = 50): number {
  return coerceLimit(value, defaultValue, MAX_RESULTS);
}

export function coercePageLimit(value: unknown, defaultValue: number = 20): number {
  return coerceLimit(value, defaultValue, MAX_PAGE_LIMIT);
}
