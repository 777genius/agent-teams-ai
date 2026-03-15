/**
 * McpServerCard — grid card for a single MCP server in the catalog.
 * Shows server icon from registry when available.
 */

import { useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { api } from '@renderer/api';
import { formatCompactNumber, formatRelativeTime } from '@renderer/utils/formatters';
import { Cloud, Clock, Globe, KeyRound, Lock, Monitor, Star, Tag, Wrench } from 'lucide-react';

// eslint-disable-next-line @typescript-eslint/no-deprecated -- lucide naming migration, alias is stable
import { Github as GithubIcon } from 'lucide-react';

import { InstallButton } from '../common/InstallButton';
import { SourceBadge } from '../common/SourceBadge';
import { sanitizeMcpServerName } from '@shared/utils/extensionNormalizers';

import type { McpCatalogItem, McpServerDiagnostic } from '@shared/types/extensions';

interface McpServerCardProps {
  server: McpCatalogItem;
  isInstalled: boolean;
  diagnostic?: McpServerDiagnostic | null;
  diagnosticsLoading?: boolean;
  onClick: (serverId: string) => void;
}

export const McpServerCard = ({
  server,
  isInstalled,
  diagnostic,
  diagnosticsLoading,
  onClick,
}: McpServerCardProps): React.JSX.Element => {
  const installProgress = useStore((s) => s.mcpInstallProgress[server.id] ?? 'idle');
  const installMcpServer = useStore((s) => s.installMcpServer);
  const uninstallMcpServer = useStore((s) => s.uninstallMcpServer);
  const installError = useStore((s) => s.installErrors[server.id]);
  const stars = useStore((s) =>
    server.repositoryUrl ? s.mcpGitHubStars[server.repositoryUrl] : undefined
  );
  const canAutoInstall = !!server.installSpec;
  const requiresConfiguration =
    server.installSpec?.type === 'http' ||
    server.envVars.length > 0 ||
    server.requiresAuth ||
    (server.authHeaders?.length ?? 0) > 0;
  const [imgError, setImgError] = useState(false);
  const hasIcon = !!server.iconUrl && !imgError;
  const diagnosticBadgeClass =
    diagnostic?.status === 'connected'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : diagnostic?.status === 'needs-authentication'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : diagnostic?.status === 'failed'
          ? 'border-red-500/30 bg-red-500/10 text-red-400'
          : 'border-border bg-surface-raised text-text-muted';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(server.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(server.id);
        }
      }}
      className={`relative flex w-full cursor-pointer flex-col gap-2 overflow-hidden rounded-lg border p-4 text-left transition-all duration-200 hover:border-border-emphasis hover:bg-surface-raised hover:shadow-[0_0_12px_rgba(255,255,255,0.02)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] ${
        isInstalled ? 'border-l-2 border-border border-l-emerald-500/30' : 'border-border'
      }`}
    >
      {/* Header: icon + name */}
      <div className="flex items-start gap-2.5">
        {/* Server icon (only when available) */}
        {hasIcon && (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised">
            <img
              src={server.iconUrl!}
              alt=""
              className="size-7 rounded object-contain"
              onError={() => setImgError(true)}
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-text">{server.name}</h3>
              {server.source !== 'official' && (
                <div className="mt-1">
                  <SourceBadge source={server.source} />
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {isInstalled && (
                <Badge
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  variant="outline"
                >
                  Installed
                </Badge>
              )}
              {isInstalled && diagnosticsLoading && !diagnostic && (
                <Badge
                  className="border-border bg-surface-raised text-text-muted"
                  variant="outline"
                >
                  Checking...
                </Badge>
              )}
              {diagnostic && (
                <Badge className={diagnosticBadgeClass} variant="outline">
                  {diagnostic.statusLabel}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="line-clamp-2 text-xs text-text-secondary">{server.description}</p>
      {diagnostic?.target && (
        <p className="truncate font-mono text-[10px] text-text-muted" title={diagnostic.target}>
          {diagnostic.target}
        </p>
      )}

      {/* Footer indicators + install button */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          {server.tools.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-1.5 py-0.5 ring-1 ring-border">
              <Wrench className="size-3" />
              {server.tools.length} {server.tools.length === 1 ? 'tool' : 'tools'}
            </span>
          )}
          {server.envVars.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <KeyRound className="size-3" />
              {server.envVars.length} {server.envVars.length === 1 ? 'env' : 'envs'}
            </span>
          )}
          {server.requiresAuth && (
            <span className="inline-flex items-center gap-1 text-amber-400">
              <Lock className="size-3" />
              Auth
            </span>
          )}
          {server.version && (
            <span className="inline-flex items-center gap-1">
              <Tag className="size-3" />
              {server.version}
            </span>
          )}
          {server.updatedAt && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {formatRelativeTime(server.updatedAt)}
            </span>
          )}
          {server.author && <span className="truncate">by {server.author}</span>}
          {server.hostingType === 'remote' && (
            <span className="inline-flex items-center gap-1">
              <Cloud className="size-3" />
              Remote
            </span>
          )}
          {server.hostingType === 'local' && (
            <span className="inline-flex items-center gap-1">
              <Monitor className="size-3" />
              Local
            </span>
          )}
          {server.hostingType === 'both' && (
            <span className="inline-flex items-center gap-1">
              <Globe className="size-3" />
              Both
            </span>
          )}
          {/* External links + stars */}
          {server.repositoryUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="inline-flex items-center gap-1.5 text-text-muted transition-colors hover:text-text"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.openExternal(server.repositoryUrl!);
                  }}
                >
                  <GithubIcon className="size-3.5" />
                  {stars != null && (
                    <span className="inline-flex items-center gap-0.5">
                      <Star className="size-3 fill-amber-400 text-amber-400" />
                      {formatCompactNumber(stars)}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Repository</TooltipContent>
            </Tooltip>
          )}
          {server.websiteUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="inline-flex items-center text-text-muted transition-colors hover:text-text"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.openExternal(server.websiteUrl!);
                  }}
                >
                  <Globe className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Website</TooltipContent>
            </Tooltip>
          )}
        </div>
        {canAutoInstall && !requiresConfiguration && (
          <div className="shrink-0">
            <InstallButton
              state={installProgress}
              isInstalled={isInstalled}
              onInstall={() =>
                installMcpServer({
                  registryId: server.id,
                  serverName: sanitizeMcpServerName(server.name),
                  scope: 'user',
                  envValues: {},
                  headers: [],
                })
              }
              onUninstall={() => uninstallMcpServer(server.id, sanitizeMcpServerName(server.name))}
              size="sm"
              errorMessage={installError}
            />
          </div>
        )}
        {canAutoInstall && requiresConfiguration && (
          <div className="shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                onClick(server.id);
              }}
            >
              {isInstalled ? 'Manage' : 'Configure'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
