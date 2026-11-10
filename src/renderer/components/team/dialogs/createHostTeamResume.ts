import { hostTeamSelectionKey, isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { createdTeamSelectionSignature } from '@shared/utils/createdTeamReadiness';

import type {
  AgentBackendApi,
  BackendHandle,
  BackendLaunchConfigurationView,
  BackendLaunchRestorations,
  BackendLaunchSnapshot,
  BackendMemberCheckpoints,
  BackendResumePreparation,
  BackendResumePrepareRequest,
} from '@features/agent-backend/contracts';
import type { TeamCreateRequest } from '@shared/types';

export interface HostTeamResumeSource {
  handle: BackendHandle;
  savedRequest: TeamCreateRequest;
  configuration: BackendLaunchConfigurationView;
  restorations: BackendLaunchRestorations;
  members: { memberId: string; label: string; availability: BackendMemberCheckpoints }[];
}

export class HostTeamResumeUnavailable extends Error {}

export function pendingHostResume(
  rows: BackendLaunchRestorations
): BackendResumePreparation | undefined {
  return rows.preparations.find((preparation) =>
    preparation.members.some(
      (member) =>
        !member.refused &&
        !rows.restorations.some(
          (row) =>
            row.commandId === member.commandId &&
            row.memberId === member.memberId &&
            row.reference === member.reference &&
            row.sourceGeneration === member.sourceGeneration &&
            row.phase === 'closed' &&
            row.custody === 'released' &&
            !row.attached
        )
    )
  );
}

export function hasUnresolvedHostResume(rows: BackendLaunchRestorations): boolean {
  return (
    Boolean(pendingHostResume(rows)) ||
    rows.restorations.some(
      (row) => row.phase !== 'closed' || row.custody !== 'released' || row.attached
    )
  );
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value))
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function savedSignature(saved: TeamCreateRequest): string {
  return JSON.stringify([saved.savedSettingsFingerprint, createdTeamSelectionSignature(saved)]);
}

function launchSignature(launch: BackendLaunchSnapshot): string {
  return JSON.stringify([
    launch.launchId,
    launch.rosterRevision,
    launch.members.map((member) => [member.memberId, member.generation]),
  ]);
}

/** Reads one existing owner and its exact generations. This never captures or starts a launch. */
export function createHostTeamResume(input: {
  backend: AgentBackendApi;
  teamName: string;
  current: () => boolean;
  getSavedRequest: (teamName: string) => Promise<TeamCreateRequest | null>;
}) {
  let requested = false;
  let intent: BackendResumePrepareRequest | undefined;
  function assertCurrent(): void {
    if (!input.current()) throw new Error('Team context changed. Reopen launch.');
  }
  async function saved(): Promise<TeamCreateRequest> {
    assertCurrent();
    const request = await input.getSavedRequest(input.teamName);
    assertCurrent();
    if (
      !request ||
      request.teamName !== input.teamName ||
      !/^[a-f0-9]{64}$/.test(request.savedSettingsFingerprint ?? '')
    )
      throw new Error('Saved team settings unavailable. Use a fresh Launch.');
    return structuredClone(request);
  }
  async function readLaunch(
    handle: BackendHandle,
    launchId: string
  ): Promise<BackendLaunchSnapshot> {
    assertCurrent();
    const result = await input.backend.invoke({
      handle,
      commandId: crypto.randomUUID(),
      operation: 'team.launch.read',
      payload: { launchId },
    });
    assertCurrent();
    if (
      !result.ok ||
      !result.value ||
      !('launchId' in result.value) ||
      !('members' in result.value)
    )
      throw new Error('Original launch unavailable. Refresh its status.');
    return result.value;
  }
  async function assertSource(source: HostTeamResumeSource): Promise<void> {
    const request = await saved();
    if (savedSignature(request) !== savedSignature(source.savedRequest))
      throw new Error('Saved settings changed. Use a fresh Launch.');
    const launch = await readLaunch(source.handle, source.configuration.launch.launchId);
    if (launchSignature(launch) !== launchSignature(source.configuration.launch))
      throw new Error('Original launch or member generation changed. Refresh its status.');
  }
  function originalPreparation(source: HostTeamResumeSource, rows: BackendLaunchRestorations) {
    const original = intent ?? pendingHostResume(source.restorations);
    return (
      original &&
      rows.preparations.find(
        (preparation) =>
          preparation.resumeId === original.resumeId &&
          preparation.rosterRevision === original.rosterRevision &&
          preparation.members.length === original.members.length &&
          original.members.every((member) =>
            preparation.members.some(
              (selected) =>
                selected.memberId === member.memberId &&
                selected.commandId === member.commandId &&
                selected.reference === member.reference &&
                selected.sourceGeneration === member.sourceGeneration
            )
          )
      )
    );
  }
  async function query(source: HostTeamResumeSource): Promise<BackendLaunchRestorations> {
    assertCurrent();
    const result = await input.backend.invoke({
      handle: source.handle,
      commandId: crypto.randomUUID(),
      operation: 'team.launch.restorations.read',
      payload: { launchId: source.configuration.launch.launchId },
    });
    assertCurrent();
    if (
      !result.ok ||
      !result.value ||
      !('restorations' in result.value) ||
      result.value.launchId !== source.configuration.launch.launchId ||
      (result.value.rosterRevision !== source.configuration.launch.rosterRevision &&
        !originalPreparation(source, result.value))
    )
      throw new Error('Original Resume status unavailable. No new launch was submitted.');
    return result.value;
  }
  async function progress(source: HostTeamResumeSource, restorations: BackendLaunchRestorations) {
    const launch = await readLaunch(source.handle, source.configuration.launch.launchId);
    const preparation = originalPreparation(source, restorations);
    const ready = Boolean(
      preparation &&
      preparation.members.length === source.members.length &&
      source.members.every((member) =>
        restorations.restorations.some(
          (row) =>
            row.memberId === member.memberId &&
            preparation.members.some(
              (choice) =>
                choice.requested &&
                !choice.refused &&
                choice.memberId === row.memberId &&
                choice.commandId === row.commandId &&
                choice.reference === row.reference &&
                choice.sourceGeneration === row.sourceGeneration
            ) &&
            row.current &&
            row.phase === 'allocated' &&
            row.custody === 'owned' &&
            row.attached &&
            launch.members.some(
              (selected) =>
                selected.memberId === row.memberId &&
                selected.generation === row.selectedGeneration &&
                selected.nativeReady &&
                selected.usable
            )
        )
      )
    );
    return { restorations, ready, queryOnly: true as const };
  }
  async function read(): Promise<HostTeamResumeSource> {
    assertCurrent();
    if (!isHostTeamSelectionKey(input.teamName))
      throw new Error('Resume is available only for this Host team.');
    const connections = await input.backend.getConnections();
    assertCurrent();
    const binding = connections.bindings.find(
      (candidate) => hostTeamSelectionKey(candidate.handle.handleId) === input.teamName
    );
    if (connections.state !== 'ready' || !binding) throw new Error('Team backend unavailable.');
    const handle = { ...binding.handle };
    const result = await input.backend.invoke({
      handle,
      commandId: crypto.randomUUID(),
      operation: 'team.launch.configuration.read',
      payload: {},
    });
    assertCurrent();
    if (result.ok && result.value === null)
      throw new HostTeamResumeUnavailable(
        'No original launch checkpoint exists. Use Fresh Launch.'
      );
    if (!result.ok || !result.value || !('launch' in result.value) || !('members' in result.value))
      throw new Error('Original launch settings unavailable. Use a fresh Launch.');
    const configuration = result.value;
    const request = await saved();
    const members: HostTeamResumeSource['members'] = [];
    const source: HostTeamResumeSource = {
      handle,
      savedRequest: request,
      configuration,
      members,
      restorations: {
        launchId: configuration.launch.launchId,
        rosterRevision: configuration.launch.rosterRevision,
        preparations: [],
        restorations: [],
      },
    };
    source.restorations = await query(source);
    for (const member of configuration.launch.members) {
      if (member.status === 'skipped') continue;
      if (!member.generation) {
        if (!hasUnresolvedHostResume(source.restorations))
          throw new HostTeamResumeUnavailable(
            'No started agent checkpoint exists. Use Fresh Launch.'
          );
        throw new Error(
          'Original Resume status is unavailable. Check its status before launching.'
        );
      }
      assertCurrent();
      const response = await input.backend.invoke({
        handle,
        commandId: crypto.randomUUID(),
        operation: 'runtime.checkpoints.read',
        payload: { memberId: member.memberId, expectedGeneration: member.generation },
      });
      assertCurrent();
      if (
        !response.ok ||
        !response.value ||
        !('checkpoints' in response.value) ||
        response.value.memberId !== member.memberId ||
        response.value.sourceGeneration !== member.generation
      )
        throw new Error('Original checkpoint availability changed. Refresh its status.');
      members.push({
        memberId: member.memberId,
        label:
          configuration.members.find((entry) => entry.memberId === member.memberId)?.label ??
          member.memberId,
        availability: response.value,
      });
    }
    if (!members.length) throw new Error('No original member checkpoints available.');
    await assertSource(source);
    return source;
  }
  async function submit(source: HostTeamResumeSource, selections: Record<string, string>) {
    const observed = await query(source);
    const pending = pendingHostResume(observed);
    if (
      requested ||
      pending?.members.some((member) => member.requested) ||
      (!pending && hasUnresolvedHostResume(observed))
    )
      return progress(source, observed);
    await assertSource(source);
    if (pending) {
      intent = {
        launchId: source.configuration.launch.launchId,
        rosterRevision: pending.rosterRevision,
        resumeId: pending.resumeId,
        members: pending.members.map(
          ({ requested: _requested, refused: _refused, ...choice }) => choice
        ),
      };
    } else if (!intent) {
      const choices = source.members.map((member) => {
        const reference = selections[member.memberId];
        if (
          member.availability.status !== 'owner-eligible' ||
          !member.availability.checkpoints.some(
            (checkpoint) =>
              checkpoint.reference === reference && checkpoint.status === 'owner-eligible'
          )
        )
          throw new Error('Select an available saved checkpoint for every teammate.');
        return {
          memberId: member.memberId,
          sourceGeneration: member.availability.sourceGeneration,
          reference,
        };
      });
      const resumeId = `resume-${await digest([
        source.handle.handleId,
        source.configuration.launch.launchId,
        source.configuration.launch.rosterRevision,
        savedSignature(source.savedRequest),
        choices,
      ])}`;
      const members = [];
      for (const choice of choices)
        members.push({ ...choice, commandId: `restore-${await digest([resumeId, choice])}` });
      intent = {
        launchId: source.configuration.launch.launchId,
        rosterRevision: source.configuration.launch.rosterRevision,
        resumeId,
        members,
      };
    }
    const captured = intent;
    if (
      captured.members.length !== source.members.length ||
      captured.members.some(
        (choice) =>
          selections[choice.memberId] !== choice.reference ||
          !source.members.some(
            (member) =>
              member.memberId === choice.memberId &&
              member.availability.sourceGeneration === choice.sourceGeneration
          )
      )
    )
      throw new Error('The original Resume selection changed. Reopen launch to query its status.');
    await assertSource(source);
    let preparation: BackendResumePreparation;
    try {
      assertCurrent();
      const result = await input.backend.invoke({
        handle: source.handle,
        commandId: captured.resumeId,
        operation: 'team.launch.resume.prepare',
        payload: captured,
      });
      assertCurrent();
      if (!result.ok) {
        if (result.outcome === 'unknown') return progress(source, await query(source));
        throw new Error(
          `Resume preparation refused (${result.code}). No new launch was submitted.`
        );
      }
      if (
        !result.value ||
        !('resumeId' in result.value) ||
        result.value.resumeId !== captured.resumeId ||
        result.value.rosterRevision !== captured.rosterRevision ||
        JSON.stringify(
          result.value.members.map(
            ({ requested: _requested, refused: _refused, ...choice }) => choice
          )
        ) !== JSON.stringify(captured.members)
      )
        throw new Error('Original Resume preparation is unverified. Query its status.');
      preparation = result.value;
    } catch (error) {
      assertCurrent();
      // A prepare may be replayed with this immutable map; it cannot allocate.
      // The original member commands are never regenerated after a lost ACK.
      if (error instanceof Error && error.message.startsWith('Resume preparation refused'))
        throw error;
      return progress(source, await query(source));
    }
    if (preparation.members.some((member) => member.requested))
      return progress(source, await query(source));
    await assertSource(source);
    requested = true;
    for (const member of captured.members) {
      assertCurrent();
      try {
        const result = await input.backend.invoke({
          handle: source.handle,
          commandId: member.commandId,
          operation: 'runtime.restore',
          payload: {
            memberId: member.memberId,
            reference: member.reference,
            expectedGeneration: member.sourceGeneration,
            resumeId: captured.resumeId,
          },
        });
        assertCurrent();
        if (
          !result.ok ||
          !result.value ||
          !('generation' in result.value) ||
          result.value.memberId !== member.memberId ||
          result.value.generation === member.sourceGeneration
        )
          break;
      } catch {
        // Partial or UNKNOWN dispatch freezes the whole prepared map. Missing
        // members remain visible through owner reads and are never dispatched here again.
        break;
      }
    }
    return progress(source, await query(source));
  }
  return {
    read,
    assertSource,
    query,
    submit,
    hasSubmitted: () => requested,
    hasIntent: () => Boolean(intent),
  };
}
