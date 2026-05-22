import { describe, expect, it } from 'vitest';

import {
  isOpenCodeWindowsAccessDeniedDiagnostic,
  normalizeOpenCodeWindowsAccessDeniedDiagnostic,
  OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE,
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
});
