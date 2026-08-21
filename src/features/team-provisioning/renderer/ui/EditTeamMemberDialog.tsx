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
  hasEditableMemberSettingsValueChanges,
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
  isLead?: boolean;
  onClose: () => void;
  onRefresh: (settings?: {
    model: string | null;
    effort: EffortLevel | null;
  }) => Promise<void> | void;
  onRelaunchRequired: () => void;
}

function createDraft(member: ResolvedTeamMember, isLead: boolean): MemberDraft {
  const configured = member.configuredRuntimeSettings;
  return createMemberDraftsFromInputs([
    {
      ...member,
      providerId: configured?.providerId ?? (isLead || !configured ? member.providerId : undefined),
      providerBackendId:
        configured?.providerBackendId ??
        (isLead || !configured ? member.providerBackendId : undefined),
      model: configured?.model ?? (isLead || !configured ? member.model : undefined),
      effort: configured?.effort ?? (isLead || !configured ? member.effort : undefined),
      fastMode:
        configured?.fastMode ?? (isLead || !configured ? member.selectedFastMode : undefined),
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
  isLead = false,
  onClose,
  onRefresh,
  onRelaunchRequired,
}: EditTeamMemberDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [baseline, setBaseline] = useState(member);
  const [draft, setDraft] = useState(() => createDraft(member, isLead));
  const [error, setError] = useState<string | null>(null);
  const [acceptRefreshedTarget, setAcceptRefreshedTarget] = useState(false);
  const { saving, save, resetIdentity } = useUpdateMemberSettings();
  const incomingFingerprint = useMemo(() => fingerprintResolvedMember(member), [member]);
  const fingerprint = useMemo(() => fingerprintResolvedMember(baseline), [baseline]);
  const settings = useMemo(() => draftToEditableSettings(draft), [draft]);
  const initialSettings = useMemo(
    () => draftToEditableSettings(createDraft(baseline, isLead)),
    [baseline, isLead]
  );
  const impact = deriveMemberSettingsSaveImpact({
    member: baseline,
    proposedProviderId: settings.providerId,
    isTeamAlive,
    leadProviderId,
    isMixedTeam,
  });
  const hasChanges = hasEditableMemberSettingsValueChanges(initialSettings, settings);
  const hasInvalidRole = !isLead && settings.role ? isForbiddenTeamRole(settings.role) : false;
  const restartWarning = isLead
    ? t('editTeam.leadRestartWarning')
    : t('editTeam.memberRestartWarning');

  useEffect(() => {
    if (acceptRefreshedTarget && !saving) {
      setBaseline(member);
      setDraft(createDraft(member, isLead));
      setAcceptRefreshedTarget(false);
    }
  }, [acceptRefreshedTarget, incomingFingerprint, isLead, member, saving]);

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
        ...(isLead
          ? { targetKind: 'lead', leadRuntime: { model: settings.model, effort: settings.effort } }
          : { targetKind: 'member', settings }),
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
    const committedLeadRuntime =
      isLead &&
      result.outcome === 'completed' &&
      (result.effect === 'lead_restart_started' || result.effect === 'persisted_only')
        ? { model: settings.model, effort: settings.effort }
        : undefined;
    try {
      await onRefresh(committedLeadRuntime);
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      const persistenceCompleted =
        result.outcome === 'completed' &&
        (result.effect === 'persisted_only' ||
          result.effect === 'member_restart_started' ||
          result.effect === 'lead_restart_started' ||
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
    if (result.effect === 'lead_restart_rolled_back') {
      resetIdentity();
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
          showWorkflow={!isLead}
          showJsonEditor={false}
          showWorktreeIsolationControls={!isLead}
          lockExistingMemberIdentity
          identityLockReason={t('editTeam.notices.liveRenameBlocked')}
          leadRuntimeSettingsOnly={isLead}
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
              : restartWarning}
          </p>
        ) : null}
        {isTeamAlive && member.currentTaskId ? (
          <p className="text-xs text-amber-300">
            {`${t('detail.actions.task')}: ${member.currentTaskId}. ${restartWarning}`}
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
