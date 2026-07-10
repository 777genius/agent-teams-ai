const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export interface TeamNameValidationResult {
  valid: boolean;
  value?: string;
  error?: string;
}

function isWindowsReservedFileName(name: string): boolean {
  const normalized = name
    .trim()
    .replace(/[. ]+$/g, '')
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  const stem = normalized.split('.')[0] ?? normalized;
  return WINDOWS_RESERVED_BASENAMES.has(stem);
}

export function validateTeamApplicationTeamName(teamName: unknown): TeamNameValidationResult {
  if (typeof teamName !== 'string') {
    return { valid: false, error: 'teamName must be a string' };
  }

  const trimmed = teamName.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'teamName cannot be empty' };
  }

  if (trimmed.length > 128) {
    return { valid: false, error: 'teamName exceeds max length (128)' };
  }

  if (!TEAM_NAME_PATTERN.test(trimmed)) {
    return { valid: false, error: 'teamName contains invalid characters' };
  }

  if (isWindowsReservedFileName(trimmed)) {
    return { valid: false, error: 'teamName is reserved on Windows' };
  }

  return { valid: true, value: trimmed };
}
