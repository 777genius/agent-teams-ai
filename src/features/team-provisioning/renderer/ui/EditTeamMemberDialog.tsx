import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  createMemberDraftsFromInputs,
  MembersEditorSection,
} from '@renderer/components/team/members/MembersEditorSection';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { isForbiddenTeamRole } from '@renderer/constants/teamRoles';

import { useUpdateMemberSettings } from '../hooks/useUpdateMemberSettings';
import {
  deriveMemberSettingsSaveImpact,
  draftToEditableSettings,
  fingerprintResolvedMember,
  hasEditableMemberSettingsChanges,
} from '../utils/memberSettingsPresentation';

import type { MemberDraft } from '@renderer/components/team/members/MembersEditorSection';
import type { EffortLevel, ResolvedTeamMember, TeamProviderId } from '@shared/types';

export interface EditTeamMemberDialogProps {
  open: boolean;
  teamName: string;
  member: ResolvedTeamMember;
  isTeamAlive: boolean;
  isTeamProvisioning: boolean;
  isMixedTeam: boolean;
  leadProviderId?: TeamProviderId;
  leadModel?: string;
  leadEffort?: EffortLevel;
  projectPath?: string | null;
  targetAvailable?: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  onRelaunchRequired: () => void;
}

function createDraft(member: ResolvedTeamMember): MemberDraft {
  const configured = member.configuredRuntimeSettings;
  return createMemberDraftsFromInputs([
    {
      ...member,
      providerId: configured?.providerId ?? (configured ? undefined : member.providerId),
      providerBackendId:
        configured?.providerBackendId ?? (configured ? undefined : member.providerBackendId),
      model: configured?.model ?? (configured ? undefined : member.model),
      effort: configured?.effort ?? (configured ? undefined : member.effort),
      fastMode: configured?.fastMode ?? (configured ? undefined : member.selectedFastMode),
    },
  ])[0];
}

export const EditTeamMemberDialog = ({
  open,
  teamName,
  member,
  isTeamAlive,
  isTeamProvisioning,
  isMixedTeam,
  leadProviderId,
  leadModel,
  leadEffort,
  projectPath,
  targetAvailable = true,
  onClose,
  onRefresh,
  onRelaunchRequired,
}: EditTeamMemberDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [baseline, setBaseline] = useState(member);
  const [draft, setDraft] = useState(() => createDraft(member));
  const [error, setError] = useState<string | null>(null);
  const [acceptRefreshedTarget, setAcceptRefreshedTarget] = useState(false);
  const { saving, save, resetIdentity } = useUpdateMemberSettings();
  const incomingFingerprint = useMemo(() => fingerprintResolvedMember(member), [member]);
  const fingerprint = useMemo(() => fingerprintResolvedMember(baseline), [baseline]);
  const settings = useMemo(() => draftToEditableSettings(draft), [draft]);
  const impact = deriveMemberSettingsSaveImpact({
    member: baseline,
    proposedProviderId: settings.providerId,
    isTeamAlive,
    leadProviderId,
    isMixedTeam,
  });
  const hasChanges = hasEditableMemberSettingsChanges(baseline, settings);
  const hasInvalidRole = settings.role ? isForbiddenTeamRole(settings.role) : false;

  useEffect(() => {
    if (acceptRefreshedTarget && !saving) {
      setBaseline(member);
      setDraft(createDraft(member));
      setAcceptRefreshedTarget(false);
    }
  }, [acceptRefreshedTarget, incomingFingerprint, member, saving]);

  const close = (): void => {
    if (saving) return;
    resetIdentity();
    setError(null);
    onClose();
  };

  const handleSave = async (): Promise<void> => {
    if (!targetAvailable) return;
    setError(null);
    if (impact === 'relaunch') {
      resetIdentity();
      onRelaunchRequired();
      return;
    }
    let result: Awaited<ReturnType<typeof save>>;
    try {
      result = await save({
        teamName,
        memberName: baseline.name,
        expectedFingerprint: fingerprint,
        settings,
      });
    } catch {
      try {
        await onRefresh();
      } catch {
        // Preserve the mutation failure while still attempting current-truth refresh.
      }
      setError(t('editTeam.errors.saveFailed'));
      return;
    }
    try {
      await onRefresh();
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      const persistenceCompleted =
        result.outcome === 'completed' &&
        (result.effect === 'persisted_only' ||
          result.effect === 'member_restart_started' ||
          result.effect === 'opencode_lane_restart_started');
      setError(
        persistenceCompleted
          ? t('editTeam.errors.changesSavedRefreshFailed', { message })
          : t('editTeam.errors.saveFailed')
      );
      return;
    }
    if (result.outcome === 'busy') {
      resetIdentity();
      setError(t('editTeam.errors.saveFailed'));
      return;
    }
    if (result.outcome === 'target_conflict') {
      resetIdentity();
      setAcceptRefreshedTarget(true);
      setError(t('editTeam.errors.settingsChanged'));
      return;
    }
    if (result.effect === 'team_relaunch_required') {
      resetIdentity();
      onRelaunchRequired();
      return;
    }
    if (result.effect === 'recovery_required') {
      setError(t('editTeam.errors.saveFailed'));
      return;
    }
    resetIdentity();
    close();
  };

  const restartLabel = `${t('editTeam.actions.save')} + ${t('members.detail.restart')}`;
  const laneRestartLabel = `${restartLabel} (${t('liveRuntimeStatus.lane', { lane: baseline.laneId ?? 'OpenCode' })})`;
  const saveLabel =
    impact === 'offline'
      ? t('editTeam.actions.save')
      : impact === 'opencode_restart'
        ? laneRestartLabel
        : impact === 'relaunch'
          ? t('activity.actions.restartTeam')
          : restartLabel;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent
        className="max-w-3xl"
        onEscapeKeyDown={(event) => saving && event.preventDefault()}
        onPointerDownOutside={(event) => saving && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{`${t('toolApproval.settings')}: ${baseline.name}`}</DialogTitle>
          <DialogDescription>{baseline.role?.trim() || t('memberDraft.noRole')}</DialogDescription>
        </DialogHeader>
        <MembersEditorSection
          members={[draft]}
          onChange={(members) => members[0] && setDraft(members[0])}
          singleMemberMode
          showWorkflow
          showJsonEditor={false}
          showWorktreeIsolationControls
          lockExistingMemberIdentity
          identityLockReason={t('editTeam.notices.liveRenameBlocked')}
          draftKeyPrefix={`editMember:${teamName}:${member.name}`}
          projectPath={projectPath}
          defaultProviderId={leadProviderId}
          inheritedProviderId={leadProviderId}
          inheritedModel={leadModel}
          inheritedEffort={leadEffort}
        />
        {impact !== 'offline' ? (
          <p className="text-xs text-amber-300">
            {impact === 'relaunch'
              ? t('editTeam.notices.unsupportedMixedPrimaryMutation', { names: baseline.name })
              : t('editTeam.memberRestartWarning')}
          </p>
        ) : null}
        {isTeamAlive && member.currentTaskId ? (
          <p className="text-xs text-amber-300">
            {`${t('detail.actions.task')}: ${member.currentTaskId}. ${t('editTeam.memberRestartWarning')}`}
          </p>
        ) : null}
        {error || !targetAvailable ? (
          <p role="alert" className="text-xs text-red-300">
            {error ?? t('editTeam.errors.settingsChanged')}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={close}>
            {t('editTeam.actions.cancel')}
          </Button>
          <Button
            disabled={
              saving || isTeamProvisioning || !targetAvailable || !hasChanges || hasInvalidRole
            }
            onClick={() => void handleSave()}
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
