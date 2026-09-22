import { useMemo } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

import { findRuntimeProviderOnboardingPlanByProviderId } from '../core/domain';

import {
  type RuntimeProviderOnboardingMode,
  useRuntimeProviderOnboarding,
} from './hooks/useRuntimeProviderOnboarding';
import { RuntimeProviderOnboardingView } from './ui/RuntimeProviderOnboardingView';

import type { RuntimeProviderQuickConnectGate } from '../core/domain';
import type { JSX } from 'react';

interface RuntimeProviderOnboardingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: RuntimeProviderOnboardingMode;
  readonly providerId?: string | null;
  readonly projectPath?: string | null;
  readonly runtimeGate: RuntimeProviderQuickConnectGate;
  readonly runtimeUpdateRequired?: boolean;
  readonly disabled?: boolean;
  readonly onInstallOrUpdateRuntime: () => Promise<void> | void;
  readonly onProviderChanged?: () => Promise<void> | void;
  readonly onAdvancedSettings: () => void;
}

export const RuntimeProviderOnboardingDialog = ({
  open,
  onOpenChange,
  mode,
  providerId = null,
  projectPath = null,
  runtimeGate,
  runtimeUpdateRequired = false,
  disabled = false,
  onInstallOrUpdateRuntime,
  onProviderChanged,
  onAdvancedSettings,
}: RuntimeProviderOnboardingDialogProps): JSX.Element => {
  const plan = useMemo(
    () => (providerId ? findRuntimeProviderOnboardingPlanByProviderId(providerId) : null),
    [providerId]
  );
  const [state, actions] = useRuntimeProviderOnboarding({
    enabled: open,
    mode,
    providerId,
    projectPath,
    runtimeGate,
    runtimeUpdateRequired,
    onInstallOrUpdateRuntime,
    onProviderChanged,
  });
  const title =
    mode === 'wizard' ? 'Connect all my plans' : `Set up ${plan?.displayName ?? 'plan'}`;
  const activeAuthOption = state.management.setupForm?.authOptions?.find(
    (option) => option.id === state.management.selectedAuthOptionId
  );
  const activeSetupMethod = activeAuthOption?.method ?? state.management.setupForm?.method ?? null;
  const blockingCredentialWrite = Boolean(
    state.management.savingProviderId && activeSetupMethod && activeSetupMethod !== 'oauth'
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && blockingCredentialWrite) {
          return;
        }
        if (!nextOpen) {
          actions.management.cancelConnect();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        closeDisabled={blockingCredentialWrite}
        className="max-h-[min(88vh,820px)] max-w-2xl overflow-y-auto"
        onEscapeKeyDown={(event) => {
          if (blockingCredentialWrite) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (blockingCredentialWrite) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Connect, verify a real model request, and finish with a model ready for Agent Teams.
          </DialogDescription>
        </DialogHeader>
        <RuntimeProviderOnboardingView
          state={state}
          actions={actions}
          disabled={disabled}
          onAdvancedSettings={() => {
            if (blockingCredentialWrite) return;
            actions.management.cancelConnect();
            onAdvancedSettings();
          }}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
};
