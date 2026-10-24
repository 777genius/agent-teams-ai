import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { createOwnerPurgeRequest } from '../adapters/lifecycle/ownerPurgeRequest.js';
import type { TeamPermanentDeletionCoordinator } from '../adapters/lifecycle/TeamPermanentDeletionCoordinator.js';
import type { HostedTeamDefinition } from '../team-registry/definition.js';

/** Retains only original captured scopes for lookup; never constructs a TeamOwnerStore for deleted data. */
export function createTeamLifecycleRetirement(options: {
  owner: unknown; principalId: string; coordinator: TeamPermanentDeletionCoordinator; assertCurrent(): void;
}) {
  const retired = new Map<string, HostedTeamDefinition>();
  function isRetired(definition: HostedTeamDefinition): boolean {
    options.assertCurrent();
    if (!options.coordinator.isPermanentDeletionFencedSync(definition.binding.teamName, definition.binding.teamId, 'retirement')) return false;
    const original = retired.get(definition.binding.teamId);
    if ((original && digest(original) !== digest(definition)) || (!original && retired.size >= 256)) throw new TeamOwnerError('hold');
    if (!original) retired.set(definition.binding.teamId, structuredClone(definition));
    return true;
  }
  return {
    isRetired,
    list(_contextId: string): string[] {
      options.assertCurrent();
      // Main intersects this owner-qualified inventory with its trusted context handles.
      return [...retired.values()].map(definition => definition.binding.teamId);
    },
    /** Live caller marks only the just-purged original definition before retiring its handle. */
    retainPurged(definition: HostedTeamDefinition): void { if (!isRetired(definition)) throw new TeamOwnerError('hold'); },
    async lookup(binding: { owner: unknown; scope: unknown }, commandId: string, expectedRevision: string) {
      options.assertCurrent();
      const scope = binding.scope as { teamId?: unknown } | null;
      const original = scope && typeof scope.teamId === 'string' ? retired.get(scope.teamId) : undefined;
      if (!original || digest(binding.owner) !== digest(options.owner) || digest(binding.scope) !== digest(original.scope)) throw new TeamOwnerError('forbidden');
      const request = createOwnerPurgeRequest(original.binding, options.principalId, commandId, expectedRevision, original.scope);
      const result = await options.coordinator.lookupOwnerPermanentDeletion(request);
      options.assertCurrent();
      if (retired.get(original.binding.teamId) !== original) throw new TeamOwnerError('hold');
      return result ? { kind: 'team_purge' as const, commandId, transactionId: result.transactionId, phase: result.phase } : null;
    },
  };
}
