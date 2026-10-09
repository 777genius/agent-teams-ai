import assert from 'node:assert/strict';

import type { WindowsProcess } from './windows-native.mts';

// Windows can reuse a predecessor child's PID for the actual NSIS successor.
// Preserve the complete identity snapshot rather than treating a PID as a lifetime.
export function windowsOtaSuccessor(
  owners: WindowsProcess[],
  before: WindowsProcess[],
  executable: string
): WindowsProcess | null {
  const matches = owners.filter(
    (owner) =>
      owner.executable.toLowerCase() === executable.toLowerCase() &&
      /(?:^|\s)--updated(?:\s|$)/u.test(owner.command) &&
      !/(?:^|\s)--type(?:=|\s|$)/u.test(owner.command) &&
      !/[\\/]mcp-server[\\/]|(?:^|\s)--(?:mcp-server|transport)(?:=|\s|$)/iu.test(owner.command) &&
      !before.some(
        (previous) =>
          previous.pid === owner.pid &&
          previous.start === owner.start &&
          previous.executable.toLowerCase() === owner.executable.toLowerCase()
      )
  );
  assert(matches.length <= 1, 'Ambiguous automatic Windows successor identity');
  return matches[0] ?? null;
}
