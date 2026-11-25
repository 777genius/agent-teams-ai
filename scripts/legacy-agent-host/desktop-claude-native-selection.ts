/** Finite native SDK binaries already pinned by the frozen provider package closure. */
export function desktopClaudeSha256(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64')
    return 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f';
  if (process.platform === 'linux' && process.arch === 'x64')
    return '86cb722ab68348877dba7971e4d0c659919e05e6228c05e006e83da320e656ef';
  throw new Error('Unqualified TEST Claude native tuple');
}
