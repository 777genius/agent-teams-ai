export const OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE =
  'Windows blocked OpenCode from accessing project or runtime files. Fix folder permissions or move the project to a user-writable folder. Running as administrator is only a temporary workaround.';

export const OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE =
  'Windows blocked OpenCode from creating the managed node_modules symlink. Run Agent Teams AI as Administrator, then retry launch.';

const OPENCODE_WINDOWS_ACCESS_DENIED_PATTERN =
  /\b(?:EPERM|EACCES)\b|access is denied|permission denied|operation not permitted/i;

const OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_PATTERN =
  /(?=[\s\S]*\bEPERM\b)(?=[\s\S]*operation not permitted)(?=[\s\S]*\bsymlink\b)(?=[\s\S]*opencode)(?=[\s\S]*node_modules)(?=[\s\S]*(?:[A-Z]:\\|AppData\\Local\\claude-multimodel-nodejs))/i;

export function isOpenCodeWindowsNodeModulesSymlinkPermissionDiagnostic(
  value: string | null | undefined
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  return (
    trimmed === OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE ||
    OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_PATTERN.test(trimmed)
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
