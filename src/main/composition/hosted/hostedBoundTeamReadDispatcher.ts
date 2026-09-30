import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { WorkspaceMountBinding } from '@features/workspace-registry';

import { matchSignedWorkspaceRoot } from './admittedWorkspaceRootResolver';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedBoundTeamReadDependencies {
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  /** Immutable bindings from the admitted registry snapshot. Omission preserves owner-only reads. */
  readonly admittedReadBindings?: readonly WorkspaceMountBinding[];
  /** Must return the same admitted binding object only while its registry row remains current. */
  readonly currentReadBinding?: (runtimeWorkspaceId: string) => WorkspaceMountBinding | null;
}

export interface HostedBoundTeamReadTarget {
  readonly binding: WorkspaceMountBinding;
  stillCurrent(): Promise<boolean>;
}

/** Keeps team reads on one admitted mount across an asynchronous read and a possible remount. */
export function createHostedBoundTeamReadDispatcher(dependencies: HostedBoundTeamReadDependencies) {
  const runtimeInstance = createRuntimeInstanceContext(dependencies.runtimeInstance);
  const bindings = new Map<string, WorkspaceMountBinding>();
  const admitted = dependencies.admittedReadBindings ?? [dependencies.mountBinding];
  if (dependencies.admittedReadBindings !== undefined && !dependencies.currentReadBinding) {
    throw new TypeError('hosted-bound-team-read-current-binding-required');
  }
  for (const binding of admitted) {
    if (!(binding instanceof WorkspaceMountBinding) || bindings.has(binding.workspaceId)) {
      throw new TypeError('hosted-bound-team-read-binding-invalid');
    }
    if (
      binding.bootId !== runtimeInstance.bootId ||
      binding.health === 'unavailable' ||
      (dependencies.admittedReadBindings !== undefined &&
        matchSignedWorkspaceRoot(runtimeInstance, binding.declaredRootHash) === null)
    )
      continue;
    bindings.set(binding.workspaceId, binding);
  }
  if (bindings.get(dependencies.mountBinding.workspaceId) !== dependencies.mountBinding) {
    throw new TypeError('hosted-bound-team-read-owner-binding-missing');
  }

  const current = (binding: WorkspaceMountBinding): boolean => {
    if (dependencies.currentReadBinding === undefined) return binding === dependencies.mountBinding;
    try {
      return dependencies.currentReadBinding(binding.workspaceId) === binding;
    } catch {
      return false;
    }
  };

  async function target(
    teamId: TeamId
  ): Promise<
    | Readonly<{ kind: 'found'; target: HostedBoundTeamReadTarget }>
    | Readonly<{ kind: 'not_found' | 'unavailable' }>
  > {
    try {
      const value = await dependencies.teamIdentities.getTeamIdentity(teamId);
      if (value === null) return Object.freeze({ kind: 'not_found' });
      const identity = parseTeamIdentityRecord(value);
      const workspaceId = identity.workspaceBinding?.workspaceId;
      if (identity.teamId !== teamId || identity.state !== 'active' || !workspaceId) {
        return Object.freeze({ kind: 'unavailable' });
      }
      const binding = bindings.get(workspaceId);
      if (!binding || !current(binding)) return Object.freeze({ kind: 'unavailable' });
      const identitySnapshot = JSON.stringify(identity);
      const exact: HostedBoundTeamReadTarget = Object.freeze({
        binding,
        async stillCurrent(): Promise<boolean> {
          if (!current(binding)) return false;
          try {
            const latest = await dependencies.teamIdentities.getTeamIdentity(teamId);
            return (
              latest !== null &&
              current(binding) &&
              JSON.stringify(parseTeamIdentityRecord(latest)) === identitySnapshot
            );
          } catch {
            return false;
          }
        },
      });
      return Object.freeze({ kind: 'found', target: exact });
    } catch {
      return Object.freeze({ kind: 'unavailable' });
    }
  }

  return Object.freeze({
    bindings: Object.freeze([...bindings.values()]),
    canReadWorkspace(runtimeWorkspaceId: string): boolean {
      const binding = bindings.get(runtimeWorkspaceId);
      return binding !== undefined && current(binding);
    },
    target,
    async isBoundTeamReadAvailable(teamId: TeamId): Promise<boolean> {
      return (await target(teamId)).kind === 'found';
    },
  });
}
