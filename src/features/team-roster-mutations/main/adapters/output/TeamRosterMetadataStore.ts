import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';

import type { TeamRosterMetadataPort } from '../../../core/application/ports/TeamRosterMutationPorts';
import type { MembersMetadataSnapshot } from '../../../core/domain/rosterMutationModels';

export class TeamRosterMetadataStore implements TeamRosterMetadataPort {
  constructor(private readonly store = new TeamMembersMetaStore()) {}

  async getSnapshot(teamName: string): Promise<MembersMetadataSnapshot | null> {
    return this.store.getMeta(teamName);
  }

  async writeSnapshot(teamName: string, snapshot: MembersMetadataSnapshot): Promise<void> {
    await this.store.writeMembers(teamName, snapshot.members, {
      providerBackendId: snapshot.providerBackendId,
    });
  }
}
