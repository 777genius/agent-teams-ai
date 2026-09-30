/** Desktop Dashboard entrypoint; native reads and notices live in its composition. */
import { DesktopDashboard } from '@renderer/composition/dashboard/DesktopDashboard';

import type React from 'react';

interface DashboardViewProps {
  isActive?: boolean;
}

export const DashboardView = ({ isActive = true }: DashboardViewProps): React.JSX.Element => (
  <DesktopDashboard isActive={isActive} />
);
