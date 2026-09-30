import {
  parseTeamId,
  parseWorkspaceId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { WorkspaceMountBinding } from '@features/workspace-registry';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';

export const HOSTED_WORKSPACE_ACCESS_CAPABILITIES = [
  'directory.read',
  'team.open',
  'configuration.read',
  'configuration.write',
  'promotion.execute',
  'lifecycle.command',
  'task.read',
  'task.write',
  'message.read',
  'message.send',
  'operator.control',
] as const;

export type HostedWorkspaceAccessCapability = (typeof HOSTED_WORKSPACE_ACCESS_CAPABILITIES)[number];

export interface HostedWorkspaceAccessDto {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly registrationRevision: number;
  readonly mountGeneration: number;
  readonly grantRevision: string;
  readonly teamIdentityRevision?: string;
  readonly capabilities: readonly HostedWorkspaceAccessCapability[];
}

export interface HostedWorkspaceAccessTarget {
  readonly publicWorkspaceId: string;
  readonly publicTeamId?: string;
}

interface WorkspaceGrantFence {
  readonly runtimeWorkspaceId: string;
  readonly grantRevision: string;
  revalidate(): Promise<boolean>;
}

interface TeamGrantFence {
  readonly publicWorkspaceId: string;
  readonly runtimeWorkspaceId: string;
  readonly ownerEffectFence: Readonly<{
    readonly grantRevision: string;
    readonly identityChecksum: string;
  }>;
  revalidate(): Promise<boolean>;
}

export interface HostedWorkspaceAccessProjectionDependencies {
  readonly authentication: Readonly<{
    captureWorkspaceReadGrantFence(
      request: object,
      publicWorkspaceId: string
    ): Promise<WorkspaceGrantFence | null>;
    captureTeamWorkspaceGrantFence(
      request: object,
      teamId: TeamId,
      permission: 'hosted.query' | 'hosted.command'
    ): Promise<TeamGrantFence | null>;
    isTeamConfigurationScopeAuthorized(
      request: object,
      scope: Readonly<{ workspaceId: WorkspaceId; teamId?: TeamId }>,
      mutation: boolean
    ): Promise<'authorized' | 'denied' | 'unavailable'>;
  }>;
  readonly runtimeInstance: Pick<RuntimeInstanceContext, 'deploymentId' | 'bootId'>;
  /** Activation gate: a granted B is still unavailable until multi-root is admitted. */
  readonly multiRootActive: boolean;
  readonly admittedSnapshot: WorkspaceRegistryStartupSnapshot;
  readonly currentSnapshot: () => WorkspaceRegistryStartupSnapshot | null;
  readonly ownerBinding: WorkspaceMountBinding;
  /** The live owner lease must still refer to the admitted A mount. */
  readonly ownerReady: () => boolean;
  /** A capability is emitted only when its exact host or authority is available. */
  readonly available: Readonly<
    Partial<
      Record<
        HostedWorkspaceAccessCapability,
        (runtimeWorkspaceId: WorkspaceId, teamId: TeamId | null) => boolean | Promise<boolean>
      >
    >
  >;
}

export interface HostedWorkspaceAccessProjection {
  project(
    request: object,
    target: HostedWorkspaceAccessTarget
  ): Promise<HostedWorkspaceAccessDto | null>;
  captureEffect(
    request: object,
    target: HostedWorkspaceAccessTarget,
    capability: HostedWorkspaceAccessCapability
  ): Promise<Readonly<{
    snapshot: HostedWorkspaceAccessDto;
    revalidate(): Promise<boolean>;
  }> | null>;
}

const TEAM_CAPABILITIES = new Set<HostedWorkspaceAccessCapability>([
  'team.open',
  'promotion.execute',
  'lifecycle.command',
  'task.read',
  'task.write',
  'message.read',
  'message.send',
  'operator.control',
]);
const OWNER_CAPABILITIES = new Set<HostedWorkspaceAccessCapability>([
  'configuration.write',
  'promotion.execute',
  'lifecycle.command',
  'task.write',
  'message.send',
  'operator.control',
]);
const COMMAND_CAPABILITIES = new Set<HostedWorkspaceAccessCapability>([
  'promotion.execute',
  'lifecycle.command',
  'task.write',
  'message.send',
  'operator.control',
]);
const SHA_256 = /^[0-9a-f]{64}$/u;

function sameDto(left: HostedWorkspaceAccessDto, right: HostedWorkspaceAccessDto): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface CapturedAccess {
  readonly snapshot: HostedWorkspaceAccessDto;
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly binding: WorkspaceMountBinding;
  readonly workspaceGrant: WorkspaceGrantFence;
  readonly teamGrant: TeamGrantFence | null;
  readonly commandGrants: ReadonlyMap<HostedWorkspaceAccessCapability, TeamGrantFence>;
}

async function revalidateCaptured(
  captured: CapturedAccess,
  capability?: HostedWorkspaceAccessCapability
): Promise<boolean> {
  try {
    if (
      !(await captured.workspaceGrant.revalidate()) ||
      (captured.teamGrant && !(await captured.teamGrant.revalidate()))
    )
      return false;
    if (capability === undefined || !COMMAND_CAPABILITIES.has(capability)) return true;
    const commandGrant = captured.commandGrants.get(capability);
    return commandGrant !== undefined && (await commandGrant.revalidate());
  } catch {
    return false;
  }
}

/** Server-side projection. Git mount operations and browser selection never imply access. */
export function createHostedWorkspaceAccessProjection(
  dependencies: HostedWorkspaceAccessProjectionDependencies
): HostedWorkspaceAccessProjection {
  const bindingFor = (workspaceId: WorkspaceId): WorkspaceMountBinding | null => {
    const admittedRegistration =
      dependencies.admittedSnapshot.registry.getByWorkspaceId(workspaceId);
    const current = dependencies.currentSnapshot();
    const currentRegistration = current?.registry.getByWorkspaceId(workspaceId);
    const admitted = dependencies.admittedSnapshot.bindings.filter(
      (binding) => binding.workspaceId === workspaceId
    );
    const currentBindings =
      current?.bindings.filter((binding) => binding.workspaceId === workspaceId) ?? [];
    if (
      !admittedRegistration?.enabled ||
      !currentRegistration?.enabled ||
      admittedRegistration.registrationRevision !== currentRegistration.registrationRevision ||
      admittedRegistration.declaredRootHash !== currentRegistration.declaredRootHash ||
      admitted.length !== 1 ||
      currentBindings.length !== 1 ||
      admitted[0] !== currentBindings[0] ||
      admitted[0]?.bootId !== dependencies.runtimeInstance.bootId ||
      admitted[0]?.declaredRootHash !== currentRegistration.declaredRootHash ||
      admitted[0]?.health === 'unavailable'
    )
      return null;
    return admitted[0];
  };

  const ownerCurrent = (captured: CapturedAccess): boolean => {
    try {
      return (
        captured.runtimeWorkspaceId === dependencies.ownerBinding.workspaceId &&
        captured.binding === dependencies.ownerBinding &&
        captured.binding.health === 'healthy' &&
        bindingFor(captured.runtimeWorkspaceId) === captured.binding &&
        dependencies.ownerReady()
      );
    } catch {
      return false;
    }
  };

  const capture = async (
    request: object,
    target: HostedWorkspaceAccessTarget
  ): Promise<CapturedAccess | null> => {
    try {
      const workspaceId = parseWorkspaceId(target.publicWorkspaceId);
      const teamId = target.publicTeamId === undefined ? null : parseTeamId(target.publicTeamId);
      const workspaceGrant = await dependencies.authentication.captureWorkspaceReadGrantFence(
        request,
        workspaceId
      );
      if (!workspaceGrant || !SHA_256.test(workspaceGrant.grantRevision)) return null;
      const runtimeWorkspaceId = parseWorkspaceId(workspaceGrant.runtimeWorkspaceId);
      if (
        !dependencies.multiRootActive &&
        runtimeWorkspaceId !== dependencies.ownerBinding.workspaceId
      )
        return null;
      const binding = bindingFor(runtimeWorkspaceId);
      if (!binding || !(await workspaceGrant.revalidate())) return null;
      const teamGrant =
        teamId === null
          ? null
          : await dependencies.authentication.captureTeamWorkspaceGrantFence(
              request,
              teamId,
              'hosted.query'
            );
      if (
        teamId !== null &&
        (!teamGrant ||
          teamGrant.publicWorkspaceId !== workspaceId ||
          teamGrant.runtimeWorkspaceId !== runtimeWorkspaceId ||
          teamGrant.ownerEffectFence.grantRevision !== workspaceGrant.grantRevision ||
          !SHA_256.test(teamGrant.ownerEffectFence.identityChecksum) ||
          !(await teamGrant.revalidate()))
      )
        return null;
      const owner =
        runtimeWorkspaceId === dependencies.ownerBinding.workspaceId &&
        binding === dependencies.ownerBinding &&
        binding.health === 'healthy' &&
        dependencies.ownerReady();
      const capabilities: HostedWorkspaceAccessCapability[] = [];
      const commandGrants = new Map<HostedWorkspaceAccessCapability, TeamGrantFence>();
      for (const capability of HOSTED_WORKSPACE_ACCESS_CAPABILITIES) {
        if (teamId === null && TEAM_CAPABILITIES.has(capability)) continue;
        if (OWNER_CAPABILITIES.has(capability) && !owner) continue;
        if (capability === 'team.open' && !capabilities.includes('directory.read')) continue;
        const available = dependencies.available[capability];
        if (!available || !(await available(runtimeWorkspaceId, teamId))) continue;
        if (capability === 'configuration.write' || capability === 'promotion.execute') {
          const scope = teamId === null ? { workspaceId } : { workspaceId, teamId };
          if (
            (await dependencies.authentication.isTeamConfigurationScopeAuthorized(
              request,
              scope,
              true
            )) !== 'authorized'
          )
            continue;
        }
        if (COMMAND_CAPABILITIES.has(capability)) {
          const commandGrant = await dependencies.authentication.captureTeamWorkspaceGrantFence(
            request,
            teamId!,
            'hosted.command'
          );
          if (
            !commandGrant ||
            commandGrant.publicWorkspaceId !== workspaceId ||
            commandGrant.runtimeWorkspaceId !== runtimeWorkspaceId ||
            commandGrant.ownerEffectFence.grantRevision !== workspaceGrant.grantRevision ||
            commandGrant.ownerEffectFence.identityChecksum !==
              teamGrant?.ownerEffectFence.identityChecksum ||
            !(await commandGrant.revalidate())
          )
            continue;
          commandGrants.set(capability, commandGrant);
        }
        capabilities.push(capability);
      }
      if (
        !(await workspaceGrant.revalidate()) ||
        (teamGrant && !(await teamGrant.revalidate())) ||
        bindingFor(runtimeWorkspaceId) !== binding ||
        (owner && !dependencies.ownerReady())
      )
        return null;
      const registration =
        dependencies.admittedSnapshot.registry.getByWorkspaceId(runtimeWorkspaceId);
      if (!registration) return null;
      const snapshot: HostedWorkspaceAccessDto = Object.freeze({
        deploymentId: dependencies.runtimeInstance.deploymentId,
        bootId: dependencies.runtimeInstance.bootId,
        registrationRevision: registration.registrationRevision,
        mountGeneration: binding.mountGeneration,
        grantRevision: workspaceGrant.grantRevision,
        ...(teamGrant === null
          ? {}
          : { teamIdentityRevision: teamGrant.ownerEffectFence.identityChecksum }),
        capabilities: Object.freeze(capabilities),
      });
      return Object.freeze({
        snapshot,
        runtimeWorkspaceId,
        binding,
        workspaceGrant,
        teamGrant,
        commandGrants,
      });
    } catch {
      return null;
    }
  };

  return Object.freeze({
    async project(request: object, target: HostedWorkspaceAccessTarget) {
      return (await capture(request, target))?.snapshot ?? null;
    },
    async captureEffect(
      request: object,
      target: HostedWorkspaceAccessTarget,
      capability: HostedWorkspaceAccessCapability
    ) {
      if (!OWNER_CAPABILITIES.has(capability)) return null;
      const captured = await capture(request, target);
      if (
        !captured?.snapshot.capabilities.includes(capability) ||
        !(await revalidateCaptured(captured, capability)) ||
        !ownerCurrent(captured)
      )
        return null;
      return Object.freeze({
        snapshot: captured.snapshot,
        revalidate: async () => {
          if (!(await revalidateCaptured(captured, capability))) return false;
          const current = await capture(request, target);
          if (
            current === null ||
            !current.snapshot.capabilities.includes(capability) ||
            !sameDto(captured.snapshot, current.snapshot) ||
            !(await revalidateCaptured(captured, capability)) ||
            !(await revalidateCaptured(current, capability))
          )
            return false;
          // Keep this synchronous check after the final await: a grant recheck may retire Owner.
          return ownerCurrent(captured) && ownerCurrent(current);
        },
      });
    },
  });
}
