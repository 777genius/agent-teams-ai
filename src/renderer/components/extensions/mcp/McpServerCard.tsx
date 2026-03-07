/**
 * McpServerCard — grid card for a single MCP server in the catalog.
 * Shows server icon from registry when available.
 */

import { useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { useStore } from '@renderer/store';
import { Lock, Server, Wrench } from 'lucide-react';

import { InstallButton } from '../common/InstallButton';
import { SourceBadge } from '../common/SourceBadge';

import type { McpCatalogItem } from '@shared/types/extensions';

interface McpServerCardProps {
  server: McpCatalogItem;
  isInstalled: boolean;
  onClick: (serverId: string) => void;
}

export const McpServerCard = ({
  server,
  isInstalled,
  onClick,
}: McpServerCardProps): React.JSX.Element => {
  const installProgress = useStore((s) => s.mcpInstallProgress[server.id] ?? 'idle');
  const installMcpServer = useStore((s) => s.installMcpServer);
  const uninstallMcpServer = useStore((s) => s.uninstallMcpServer);
  const canAutoInstall = !!server.installSpec;
  const [imgError, setImgError] = useState(false);

  return (
    <button
      onClick={() => onClick(server.id)}
      className={`flex w-full flex-col gap-2 rounded-lg border p-4 text-left transition-all duration-200 hover:border-border-emphasis hover:bg-surface-raised hover:shadow-[0_0_12px_rgba(255,255,255,0.02)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] ${
        isInstalled ? 'border-l-2 border-border border-l-emerald-500/30' : 'border-border'
      }`}
    >
      {/* Header: icon + name + source */}
      <div className="flex items-start gap-2.5">
        {/* Server icon or fallback */}
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised">
          {server.iconUrl && !imgError ? (
            <img
              src={server.iconUrl}
              alt=""
              className="size-7 rounded object-contain"
              onError={() => setImgError(true)}
            />
          ) : (
            <Server className="size-4 text-text-muted" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-sm font-semibold text-text">{server.name}</h3>
            <div className="flex shrink-0 items-center gap-1.5">
              {isInstalled && (
                <Badge
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  variant="outline"
                >
                  Installed
                </Badge>
              )}
              <SourceBadge source={server.source} />
            </div>
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="line-clamp-2 text-xs text-text-secondary">{server.description}</p>

      {/* Footer indicators + install button */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3 text-xs text-text-muted">
          {server.tools.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-1.5 py-0.5 ring-1 ring-border">
              <Wrench className="size-3" />
              {server.tools.length}
            </span>
          )}
          {server.requiresAuth && (
            <span className="inline-flex items-center gap-1 text-amber-400">
              <Lock className="size-3" />
              Auth
            </span>
          )}
          {server.license && <span>{server.license}</span>}
        </div>
        {canAutoInstall && (
          <div className="shrink-0">
            <InstallButton
              state={installProgress}
              isInstalled={isInstalled}
              onInstall={() =>
                installMcpServer({
                  registryId: server.id,
                  serverName: server.name.toLowerCase().replaceAll(/\s+/g, '-'),
                  scope: 'user',
                  envValues: {},
                  headers: [],
                })
              }
              onUninstall={() =>
                uninstallMcpServer(server.id, server.name.toLowerCase().replaceAll(/\s+/g, '-'))
              }
              size="sm"
            />
          </div>
        )}
      </div>
    </button>
  );
};
