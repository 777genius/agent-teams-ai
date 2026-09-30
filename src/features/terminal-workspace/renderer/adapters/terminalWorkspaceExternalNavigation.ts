export const TERMINAL_PLATFORM_REPOSITORY_URL = 'https://github.com/777genius/terminal-platform';

export function openTerminalPlatformRepository(): void {
  if (window.electronAPI?.openExternal) {
    void window.electronAPI.openExternal(TERMINAL_PLATFORM_REPOSITORY_URL);
    return;
  }

  window.open(TERMINAL_PLATFORM_REPOSITORY_URL, '_blank', 'noopener,noreferrer');
}
