import {
  formatInstallButtonLabel,
  formatTmuxInstallerProgress,
  formatTmuxInstallerTitle,
  formatTmuxLocationLabel,
  formatTmuxOptionalBenefits,
  formatTmuxPlatformLabel,
} from '@features/tmux-installer/renderer/utils/formatTmuxInstallerText';

import type {
  TmuxInstallerSnapshot,
  TmuxInstallHint,
  TmuxStatus,
} from '@features/tmux-installer/contracts';

export interface TmuxInstallerBannerViewModel {
  visible: boolean;
  loading: boolean;
  title: string;
  body: string;
  benefitsBody: string | null;
  error: string | null;
  platformLabel: string | null;
  locationLabel: string | null;
  runtimeReadyLabel: string | null;
  versionLabel: string | null;
  phase: TmuxInstallerSnapshot['phase'];
  progressPercent: number | null;
  logs: string[];
  manualHints: TmuxInstallHint[];
  manualHintsCollapsible: boolean;
  primaryGuideUrl: string | null;
  installSupported: boolean;
  installDisabled: boolean;
  installLabel: string;
  installButtonPrimary: boolean;
  showRefreshButton: boolean;
  canCancel: boolean;
  acceptsInput: boolean;
  inputPrompt: string | null;
  inputSecret: boolean;
  detailsOpen: boolean;
}

interface TmuxInstallerBannerViewModelInput {
  status: TmuxStatus | null;
  snapshot: TmuxInstallerSnapshot;
  loading: boolean;
  error: string | null;
  detailsOpen: boolean;
}

const RESTART_REQUIRED_PATTERNS = ['restart', 'reboot', 'перезагруз', 'требуется перезагрузка'];

export class TmuxInstallerBannerViewModelBuilder {
  static create(): TmuxInstallerBannerViewModelBuilder {
    return new TmuxInstallerBannerViewModelBuilder();
  }

  build(input: TmuxInstallerBannerViewModelInput): TmuxInstallerBannerViewModel {
    const status = input.status;
    const snapshot = input.snapshot;
    const displayPhase = this.#resolveDisplayPhase(snapshot, status);
    const hasActiveInstallFlow =
      displayPhase !== 'idle' && displayPhase !== 'completed' && displayPhase !== 'cancelled';
    const tmuxMissing = status ? !status.effective.available : !input.loading;
    const visible =
      hasActiveInstallFlow || (displayPhase !== 'completed' && !input.loading && tmuxMissing);
    const title =
      snapshot.message &&
      (displayPhase === 'pending_external_elevation' ||
        displayPhase === 'waiting_for_external_step' ||
        displayPhase === 'needs_restart' ||
        displayPhase === 'needs_manual_step')
        ? snapshot.message
        : formatTmuxInstallerTitle(displayPhase);
    const primaryGuideUrl =
      status?.autoInstall.manualHints.find((hint) => typeof hint.url === 'string')?.url ?? null;
    const body =
      input.error ??
      snapshot.error ??
      snapshot.detail ??
      snapshot.message ??
      status?.effective.detail ??
      status?.wsl?.statusDetail ??
      'tmux is optional. Install it only if you want pane-based terminal transport for long-running teammate sessions.';
    const benefitsBody =
      status && !status.effective.available ? formatTmuxOptionalBenefits(status.platform) : null;
    const runtimeReadyLabel = status
      ? status.effective.runtimeReady
        ? 'Pane transport ready'
        : status.effective.available
          ? 'Installed, optional transport inactive'
          : null
      : null;
    const versionLabel =
      status?.effective.version ?? status?.host.version ?? status?.wsl?.tmuxVersion ?? null;
    const manualHints = status?.autoInstall.manualHints ?? [];
    const manualHintsCollapsible = status?.platform === 'win32' && manualHints.length > 0;
    const installLabel =
      displayPhase === 'idle' &&
      status?.platform === 'win32' &&
      status.autoInstall.strategy === 'wsl' &&
      status.autoInstall.supported
        ? !status.wsl?.wslInstalled
          ? 'Install WSL'
          : !status.wsl?.distroName
            ? 'Install Ubuntu in WSL'
            : 'Install tmux in WSL'
        : formatInstallButtonLabel(displayPhase);
    const installDisabled =
      input.loading ||
      displayPhase === 'preparing' ||
      displayPhase === 'checking' ||
      displayPhase === 'requesting_privileges' ||
      displayPhase === 'pending_external_elevation' ||
      displayPhase === 'waiting_for_external_step' ||
      displayPhase === 'installing' ||
      displayPhase === 'verifying';
    const installButtonPrimary =
      !installDisabled && (installLabel.startsWith('Install') || installLabel.startsWith('Retry'));
    const showRefreshButton =
      !(status?.autoInstall.supported ?? false) ||
      (installLabel !== 'Re-check' && installLabel !== 'Re-check after restart');

    return {
      visible,
      loading: input.loading,
      title,
      body,
      benefitsBody,
      error: input.error ?? snapshot.error ?? status?.error ?? null,
      platformLabel: formatTmuxPlatformLabel(status?.platform ?? null),
      locationLabel: formatTmuxLocationLabel(status?.effective.location ?? null),
      runtimeReadyLabel,
      versionLabel,
      phase: displayPhase,
      progressPercent: formatTmuxInstallerProgress(displayPhase),
      logs: snapshot.logs,
      manualHints,
      manualHintsCollapsible,
      primaryGuideUrl,
      installSupported: status?.autoInstall.supported ?? false,
      installDisabled,
      installLabel,
      installButtonPrimary,
      showRefreshButton,
      canCancel: snapshot.canCancel,
      acceptsInput: snapshot.acceptsInput,
      inputPrompt: snapshot.inputPrompt,
      inputSecret: snapshot.inputSecret,
      detailsOpen: input.detailsOpen,
    };
  }

  #resolveDisplayPhase(
    snapshot: TmuxInstallerSnapshot,
    status: TmuxStatus | null
  ): TmuxInstallerSnapshot['phase'] {
    if (snapshot.phase !== 'waiting_for_external_step') {
      return snapshot.phase;
    }

    const combinedSignals = [
      snapshot.message,
      snapshot.detail,
      status?.wsl?.statusDetail,
      ...snapshot.logs,
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    const restartRequired =
      status?.wsl?.rebootRequired === true ||
      RESTART_REQUIRED_PATTERNS.some((pattern) => combinedSignals.includes(pattern));

    return restartRequired ? 'needs_restart' : snapshot.phase;
  }
}
