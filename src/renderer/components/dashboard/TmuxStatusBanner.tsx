import type { JSX } from 'react';

export const TmuxStatusBanner = (): JSX.Element | null => {
  // tmux is now a debug/operator runtime mode, not a default production requirement.
  // return <TmuxInstallerBannerView />;
  return null;
};
