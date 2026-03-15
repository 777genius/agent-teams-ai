/**
 * InstallButton — animated install/uninstall button for extensions.
 * States: idle → pending (spinner) → success (checkmark, 2s) → idle
 */

import { useEffect, useState } from 'react';

import { Check, Loader2, Trash2 } from 'lucide-react';

import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';

import type { ExtensionOperationState } from '@shared/types/extensions';

interface InstallButtonProps {
  state: ExtensionOperationState;
  isInstalled: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  disabled?: boolean;
  size?: 'sm' | 'default';
  errorMessage?: string;
}

export function InstallButton({
  state,
  isInstalled,
  onInstall,
  onUninstall,
  disabled,
  size = 'sm',
  errorMessage,
}: InstallButtonProps) {
  const cliStatus = useStore((s) => s.cliStatus);
  const cliMissing = cliStatus !== null && !cliStatus.installed;
  const isDisabled = disabled || cliMissing;
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
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="ml-1.5">
          {pendingAction === 'uninstall' ? 'Removing...' : 'Installing...'}
        </span>
      </Button>
    );
  }

  if (state === 'success') {
    return (
      <Button size={size} variant="outline" disabled className="text-green-400">
        <Check className="h-3.5 w-3.5" />
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

    if (errorMessage) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{retryButton}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-red-300">{errorMessage}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return retryButton;
  }

  // idle — wrap in tooltip when CLI missing
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
      <Trash2 className="h-3.5 w-3.5" />
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

  if (cliMissing) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{button}</span>
          </TooltipTrigger>
          <TooltipContent>Claude CLI required</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
}
