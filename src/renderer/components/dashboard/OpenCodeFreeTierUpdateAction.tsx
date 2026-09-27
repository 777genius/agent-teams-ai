import { Button } from '@renderer/components/ui/button';
import {
  formatRuntimeVersionTransition,
  isOpenCodeFreeTierVersionOutdated,
  MINIMUM_OPENCODE_FREE_TIER_VERSION,
  normalizeVersion,
} from '@shared/utils/version';
import { AlertTriangle, Download } from 'lucide-react';

interface OpenCodeFreeTierUpdateActionProps {
  version: string;
  latestVersion?: string | null;
  compact?: boolean;
  disabled?: boolean;
  onUpdate?: () => void;
}

export const OpenCodeFreeTierUpdateAction = ({
  version,
  latestVersion,
  compact = false,
  disabled = false,
  onUpdate,
}: OpenCodeFreeTierUpdateActionProps): React.JSX.Element => {
  if (compact) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onUpdate}
        disabled={disabled}
        className="h-auto gap-1 px-2 py-[3px] text-[10px] font-medium hover:bg-white/5"
        style={{
          borderColor: 'rgba(34, 197, 94, 0.34)',
          color: 'var(--color-positive-subtle-text)',
        }}
      >
        <Download className="size-3" />
        {latestVersion
          ? `Update ${formatRuntimeVersionTransition(version, latestVersion)}`
          : isOpenCodeFreeTierVersionOutdated(version)
            ? `Update ${formatRuntimeVersionTransition(version, MINIMUM_OPENCODE_FREE_TIER_VERSION)}+`
            : 'Update OpenCode'}
      </Button>
    );
  }
  return (
    <p className="mt-2 flex items-start gap-1.5 text-[11px]" style={{ color: '#fbbf24' }}>
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span>
        OpenCode {normalizeVersion(version)} is too old for built-in free-tier models. Update to{' '}
        {MINIMUM_OPENCODE_FREE_TIER_VERSION} or newer.
      </span>
    </p>
  );
};
