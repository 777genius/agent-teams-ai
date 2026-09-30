import { DecideHostedTeamApproval } from '../../core/application/use-cases/DecideHostedTeamApproval';
import { GetHostedTeamApprovalPage } from '../../core/application/use-cases/GetHostedTeamApprovalPage';
import { GetHostedTeamApprovalPreview } from '../../core/application/use-cases/GetHostedTeamApprovalPreview';
import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '../adapters/input/http/hostedTeamApprovalRoutes';

import type {
  HostedTeamApprovalClockPort,
  HostedTeamApprovalDecisionAdmissionPort,
  HostedTeamApprovalPageSourcePort,
  HostedTeamApprovalPreviewSourcePort,
} from '../../core/application/ports/HostedTeamApprovalPorts';
import type { HostedTeamApprovalsHttpFacade } from '../adapters/input/http/registerHostedTeamApprovalsHttp';
import type { HostedRouteContribution } from '@main/composition/hosted/application';

export interface HostedTeamApprovalsFeature extends HostedTeamApprovalsHttpFacade {
  readonly routes: typeof HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS;
}

export interface HostedTeamApprovalsFeatureDependencies {
  readonly pageSource: HostedTeamApprovalPageSourcePort;
  readonly previewSource: HostedTeamApprovalPreviewSourcePort;
  readonly decisionAdmission: HostedTeamApprovalDecisionAdmissionPort;
  readonly clock?: HostedTeamApprovalClockPort;
}

export function createHostedTeamApprovalsFeature(
  dependencies: HostedTeamApprovalsFeatureDependencies
): HostedTeamApprovalsFeature {
  const clock = dependencies.clock ?? Object.freeze({ now: Date.now });
  const getPage = new GetHostedTeamApprovalPage(dependencies.pageSource, clock);
  const getPreview = new GetHostedTeamApprovalPreview(dependencies.previewSource, clock);
  const decide = new DecideHostedTeamApproval(dependencies.decisionAdmission);

  return Object.freeze({
    routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
    getPage: getPage.execute.bind(getPage),
    getPreview: getPreview.execute.bind(getPreview),
    decide: decide.execute.bind(decide),
  });
}

export function createHostedTeamApprovalsRouteContribution(
  feature: HostedTeamApprovalsFeature
): HostedRouteContribution<HostedTeamApprovalsHttpFacade> {
  return Object.freeze({
    id: 'team-approvals.hosted.v1',
    facade: feature,
    routes: feature.routes,
  });
}
