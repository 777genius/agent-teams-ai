import { HostedTeamApprovalAuthorityAdapter } from '../adapters/output/HostedTeamApprovalAuthorityAdapter';

import type {
  HostedTeamApprovalClockPort,
  HostedTeamApprovalDecisionAdmissionPort,
  HostedTeamApprovalPageSourcePort,
  HostedTeamApprovalPreviewSourcePort,
} from '../../core/application/ports/HostedTeamApprovalPorts';
import type { HostedTeamApprovalAuthorityPort } from '../ports/HostedTeamApprovalAuthorityPort';

export interface HostedTeamApprovalOutputAdapters {
  readonly pageSource: HostedTeamApprovalPageSourcePort;
  readonly previewSource: HostedTeamApprovalPreviewSourcePort;
  readonly decisionAdmission: HostedTeamApprovalDecisionAdmissionPort;
}

/** Creates one authority adapter shared by every hosted approval application port. */
export function createHostedTeamApprovalOutputAdapters(
  authority: HostedTeamApprovalAuthorityPort,
  clock: HostedTeamApprovalClockPort = Object.freeze({ now: Date.now })
): HostedTeamApprovalOutputAdapters {
  const adapter = new HostedTeamApprovalAuthorityAdapter(authority, clock);
  return Object.freeze({
    pageSource: adapter,
    previewSource: adapter,
    decisionAdmission: adapter,
  });
}
