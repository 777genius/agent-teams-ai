/**
 * McpServerDetailDialog — full detail view for a single MCP server with install controls.
 * Uses Radix UI Kit for all form elements.
 */

import { useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';
import { api } from '@renderer/api';
import { ExternalLink, Lock, Plus, Server, Trash2, Wrench } from 'lucide-react';

import { InstallButton } from '../common/InstallButton';
import { SourceBadge } from '../common/SourceBadge';

import type { McpCatalogItem, McpHeaderDef } from '@shared/types/extensions';

interface McpServerDetailDialogProps {
  server: McpCatalogItem | null;
  isInstalled: boolean;
  open: boolean;
  onClose: () => void;
}

type Scope = 'local' | 'user' | 'project';

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: 'user', label: 'User (global)' },
  { value: 'project', label: 'Project' },
  { value: 'local', label: 'Local' },
];

export const McpServerDetailDialog = ({
  server,
  isInstalled,
  open,
  onClose,
}: McpServerDetailDialogProps): React.JSX.Element => {
  const installProgress = useStore(
    (s) => (server ? s.mcpInstallProgress[server.id] : undefined) ?? 'idle'
  );
  const installMcpServer = useStore((s) => s.installMcpServer);
  const uninstallMcpServer = useStore((s) => s.uninstallMcpServer);

  const [scope, setScope] = useState<Scope>('user');
  const [serverName, setServerName] = useState('');
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<McpHeaderDef[]>([]);
  const [imgError, setImgError] = useState(false);

  // Initialize form when server changes
  const [lastServerId, setLastServerId] = useState<string | null>(null);
  if (server && server.id !== lastServerId) {
    setLastServerId(server.id);
    setServerName(server.name.toLowerCase().replaceAll(/\s+/g, '-'));
    setEnvValues(Object.fromEntries(server.envVars.map((env) => [env.name, ''])));
    setHeaders([]);
    setImgError(false);
  }

  if (!server) return <></>;

  const canAutoInstall = !!server.installSpec;
  const isHttp = server.installSpec?.type === 'http';

  const handleInstall = () => {
    installMcpServer({
      registryId: server.id,
      serverName,
      scope,
      envValues,
      headers,
    });
  };

  const handleUninstall = () => {
    uninstallMcpServer(server.id, serverName, scope);
  };

  const addHeader = () => {
    setHeaders((prev) => [...prev, { key: '', value: '' }]);
  };

  const removeHeader = (index: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== index));
  };

  const updateHeader = (index: number, field: 'key' | 'value', value: string) => {
    setHeaders((prev) => prev.map((h, i) => (i === index ? { ...h, [field]: value } : h)));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start gap-3">
            {/* Server icon */}
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised">
              {server.iconUrl && !imgError ? (
                <img
                  src={server.iconUrl}
                  alt=""
                  className="size-8 rounded object-contain"
                  onError={() => setImgError(true)}
                />
              ) : (
                <Server className="size-5 text-text-muted" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <DialogTitle className="truncate">{server.name}</DialogTitle>
                  <DialogDescription className="mt-1">{server.description}</DialogDescription>
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
                  <SourceBadge source={server.source} />
                </div>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Metadata grid */}
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <span className="text-text-muted">Source</span>
            <p className="capitalize text-text">{server.source}</p>
          </div>
          {server.version && (
            <div>
              <span className="text-text-muted">Version</span>
              <p className="text-text">{server.version}</p>
            </div>
          )}
          {server.license && (
            <div>
              <span className="text-text-muted">License</span>
              <p className="text-text">{server.license}</p>
            </div>
          )}
          <div>
            <span className="text-text-muted">Install Type</span>
            <p className="text-text">
              {server.installSpec
                ? server.installSpec.type === 'stdio'
                  ? `npm: ${server.installSpec.npmPackage}`
                  : `HTTP: ${server.installSpec.transportType}`
                : 'Manual setup required'}
            </p>
          </div>
        </div>

        {/* Auth indicator */}
        {server.requiresAuth && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400">
            <Lock className="size-4" />
            This server requires authentication
          </div>
        )}

        {/* Install form */}
        {canAutoInstall && (
          <div className="space-y-3 rounded-md border border-border bg-surface-raised p-4">
            <h4 className="text-sm font-medium text-text">
              {isInstalled ? 'Manage Installation' : 'Install Server'}
            </h4>

            {/* Server name */}
            <div className="space-y-1.5">
              <Label htmlFor="server-name" className="text-xs">
                Server Name
              </Label>
              <Input
                id="server-name"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                placeholder="my-server"
                className="h-8 text-sm"
              />
            </div>

            {/* Scope */}
            <div className="space-y-1.5">
              <Label className="text-xs">Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Environment variables */}
            {server.envVars.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">Environment Variables</Label>
                <div className="space-y-2">
                  {server.envVars.map((env) => (
                    <div key={env.name} className="flex items-center gap-2">
                      <code className="w-40 shrink-0 truncate text-xs text-blue-400">
                        {env.name}
                      </code>
                      <Input
                        type={env.isSecret ? 'password' : 'text'}
                        value={envValues[env.name] ?? ''}
                        onChange={(e) =>
                          setEnvValues((prev) => ({ ...prev, [env.name]: e.target.value }))
                        }
                        className="h-7 flex-1 text-xs"
                        placeholder={env.description ?? env.name}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Headers (for HTTP/SSE servers) */}
            {isHttp && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Headers</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={addHeader}
                    className="h-6 px-1.5 text-xs"
                  >
                    <Plus className="mr-1 size-3" />
                    Add
                  </Button>
                </div>
                {headers.length > 0 && (
                  <div className="space-y-2">
                    {headers.map((header, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          value={header.key}
                          onChange={(e) => updateHeader(index, 'key', e.target.value)}
                          className="h-7 w-32 text-xs"
                          placeholder="Header-Name"
                        />
                        <Input
                          type={header.secret ? 'password' : 'text'}
                          value={header.value}
                          onChange={(e) => updateHeader(index, 'value', e.target.value)}
                          className="h-7 flex-1 text-xs"
                          placeholder="value"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-red-400 hover:bg-red-500/10"
                          onClick={() => removeHeader(index)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Install/Uninstall button */}
            <div className="flex justify-end pt-1">
              <InstallButton
                state={installProgress}
                isInstalled={isInstalled}
                onInstall={handleInstall}
                onUninstall={handleUninstall}
                disabled={!serverName.trim()}
                size="default"
              />
            </div>
          </div>
        )}

        {!canAutoInstall && (
          <div className="rounded-md border border-border bg-surface-raised px-4 py-3 text-sm text-text-muted">
            This server requires manual setup. Check the repository for installation instructions.
          </div>
        )}

        {/* Tools */}
        {server.tools.length > 0 && (
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text">
              <Wrench className="size-4" />
              Tools ({server.tools.length})
            </h4>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {server.tools.map((tool) => (
                <div key={tool.name} className="rounded-md bg-surface-raised p-2 text-xs">
                  <code className="font-mono text-text">{tool.name}</code>
                  {tool.description && <p className="mt-0.5 text-text-muted">{tool.description}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Links */}
        <div className="flex items-center gap-4">
          {server.repositoryUrl && (
            <Button
              variant="link"
              className="h-auto p-0 text-sm text-blue-400"
              onClick={() => void api.openExternal(server.repositoryUrl!)}
            >
              <ExternalLink className="mr-1 size-3.5" />
              Repository
            </Button>
          )}
          {server.glamaUrl && (
            <Button
              variant="link"
              className="h-auto p-0 text-sm text-blue-400"
              onClick={() => void api.openExternal(server.glamaUrl!)}
            >
              <ExternalLink className="mr-1 size-3.5" />
              Glama
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
