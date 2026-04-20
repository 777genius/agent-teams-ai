/**
 * PluginDetailDialog — full detail view for a single plugin with install controls.
 */

import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';
import {
  getCapabilityLabel,
  getInstallationSummaryLabel,
  getPluginOperationKey,
  hasInstallationInScope,
  inferCapabilities,
  normalizeCategory,
} from '@shared/utils/extensionNormalizers';
import { ExternalLink, Loader2, Mail } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { InstallButton } from '../common/InstallButton';
import { InstallCountBadge } from '../common/InstallCountBadge';
import { SourceBadge } from '../common/SourceBadge';

import type { CliInstallationStatus } from '@shared/types';
import type { EnrichedPlugin, InstallScope } from '@shared/types/extensions';

interface PluginDetailDialogProps {
  plugin: EnrichedPlugin | null;
  open: boolean;
  onClose: () => void;
  projectPath: string | null;
  cliStatus?: Pick<
    CliInstallationStatus,
    'installed' | 'authLoggedIn' | 'binaryPath' | 'launchError' | 'flavor' | 'providers'
  > | null;
  cliStatusLoading?: boolean;
}

const SCOPE_OPTIONS: { value: InstallScope; label: string }[] = [
  { value: 'user', label: 'User (global)' },
  { value: 'project', label: 'Project (shared)' },
  { value: 'local', label: 'Local (gitignored)' },
];

export const PluginDetailDialog = ({
  plugin,
  open,
  onClose,
  projectPath,
  cliStatus,
  cliStatusLoading,
}: PluginDetailDialogProps): React.JSX.Element => {
  const { fetchPluginReadme, readmes, readmeLoading, installPlugin, uninstallPlugin } = useStore(
    useShallow((s) => ({
      fetchPluginReadme: s.fetchPluginReadme,
      readmes: s.pluginReadmes,
      readmeLoading: s.pluginReadmeLoading,
      installPlugin: s.installPlugin,
      uninstallPlugin: s.uninstallPlugin,
    }))
  );

  const [scope, setScope] = useState<InstallScope>('user');
  const projectScopeAvailable = Boolean(projectPath);

  useEffect(() => {
    if (plugin && open) {
      fetchPluginReadme(plugin.pluginId);
    }
  }, [plugin, open, fetchPluginReadme]);

  useEffect(() => {
    if (open) {
      setScope('user');
    }
  }, [open, plugin?.pluginId]);

  useEffect(() => {
    if (scope !== 'user' && !projectScopeAvailable) {
      setScope('user');
    }
  }, [projectScopeAvailable, scope]);

  const operationKey = plugin
    ? getPluginOperationKey(plugin.pluginId, scope, scope !== 'user' ? projectPath : undefined)
    : null;
  const installProgress = useStore(
    (s) => (operationKey ? s.pluginInstallProgress[operationKey] : undefined) ?? 'idle'
  );
  const installError = useStore((s) => (operationKey ? s.installErrors[operationKey] : undefined));

  if (!plugin) return <></>;

  const capabilities = inferCapabilities(plugin);
  const category = normalizeCategory(plugin.category);
  const readme = readmes[plugin.pluginId];
  const isReadmeLoading = readmeLoading[plugin.pluginId] ?? false;
  const isInstalledForScope = hasInstallationInScope(plugin.installations, scope);
  const installSummaryLabel = getInstallationSummaryLabel(plugin.installations);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="truncate">{plugin.name}</DialogTitle>
              <DialogDescription className="mt-1">{plugin.description}</DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {installSummaryLabel && (
                <Badge
                  className="shrink-0 border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  variant="outline"
                >
                  {installSummaryLabel}
                </Badge>
              )}
              <SourceBadge source={plugin.source} />
            </div>
          </div>
        </DialogHeader>

        {/* Metadata grid */}
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <span className="text-text-muted">Author</span>
            <p className="text-text">{plugin.author?.name ?? 'Unknown'}</p>
          </div>
          <div>
            <span className="text-text-muted">Category</span>
            <p className="capitalize text-text">{category}</p>
          </div>
          <div>
            <span className="text-text-muted">Source</span>
            <p className="capitalize text-text">{plugin.source}</p>
          </div>
          {plugin.version && (
            <div>
              <span className="text-text-muted">Version</span>
              <p className="text-text">{plugin.version}</p>
            </div>
          )}
          <div>
            <span className="text-text-muted">Capabilities</span>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {capabilities.map((cap) => (
                <Badge
                  key={cap}
                  variant="outline"
                  className="border-purple-500/30 bg-purple-500/10 text-purple-400"
                >
                  {getCapabilityLabel(cap)}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <span className="text-text-muted">Installs</span>
            <div className="mt-0.5">
              <InstallCountBadge count={plugin.installCount} />
            </div>
          </div>
        </div>

        {/* Install controls */}
        <div className="flex items-center gap-3 rounded-md border border-border bg-surface-raised px-4 py-3">
          <div className="flex flex-1 items-center gap-2">
            <Label className="text-xs text-text-muted">Scope:</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as InstallScope)}>
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    disabled={opt.value !== 'user' && !projectScopeAvailable}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <InstallButton
            state={installProgress}
            isInstalled={isInstalledForScope}
            section="plugins"
            cliStatus={cliStatus}
            cliStatusLoading={cliStatusLoading}
            onInstall={() =>
              installPlugin({
                pluginId: plugin.pluginId,
                scope,
                ...(scope !== 'user' && projectPath ? { projectPath } : {}),
              })
            }
            onUninstall={() =>
              uninstallPlugin(
                plugin.pluginId,
                scope,
                scope !== 'user' ? (projectPath ?? undefined) : undefined
              )
            }
            size="default"
            errorMessage={installError}
          />
        </div>

        {/* Links */}
        <div className="flex items-center gap-4">
          {plugin.homepage && (
            <Button
              variant="link"
              className="h-auto justify-start p-0 text-sm text-blue-400"
              onClick={() => void api.openExternal(plugin.homepage!)}
            >
              <ExternalLink className="mr-1 size-3.5" />
              Homepage
            </Button>
          )}
          {plugin.author?.email && (
            <Button
              variant="link"
              className="h-auto justify-start p-0 text-sm text-blue-400"
              onClick={() => void api.openExternal(`mailto:${plugin.author!.email}`)}
            >
              <Mail className="mr-1 size-3.5" />
              Contact
            </Button>
          )}
        </div>

        {/* README */}
        <div className="mt-2 max-h-80 overflow-y-auto rounded-md border border-border bg-surface-raised p-4">
          {isReadmeLoading && (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 className="size-4 animate-spin" />
              Loading README...
            </div>
          )}
          {!isReadmeLoading && readme && (
            <MarkdownViewer content={readme} bare maxHeight="max-h-none" />
          )}
          {!isReadmeLoading && !readme && (
            <p className="text-sm text-text-muted">No README available.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
