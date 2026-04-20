/**
 * InstallButton — animated install/uninstall button for extensions.
 * States: idle → pending (spinner) → success (checkmark, 2s) → idle
 */

import { useEffect, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { getExtensionActionDisableReason } from '@shared/utils/extensionNormalizers';
import { Check, Loader2, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { CliInstallationStatus } from '@shared/types';
import type { ExtensionOperationState } from '@shared/types/extensions';

interface InstallButtonProps {
  state: ExtensionOperationState;
  isInstalled: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  section?: 'plugins' | 'mcp';
  disabled?: boolean;
  size?: 'sm' | 'default';
  errorMessage?: string;
  cliStatus?: Pick<
    CliInstallationStatus,
    'installed' | 'authLoggedIn' | 'binaryPath' | 'launchError' | 'flavor' | 'providers'
  > | null;
  cliStatusLoading?: boolean;
}

export const InstallButton = ({
  state,
  isInstalled,
  onInstall,
  onUninstall,
  section = 'plugins',
  disabled,
  size = 'sm',
  errorMessage,
  cliStatus: cliStatusOverride,
  cliStatusLoading: cliStatusLoadingOverride,
}: InstallButtonProps) => {
  const { cliStatus: storedCliStatus, cliStatusLoading: storedCliStatusLoading } = useStore(
    useShallow((s) => ({
      cliStatus: s.cliStatus,
      cliStatusLoading: s.cliStatusLoading,
    }))
  );
  const cliStatus = cliStatusOverride ?? storedCliStatus;
  const cliStatusLoading = cliStatusLoadingOverride ?? storedCliStatusLoading;
  const disableReason = getExtensionActionDisableReason({
    isInstalled,
    cliStatus,
    cliStatusLoading,
    section,
  });
  const isDisabled = disabled || Boolean(disableReason);
  const [lastAction, setLastAction] = useState<'install' | 'uninstall' | null>(null);

  useEffect(() => {
    if (state === 'idle' || state === 'success') {
      setLastAction(null);
    }
  }, [state]);

  const pendingAction = lastAction ?? (isInstalled ? 'uninstall' : 'install');
  if (state === 'pending') {
    return (
      <Button size={size} variant="outline" disabled>
        <Loader2 className="size-3.5 animate-spin" />
        <span className="ml-1.5">
          {pendingAction === 'uninstall' ? 'Removing...' : 'Installing...'}
        </span>
      </Button>
    );
  }

  if (state === 'success') {
    return (
      <Button size={size} variant="outline" disabled className="text-green-400">
        <Check className="size-3.5" />
        <span className="ml-1.5">Done</span>
      </Button>
    );
  }

  if (state === 'error') {
    const retryButton = (
      <Button
        size={size}
        variant="outline"
        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
        onClick={(e) => {
          e.stopPropagation();
          if (pendingAction === 'uninstall') {
            setLastAction('uninstall');
            onUninstall();
            return;
          }

          setLastAction('install');
          onInstall();
        }}
        disabled={isDisabled}
      >
        <span>Retry</span>
      </Button>
    );

    const tooltipMessage = disableReason ?? errorMessage;

    if (tooltipMessage) {
      return (
        <div className="flex max-w-64 flex-col items-end gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>{retryButton}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-64 text-red-300">{tooltipMessage}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {errorMessage && !disableReason ? (
            <p className="text-right text-[11px] leading-4 text-red-300">{errorMessage}</p>
          ) : null}
        </div>
      );
    }

    return retryButton;
  }

  // idle — wrap in tooltip when install is unavailable
  const button = isInstalled ? (
    <Button
      size={size}
      variant="outline"
      className="border-red-500/30 text-red-400 hover:bg-red-500/10"
      onClick={(e) => {
        e.stopPropagation();
        setLastAction('uninstall');
        onUninstall();
      }}
      disabled={isDisabled}
    >
      <Trash2 className="size-3.5" />
      <span className="ml-1.5">Uninstall</span>
    </Button>
  ) : (
    <Button
      size={size}
      variant="default"
      onClick={(e) => {
        e.stopPropagation();
        setLastAction('install');
        onInstall();
      }}
      disabled={isDisabled}
    >
      Install
    </Button>
  );

  if (disableReason) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{button}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{disableReason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};
