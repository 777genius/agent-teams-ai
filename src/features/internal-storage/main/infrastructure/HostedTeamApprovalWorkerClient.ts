import { HostedTeamStorageWorkerClient } from './HostedTeamStorageWorkerClient';
import { ProcessOwnershipStorageGatewayClient } from './ProcessOwnershipStorageGateway';

import type { HostedTeamApprovalAuthorityStorageGateway } from '../../contracts/hostedTeamApprovalAuthorityStorageContracts';

export abstract class HostedTeamApprovalWorkerClient
  extends ProcessOwnershipStorageGatewayClient
  implements HostedTeamApprovalAuthorityStorageGateway
{
  protected hostedTeamStorage!: HostedTeamStorageWorkerClient;

  protected initializeHostedTeamStorage(
    ...input: ConstructorParameters<typeof HostedTeamStorageWorkerClient>
  ): void {
    this.hostedTeamStorage = new HostedTeamStorageWorkerClient(...input);
  }

  hostedTeamApprovalObserve: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalObserve'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalObserve(request);
  hostedTeamApprovalReadPending: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalReadPending'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalReadPending(request);
  hostedTeamApprovalReadPreview: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalReadPreview'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalReadPreview(request);
  hostedTeamApprovalDecide: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalDecide'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalDecide(request);
  hostedTeamApprovalClaimDeliveries: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalClaimDeliveries'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalClaimDeliveries(request);
  hostedTeamApprovalAcknowledgeDelivery: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalAcknowledgeDelivery'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalAcknowledgeDelivery(request);
  hostedTeamApprovalMarkDeliveryOperatorRequired: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalMarkDeliveryOperatorRequired'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalMarkDeliveryOperatorRequired(request);
  hostedTeamApprovalReadDeliveryReconciliation: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalReadDeliveryReconciliation'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalReadDeliveryReconciliation(request);
  hostedTeamApprovalSettleDeliveryReconciliation: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalSettleDeliveryReconciliation'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalSettleDeliveryReconciliation(request);
  hostedTeamApprovalAuditTimeouts: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalAuditTimeouts'] =
    (request) => this.hostedTeamStorage.hostedTeamApprovalAuditTimeouts(request);
}
