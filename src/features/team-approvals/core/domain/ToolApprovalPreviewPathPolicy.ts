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

export function isToolApprovalPreviewPathLexicallyUnsafe(
  filePath: string,
  platform: ToolApprovalPreviewPathPlatform
): boolean {
  if (platform === 'win32') {
    if (/^[a-zA-Z]:(?![\\/])/.test(filePath)) return true;
    return filePath.split(/[\\/]+/).some(isWindowsParentPathComponent);
  }
  return filePath.split('/').includes('..');
}
