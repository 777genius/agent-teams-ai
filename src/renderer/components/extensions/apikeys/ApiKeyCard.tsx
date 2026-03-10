/**
 * ApiKeyCard — displays a single API key entry with edit/delete controls.
 */

import { useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { Copy, Check, Pencil, Trash2 } from 'lucide-react';

import type { ApiKeyEntry } from '@shared/types/extensions';

interface ApiKeyCardProps {
  apiKey: ApiKeyEntry;
  onEdit: (key: ApiKeyEntry) => void;
}

export const ApiKeyCard = ({ apiKey, onEdit }: ApiKeyCardProps): React.JSX.Element => {
  const deleteApiKey = useStore((s) => s.deleteApiKey);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleCopyEnvVar = async () => {
    await navigator.clipboard.writeText(apiKey.envVarName);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    void deleteApiKey(apiKey.id);
    setConfirmDelete(false);
  };

  const createdDate = new Date(apiKey.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-emphasis">
      {/* Name + scope badge */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate text-sm font-medium text-text">{apiKey.name}</h3>
        <Badge
          variant="outline"
          className={
            apiKey.scope === 'user'
              ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
              : 'border-purple-500/30 bg-purple-500/10 text-purple-400'
          }
        >
          {apiKey.scope}
        </Badge>
      </div>

      {/* Env var name */}
      <div className="flex items-center gap-1.5">
        <code className="rounded bg-surface-raised px-1.5 py-0.5 text-xs text-blue-400">
          {apiKey.envVarName}
        </code>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                onClick={() => void handleCopyEnvVar()}
              >
                {copied ? (
                  <Check className="size-3 text-emerald-400" />
                ) : (
                  <Copy className="size-3 text-text-muted" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? 'Copied!' : 'Copy env var name'}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Masked value */}
      <p className="font-mono text-xs text-text-muted">{apiKey.maskedValue}</p>

      {/* Footer: date + actions */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-text-muted">{createdDate}</span>
        <div className="flex items-center gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => onEdit(apiKey)}
                >
                  <Pencil className="size-3.5 text-text-muted" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`size-7 ${confirmDelete ? 'text-red-400 hover:bg-red-500/10' : 'text-text-muted'}`}
                  onClick={handleDelete}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{confirmDelete ? 'Click again to confirm' : 'Delete'}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
};
