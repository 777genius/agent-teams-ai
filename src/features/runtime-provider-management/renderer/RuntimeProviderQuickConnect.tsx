import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';

import {
  getRuntimeProviderOnboardingPlan,
  isOpenCodeProviderOAuthBridgeOutdated,
  resolveOpenCodeQuickConnectGate,
  resolveOpenCodeQuickPlanState,
} from '../core/domain';

import {
  type RuntimeProviderCompanionState,
  useRuntimeProviderCompanion,
} from './hooks/useRuntimeProviderCompanion';
import { useRuntimeProviderQuickConnect } from './hooks/useRuntimeProviderQuickConnect';
import { RuntimeProviderCompanionSetupDialog } from './ui/RuntimeProviderCompanionSetupDialog';
import {
  type RuntimeProviderQuickCardViewModel,
  RuntimeProviderQuickConnectView,
} from './ui/RuntimeProviderQuickConnectView';
import { XiaomiMiMoTokenPlanSetupDialog } from './ui/XiaomiMiMoTokenPlanSetupDialog';

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
  onBrowseProviders: (query?: string) => void;
  onConnectedCountChange?: (count: number) => void;
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

type CompanionPlanId = 'kiro' | 'cursor';

const COMPANION_PLAN_IDS = new Set<RuntimeProviderOnboardingPlanId>(['kiro', 'cursor']);

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
  'cursor',
  'github-copilot',
  'supergrok',
  'kiro',
  'kimi-code-membership',
  'zai-coding-plan',
  'minimax-token-plan',
  'xiaomi-mimo-token-plan',
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
  onConnectedCountChange,
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
    'kiro-cli',
    enabled && gate === 'ready',
    projectPath ?? null
  );
  const cursorCompanion = useRuntimeProviderCompanion(
    'cursor-agent',
    enabled && gate === 'ready',
    projectPath ?? null
  );
  const [activeCompanionPlanId, setActiveCompanionPlanId] = useState<CompanionPlanId | null>(null);
  const [xiaomiDialogOpen, setXiaomiDialogOpen] = useState(false);
  const oauthBridgeOutdated = isOpenCodeProviderOAuthBridgeOutdated(openCodeRuntimeStatus);

  const getCompanionState = useCallback(
    (planId: CompanionPlanId): RuntimeProviderCompanionState =>
      planId === 'kiro' ? kiroCompanion : cursorCompanion,
    [cursorCompanion, kiroCompanion]
  );

  const runCompanionOperation = useCallback(
    async (planId: CompanionPlanId, operation: 'install' | 'connect'): Promise<void> => {
      setActiveCompanionPlanId(planId);
      const companion = getCompanionState(planId);
      if (operation === 'install') {
        await companion.runInstallAndConnect();
      } else {
        await companion.runConnect();
      }
      directory.refresh();
    },
    [directory, getCompanionState]
  );

  const handleCompanionCardAction = useCallback(
    (planId: CompanionPlanId): void => {
      const companion = getCompanionState(planId);
      const status = companion.status;
      if (status?.phase === 'connected') {
        const providerId = planId === 'kiro' ? 'kiro' : 'cursor-acp';
        onOpenCodeProviderAction(providerId, 'select');
        return;
      }
      setActiveCompanionPlanId(planId);
    },
    [getCompanionState, onOpenCodeProviderAction]
  );

  const openCodeCards = useMemo<RuntimeProviderQuickCardViewModel[]>(() => {
    const planCards: RuntimeProviderQuickCardViewModel[] = OPEN_CODE_PLANS.map((plan) => {
      if (gate !== 'ready') {
        const busy = gate === 'checking' || gate === 'installing';
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
          actionLabel: null,
          onAction: null,
        };
      }

      if (COMPANION_PLAN_IDS.has(plan.id)) {
        const companionPlanId = plan.id as CompanionPlanId;
        const companion = getCompanionState(companionPlanId);
        const status = companion.status;
        const progress =
          typeof status?.percent === 'number'
            ? { percent: status.percent, detail: status.detail }
            : null;
        if (!status || companion.loading) {
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
            stateLabel:
              companionPlanId === 'kiro'
                ? t('cliStatus.quickConnect.kiroConnected')
                : t('cliStatus.quickConnect.cursorConnected'),
            actionLabel: t('cliStatus.actions.manage'),
            onAction: () => handleCompanionCardAction(companionPlanId),
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
          onAction: () => handleCompanionCardAction(companionPlanId),
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
            ? t('cliStatus.actions.connect')
            : state === 'different-credential'
              ? isSuperGrok
                ? t('cliStatus.quickConnect.switchToSuperGrok')
                : t('cliStatus.actions.connect')
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
    const xiaomiEntries = directory.entries.filter((entry) =>
      entry.providerId.toLowerCase().startsWith('xiaomi-token-plan-')
    );
    const connectedXiaomiEntry = xiaomiEntries.find((entry) => entry.state === 'connected') ?? null;
    const xiaomiConnected = connectedXiaomiEntry !== null;
    const xiaomiLoading = gate === 'checking' || gate === 'installing' || directory.loading;
    const xiaomiAvailable = xiaomiEntries.length > 0;
    planCards.push({
      id: 'xiaomi-mimo-token-plan',
      providerId: 'xiaomi',
      displayName: 'Xiaomi MiMo Token Plan',
      description: t('cliStatus.quickConnect.xiaomiDescription'),
      state: xiaomiLoading
        ? 'checking'
        : xiaomiConnected
          ? 'connected'
          : gate !== 'ready' || directory.error || !xiaomiAvailable
            ? 'unavailable'
            : 'connectable',
      stateLabel: xiaomiLoading
        ? t('cliStatus.quickConnect.checkingPlan')
        : xiaomiConnected
          ? t('cliStatus.quickConnect.planConnected')
          : gate !== 'ready'
            ? t('cliStatus.quickConnect.requiresOpenCode')
            : directory.error
              ? t('cliStatus.quickConnect.statusUnavailable')
              : xiaomiAvailable
                ? t('cliStatus.quickConnect.pasteBaseUrl')
                : t('cliStatus.quickConnect.notInCatalog'),
      actionLabel:
        xiaomiLoading || directory.error || !xiaomiAvailable
          ? null
          : xiaomiConnected
            ? t('cliStatus.actions.manage')
            : t('cliStatus.actions.connect'),
      onAction:
        xiaomiLoading || directory.error || !xiaomiAvailable
          ? null
          : xiaomiConnected && connectedXiaomiEntry
            ? () => onOpenCodeProviderAction(connectedXiaomiEntry.providerId, 'select')
            : () => setXiaomiDialogOpen(true),
    });
    return planCards;
  }, [
    directory.entries,
    directory.error,
    directory.loaded,
    directory.loading,
    gate,
    getCompanionState,
    handleCompanionCardAction,
    oauthBridgeOutdated,
    onInstallOpenCode,
    onOpenCodeProviderAction,
    t,
  ]);
  const connectedCount = openCodeCards.filter((card) => card.state === 'connected').length;

  useEffect(() => {
    onConnectedCountChange?.(connectedCount);
  }, [connectedCount, onConnectedCountChange]);

  return (
    <>
      <RuntimeProviderQuickConnectView
        cards={sortQuickConnectCards(openCodeCards)}
        gate={gate}
        runtimeStatus={openCodeRuntimeStatus}
        directoryError={directory.error}
        onInstallOpenCode={onInstallOpenCode}
        onRetryDirectory={directory.refresh}
        onBrowseProviders={() => onBrowseProviders()}
      />
      <RuntimeProviderCompanionSetupDialog
        open={activeCompanionPlanId !== null}
        title={
          activeCompanionPlanId === 'kiro'
            ? getRuntimeProviderOnboardingPlan('kiro').displayName
            : getRuntimeProviderOnboardingPlan('cursor').displayName
        }
        description={
          activeCompanionPlanId === 'kiro'
            ? t('cliStatus.quickConnect.kiroDescription')
            : t('cliStatus.quickConnect.cursorDescription')
        }
        status={activeCompanionPlanId ? getCompanionState(activeCompanionPlanId).status : null}
        busy={activeCompanionPlanId ? getCompanionState(activeCompanionPlanId).loading : false}
        onOpenChange={(open) => {
          if (!open) setActiveCompanionPlanId(null);
        }}
        onInstallAndConnect={() => {
          if (activeCompanionPlanId) {
            void runCompanionOperation(activeCompanionPlanId, 'install');
          }
        }}
        onConnect={() => {
          if (activeCompanionPlanId) {
            void runCompanionOperation(activeCompanionPlanId, 'connect');
          }
        }}
        onCopyManualCommand={() => {
          const command = activeCompanionPlanId
            ? getCompanionState(activeCompanionPlanId).status?.manualCommand
            : null;
          if (command) void navigator.clipboard.writeText(command);
        }}
        onOpenManualGuide={() => {
          const url = activeCompanionPlanId
            ? getCompanionState(activeCompanionPlanId).status?.manualUrl
            : null;
          if (url) void api.openExternal(url);
        }}
      />
      <XiaomiMiMoTokenPlanSetupDialog
        open={xiaomiDialogOpen}
        onOpenChange={setXiaomiDialogOpen}
        onConnect={(providerId) => onOpenCodeProviderAction(providerId, 'connect')}
        onOpenPlanPage={(url) => void api.openExternal(url)}
      />
    </>
  );
};
