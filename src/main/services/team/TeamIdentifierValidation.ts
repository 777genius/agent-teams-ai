import { isWindowsReservedFileName } from '@main/utils/pathValidation';

const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MEMBER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const RESERVED_MEMBER_NAMES = new Set<string>(['user']);
const RESERVED_TEAMMATE_NAMES = new Set<string>(['team-lead']);

export interface TeamIdentifierValidationResult<T> {
  valid: boolean;
  value?: T;
  error?: string;
}

function validateString(
  value: unknown,
  fieldName: string,
  maxLength: number = 256
): TeamIdentifierValidationResult<string> {
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

function rejectWindowsReserved(
  value: string,
  fieldName: string
): TeamIdentifierValidationResult<never> | null {
  return isWindowsReservedFileName(value)
    ? { valid: false, error: `${fieldName} is reserved on Windows` }
    : null;
}

export function validateTeamName(teamName: unknown): TeamIdentifierValidationResult<string> {
  const basic = validateString(teamName, 'teamName', 128);
  if (!basic.valid) {
    return basic;
  }

  if (!TEAM_NAME_PATTERN.test(basic.value!)) {
    return { valid: false, error: 'teamName contains invalid characters' };
  }

  const reserved = rejectWindowsReserved(basic.value!, 'teamName');
  if (reserved) {
    return reserved;
  }

  return { valid: true, value: basic.value };
}

export function validateMemberName(memberName: unknown): TeamIdentifierValidationResult<string> {
  const basic = validateString(memberName, 'member', 128);
  if (!basic.valid) {
    return basic;
  }

  if (!MEMBER_NAME_PATTERN.test(basic.value!)) {
    return { valid: false, error: 'member contains invalid characters' };
  }

  if (/[. ]$/.test(basic.value!)) {
    return { valid: false, error: 'member cannot end with a space or period' };
  }

  const windowsReserved = rejectWindowsReserved(basic.value!, 'member');
  if (windowsReserved) {
    return windowsReserved;
  }

  const lower = basic.value!.toLowerCase();
  if (RESERVED_MEMBER_NAMES.has(lower)) {
    return { valid: false, error: `member name "${basic.value!}" is reserved` };
  }

  return { valid: true, value: basic.value };
}

export function validateTeammateName(memberName: unknown): TeamIdentifierValidationResult<string> {
  const basic = validateMemberName(memberName);
  if (!basic.valid) {
    return basic;
  }

  const lower = basic.value!.toLowerCase();
  if (RESERVED_TEAMMATE_NAMES.has(lower)) {
    return { valid: false, error: `member name "${basic.value!}" is reserved` };
  }
  return basic;
}
