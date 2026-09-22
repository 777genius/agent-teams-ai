import type { HostedTeamConfigurationAuthorityStoragePort } from '../../../../core/application/hosted-authority/HostedTeamConfigurationAuthorityPorts';
import type { HostedTeamConfigurationStorageGateway } from '@features/internal-storage/contracts';

/** Storage-only adapter from team-configuration's application port to internal-storage. */
export class InternalStorageHostedTeamConfigurationStorageAdapter implements HostedTeamConfigurationAuthorityStoragePort {
  constructor(private readonly storage: HostedTeamConfigurationStorageGateway) {}

  create(
    request: Parameters<HostedTeamConfigurationAuthorityStoragePort['create']>[0],
    signal: AbortSignal
  ) {
    return this.storage.createHostedTeamConfiguration(request, { signal });
  }

  read(identity: Parameters<HostedTeamConfigurationAuthorityStoragePort['read']>[0]) {
    return this.storage.readHostedTeamConfiguration(identity);
  }

  update(
    request: Parameters<HostedTeamConfigurationAuthorityStoragePort['update']>[0],
    signal: AbortSignal
  ) {
    return this.storage.updateHostedTeamConfiguration(request, { signal });
  }

  delete(
    request: Parameters<HostedTeamConfigurationAuthorityStoragePort['delete']>[0],
    signal: AbortSignal
  ) {
    return this.storage.deleteHostedTeamConfiguration(request, { signal });
  }
}
