/**
 * CustomTitleBar - Conventional title bar for Windows and Linux when the native frame is hidden.
 *
 * Renders a draggable top strip with window controls (minimize, maximize/restore, close)
 * on the right. Only shown in Electron on Windows or Linux (macOS uses native traffic lights).
 */

import { useEffect, useState } from 'react';

import { isElectronMode } from '@renderer/api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import faviconUrl from '@renderer/favicon.png';
import { useStore } from '@renderer/store';
import { Minus, Square, X } from 'lucide-react';

const TITLE_BAR_HEIGHT = 32;

/**
 * Detect whether the custom title bar should be shown.
 *
 * In Electron, the userAgent string reliably contains the OS name
 * (e.g. "Windows NT 10.0", "Linux x86_64"), so this check works on
 * all three platforms.  macOS is excluded because it uses native
 * traffic-light window controls instead.
 */
function needsCustomTitleBar(): boolean {
  if (!isElectronMode()) return false;
  const ua = window.navigator.userAgent;
  return ua.includes('Windows') || ua.includes('Linux');
}

export const CustomTitleBar = (): React.JSX.Element | null => {
  const [isMaximized, setIsMaximized] = useState(false);
  const useNativeTitleBar = useStore((s) => s.appConfig?.general?.useNativeTitleBar ?? false);
  const showTitleBar = needsCustomTitleBar() && !useNativeTitleBar;
  const api = typeof window !== 'undefined' ? window.electronAPI?.windowControls : null;

  useEffect(() => {
    if (api) void api.isMaximized().then(setIsMaximized);
  }, [api]);

  if (!showTitleBar || !api) return null;

  const { minimize, maximize, close, isMaximized: getIsMaximized } = api;

  const handleMaximize = async (): Promise<void> => {
    await maximize();
    const maximized = await getIsMaximized();
    setIsMaximized(maximized);
  };

  const buttonBase =
    'flex h-full w-12 items-center justify-center transition-colors border-0 outline-none';
  const buttonHover = 'hover:bg-white/10';

  const titleBarStyle = {
    height: `${TITLE_BAR_HEIGHT}px`,
    backgroundColor: 'var(--color-surface-sidebar)',
    borderBottom: '1px solid var(--color-border)',
    WebkitAppRegion: 'drag',
  } as React.CSSProperties;

  return (
    <div className="flex shrink-0 select-none items-stretch" style={titleBarStyle}>
      {/* Draggable area — app icon */}
      <div className="flex flex-1 items-center pl-3" style={{ minWidth: 0 }}>
        <img src={faviconUrl} alt="" className="size-5 shrink-0 rounded-sm" draggable={false} />
      </div>

      {/* Window controls — no-drag so they receive clicks */}
      <div className="flex shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`${buttonBase} ${buttonHover}`}
              style={{ color: 'var(--color-text-secondary)' }}
              onClick={() => void minimize()}
              aria-label="Minimize"
            >
              <Minus className="size-4" strokeWidth={2.5} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Minimize</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`${buttonBase} ${buttonHover}`}
              style={{ color: 'var(--color-text-secondary)' }}
              onClick={() => void handleMaximize()}
              aria-label={isMaximized ? 'Restore' : 'Maximize'}
            >
              <Square className="size-3.5" strokeWidth={2.5} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{isMaximized ? 'Restore' : 'Maximize'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`${buttonBase} hover:bg-red-500/90 hover:text-white`}
              style={{ color: 'var(--color-text-secondary)' }}
              onClick={() => void close()}
              aria-label="Close"
            >
              <X className="size-4" strokeWidth={2.5} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
