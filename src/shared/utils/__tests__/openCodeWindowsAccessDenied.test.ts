import { describe, expect, it } from 'vitest';

import {
  isOpenCodeWindowsAccessDeniedDiagnostic,
  isOpenCodeWindowsNodeModulesSymlinkPermissionDiagnostic,
  normalizeOpenCodeWindowsAccessDeniedDiagnostic,
  OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE,
  OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE,
} from '../openCodeWindowsAccessDenied';

describe('OpenCode Windows access-denied diagnostics', () => {
  it.each([
    'EPERM: operation not permitted, mkdir C:\\Program Files\\project',
    'EACCES: permission denied, open C:\\work\\repo',
    'Access is denied.',
    'permission denied while opening OpenCode runtime file',
    'operation not permitted while starting OpenCode',
  ])('detects %s', (message) => {
    expect(isOpenCodeWindowsAccessDeniedDiagnostic(message)).toBe(true);
    expect(normalizeOpenCodeWindowsAccessDeniedDiagnostic(message)).toBe(
      OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE
    );
  });

  it('does not match unrelated OpenCode diagnostics', () => {
    expect(isOpenCodeWindowsAccessDeniedDiagnostic('OpenCode app MCP is unreachable')).toBe(false);
    expect(normalizeOpenCodeWindowsAccessDeniedDiagnostic('OpenCode CLI not found')).toBeNull();
  });

  it('detects the managed OpenCode node_modules symlink permission failure separately', () => {
    const message = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'C:\\Users\\ben\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
      "-> 'C:\\Users\\ben\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
    ].join(' ');

    expect(isOpenCodeWindowsNodeModulesSymlinkPermissionDiagnostic(message)).toBe(true);
    expect(isOpenCodeWindowsAccessDeniedDiagnostic(message)).toBe(true);
    expect(normalizeOpenCodeWindowsAccessDeniedDiagnostic(message)).toBe(
      OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE
    );
  });
});
