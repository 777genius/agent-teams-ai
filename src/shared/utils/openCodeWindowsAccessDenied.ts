export const OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE =
  'Windows blocked OpenCode from accessing project or runtime files. Fix folder permissions or move the project to a user-writable folder. Running as administrator is only a temporary workaround.';

export const OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE =
  'Windows blocked OpenCode from creating the managed node_modules symlink. Run Agent Teams AI as Administrator, then retry launch.';

const OPENCODE_WINDOWS_ACCESS_DENIED_PATTERN =
  /\b(?:EPERM|EACCES)\b|access is denied|permission denied|operation not permitted/i;

const OPENCODE_WINDOWS_EPERM_CODE_PATTERN = /\bEPERM\b/i;
const WINDOWS_DRIVE_PATH_PATTERN = /\b[A-Z]:\\/i;

function isOpenCodeWindowsNodeModulesSymlinkPermissionText(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    OPENCODE_WINDOWS_EPERM_CODE_PATTERN.test(value) &&
    lower.includes('operation not permitted') &&
    lower.includes('symlink') &&
    lower.includes('opencode') &&
    lower.includes('node_modules') &&
    (WINDOWS_DRIVE_PATH_PATTERN.test(value) ||
      lower.includes('appdata\\local\\claude-multimodel-nodejs'))
  );
}

export function isOpenCodeWindowsNodeModulesSymlinkPermissionDiagnostic(
  value: string | null | undefined
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  return (
    trimmed === OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE ||
    isOpenCodeWindowsNodeModulesSymlinkPermissionText(trimmed)
  );
}

export function isOpenCodeWindowsAccessDeniedDiagnostic(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  return (
    isOpenCodeWindowsNodeModulesSymlinkPermissionDiagnostic(trimmed) ||
    trimmed === OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE ||
    OPENCODE_WINDOWS_ACCESS_DENIED_PATTERN.test(trimmed)
  );
}

export function normalizeOpenCodeWindowsAccessDeniedDiagnostic(
  value: string | null | undefined
): string | null {
  if (isOpenCodeWindowsNodeModulesSymlinkPermissionDiagnostic(value)) {
    return OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE;
  }
  return isOpenCodeWindowsAccessDeniedDiagnostic(value)
    ? OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE
    : null;
}
