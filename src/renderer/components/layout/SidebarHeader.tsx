/**
 * SidebarHeader - Minimal header with logo and collapse button.
 *
 * Layout:
 * - Row 1: Logo (left, after macOS traffic lights) + Collapse button (right)
 * - Row 1 is the drag region for window movement
 */

import { useState } from 'react';

import { isElectronMode } from '@renderer/api';
import { HEADER_ROW1_HEIGHT } from '@renderer/constants/layout';
import { useStore } from '@renderer/store';
import { formatShortcut } from '@renderer/utils/stringUtils';
import { PanelLeft } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { AppLogo } from '../common/AppLogo';

export const SidebarHeader = (): React.JSX.Element => {
  const isMacElectron =
    isElectronMode() && window.navigator.userAgent.toLowerCase().includes('mac');

  const { toggleSidebar } = useStore(
    useShallow((s) => ({
      toggleSidebar: s.toggleSidebar,
    }))
  );

  const [isCollapseHovered, setIsCollapseHovered] = useState(false);

  return (
    <div
      className="flex w-full flex-col"
      style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
    >
      <div
        className="flex select-none items-center gap-1.5 pr-1"
        style={
          {
            height: `${HEADER_ROW1_HEIGHT}px`,
            paddingLeft: isMacElectron ? 'var(--macos-traffic-light-padding-left, 72px)' : 0,
            WebkitAppRegion: isMacElectron ? 'drag' : undefined,
          } as React.CSSProperties
        }
      >
        {isMacElectron && (
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <AppLogo size={22} className="shrink-0" />
          </div>
        )}
        <div className="flex-1" />
        <button
          onClick={toggleSidebar}
          onMouseEnter={() => setIsCollapseHovered(true)}
          onMouseLeave={() => setIsCollapseHovered(false)}
          className="shrink-0 rounded-md p-1.5 transition-colors"
          style={
            {
              WebkitAppRegion: 'no-drag',
              color: isCollapseHovered ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
              backgroundColor: isCollapseHovered ? 'var(--color-surface-raised)' : 'transparent',
            } as React.CSSProperties
          }
          title={`Collapse sidebar (${formatShortcut('B')})`}
        >
          <PanelLeft className="size-4" />
        </button>
      </div>
    </div>
  );
};
