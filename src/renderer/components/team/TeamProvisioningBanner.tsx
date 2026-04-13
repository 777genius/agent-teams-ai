import { memo } from 'react';

import { TeamProvisioningPanel } from './TeamProvisioningPanel';

interface TeamProvisioningBannerProps {
  teamName: string;
}

export const TeamProvisioningBanner = memo(function TeamProvisioningBanner({
  teamName,
}: TeamProvisioningBannerProps): React.JSX.Element | null {
  const panel = (
    <TeamProvisioningPanel teamName={teamName} surface="flat" dismissible className="mb-3" />
  );
  return panel;
});
