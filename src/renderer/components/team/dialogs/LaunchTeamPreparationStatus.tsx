import { AlertTriangle } from 'lucide-react';

import { CodexReconnectPrompt } from './CodexReconnectPrompt';
import { ExperimentalLocalModelOverrideCheckbox } from './ExperimentalLocalModelOverride';
import { ProviderLaunchAuthorityNotice } from './ProviderLaunchAuthorityNotice';
import { ProviderPrepareReadyNotice } from './ProviderPrepareReadyNotice';
import {
  getProvisioningFailureHint,
  ProvisioningProviderStatusList,
  shouldHideProvisioningProviderStatusList,
} from './ProvisioningProviderStatusList';
import { TeammateRuntimeCompatibilityNotice } from './TeammateRuntimeCompatibilityNotice';

import type {
  ProvisioningPrepareState,
  ProvisioningProviderCheck,
} from './provisioningProviderChecks';
import type { useCodexAccountSnapshot } from '@features/codex-account/renderer';
import type { useAppTranslation } from '@features/localization/renderer';
import type { TeamProviderId } from '@shared/types';
import type React from 'react';
import type { ComponentProps } from 'react';

interface LaunchTeamPreparationStatusProps {
  t: ReturnType<typeof useAppTranslation>['t'];
  presentedPrepareState: ProvisioningPrepareState;
  effectivePrepare: { message: string | null };
  isRelaunch: boolean;
  prepareChecks: ProvisioningProviderCheck[];
  prepareWarnings: string[];
  setProviderSettingsProviderId: (providerId: TeamProviderId) => void;
  teammateRuntimeCompatibility: ComponentProps<
    typeof TeammateRuntimeCompatibilityNotice
  >['analysis'];
  launchAuthorityBlocked: boolean;
  launchAuthorityBlockers: ComponentProps<typeof ProviderLaunchAuthorityNotice>['blockers'];
  launchAuthorityBlockerId: string;
  experimentalLocalModelOverrideAvailable: boolean;
  allowExperimentalLocalModels: boolean;
  markLaunchEdited: () => void;
  setAllowExperimentalLocalModels: (value: boolean) => void;
  showCodexReconnectPrompt: boolean;
  codexAccount: Pick<ReturnType<typeof useCodexAccountSnapshot>, 'snapshot' | 'loading'>;
  handleCodexReconnect: (mode: 'browser' | 'device_code') => void;
  closeDialog: () => void;
  openDashboard: () => void;
}

export const LaunchTeamPreparationStatus = ({
  t,
  presentedPrepareState,
  effectivePrepare,
  isRelaunch,
  prepareChecks,
  prepareWarnings,
  setProviderSettingsProviderId,
  teammateRuntimeCompatibility,
  launchAuthorityBlocked,
  launchAuthorityBlockers,
  experimentalLocalModelOverrideAvailable,
  allowExperimentalLocalModels,
  markLaunchEdited,
  setAllowExperimentalLocalModels,
  showCodexReconnectPrompt,
  codexAccount,
  handleCodexReconnect,
  closeDialog,
  openDashboard,
  launchAuthorityBlockerId,
}: LaunchTeamPreparationStatusProps): React.JSX.Element => (
  <>
    {presentedPrepareState === 'loading' ? (
      <>
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <div>
            {effectivePrepare.message ?? t('launch.prepare.preparingEnvironment')}
            <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
              <span>
                {t('launch.prepare.preflight', {
                  action: isRelaunch
                    ? t('launch.prepare.action.relaunch')
                    : t('launch.prepare.action.launch'),
                })}
              </span>
            </p>
          </div>
        </div>
        <ProvisioningProviderStatusList
          checks={prepareChecks}
          className="mt-2"
          onOpenProviderSettings={setProviderSettingsProviderId}
        />
      </>
    ) : null}

    {teammateRuntimeCompatibility.blocksSubmission && !teammateRuntimeCompatibility.checking ? (
      <TeammateRuntimeCompatibilityNotice
        analysis={teammateRuntimeCompatibility}
        showMemberErrors
      />
    ) : null}

    {presentedPrepareState === 'ready' &&
    !teammateRuntimeCompatibility.blocksSubmission &&
    !launchAuthorityBlocked ? (
      <ProviderPrepareReadyNotice
        checks={prepareChecks}
        message={effectivePrepare.message}
        warnings={prepareWarnings}
        onOpenProviderSettings={setProviderSettingsProviderId}
      />
    ) : null}

    {presentedPrepareState === 'ready' && launchAuthorityBlocked ? (
      <ProviderLaunchAuthorityNotice
        id={launchAuthorityBlockerId}
        action={
          isRelaunch ? t('launch.prepare.action.relaunch') : t('launch.prepare.action.launch')
        }
        blockers={launchAuthorityBlockers}
        onOpenProviderSettings={setProviderSettingsProviderId}
      />
    ) : null}

    {presentedPrepareState === 'failed' ? (
      <div className="text-xs">
        <div className="flex items-start gap-2 text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">
              {t('launch.prepare.blocked', {
                action: isRelaunch
                  ? t('launch.prepare.action.relaunch')
                  : t('launch.prepare.action.launch'),
              })}
            </p>
            <p className="mt-0.5 text-red-700/80 dark:text-red-300/80">
              {effectivePrepare.message ?? t('launch.prepare.failed')}
            </p>
            <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
              {t('launch.prepare.preflight', {
                action: isRelaunch
                  ? t('launch.prepare.action.relaunch')
                  : t('launch.prepare.action.launch'),
              })}
            </p>
          </div>
        </div>
        {!shouldHideProvisioningProviderStatusList(prepareChecks, effectivePrepare.message) ? (
          <ProvisioningProviderStatusList
            checks={prepareChecks}
            className="mt-2"
            suppressDetailsMatching={effectivePrepare.message}
            onOpenProviderSettings={setProviderSettingsProviderId}
          />
        ) : null}
        {prepareWarnings.length > 0 && prepareChecks.length === 0 ? (
          <div className="mt-1 space-y-0.5 pl-6">
            {prepareWarnings.map((warning, index) => (
              <p
                key={`${index}:${warning}`}
                className="text-[11px]"
                style={{ color: 'var(--warning-text)' }}
              >
                {warning}
              </p>
            ))}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2 pl-6">
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {getProvisioningFailureHint(effectivePrepare.message, prepareChecks, t)}
          </p>
          {(effectivePrepare.message ?? '').toLowerCase().includes('spawn ') ||
          prepareChecks.some((check) =>
            check.details.some((detail) => detail.toLowerCase().includes('spawn '))
          ) ? (
            <button
              type="button"
              className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500"
              onClick={() => {
                closeDialog();
                openDashboard();
              }}
            >
              {t('launch.actions.goToDashboard')}
            </button>
          ) : null}
        </div>
        {experimentalLocalModelOverrideAvailable ? (
          <ExperimentalLocalModelOverrideCheckbox
            id="launch-experimental-local-model"
            checked={allowExperimentalLocalModels}
            onCheckedChange={(value) => {
              markLaunchEdited();
              setAllowExperimentalLocalModels(value);
            }}
            label={t('launch.prepare.experimentalLocalModelOverride')}
            hint={t('launch.prepare.experimentalLocalModelOverrideHint')}
          />
        ) : null}
        {showCodexReconnectPrompt ? (
          <div className="pl-6">
            <CodexReconnectPrompt
              authUrl={codexAccount.snapshot?.login.authUrl ?? null}
              userCode={codexAccount.snapshot?.login.userCode ?? null}
              reconnectBusy={codexAccount.loading}
              onReconnect={() => handleCodexReconnect('browser')}
              onDeviceCodeReconnect={() => handleCodexReconnect('device_code')}
            />
          </div>
        ) : null}
      </div>
    ) : null}
  </>
);
