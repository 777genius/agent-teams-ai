/**
 * InstallCountBadge — formatted download count with icon.
 */

import { formatInstallCount } from '@shared/utils/extensionNormalizers';
import { Download } from 'lucide-react';

interface InstallCountBadgeProps {
  count: number;
}

export const InstallCountBadge = ({ count }: InstallCountBadgeProps): React.JSX.Element | null => {
  if (count <= 0) return null;

  return (
    <span className="inline-flex items-center gap-1 text-xs text-text-muted">
      <Download className="size-3" />
      {formatInstallCount(count)}
    </span>
  );
};
