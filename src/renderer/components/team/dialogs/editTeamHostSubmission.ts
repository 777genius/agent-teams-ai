import { HostTeamOperationError } from '@features/agent-backend/renderer';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

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
  prompt?: string;
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
  const epoch = captureContextScopedRequestEpoch();
  let source: Promise<TeamCreateRequest> | undefined;
  function readSource(): Promise<TeamCreateRequest> {
    if (source) return source;
    const pending = options.teams.getSavedRequest(options.teamName).then(
      (raw) => {
        const saved = raw && structuredClone(raw);
        if (
          !saved ||
          saved.teamName !== options.teamName ||
          !/^[a-f0-9]{64}$/.test(saved.savedSettingsFingerprint ?? '') ||
          (saved.displayName ?? baseline.name).trim() !== baseline.name.trim() ||
          (saved.description ?? '').trim() !== baseline.description.trim() ||
          (saved.color ?? '').trim() !== baseline.color.trim() ||
          (baseline.prompt !== undefined &&
            (saved.prompt ?? '').trim() !== baseline.prompt.trim()) ||
          roster(saved.members) !== roster(baseline.members)
        )
          throw new Error('The saved team configuration changed. Refresh the team before editing.');
        return saved;
      },
      (error: unknown) => {
        // Only failed discovery may retry. A captured source or mismatch never silently rebases.
        if (source === pending) source = undefined;
        throw error;
      }
    );
    source = pending;
    return pending;
  }
  // Handle eager hydration failure; a later explicit Save may retry only that failed read.
  void readSource().catch(() => undefined);
  let submitted: { signature: string; request: ReplaceMembersRequest } | undefined;
  const current = () => {
    if (!options.isCurrent() || !isContextScopedRequestEpochCurrent(epoch))
      throw new Error('Team context changed. Save outcome is unavailable.');
  };
  return {
    async submit(values: EditTeamValues): Promise<void> {
      const captured = structuredClone(values);
      current();
      const saved = await readSource();
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
            ...(captured.prompt !== undefined ? { prompt: captured.prompt.trim() } : {}),
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
