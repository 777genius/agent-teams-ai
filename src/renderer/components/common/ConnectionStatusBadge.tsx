/**
 * ConnectionStatusBadge - Visual indicator for workspace connection status.
 *
 * Renders appropriate icon based on connection state:
 * - Local: Monitor icon (muted)
 * - SSH connected: Wifi icon (green)
 * - SSH connecting: Animated spinner (muted)
 * - SSH disconnected: WifiOff icon (muted)
 * - SSH error: WifiOff icon (red)
 */

import { useStore } from '@renderer/store';
import { Loader2, Monitor, Wifi, WifiOff } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

interface ConnectionStatusBadgeProps {
  contextId: string;
  className?: string;
}

export const ConnectionStatusBadge = ({
  contextId,
  className,
}: Readonly<ConnectionStatusBadgeProps>): React.JSX.Element => {
  const { connectionState, connectedHost } = useStore(
    useShallow((s) => ({
      connectionState: s.connectionState,
      connectedHost: s.connectedHost,
    }))
  );

  // Local context always shows Monitor icon
  if (contextId === 'local') {
    return <Monitor className={`size-3.5 text-text-muted ${className ?? ''}`} />;
  }

  // SSH context - determine if this specific SSH context matches connected host
  const isConnectedToThisHost = connectedHost != null && contextId === `ssh-${connectedHost}`;

  // If this SSH context doesn't match the connected host, treat as disconnected
  const effectiveState = isConnectedToThisHost ? connectionState : 'disconnected';

  // Render icon based on connection state
  switch (effectiveState) {
    case 'connected':
      return <Wifi className={`size-3.5 text-green-400 ${className ?? ''}`} />;
    case 'connecting':
      return <Loader2 className={`size-3.5 animate-spin text-text-muted ${className ?? ''}`} />;
    case 'disconnected':
      return <WifiOff className={`size-3.5 text-text-muted ${className ?? ''}`} />;
    case 'error':
      return <WifiOff className={`size-3.5 text-red-400 ${className ?? ''}`} />;
    default:
      return <WifiOff className={`size-3.5 text-text-muted ${className ?? ''}`} />;
  }
};
