import type { HostedLifecycleCommandAuthorization } from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';

export function sameHostedLifecycleAuthorizationFence(
  left: HostedLifecycleCommandAuthorization,
  right: HostedLifecycleCommandAuthorization
): boolean {
  return (
    left.grantId === right.grantId &&
    left.authorizationGeneration === right.authorizationGeneration &&
    left.deploymentId === right.deploymentId &&
    left.bootId === right.bootId &&
    left.actorId === right.actorId &&
    left.workspaceId === right.workspaceId &&
    left.teamId === right.teamId &&
    left.restoreGeneration === right.restoreGeneration &&
    left.mountGeneration === right.mountGeneration &&
    left.ownerEffectFence.grantRevision === right.ownerEffectFence.grantRevision &&
    left.ownerEffectFence.identityChecksum === right.ownerEffectFence.identityChecksum
  );
}
