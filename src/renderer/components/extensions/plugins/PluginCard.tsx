/**
 * PluginCard — grid card for a single plugin in the catalog.
 */

import { Badge } from '@renderer/components/ui/badge';
import { useStore } from '@renderer/store';
import {
  getCapabilityLabel,
  getInstallationSummaryLabel,
  getPluginOperationKey,
  hasInstallationInScope,
  inferCapabilities,
  normalizeCategory,
} from '@shared/utils/extensionNormalizers';
import { Tag } from 'lucide-react';

import { InstallButton } from '../common/InstallButton';
import { InstallCountBadge } from '../common/InstallCountBadge';

import type { EnrichedPlugin } from '@shared/types/extensions';

interface PluginCardProps {
  plugin: EnrichedPlugin;
  index: number;
  onClick: (pluginId: string) => void;
}

export const PluginCard = ({ plugin, index, onClick }: PluginCardProps): React.JSX.Element => {
  const capabilities = inferCapabilities(plugin);
  const category = normalizeCategory(plugin.category);
  const operationKey = getPluginOperationKey(plugin.pluginId, 'user');
  const installProgress = useStore((s) => s.pluginInstallProgress[operationKey] ?? 'idle');
  const installPlugin = useStore((s) => s.installPlugin);
  const uninstallPlugin = useStore((s) => s.uninstallPlugin);
  const installError = useStore((s) => s.installErrors[operationKey]);
  const isUserInstalled = hasInstallationInScope(plugin.installations, 'user');
  const installSummaryLabel = getInstallationSummaryLabel(plugin.installations);
  const baseStriped = index % 2 === 0;
  const smStriped = Math.floor(index / 2) % 2 === 0;
  const xlStriped = Math.floor(index / 3) % 2 === 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(plugin.pluginId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(plugin.pluginId);
        }
      }}
      className={`relative flex w-full cursor-pointer flex-col gap-3 rounded-xl border p-4 text-left transition-all duration-200 hover:border-border-emphasis hover:bg-white/[0.06] hover:shadow-[0_0_12px_rgba(255,255,255,0.02)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] ${
        baseStriped ? 'bg-white/[0.045]' : 'bg-white/[0.015]'
      } ${smStriped ? 'sm:bg-white/[0.045]' : 'sm:bg-white/[0.015]'} ${
        xlStriped ? 'xl:bg-white/[0.045]' : 'xl:bg-white/[0.015]'
      } ${
        plugin.isInstalled ? 'border-l-2 border-border border-l-emerald-500/35' : 'border-border'
      }`}
    >
      {plugin.source === 'official' && (
        <div className="pointer-events-none absolute -left-px -top-px size-16 overflow-hidden">
          <div className="absolute left-[-24px] top-[4px] w-[80px] -rotate-45 bg-blue-500/90 text-center text-[9px] font-semibold leading-[18px] text-white shadow-sm">
            Official
          </div>
        </div>
      )}

      {/* Header: name + status/meta */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate text-sm font-semibold text-text">{plugin.name}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="text-[11px]">
              {category}
            </Badge>
            {capabilities.map((cap) => (
              <Badge
                key={cap}
                variant="outline"
                className="bg-surface-raised/60 border-border text-[11px] text-text-secondary"
              >
                {getCapabilityLabel(cap)}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <InstallCountBadge count={plugin.installCount} />
          {installSummaryLabel && (
            <Badge
              className="shrink-0 border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              variant="outline"
            >
              {installSummaryLabel}
            </Badge>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="line-clamp-3 min-h-[3.75rem] text-xs leading-5 text-text-secondary">
        {plugin.description}
      </p>

      {/* Footer: author + version + install button */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3 text-xs text-text-muted">
          <span className="truncate">{plugin.author?.name ?? 'Unknown author'}</span>
          {plugin.version && (
            <span className="inline-flex shrink-0 items-center gap-1">
              <Tag className="size-3" />
              {plugin.version}
            </span>
          )}
        </div>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <InstallButton
            state={installProgress}
            isInstalled={isUserInstalled}
            section="plugins"
            onInstall={() => installPlugin({ pluginId: plugin.pluginId, scope: 'user' })}
            onUninstall={() => uninstallPlugin(plugin.pluginId, 'user')}
            size="sm"
            errorMessage={installError}
          />
        </div>
      </div>
    </div>
  );
};
