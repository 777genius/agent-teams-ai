import { HostTeamOperationError } from '@features/agent-backend/renderer';

import {
  buildEditTeamMemberRosterSnapshot,
  getEditTeamConfiguredMember,
} from './editTeamRuntimeChanges';

import type { TeamsAPI } from '@shared/types/api';
import type {
  ReplaceMembersRequest,
  ResolvedTeamMember,
  TeamCreateRequest,
  TeamProvisioningMemberInput,
} from '@shared/types/team';

interface EditTeamValues {
  name: string;
  description: string;
  color: string;
  members: TeamProvisioningMemberInput[];
}

function roster(members: readonly (ResolvedTeamMember | TeamProvisioningMemberInput)[]): string {
  return buildEditTeamMemberRosterSnapshot(
    members.map((member) => {
      const configured =
        'configuredRuntimeSettings' in member ? getEditTeamConfiguredMember(member) : member;
      // Product snapshots include canonical membership when no descriptive role was saved.
      return { ...configured, role: configured.role === 'member' ? undefined : configured.role };
    })
  );
}

/** One existing Edit dialog owns one source revision and one immutable save intent. */
export function createEditTeamHostSubmission(options: {
  teams: Pick<TeamsAPI, 'getSavedRequest' | 'replaceMembers'>;
  teamName: string;
  baseline: Omit<EditTeamValues, 'members'> & { members: readonly ResolvedTeamMember[] };
  isCurrent(): boolean;
}) {
  const baseline = structuredClone(options.baseline);
  const source = options.teams.getSavedRequest(options.teamName).then((raw) => {
    const saved = raw && structuredClone(raw);
    if (
      !saved ||
      saved.teamName !== options.teamName ||
      !/^[a-f0-9]{64}$/.test(saved.savedSettingsFingerprint ?? '') ||
      (saved.displayName ?? baseline.name).trim() !== baseline.name.trim() ||
      (saved.description ?? '').trim() !== baseline.description.trim() ||
      (saved.color ?? '').trim() !== baseline.color.trim() ||
      roster(saved.members) !== roster(baseline.members)
    )
      throw new Error('The saved team configuration changed. Refresh the team before editing.');
    return saved;
  });
  // Hydration can fail before Save is clicked; the original error is surfaced by submit.
  void source.catch(() => undefined);
  let submitted: { signature: string; request: ReplaceMembersRequest } | undefined;
  const current = () => {
    if (!options.isCurrent()) throw new Error('Team context changed. Save outcome is unavailable.');
  };
  return {
    async submit(values: EditTeamValues): Promise<void> {
      const captured = structuredClone(values);
      const saved: TeamCreateRequest = await source;
      current();
      const {
        teamName: _team,
        members: _members,
        savedSettingsFingerprint: _revision,
        command: _command,
        createdTeamReadiness: _readiness,
        ...settings
      } = saved;
      const payload = {
        members: captured.members,
        configuration: {
          expectedRevision: saved.savedSettingsFingerprint!,
          savedSettings: {
            ...settings,
            displayName: captured.name.trim(),
            description: captured.description.trim(),
            color: captured.color.trim(),
          },
        },
      };
      const signature = JSON.stringify(payload);
      if (submitted && submitted.signature !== signature)
        throw new Error(
          'The previous save is unresolved. Retry its original settings before making another change.'
        );
      if (!submitted) {
        const commandId = crypto.randomUUID();
        submitted = {
          signature,
          request: { ...payload, command: { commandId, idempotencyKey: commandId } },
        };
      }
      current();
      try {
        await options.teams.replaceMembers(options.teamName, structuredClone(submitted.request));
      } catch (error) {
        if (error instanceof HostTeamOperationError && error.outcome !== 'unknown')
          submitted = undefined;
        throw error;
      }
      current();
    },
  };
}
