/** Classifies normalized backup-relative paths before generic copy or feature preflight. */
export function isMemberWorkSyncBackupPath(relativePath: string): boolean {
  // Accept platform separators, but never let normalization hide traversal.
  const parts = relativePath.replaceAll('\\', '/').split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..') ||
    /^[a-z]:/i.test(relativePath) ||
    relativePath.includes('\0')
  ) {
    throw new Error('Invalid backup relative path');
  }
  return (
    parts[0] === '.member-work-sync' ||
    (parts[0] === 'members' && parts.length >= 3 && parts[2] === '.member-work-sync')
  );
}
