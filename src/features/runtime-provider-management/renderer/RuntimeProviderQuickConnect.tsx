import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import {
  loadProjectPathProjects,
  type ProjectPathProject,
} from '@renderer/components/team/dialogs/projectPathProjects';
import { useStore } from '@renderer/store';

import {
  getRuntimeProviderOnboardingPlan,
  getXiaomiMiMoTokenPlanResolutionByProviderId,
  isOpenCodeProviderOAuthBridgeOutdated,
  isRuntimeProviderOnboardingPlanRoutable,
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
import { RuntimeLocalProviderSetupDialog } from './RuntimeLocalProviderSetupDialog';

import type {
  RuntimeProviderCompanionActionDto,
  RuntimeProviderDirectoryEntryDto,
} from '../contracts';
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
  onRefreshOpenCode: () => void;
  onOpenCodeProviderAction: (
    providerId: string,
    action: 'connect' | 'reconnect' | 'select'
  ) => void;
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
  connectionStrategy: ReturnType<typeof getRuntimeProviderOnboardingPlan>['connectionStrategy'];
}

type CompanionPlanId = 'kiro' | 'cursor';

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
      connectionStrategy: plan.connectionStrategy,
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
  onRefreshOpenCode,
  onOpenCodeProviderAction,
  onBrowseProviders,
  onConnectedCountChange,
}: RuntimeProviderQuickConnectProps): JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const repositoryGroups = useStore((state) => state.repositoryGroups);
  const fetchCliProviderStatus = useStore((state) => state.fetchCliProviderStatus);
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
    // Warm the provider directory while the lightweight OpenCode readiness
    // check is still running. Waiting for the gate made these independent
    // probes sequential and kept every plan card in a loading state longer.
    enabled: enabled && (gate === 'checking' || gate === 'ready'),
    projectPath,
    refreshKey,
  });
  const canWarmProviderStatus = enabled && (gate === 'checking' || gate === 'ready');
  const kiroCompanion = useRuntimeProviderCompanion(
    'kiro-cli',
    canWarmProviderStatus,
    projectPath ?? null
  );
  const cursorCompanion = useRuntimeProviderCompanion(
    'cursor-agent',
    canWarmProviderStatus,
    projectPath ?? null
  );
  const [activeCompanionPlanId, setActiveCompanionPlanId] = useState<CompanionPlanId | null>(null);
  const [xiaomiDialogOpen, setXiaomiDialogOpen] = useState(false);
  const [localProviderSetupOpen, setLocalProviderSetupOpen] = useState(false);
  const [localProviderProjectPath, setLocalProviderProjectPath] = useState<string | null>(
    projectPath?.trim() || null
  );
  const [localProviderProjects, setLocalProviderProjects] = useState<ProjectPathProject[]>([]);
  const oauthBridgeOutdated = isOpenCodeProviderOAuthBridgeOutdated(openCodeRuntimeStatus);

  useEffect(() => {
    if (!localProviderSetupOpen) return;
    setLocalProviderProjectPath(projectPath?.trim() || null);
  }, [localProviderSetupOpen, projectPath]);

  useEffect(() => {
    if (!localProviderSetupOpen) return;
    let cancelled = false;
    void loadProjectPathProjects({
      defaultProjectPath: localProviderProjectPath ?? projectPath,
      repositoryGroups,
    })
      .then((projects) => {
        if (!cancelled) setLocalProviderProjects(projects);
      })
      .catch(() => {
        if (!cancelled) setLocalProviderProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [localProviderProjectPath, localProviderSetupOpen, projectPath, repositoryGroups]);

  const refreshConfiguredLocalProvider = useCallback(async (): Promise<void> => {
    await Promise.all([
      directory.refresh(),
      fetchCliProviderStatus('opencode', {
        silent: false,
        checkReason: 'manual_refresh',
        projectPath: localProviderProjectPath,
      }),
    ]);
  }, [directory, fetchCliProviderStatus, localProviderProjectPath]);

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

  const runCompanionAction = useCallback(
    async (planId: CompanionPlanId, action: RuntimeProviderCompanionActionDto): Promise<void> => {
      setActiveCompanionPlanId(planId);
      await getCompanionState(planId).runAction(action);
      directory.refresh();
    },
    [directory, getCompanionState]
  );

  const handleCompanionCardAction = useCallback((planId: CompanionPlanId): void => {
    setActiveCompanionPlanId(planId);
  }, []);

  const xiaomiEntries = useMemo(
    () =>
      directory.entries.filter((entry) =>
        entry.providerId.toLowerCase().startsWith('xiaomi-token-plan-')
      ),
    [directory.entries]
  );
  const connectedXiaomiEntry = xiaomiEntries.find((entry) => entry.state === 'connected') ?? null;
  const connectedXiaomiResolution = connectedXiaomiEntry
    ? getXiaomiMiMoTokenPlanResolutionByProviderId(connectedXiaomiEntry.providerId)
    : null;

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

      if (plan.connectionStrategy.kind === 'companion') {
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
          const bridgeEntry = findDirectoryEntry(directory.entries, plan.providerId);
          if (
            directory.loaded &&
            !isRuntimeProviderOnboardingPlanRoutable(
              getRuntimeProviderOnboardingPlan(plan.id),
              bridgeEntry
            )
          ) {
            return {
              id: plan.id,
              providerId: plan.providerId,
              displayName: plan.displayName,
              description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
              state: 'manual',
              stateLabel: t('cliStatus.quickConnect.statusUnavailable'),
              actionLabel: t('cliStatus.quickConnect.checkAndConnect'),
              onAction: () => void runCompanionOperation(companionPlanId, 'connect'),
              progress,
            };
          }
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
        const failed = status.phase === 'error';
        const needsInstall = !status.installed;
        return {
          id: plan.id,
          providerId: plan.providerId,
          displayName: plan.displayName,
          description: t(`cliStatus.quickConnect.${plan.descriptionKey}`),
          state: failed ? 'manual' : needsInstall ? 'update-required' : 'connectable',
          stateLabel: failed
            ? (status.error ?? status.message)
            : needsInstall
              ? status.phase === 'needs-manual-step'
                ? status.message
                : t('cliStatus.quickConnect.cliNotInstalled')
              : status.message,
          actionLabel: failed
            ? t('cliStatus.quickConnect.checkAndConnect')
            : needsInstall
              ? t('cliStatus.quickConnect.installAndConnect')
              : t('cliStatus.quickConnect.signIn'),
          onAction: () => handleCompanionCardAction(companionPlanId),
          progress,
        };
      }

      if ((directory.loading && !directory.loaded) || (!directory.loaded && !directory.error)) {
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

      if (directory.error && directory.entries.length === 0) {
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
        oauthBridgeOutdated: Boolean(plan.requiresOAuthCredential && oauthBridgeOutdated),
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
    const xiaomiConnected = connectedXiaomiEntry !== null;
    const xiaomiLoading =
      gate === 'checking' || gate === 'installing' || (directory.loading && !directory.loaded);
    const xiaomiAvailable = xiaomiEntries.length > 0;
    const xiaomiDirectoryUnavailable = Boolean(directory.error && xiaomiEntries.length === 0);
    planCards.push({
      id: 'xiaomi-mimo-token-plan',
      providerId: 'xiaomi',
      displayName: 'Xiaomi MiMo Token Plan',
      description: t('cliStatus.quickConnect.xiaomiDescription'),
      state: xiaomiLoading
        ? 'checking'
        : xiaomiConnected
          ? 'connected'
          : gate !== 'ready' || xiaomiDirectoryUnavailable || !xiaomiAvailable
            ? 'unavailable'
            : 'connectable',
      stateLabel: xiaomiLoading
        ? t('cliStatus.quickConnect.checkingPlan')
        : xiaomiConnected
          ? t('cliStatus.quickConnect.planConnected')
          : gate !== 'ready'
            ? t('cliStatus.quickConnect.requiresOpenCode')
            : xiaomiDirectoryUnavailable
              ? t('cliStatus.quickConnect.statusUnavailable')
              : xiaomiAvailable
                ? t('cliStatus.quickConnect.pasteBaseUrl')
                : t('cliStatus.quickConnect.notInCatalog'),
      actionLabel:
        xiaomiLoading || xiaomiDirectoryUnavailable || !xiaomiAvailable
          ? null
          : xiaomiConnected
            ? t('cliStatus.actions.manage')
            : t('cliStatus.actions.connect'),
      onAction:
        xiaomiLoading || xiaomiDirectoryUnavailable || !xiaomiAvailable
          ? null
          : () => setXiaomiDialogOpen(true),
    });
    return planCards;
  }, [
    directory.entries,
    directory.error,
    directory.loaded,
    directory.loading,
    connectedXiaomiEntry,
    gate,
    getCompanionState,
    handleCompanionCardAction,
    oauthBridgeOutdated,
    onInstallOpenCode,
    onOpenCodeProviderAction,
    runCompanionOperation,
    t,
    xiaomiEntries,
  ]);
  const observedConnectedCount = openCodeCards.filter((card) => card.state === 'connected').length;
  const [lastReadyConnectedCount, setLastReadyConnectedCount] = useState(0);
  useEffect(() => {
    if (gate === 'ready') {
      setLastReadyConnectedCount(observedConnectedCount);
    }
  }, [gate, observedConnectedCount]);
  const connectedCount =
    gate === 'checking' || gate === 'installing' ? lastReadyConnectedCount : observedConnectedCount;

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
        onRefreshOpenCode={onRefreshOpenCode}
        onRetryDirectory={directory.refresh}
        onSetupLocalModel={() => setLocalProviderSetupOpen(true)}
        onBrowseProviders={() => onBrowseProviders()}
      />
      <RuntimeLocalProviderSetupDialog
        open={localProviderSetupOpen}
        onOpenChange={setLocalProviderSetupOpen}
        projectPath={localProviderProjectPath}
        projects={localProviderProjects}
        onProjectPathChange={setLocalProviderProjectPath}
        onConfigured={refreshConfiguredLocalProvider}
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
        onAction={(action) => {
          if (activeCompanionPlanId) {
            void runCompanionAction(activeCompanionPlanId, action);
          }
        }}
        onOpenUsage={
          activeCompanionPlanId === 'kiro'
            ? () => void api.openExternal('https://app.kiro.dev/account/usage')
            : undefined
        }
        onManage={() => {
          if (!activeCompanionPlanId) return;
          onOpenCodeProviderAction(
            activeCompanionPlanId === 'kiro' ? 'kiro' : 'cursor-acp',
            'select'
          );
          setActiveCompanionPlanId(null);
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
        initialBaseUrl={connectedXiaomiResolution?.canonicalBaseUrl ?? null}
        onConnect={(providerId) =>
          onOpenCodeProviderAction(
            providerId,
            connectedXiaomiEntry?.providerId === providerId ? 'reconnect' : 'connect'
          )
        }
        onManage={
          connectedXiaomiEntry
            ? () => {
                onOpenCodeProviderAction(connectedXiaomiEntry.providerId, 'select');
                setXiaomiDialogOpen(false);
              }
            : undefined
        }
        onOpenPlanPage={(url) => void api.openExternal(url)}
      />
    </>
  );
};
