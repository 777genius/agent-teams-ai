export type ToolApprovalPreviewPathPlatform = 'posix' | 'win32';

function isWindowsParentPathComponent(component: string): boolean {
  if (!component.startsWith('..')) return false;

  let leadingPeriodCount = 0;
  while (component[leadingPeriodCount] === '.') leadingPeriodCount += 1;
  if (leadingPeriodCount !== 2) return false;

  for (let index = leadingPeriodCount; index < component.length; index += 1) {
    const character = component[index];
    if (character !== ' ' && character !== '.') return false;
  }
  return true;
}

function isFullyQualifiedWindowsPath(filePath: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(filePath)) return true;
  if (/^[\\/]{2}\?[\\/][a-zA-Z]:[\\/]/.test(filePath)) return true;
  if (/^[\\/]{2}\?[\\/]UNC[\\/][^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/i.test(filePath)) {
    return true;
  }
  return /^[\\/]{2}(?![?.](?:[\\/]|$))[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.test(filePath);
}

function isPartiallyQualifiedWindowsPath(filePath: string): boolean {
  if (/^[a-zA-Z]:/.test(filePath)) return !isFullyQualifiedWindowsPath(filePath);
  if (/^[\\/]/.test(filePath)) return !isFullyQualifiedWindowsPath(filePath);
  return false;
}

export function isToolApprovalPreviewPathLexicallyUnsafe(
  filePath: string,
  platform: ToolApprovalPreviewPathPlatform
): boolean {
  if (platform === 'win32') {
    if (isPartiallyQualifiedWindowsPath(filePath)) return true;
    return filePath.split(/[\\/]+/).some(isWindowsParentPathComponent);
  }
  return filePath.split('/').includes('..');
}
