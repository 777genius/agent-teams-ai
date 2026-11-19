import { RuntimeOwnerError } from '../runtime/contracts.js';

import type { MemberEntry } from './MemberEntry.js';

/** Share only one synchronous account inspection's original Team lock, never its observations. */
export function captureTeamAccountRead(options: {
  entry: MemberEntry;
  principalId: string;
  assertCurrent(): void;
}): <T>(read: () => T, inheritedNamespace?: true) => T {
  const { entry, principalId } = options, team = entry.team, owner = team.owner;
  const assertCaptured = () => {
    if (entry.team !== team || team.owner !== owner) throw new RuntimeOwnerError('forbidden');
  };
  return (read, inheritedNamespace) => {
    assertCaptured();
    // Preserve the writer/source prelude before publishing any Team lock.
    options.assertCurrent();
    assertCaptured();
    return owner.withLaunchAuthority(principalId, 'read', () => {
      assertCaptured();
      const result = read();
      assertCaptured();
      // Nested checks still validate the namespace and read the actual current grants/state.
      options.assertCurrent();
      assertCaptured();
      return result;
    }, inheritedNamespace);
  };
}
