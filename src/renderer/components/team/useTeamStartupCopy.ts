import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
} from '@renderer/store/slices/teamSlice';
import { hasObservedLeadWorkDuringProvisioning } from '@renderer/utils/teamProvisioningLeadActivityPresentation';
import { useShallow } from 'zustand/react/shallow';

/** Display-only copy; observed work must not release launch or delivery gates. */
export function useTeamStartupCopy(teamName: string): {
  isProvisioning: boolean;
  statusLabel: string;
  placeholder: string;
  sendingUnavailable: string;
} {
  const { t } = useAppTranslation('team');
  const { isProvisioning, leadWorking } = useStore(
    useShallow((state) => ({
      isProvisioning: isTeamProvisioningActive(state, teamName),
      leadWorking: hasObservedLeadWorkDuringProvisioning({
        progress: getCurrentProvisioningProgressForTeam(state, teamName),
        leadActivity: state.leadActivityByTeam?.[teamName],
        currentRuntimeRunId: state.currentRuntimeRunIdByTeam?.[teamName],
      }),
    }))
  );
  return {
    isProvisioning,
    statusLabel: leadWorking
      ? t('provisioning.presentation.panel.finishingStartup', { defaultValue: 'Finishing startup' })
      : t('detail.status.launching'),
    placeholder: leadWorking
      ? t('messageComposer.input.finishingStartupPlaceholder', {
          defaultValue:
            'Lead is working. Startup checks are finishing; sending is not yet available.',
        })
      : t('messageComposer.input.teamLaunchingPlaceholder'),
    sendingUnavailable: leadWorking
      ? t('messageComposer.actions.sendingUnavailableStartupChecks', {
          defaultValue: 'Sending unavailable while startup checks finish',
        })
      : t('messageComposer.actions.sendingUnavailableLaunching'),
  };
}
