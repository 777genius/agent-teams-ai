/**
 * InstallButton — animated install/uninstall button for extensions.
 * States: idle → pending (spinner) → success (checkmark, 2s) → idle
 */

import { Check, Loader2, Trash2 } from 'lucide-react';

import { Button } from '@renderer/components/ui/button';

import type { ExtensionOperationState } from '@shared/types/extensions';

interface InstallButtonProps {
  state: ExtensionOperationState;
  isInstalled: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  disabled?: boolean;
  size?: 'sm' | 'default';
}

export function InstallButton({
  state,
  isInstalled,
  onInstall,
  onUninstall,
  disabled,
  size = 'sm',
}: InstallButtonProps) {
  if (state === 'pending') {
    return (
      <Button size={size} variant="outline" disabled>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="ml-1.5">{isInstalled ? 'Removing...' : 'Installing...'}</span>
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
    return (
      <Button
        size={size}
        variant="outline"
        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
        onClick={(e) => {
          e.stopPropagation();
          (isInstalled ? onUninstall : onInstall)();
        }}
        disabled={disabled}
      >
        <span>Retry</span>
      </Button>
    );
  }

  // idle
  if (isInstalled) {
    return (
      <Button
        size={size}
        variant="outline"
        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
        onClick={(e) => {
          e.stopPropagation();
          onUninstall();
        }}
        disabled={disabled}
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span className="ml-1.5">Uninstall</span>
      </Button>
    );
  }

  return (
    <Button
      size={size}
      variant="default"
      onClick={(e) => {
        e.stopPropagation();
        onInstall();
      }}
      disabled={disabled}
    >
      Install
    </Button>
  );
}
