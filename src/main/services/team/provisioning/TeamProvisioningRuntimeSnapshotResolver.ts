import {
  projectRuntimeSnapshotMemberLivenessFields,
  type RuntimeProjectionSnapshotMemberLivenessFields,
  type RuntimeProjectionSnapshotMemberLivenessInput,
} from '../runtime-projection';

export interface TeamProvisioningRuntimeSnapshotLivenessInput extends RuntimeProjectionSnapshotMemberLivenessInput {
  permissionBlocked?: boolean;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveTeamProvisioningRuntimeSnapshotLiveness(
  input: TeamProvisioningRuntimeSnapshotLivenessInput
): RuntimeProjectionSnapshotMemberLivenessFields {
  const livePermissionBlocked = input.liveLivenessKind === 'permission_blocked';
  if (input.permissionBlocked === true || livePermissionBlocked) {
    return {
      alive: false,
      livenessKind: 'permission_blocked',
      ...(livePermissionBlocked && input.livePidSource ? { pidSource: input.livePidSource } : {}),
      runtimeDiagnostic:
        (livePermissionBlocked ? nonEmptyString(input.liveRuntimeDiagnostic) : undefined) ??
        'waiting for permission approval',
      runtimeDiagnosticSeverity:
        (livePermissionBlocked ? input.liveRuntimeDiagnosticSeverity : undefined) ?? 'warning',
    };
  }

  return projectRuntimeSnapshotMemberLivenessFields(input);
}
