import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { RuntimeBinding, RuntimeOwnerOptions } from '../runtime/contracts.js';
import type { MemberEntry } from './MemberEntry.js';

/** The Runtime callback owns no Team policy; its captured entry delegates to the existing Team fence. */
export function createTeamContextPreparation(options: {
  entries: ReadonlyMap<string, MemberEntry>;
  principalId: string;
  assertCurrent(entry: MemberEntry): void;
}): Pick<RuntimeOwnerOptions, 'prepareInput' | 'inputPrepared' | 'contextObserved'> {
  const entryFor = (binding: RuntimeBinding) => {
    const entry = options.entries.get(runtimeDigest(binding));
    if (!entry) throw new RuntimeOwnerError('hold');
    options.assertCurrent(entry);
    return entry;
  };
  return {
    prepareInput(binding, request) {
      const entry = entryFor(binding);
      return entry.team.owner.contextReminders.prepare(options.principalId, {
        ...request,
        binding,
        workspace: entry.profile.cwd,
        maxPrefixBytes: Math.min(
          64 * 1024,
          entry.profile.limits.inputBytes - request.originalContentBytes
        ),
      });
    },
    contextObserved(binding, epoch) {
      const entry = entryFor(binding);
      entry.team.owner.contextReminders.observe(options.principalId, binding, epoch);
      return undefined;
    },
    inputPrepared(binding, proof) {
      const entry = entryFor(binding);
      entry.team.owner.contextReminders.prepared(options.principalId, binding, proof);
      return undefined;
    },
  };
}
