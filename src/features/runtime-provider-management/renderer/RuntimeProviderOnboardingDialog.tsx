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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(88vh,820px)] max-w-2xl overflow-y-auto">
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
          onAdvancedSettings={onAdvancedSettings}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
