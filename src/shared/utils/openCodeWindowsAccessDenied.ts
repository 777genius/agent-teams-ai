export const OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE =
  'Windows blocked OpenCode from accessing project or runtime files. Fix folder permissions or move the project to a user-writable folder. Running as administrator is only a temporary workaround.';

const OPENCODE_WINDOWS_ACCESS_DENIED_PATTERN =
  /\b(?:EPERM|EACCES)\b|access is denied|permission denied|operation not permitted/i;

export function isOpenCodeWindowsAccessDeniedDiagnostic(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  return (
    trimmed === OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE ||
    OPENCODE_WINDOWS_ACCESS_DENIED_PATTERN.test(trimmed)
  );
}

export function normalizeOpenCodeWindowsAccessDeniedDiagnostic(
  value: string | null | undefined
): string | null {
  return isOpenCodeWindowsAccessDeniedDiagnostic(value)
    ? OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE
    : null;
}
