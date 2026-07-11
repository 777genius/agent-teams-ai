import { useCallback, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';

import {
  getRuntimeProviderOnboardingPlan,
  isOpenCodeProviderOAuthBridgeOutdated,
  resolveOpenCodeQuickConnectGate,
  resolveOpenCodeQuickPlanState,
} from '../core/domain';

import { useRuntimeProviderCompanion } from './hooks/useRuntimeProviderCompanion';
import { useRuntimeProviderQuickConnect } from './hooks/useRuntimeProviderQuickConnect';
import { RuntimeProviderCompanionSetupDialog } from './ui/RuntimeProviderCompanionSetupDialog';
import {
  type RuntimeProviderQuickCardViewModel,
  RuntimeProviderQuickConnectView,
} from './ui/RuntimeProviderQuickConnectView';

import type { RuntimeProviderDirectoryEntryDto } from '../contracts';
import type { RuntimeProviderOnboardingPlanId } from '../core/domain';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';
import type { JSX } from 'react';

interface RuntimeProviderQuickConnectProps {
  enabled: boolean;
  cliStatusLoading: boolean;
  providers: readonly CliProviderStatus[];
  openCodeRuntimeStatus: OpenCodeRuntimeStatus | null;
  openCodeRuntimeStatusLoading: boolean;
  projectPath?: string | null;
  refreshKey?: number;
  onInstallOpenCode: () => void;
  onOpenCodeProviderAction: (providerId: string, action: 'connect' | 'select') => void;
  onBrowseProviders: () => void;
}

interface OpenCodePlanDefinition {
  id: RuntimeProviderOnboardingPlanId;
  providerId: string;
  displayName: string;
  descriptionKey:
    | 'superGrokDescription'
    | 'zaiDescription'
    | 'miniMaxDescription'
    | 'copilotDescription'
    | 'kimiDescription'
    | 'kiroDescription'
    | 'cursorDescription';
  requiresOAuthCredential?: boolean;
}

const OPEN_CODE_PLAN_PRESENTATION: readonly Pick<
  OpenCodePlanDefinition,
  'id' | 'descriptionKey' | 'requiresOAuthCredential'
>[] = [
  {
    id: 'supergrok',
    descriptionKey: 'superGrokDescription',
    requiresOAuthCredential: true,
  },
  {
    id: 'zai-coding-plan',
    descriptionKey: 'zaiDescription',
  },
  {
    id: 'minimax-token-plan',
    descriptionKey: 'miniMaxDescription',
  },
  {
    id: 'github-copilot',
    descriptionKey: 'copilotDescription',
  },
  {
    id: 'kimi-code-membership',
    descriptionKey: 'kimiDescription',
  },
  {
    id: 'kiro',
    descriptionKey: 'kiroDescription',
  },
  {
    id: 'cursor',
    descriptionKey: 'cursorDescription',
  },
];

const OPEN_CODE_PLANS: readonly OpenCodePlanDefinition[] = OPEN_CODE_PLAN_PRESENTATION.map(
  (presentation) => {
    const plan = getRuntimeProviderOnboardingPlan(presentation.id);
    return {
      ...presentation,
      providerId: plan.providerId,
      displayName: plan.displayName,
    };
  }
);

const QUICK_CONNECT_CARD_ORDER = [
  'github-copilot',
  'cursor',
  'supergrok',
  'kiro',
  'kimi-code-membership',
  'zai-coding-plan',
  'minimax-token-plan',
] as const;

const QUICK_CONNECT_CARD_RANK = new Map<string, number>(
  QUICK_CONNECT_CARD_ORDER.map((id, index) => [id, index])
);

function sortQuickConnectCards(
  cards: readonly RuntimeProviderQuickCardViewModel[]
): RuntimeProviderQuickCardViewModel[] {
  return [...cards].sort(
    (left, right) =>
      (QUICK_CONNECT_CARD_RANK.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (QUICK_CONNECT_CARD_RANK.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  );
}

function findDirectoryEntry(
  entries: readonly RuntimeProviderDirectoryEntryDto[],
  providerId: string
): RuntimeProviderDirectoryEntryDto | null {
  const normalizedProviderId = providerId.trim().toLowerCase();
  return (
    entries.find((entry) => entry.providerId.trim().toLowerCase() === normalizedProviderId) ?? null
  );
}

export const RuntimeProviderQuickConnect = ({
  enabled,
  cliStatusLoading,
  providers,
  openCodeRuntimeStatus,
  openCodeRuntimeStatusLoading,
  projectPath = null,
  refreshKey = 0,
  onInstallOpenCode,
  onOpenCodeProviderAction,
  onBrowseProviders,
}: RuntimeProviderQuickConnectProps): JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const providerMap = useMemo(
    () => new Map(providers.map((provider) => [provider.providerId, provider])),
    [providers]
  );
  const openCodeProvider = providerMap.get('opencode') ?? null;
  const gate = resolveOpenCodeQuickConnectGate({
    runtimeStatus: openCodeRuntimeStatus,
    runtimeStatusLoading: openCodeRuntimeStatusLoading,
    provider: openCodeProvider,
    cliStatusLoading,
  });
  const directory = useRuntimeProviderQuickConnect({
    enabled: enabled && gate === 'ready',
    projectPath,
    refreshKey,
  });
  const kiroCompanion = useRuntimeProviderCompanion(
    enabled && gate === 'ready',
    projectPath ?? null
  );
  const [kiroDialogOpen, setKiroDialogOpen] = useState(false);
  const oauthBridgeOutdated = isOpenCodeProviderOAuthBridgeOutdated(openCodeRuntimeStatus);

  const runKiroOperation = useCallback(
    async (operation: 'install' | 'connect'): Promise<void> => {
      setKiroDialogOpen(true);
      if (operation === 'install') {
        await kiroCompanion.runInstallAndConnect();
      } else {
        await kiroCompanion.runConnect();
      }
      directory.refresh();
    },
    [directory, kiroCompanion]
  );

  const handleKiroCardAction = useCallback((): void => {
    const status = kiroCompanion.status;
    if (status?.phase === 'connected') {
      onOpenCodeProviderAction('kiro', 'select');
      return;
    }
    if (kiroCompanion.loading) {
      setKiroDialogOpen(true);
      return;
    }
    setKiroDialogOpen(true);
  }, [kiroCompanion.loading, kiroCompanion.status, onOpenCodeProviderAction]);

  const openCodeCards = useMemo<RuntimeProviderQuickCardViewModel[]>(() => {
    return OPEN_CODE_PLANS.map((plan) => {
      if (gate !== 'ready') {
        const busy = gate === 'checking' || gate === 'installing';
        const actionLabel = busy
          ? null
          : plan.id === 'supergrok'
            ? t('cliStatus.quickConnect.connectSuperGrok')
            : t('cliStatus.quickConnect.connectPlan');
        return {
          id: plan.id,
          providerId: plan.providerId,
          displayName: plan.displayName,
          description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
          state: busy ? 'checking' : 'unavailable',
          stateLabel: busy
            ? gate === 'installing'
              ? t('cliStatus.quickConnect.installingOpenCode')
              : t('cliStatus.quickConnect.checkingOpenCode')
            : t('cliStatus.quickConnect.requiresOpenCode'),
          actionLabel,
          onAction: busy ? null : () => onOpenCodeProviderAction(plan.providerId, 'connect'),
        };
      }

      if (plan.id === 'kiro') {
        const status = kiroCompanion.status;
        const progress =
          typeof status?.percent === 'number'
            ? { percent: status.percent, detail: status.detail }
            : null;
        if (!status || kiroCompanion.loading) {
          return {
            id: plan.id,
            providerId: plan.providerId,
            displayName: plan.displayName,
            description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
            state: 'checking',
            stateLabel: status?.message ?? t('cliStatus.quickConnect.checkingPlan'),
            actionLabel: null,
            onAction: null,
            progress,
          };
        }
        if (status.phase === 'connected') {
          return {
            id: plan.id,
            providerId: plan.providerId,
            displayName: plan.displayName,
            description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
            state: 'connected',
            stateLabel: t('cliStatus.quickConnect.kiroConnected'),
            actionLabel: t('cliStatus.actions.manage'),
            onAction: handleKiroCardAction,
            progress,
          };
        }
        const needsInstall = !status.installed;
        return {
          id: plan.id,
          providerId: plan.providerId,
          displayName: plan.displayName,
          description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
          state: needsInstall
            ? 'update-required'
            : status.phase === 'error'
              ? 'manual'
              : 'connectable',
          stateLabel: needsInstall
            ? status.phase === 'needs-manual-step'
              ? status.message
              : t('cliStatus.quickConnect.cliNotInstalled')
            : status.message,
          actionLabel: needsInstall
            ? t('cliStatus.quickConnect.installAndConnect')
            : status.phase === 'error'
              ? t('cliStatus.quickConnect.checkAndConnect')
              : t('cliStatus.quickConnect.signIn'),
          onAction: handleKiroCardAction,
          progress,
        };
      }

      if (directory.loading || (!directory.loaded && !directory.error)) {
        return {
          id: plan.id,
          providerId: plan.providerId,
          displayName: plan.displayName,
          description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
          state: 'checking',
          stateLabel: t('cliStatus.quickConnect.checkingPlan'),
          actionLabel: null,
          onAction: null,
        };
      }

      if (directory.error) {
        return {
          id: plan.id,
          providerId: plan.providerId,
          displayName: plan.displayName,
          description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
          state: 'unavailable',
          stateLabel: t('cliStatus.quickConnect.statusUnavailable'),
          actionLabel: null,
          onAction: null,
        };
      }

      const entry = findDirectoryEntry(directory.entries, plan.providerId);
      const state = resolveOpenCodeQuickPlanState({
        entry,
        requiresOAuthCredential: plan.requiresOAuthCredential,
        oauthBridgeOutdated: plan.id === 'supergrok' && oauthBridgeOutdated,
      });
      const isSuperGrok = plan.id === 'supergrok';
      const stateLabel =
        state === 'connected'
          ? isSuperGrok
            ? t('cliStatus.quickConnect.superGrokConnected')
            : t('cliStatus.quickConnect.planConnected')
          : state === 'connectable'
            ? t('cliStatus.quickConnect.readyToConnect')
            : state === 'different-credential'
              ? isSuperGrok
                ? t('cliStatus.quickConnect.xaiApiConnected')
                : t('cliStatus.quickConnect.planCredentialUnverified')
              : state === 'update-required'
                ? t('cliStatus.quickConnect.updateForSuperGrok')
                : state === 'manual'
                  ? t('cliStatus.quickConnect.manualSetup')
                  : t('cliStatus.quickConnect.notInCatalog');

      const actionLabel =
        state === 'connected'
          ? t('cliStatus.actions.manage')
          : state === 'connectable'
            ? isSuperGrok
              ? t('cliStatus.quickConnect.connectSuperGrok')
              : t('cliStatus.quickConnect.connectPlan')
            : state === 'different-credential'
              ? isSuperGrok
                ? t('cliStatus.quickConnect.switchToSuperGrok')
                : t('cliStatus.quickConnect.connectPlan')
              : state === 'update-required'
                ? t('cliStatus.quickConnect.updateOpenCode')
                : state === 'manual'
                  ? t('cliStatus.actions.manage')
                  : null;

      const onAction =
        state === 'update-required'
          ? onInstallOpenCode
          : state === 'connected' || state === 'manual'
            ? () => onOpenCodeProviderAction(plan.providerId, 'select')
            : state === 'connectable' || state === 'different-credential'
              ? () => onOpenCodeProviderAction(plan.providerId, 'connect')
              : null;

      return {
        id: plan.id,
        providerId: plan.providerId,
        displayName: plan.displayName,
        description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
        state,
        stateLabel,
        actionLabel,
        onAction,
      };
    });
  }, [
    directory.entries,
    directory.error,
    directory.loaded,
    directory.loading,
    gate,
    handleKiroCardAction,
    kiroCompanion.loading,
    kiroCompanion.status,
    oauthBridgeOutdated,
    onInstallOpenCode,
    onOpenCodeProviderAction,
    t,
  ]);

  return (
    <>
      <RuntimeProviderQuickConnectView
        cards={sortQuickConnectCards(openCodeCards)}
        gate={gate}
        runtimeStatus={openCodeRuntimeStatus}
        directoryError={directory.error}
        onInstallOpenCode={onInstallOpenCode}
        onRetryDirectory={directory.refresh}
        onBrowseProviders={onBrowseProviders}
      />
      <RuntimeProviderCompanionSetupDialog
        open={kiroDialogOpen}
        status={kiroCompanion.status}
        busy={kiroCompanion.loading}
        onOpenChange={setKiroDialogOpen}
        onInstallAndConnect={() => void runKiroOperation('install')}
        onConnect={() => void runKiroOperation('connect')}
        onCopyManualCommand={() => {
          const command = kiroCompanion.status?.manualCommand;
          if (command) void navigator.clipboard.writeText(command);
        }}
        onOpenManualGuide={() => {
          const url = kiroCompanion.status?.manualUrl;
          if (url) void api.openExternal(url);
        }}
      />
    </>
  );
};
