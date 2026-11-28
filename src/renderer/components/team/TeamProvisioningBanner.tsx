import { memo } from 'react';

import { TeamProvisioningPanel } from './TeamProvisioningPanel';

interface TeamProvisioningBannerProps {
  teamName: string;
  runtimeTeamName?: string;
}

export const TeamProvisioningBanner = memo(function TeamProvisioningBanner({
  teamName,
  runtimeTeamName,
}: TeamProvisioningBannerProps): React.JSX.Element | null {
  const panel = (
    <TeamProvisioningPanel
      teamName={teamName}
      runtimeTeamName={runtimeTeamName}
      surface="flat"
      dismissible
      className="mb-3"
    />
  );
  return panel;
});
