/**
 * McpServerDetailDialog — full detail view for a single MCP server with install controls.
 * Uses Radix UI Kit for all form elements.
 */

import { useEffect, useState } from 'react';

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
import { ExternalLink, Lock, Plus, Star, Trash2, Wrench } from 'lucide-react';

import { InstallButton } from '../common/InstallButton';
import { SourceBadge } from '../common/SourceBadge';
import { sanitizeMcpServerName } from '@shared/utils/extensionNormalizers';

import type { McpCatalogItem, McpHeaderDef, McpServerDiagnostic } from '@shared/types/extensions';

interface McpServerDetailDialogProps {
  server: McpCatalogItem | null;
  isInstalled: boolean;
  diagnostic?: McpServerDiagnostic | null;
  diagnosticsLoading?: boolean;
  open: boolean;
  onClose: () => void;
}

type Scope = 'local' | 'user';

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: 'user', label: 'User (global)' },
  { value: 'local', label: 'Local' },
];

export const McpServerDetailDialog = ({
  server,
  isInstalled,
  diagnostic,
  diagnosticsLoading,
  open,
  onClose,
}: McpServerDetailDialogProps): React.JSX.Element => {
  const installProgress = useStore(
    (s) => (server ? s.mcpInstallProgress[server.id] : undefined) ?? 'idle'
  );
  const installMcpServer = useStore((s) => s.installMcpServer);
  const uninstallMcpServer = useStore((s) => s.uninstallMcpServer);
  const installError = useStore((s) => (server ? s.installErrors[server.id] : undefined));
  const stars = useStore((s) =>
    server?.repositoryUrl ? s.mcpGitHubStars[server.repositoryUrl] : undefined
  );

  const [scope, setScope] = useState<Scope>('user');
  const [serverName, setServerName] = useState('');
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<McpHeaderDef[]>([]);
  const [imgError, setImgError] = useState(false);
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());

  // Initialize form when dialog opens or server changes
  useEffect(() => {
    if (!server || !open) {
      return;
    }

    setServerName(sanitizeMcpServerName(server.name));
    setEnvValues(Object.fromEntries(server.envVars.map((env) => [env.name, ''])));
    setHeaders(
      (server.authHeaders ?? []).map((header) => ({
        key: header.key,
        value: '',
        secret: header.isSecret,
        description: header.description,
        isRequired: header.isRequired,
        valueTemplate: header.valueTemplate,
        locked: true,
      }))
    );
    setScope('user');
    setImgError(false);
    setAutoFilledFields(new Set());
  }, [server?.id, open]);

  // Auto-fill env values from saved API keys
  useEffect(() => {
    if (!server || !open || server.envVars.length === 0 || !api.apiKeys) return;

    const envVarNames = server.envVars.map((e) => e.name);
    void api.apiKeys.lookup(envVarNames).then(
      (results) => {
        if (results.length === 0) return;
        const filled = new Set<string>();
        const values: Record<string, string> = {};
        for (const r of results) {
          values[r.envVarName] = r.value;
          filled.add(r.envVarName);
        }
        setEnvValues((prev) => ({ ...prev, ...values }));
        setAutoFilledFields(filled);
      },
      () => {
        // Silently fail — auto-fill is supplementary
      }
    );
  }, [server?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fill env vars from saved API keys
  useEffect(() => {
    if (!server || server.envVars.length === 0 || !api.apiKeys) return;

    const envVarNames = server.envVars.map((env) => env.name);
    void api.apiKeys.lookup(envVarNames).then(
      (results) => {
        if (results.length === 0) return;
        const filled = new Set<string>();
        const updates: Record<string, string> = {};
        for (const r of results) {
          updates[r.envVarName] = r.value;
          filled.add(r.envVarName);
        }
        setEnvValues((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(updates)) {
            // Only auto-fill if the field is empty
            if (!next[k]) {
              next[k] = v;
            }
          }
          return next;
        });
        setAutoFilledFields(filled);
      },
      () => {
        // Silently ignore lookup failures
      }
    );
  }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!server) return <></>;

  const canAutoInstall = !!server.installSpec;
  const isHttp = server.installSpec?.type === 'http';
  const hasIcon = !!server.iconUrl && !imgError;
  const npmPackageUrl =
    server.installSpec?.type === 'stdio'
      ? `https://www.npmjs.com/package/${server.installSpec.npmPackage}`
      : null;
  const hasSuggestedHeaders = headers.some((header) => header.locked);
  const missingRequiredEnvVars = server.envVars.some(
    (env) => env.isRequired && !envValues[env.name]?.trim()
  );
  const missingRequiredHeaders = headers.some(
    (header) => header.isRequired && !header.value.trim()
  );
  const installDisabled = !serverName.trim() || missingRequiredEnvVars || missingRequiredHeaders;
  const diagnosticBadgeClass =
    diagnostic?.status === 'connected'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : diagnostic?.status === 'needs-authentication'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : diagnostic?.status === 'failed'
          ? 'border-red-500/30 bg-red-500/10 text-red-400'
          : 'border-border bg-surface-raised text-text-muted';

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
            {/* Server icon (only when available) */}
            {hasIcon && (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised">
                <img
                  src={server.iconUrl!}
                  alt=""
                  className="size-8 rounded object-contain"
                  onError={() => setImgError(true)}
                />
              </div>
            )}
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
                  {server.source !== 'official' && <SourceBadge source={server.source} />}
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
          {stars != null && (
            <div>
              <span className="text-text-muted">GitHub Stars</span>
              <p className="flex items-center gap-1 text-text">
                <Star className="size-3.5 fill-amber-400 text-amber-400" />
                {stars.toLocaleString()}
              </p>
            </div>
          )}
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
            {server.installSpec?.type === 'stdio' ? (
              <Button
                variant="link"
                className="h-auto p-0 text-sm text-blue-400"
                onClick={() => void api.openExternal(npmPackageUrl!)}
              >
                npm: {server.installSpec.npmPackage}
              </Button>
            ) : (
              <p className="text-text">
                {server.installSpec
                  ? `HTTP: ${server.installSpec.transportType}`
                  : 'Manual setup required'}
              </p>
            )}
          </div>
          {server.author && (
            <div>
              <span className="text-text-muted">Author</span>
              <p className="text-text">{server.author}</p>
            </div>
          )}
          {server.hostingType && (
            <div>
              <span className="text-text-muted">Hosting</span>
              <p className="capitalize text-text">{server.hostingType}</p>
            </div>
          )}
          {server.publishedAt && (
            <div>
              <span className="text-text-muted">Published</span>
              <p className="text-text">{new Date(server.publishedAt).toLocaleDateString()}</p>
            </div>
          )}
          {server.updatedAt && (
            <div>
              <span className="text-text-muted">Updated</span>
              <p className="text-text">{new Date(server.updatedAt).toLocaleDateString()}</p>
            </div>
          )}
        </div>

        {/* Auth indicator */}
        {server.requiresAuth && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400">
            <Lock className="size-4" />
            This server requires authentication
          </div>
        )}
        {isHttp && !server.requiresAuth && (server.authHeaders?.length ?? 0) === 0 && (
          <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-sm text-blue-400">
            Remote MCP servers may still require custom headers or API keys even when the registry
            does not describe them. If connection fails after install, check the provider docs.
          </div>
        )}
        {(isInstalled || diagnosticsLoading) && (
          <div className="space-y-2 rounded-md border border-border bg-surface-raised px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-text">Claude Status</span>
              {diagnosticsLoading && !diagnostic ? (
                <Badge
                  className="border-border bg-surface-raised text-text-muted"
                  variant="outline"
                >
                  Checking...
                </Badge>
              ) : diagnostic ? (
                <Badge className={diagnosticBadgeClass} variant="outline">
                  {diagnostic.statusLabel}
                </Badge>
              ) : (
                <Badge
                  className="border-border bg-surface-raised text-text-muted"
                  variant="outline"
                >
                  Not checked
                </Badge>
              )}
            </div>
            {diagnostic?.target && (
              <div>
                <p className="mb-1 text-xs text-text-muted">Launch Target</p>
                <code className="block overflow-x-auto rounded bg-surface px-2 py-1 text-xs text-text">
                  {diagnostic.target}
                </code>
              </div>
            )}
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
                      {autoFilledFields.has(env.name) && envValues[env.name] && (
                        <span className="shrink-0 text-[10px] text-emerald-400">Auto-filled</span>
                      )}
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
                    {hasSuggestedHeaders ? 'Add custom' : 'Add'}
                  </Button>
                </div>
                {headers.length > 0 && (
                  <div className="space-y-2">
                    {headers.map((header, index) => (
                      <div key={index} className="space-y-1">
                        <div className="flex items-center gap-2">
                          {header.locked ? (
                            <code className="w-32 shrink-0 truncate text-xs text-blue-400">
                              {header.key}
                            </code>
                          ) : (
                            <Input
                              value={header.key}
                              onChange={(e) => updateHeader(index, 'key', e.target.value)}
                              className="h-7 w-32 text-xs"
                              placeholder="Header-Name"
                            />
                          )}
                          <Input
                            type={header.secret ? 'password' : 'text'}
                            value={header.value}
                            onChange={(e) => updateHeader(index, 'value', e.target.value)}
                            className="h-7 flex-1 text-xs"
                            placeholder={header.valueTemplate ?? header.description ?? 'value'}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-red-400 hover:bg-red-500/10"
                            onClick={() => removeHeader(index)}
                            disabled={header.locked && header.isRequired}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                        {(header.description || header.valueTemplate || header.isRequired) && (
                          <p className="text-[10px] text-text-muted">
                            {[
                              header.isRequired ? 'Required' : null,
                              header.description,
                              header.valueTemplate,
                            ]
                              .filter(Boolean)
                              .join(' • ')}
                          </p>
                        )}
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
                disabled={installDisabled}
                size="default"
                errorMessage={installError}
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
          {server.websiteUrl && (
            <Button
              variant="link"
              className="h-auto p-0 text-sm text-blue-400"
              onClick={() => void api.openExternal(server.websiteUrl!)}
            >
              <ExternalLink className="mr-1 size-3.5" />
              Website
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
