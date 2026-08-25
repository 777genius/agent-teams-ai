// eslint-disable-next-line no-restricted-imports -- Existing lifecycle composition uses the bounded hosted-only bridge entrypoint.
import {
  createHostedTeamApprovalRuntimeBridge,
  type HostedTeamApprovalRuntimeBridge,
  type HostedTeamApprovalRuntimeBridgeDependencies,
} from '@features/team-approvals/main/hosted';

/**
 * Compatibility seam for an existing lifecycle owner. It only returns the
 * bounded bridge handlers and intentionally creates no runtime or scheduler.
 */
export function createHostedTeamApprovalRuntimeCompatibility(
  dependencies: HostedTeamApprovalRuntimeBridgeDependencies
): HostedTeamApprovalRuntimeBridge {
  return createHostedTeamApprovalRuntimeBridge(dependencies);
}
