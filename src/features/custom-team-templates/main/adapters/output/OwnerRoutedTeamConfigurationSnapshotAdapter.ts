import { hostTeamSelectionKey, isHostTeamSelectionKey } from '@features/agent-backend/contracts/teamSelection';

import { SavedTeamConfigurationSnapshotAdapter } from './SavedTeamConfigurationSnapshotAdapter';

import type { CustomTeamTemplateSnapshotReader, CustomTeamTemplateSnapshotReadOutcome } from '../../../core/application/ports';
import type { RosterMetadataMember } from '../../../core/domain/templateSourceSnapshot';
import type { CaptureHostTeamReads } from '@features/agent-backend/main';

/** Templates consume authored configuration only; Host keys never enter legacy path readers. */
export class OwnerRoutedTeamConfigurationSnapshotAdapter implements CustomTeamTemplateSnapshotReader {
  constructor(private readonly captureHost: CaptureHostTeamReads,
    private readonly legacy: CustomTeamTemplateSnapshotReader = new SavedTeamConfigurationSnapshotAdapter()) {}

  async readSnapshot(sourceTeamName: string): Promise<CustomTeamTemplateSnapshotReadOutcome> {
    if (!isHostTeamSelectionKey(sourceTeamName)) return this.legacy.readSnapshot(sourceTeamName);
    try {
      const host = await this.captureHost();
      if (!host) throw new Error('Original Host configuration unavailable');
      const selected = host.connection(sourceTeamName);
      const logical = host.logicalConnection(selected);
      const logicalSelection = hostTeamSelectionKey(logical.handle.handleId);
      const saved = await host.savedConfiguration(logicalSelection);
      const { configuration } = saved;
      const prompt = configuration.savedSettings?.prompt;
      const members: RosterMetadataMember[] = configuration.members.map(member => ({
        name: member.name,
        ...(member.role === 'lead' ? { agentType: 'team-lead' } : {}),
        ...(member.settings.role ? { role: member.settings.role } : {}),
        ...(member.settings.workflow ? { workflow: member.settings.workflow } : {}),
      }));
      for (const member of configuration.removedMembers) members.push({
        name: member.name, removed: true,
        ...(member.settings.role ? { role: member.settings.role } : {}),
        ...(member.settings.workflow ? { workflow: member.settings.workflow } : {}),
      });
      saved.assertCurrent();
      host.assertCurrent();
      const sourceAdmission = Object.freeze({
        identity: JSON.stringify({ contextId: host.contextId,
          selected: { handle: selected.handle, owner: selected.ownerResourceRef,
            team: selected.teamResourceRef, projectContext: selected.projectContext },
          logical: { handle: logical.handle, owner: logical.ownerResourceRef,
            team: logical.teamResourceRef },
        }),
        assertCurrent: () => { saved.assertCurrent(); host.assertCurrent(); },
        verifyCurrent: () => host.verifyConfiguration(logicalSelection, saved.revision),
      });
      return { status: 'available', revision: saved.revision, sourceAdmission, snapshot: {
        sourceTeamName, ...(prompt ? { teamPrompt: prompt } : {}),
        roster: { status: 'readable', members },
      } };
    } catch {
      return { status: 'sourceUnavailable', sourceTeamName };
    }
  }
}
