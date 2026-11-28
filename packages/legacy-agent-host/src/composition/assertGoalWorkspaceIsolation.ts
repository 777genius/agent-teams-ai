import { isAbsolute, relative, sep } from 'node:path';
import { capturedWorkspaceIdentity } from './capturedWorkspaceIdentity.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeInput } from '../runtime/contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';

const contains = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return !suffix || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
};

export function overlapsGoalWorkspace(left: string, right: string): boolean {
  const leftIdentity = capturedWorkspaceIdentity(left), rightIdentity = capturedWorkspaceIdentity(right);
  return leftIdentity === rightIdentity || contains(left, right) || contains(right, left);
}

export function isUnsettledWorkspaceInput(input: RuntimeInput): boolean {
  return ['claimed', 'consumed', 'unknown'].includes(input.phase);
}

/** Same-Team shared work is fenced by Team; independent Teams require distinct captured workspaces. */
export function assertGoalWorkspaceIsolation(
  teamId: string,
  entries: Iterable<MemberEntry>,
  isCurrent: (entry: MemberEntry) => boolean,
  readRuntime: RuntimeOwner['readCapturedSession']
): void {
  try {
    const captured = [...entries];
    const own = [...new Set(captured.filter(entry => entry.binding.teamId === teamId && isCurrent(entry))
      .map(entry => entry.profile.cwd))];
    if (!own.length) throw new TeamOwnerError('hold');
    own.forEach(capturedWorkspaceIdentity);
    for (const entry of captured) {
      if (entry.binding.teamId === teamId) continue;
      if (!isCurrent(entry)) {
        // Revocation closes new claims, but cannot settle the original native effect.
        // Only other Teams are read: this guard also runs inside the target Runtime fence.
        const record = readRuntime(entry.binding).record;
        if (record && !record.inputs.some(isUnsettledWorkspaceInput)) continue;
      }
      if (own.some(path => overlapsGoalWorkspace(path, entry.profile.cwd))) throw new TeamOwnerError('hold');
    }
  } catch { throw new TeamOwnerError('hold'); }
}
