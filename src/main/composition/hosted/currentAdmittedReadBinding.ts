import { parseWorkspaceId } from '@shared/contracts/hosted';

import type { WorkspaceMountBinding } from '@features/workspace-registry';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';

/** Resolve only the original signed binding, never a replacement at the same workspace ID. */
export function createCurrentAdmittedReadBindingResolver(
  options: Readonly<{
    admitted: WorkspaceRegistryStartupSnapshot;
    current: () => WorkspaceRegistryStartupSnapshot | null;
    bootId: string;
    ownerWorkspaceId: string;
    multiRootActive: boolean;
  }>
): (runtimeWorkspaceId: string) => WorkspaceMountBinding | null {
  return (runtimeWorkspaceId) => {
    try {
      const workspaceId = parseWorkspaceId(runtimeWorkspaceId);
      if (!options.multiRootActive && workspaceId !== options.ownerWorkspaceId) return null;
      const admittedBinding = options.admitted.bindings.filter(
        (entry) => entry.workspaceId === workspaceId
      );
      const current = options.current();
      const currentBinding =
        current?.bindings.filter((entry) => entry.workspaceId === workspaceId) ?? [];
      const admittedRegistration = options.admitted.registry.getByWorkspaceId(workspaceId);
      const currentRegistration = current?.registry.getByWorkspaceId(workspaceId);
      if (
        admittedBinding.length !== 1 ||
        currentBinding.length !== 1 ||
        admittedBinding[0] !== currentBinding[0] ||
        admittedBinding[0]?.bootId !== options.bootId ||
        admittedBinding[0]?.health === 'unavailable' ||
        !admittedRegistration?.enabled ||
        !currentRegistration?.enabled ||
        admittedRegistration.registrationRevision !== currentRegistration.registrationRevision ||
        admittedRegistration.declaredRootHash !== currentRegistration.declaredRootHash ||
        admittedBinding[0]?.declaredRootHash !== currentRegistration.declaredRootHash
      )
        return null;
      return admittedBinding[0];
    } catch {
      return null;
    }
  };
}
