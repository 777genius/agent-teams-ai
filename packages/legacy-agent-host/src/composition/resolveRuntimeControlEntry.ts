import { RuntimeOwnerError } from '../runtime/contracts.js';
import { assertCapturedRosterCurrent } from './teamRoster.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';

/** Existing original-generation selection and operator authority, shared by Runtime control routes. */
export function resolveRuntimeControlEntry(options: {
  entries: Iterable<MemberEntry>;
  capturedTeam: HostedTeam | undefined;
  teamId: string;
  operation: string;
  parsed: { memberId: string; expectedGeneration?: string | undefined };
  principalId: string;
  assertWriter(): void;
}): MemberEntry {
  const candidates = [...options.entries].filter(
    (candidate) =>
      candidate.profile.teamId === options.teamId &&
      candidate.profile.memberId === options.parsed.memberId
  );
  const entry = candidates.find((candidate) =>
    options.parsed.expectedGeneration === undefined
      ? candidate.team === options.capturedTeam
      : candidate.binding.generation === options.parsed.expectedGeneration ||
        (options.operation === 'restore' &&
          candidate.selection?.restore?.sourceBinding.generation ===
            options.parsed.expectedGeneration)
  );
  if (!entry)
    throw new RuntimeOwnerError(
      candidates.length && options.parsed.expectedGeneration ? 'conflict' : 'invalid'
    );
  options.assertWriter();
  const readOnly =
    options.operation === 'read' ||
    options.operation === 'checkpoints.read' ||
    options.operation.startsWith('activity.');
  if (
    !(readOnly
      ? entry.team.owner.withLaunchAuthority(options.principalId, 'read', () => true)
      : entry.team.owner.authorizeRuntimeAccess(options.principalId, entry.binding, 'control'))
  )
    throw new RuntimeOwnerError('forbidden');
  if (options.operation === 'open' || options.operation === 'restore')
    assertCapturedRosterCurrent(entry.team);
  if (
    options.operation !== 'restore' &&
    ((options.parsed.expectedGeneration !== undefined &&
      options.parsed.expectedGeneration !== entry.binding.generation) ||
      (!readOnly && entry.selection?.restore && options.parsed.expectedGeneration === undefined))
  )
    throw new RuntimeOwnerError('conflict');
  return entry;
}
