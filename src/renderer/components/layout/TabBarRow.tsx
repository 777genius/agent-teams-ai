/**
 * TabBarRow - Full-width tab bar row rendered above the sidebar + content area.
 * Renders pane-specific TabBars proportionally + new tab button on the right.
 * Handles window drag region and focus indicator for multi-pane layouts.
 */

import { Fragment, useState } from 'react';

import { isElectronMode } from '@renderer/api';
import { HEADER_ROW1_HEIGHT } from '@renderer/constants/layout';
import { useStore } from '@renderer/store';
import { Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TabBar } from './TabBar';
import { TabBarActions } from './TabBarActions';

export const TabBarRow = (): React.JSX.Element => {
  const { panes, focusedPaneId, openDashboard } = useStore(
    useShallow((s) => ({
      panes: s.paneLayout.panes,
      focusedPaneId: s.paneLayout.focusedPaneId,
      openDashboard: s.openDashboard,
    }))
  );

  const [newTabHover, setNewTabHover] = useState(false);

  const isMacElectron =
    isElectronMode() && window.navigator.userAgent.toLowerCase().includes('mac');

  return (
    <div
      className="flex shrink-0 items-center"
      style={
        {
          height: `${HEADER_ROW1_HEIGHT}px`,
          backgroundColor: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
          WebkitAppRegion: isMacElectron ? 'drag' : undefined,
        } as React.CSSProperties
      }
    >
      {/* Pane TabBars — proportional width, side by side */}
      <div className="flex min-w-0 flex-1 self-stretch">
        {panes.map((pane, i) => (
          <Fragment key={pane.id}>
            {/* Separator between pane TabBars */}
            {i > 0 && (
              <div
                className="w-px shrink-0 self-stretch"
                style={{ backgroundColor: 'var(--color-border-emphasis)' }}
              />
            )}

            {/* Pane TabBar segment with focus indicator */}
            <div
              className="min-w-0"
              style={{
                width: `${pane.widthFraction * 100}%`,
                borderTop:
                  focusedPaneId === pane.id && panes.length > 1
                    ? '2px solid var(--color-accent, #6366f1)'
                    : '2px solid transparent',
              }}
            >
              <TabBar paneId={pane.id} />
            </div>
          </Fragment>
        ))}

        {/* New tab button — right after last tab */}
        <button
          onClick={openDashboard}
          onMouseEnter={() => setNewTabHover(true)}
          onMouseLeave={() => setNewTabHover(false)}
          className="shrink-0 self-stretch px-2 transition-colors"
          style={
            {
              WebkitAppRegion: 'no-drag',
              color: newTabHover ? 'var(--color-text)' : 'var(--color-text-muted)',
              backgroundColor: newTabHover ? 'var(--color-surface-raised)' : 'transparent',
            } as React.CSSProperties
          }
          title="New tab (Dashboard)"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {/* Action buttons — right side */}
      <TabBarActions />
    </div>
  );
};
