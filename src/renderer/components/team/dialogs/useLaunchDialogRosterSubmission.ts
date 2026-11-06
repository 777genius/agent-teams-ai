import { useCallback, useEffect, useRef } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { buildMemberSettingsRelaunchIntent } from '@features/team-provisioning/renderer';

import { isHostSavedRequest } from './launchDialogPrefill';

import type { LaunchTeamDialogProps } from './LaunchTeamDialog.types';
import type { TeamRelaunchContinuation } from './teamRelaunchFlow';
import type { TeamsAPI } from '@shared/types/api';
import type {
  ReplaceMembersRequest,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types/team';

type LaunchProps = Extract<LaunchTeamDialogProps, { mode: 'launch' | 'relaunch' }>;
type Metadata = Pick<ReplaceMembersRequest, 'command' | 'configuration'> & {
  relaunch?: TeamRelaunchContinuation;
};

/** Form-source metadata only. Team remains the sole configuration/receipt owner. */
export function useLaunchDialogRosterSubmission(
  teamName: string,
  open: boolean,
  preparationId: string
) {
  const source = useRef<TeamCreateRequest | null>(null);
  const submitted = useRef<{
    commandId: string;
    signature: string;
    intent: ReplaceMembersRequest['memberSettingsRelaunch'];
    relaunch?: TeamRelaunchContinuation;
  } | null>(null);
  useEffect(() => {
    if (!open || source.current?.teamName !== teamName) {
      source.current = null;
      submitted.current = null;
    }
  }, [teamName, open]);
  const captureSource = useCallback(
    (request: TeamCreateRequest | null) => {
      if (
        open &&
        request &&
        request.teamName === teamName &&
        isHostSavedRequest(request) &&
        !source.current
      )
        source.current = structuredClone(request);
    },
    [open, teamName]
  );

  async function submit(
    props: LaunchProps,
    request: TeamLaunchRequest,
    members: ReplaceMembersRequest['members'],
    configuredModel: string,
    replaceMembers: TeamsAPI['replaceMembers'],
    onMembersSaved?: () => void
  ): Promise<void> {
    const intent = submitted.current
      ? submitted.current.intent
      : buildMemberSettingsRelaunchIntent(
          props.memberSettingsDraft,
          props.members,
          configuredModel || null,
          request.effort ?? null,
          members
        );
    let metadata: Metadata | undefined;
    // Selection qualification is checked independently of source availability.
    if (isHostTeamSelectionKey(request.teamName)) {
      const captured = source.current;
      if (!captured || captured.teamName !== request.teamName)
        throw new Error('Saved team configuration unavailable. Close and reopen launch.');
      const {
        teamName: _team,
        members: _members,
        savedSettingsFingerprint: _version,
        ...saved
      } = captured;
      const {
        teamName: _target,
        clearContext: _clear,
        command: _command,
        savedRosterCommandId: _sourceCommand,
        ...choices
      } = request;
      // A renewed model preflight cannot replace an uncertain roster intent.
      const commandId = submitted.current?.commandId ?? `roster:${preparationId}`;
      metadata = {
        command: { commandId, idempotencyKey: commandId },
        configuration: {
          expectedRevision: captured.savedSettingsFingerprint!,
          savedSettings: {
            ...saved,
            ...choices,
            model: configuredModel || undefined,
            allowExperimentalLocalModels: request.allowExperimentalLocalModels ?? false,
          },
        },
      };
      const signature = JSON.stringify({ request, members, intent, metadata });
      if (submitted.current && submitted.current.signature !== signature)
        throw new Error(
          'The previous launch intent changed. Close and reopen launch before submitting changes.'
        );
      const relaunch =
        props.mode === 'relaunch'
          ? (submitted.current?.relaunch ?? {
              originalRunId: props.runtimeRunId,
              stopConfirmed: false,
              replaceAttempted: false,
              replaceConfirmed: false,
            })
          : undefined;
      submitted.current = {
        commandId,
        signature,
        intent: structuredClone(intent),
        ...(relaunch ? { relaunch } : {}),
      };
      if (relaunch) metadata.relaunch = relaunch;
    }
    const launchRequest: TeamLaunchRequest = metadata?.command
      ? {
          ...request,
          command: {
            commandId: `launch:${metadata.command.commandId}`,
            idempotencyKey: `launch:${metadata.command.commandId}`,
          },
          savedRosterCommandId: metadata.command.commandId,
        }
      : request;
    if (props.mode === 'relaunch') {
      if (metadata)
        await props.onRelaunch(launchRequest, members, intent, metadata, onMembersSaved);
      else if (onMembersSaved)
        await props.onRelaunch(request, members, intent, undefined, onMembersSaved);
      else await props.onRelaunch(request, members, intent);
    } else {
      await props.validateMemberSettings?.();
      await replaceMembers(teamName, { members, memberSettingsRelaunch: intent, ...metadata });
      onMembersSaved?.();
      await props.onLaunch(launchRequest);
    }
  }
  return { captureSource, submit };
}
