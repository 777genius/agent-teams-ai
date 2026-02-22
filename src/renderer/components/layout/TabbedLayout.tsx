/**
 * TabbedLayout - Main layout with project-centric sidebar and multi-pane tabbed content.
 *
 * Layout structure:
 * - Sidebar (280px): Project dropdown + date-grouped sessions
 * - Main content: PaneContainer with one or more panes, each with TabBar + content
 */

import { isElectronMode } from '@renderer/api';
import { getTrafficLightPaddingForZoom } from '@renderer/constants/layout';
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts';
import { useZoomFactor } from '@renderer/hooks/useZoomFactor';

import { UpdateBanner } from '../common/UpdateBanner';
import { UpdateDialog } from '../common/UpdateDialog';
import { WorkspaceIndicator } from '../common/WorkspaceIndicator';
import { CommandPalette } from '../search/CommandPalette';

import { CustomTitleBar } from './CustomTitleBar';
import { PaneContainer } from './PaneContainer';
import { Sidebar } from './Sidebar';

export const TabbedLayout = (): React.JSX.Element => {
  // Enable keyboard shortcuts
  useKeyboardShortcuts();
  const zoomFactor = useZoomFactor();
  const trafficLightPadding = isElectronMode() ? getTrafficLightPaddingForZoom(zoomFactor) : 0;

  return (
    <div
      className="flex h-screen flex-col bg-claude-dark-bg text-claude-dark-text"
      style={
        { '--macos-traffic-light-padding-left': `${trafficLightPadding}px` } as React.CSSProperties
      }
    >
      <CustomTitleBar />
      <UpdateBanner />
      <div className="flex flex-1 overflow-hidden">
        {/* Command Palette (Cmd+K) */}
        <CommandPalette />

        {/* Sidebar - Project dropdown + Sessions (280px) */}
        <Sidebar />

        {/* Multi-pane content area */}
        <PaneContainer />
      </div>
      <UpdateDialog />
      <WorkspaceIndicator />
    </div>
  );
};
