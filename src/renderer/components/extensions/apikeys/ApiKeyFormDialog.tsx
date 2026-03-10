/**
 * ApiKeyFormDialog — create or edit an API key entry.
 * Edit mode pre-fills all fields except the value (which must be re-entered).
 */

import { useEffect, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
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
import { AlertTriangle, Key } from 'lucide-react';

import type { ApiKeyEntry } from '@shared/types/extensions';

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,100}$/i;

interface ApiKeyFormDialogProps {
  open: boolean;
  editingKey: ApiKeyEntry | null;
  onClose: () => void;
}

type Scope = 'user' | 'project';

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: 'user', label: 'User (global)' },
  { value: 'project', label: 'Project' },
];

export const ApiKeyFormDialog = ({
  open,
  editingKey,
  onClose,
}: ApiKeyFormDialogProps): React.JSX.Element => {
  const saveApiKey = useStore((s) => s.saveApiKey);
  const apiKeySaving = useStore((s) => s.apiKeySaving);
  const storageStatus = useStore((s) => s.apiKeyStorageStatus);

  const [name, setName] = useState('');
  const [envVarName, setEnvVarName] = useState('');
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<Scope>('user');
  const [error, setError] = useState<string | null>(null);
  const [envVarError, setEnvVarError] = useState<string | null>(null);

  // Reset form when dialog opens/closes or editing key changes
  useEffect(() => {
    if (open) {
      if (editingKey) {
        setName(editingKey.name);
        setEnvVarName(editingKey.envVarName);
        setScope(editingKey.scope);
        setValue('');
      } else {
        setName('');
        setEnvVarName('');
        setValue('');
        setScope('user');
      }
      setError(null);
      setEnvVarError(null);
    }
  }, [open, editingKey]);

  const validateEnvVar = (v: string) => {
    if (!v.trim()) {
      setEnvVarError(null);
      return;
    }
    if (!ENV_KEY_RE.test(v)) {
      setEnvVarError('Use letters, digits, underscores. Must start with a letter or underscore.');
    } else {
      setEnvVarError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!envVarName.trim()) {
      setError('Environment variable name is required');
      return;
    }
    if (!ENV_KEY_RE.test(envVarName)) {
      setError('Invalid environment variable name');
      return;
    }
    if (!value) {
      setError('Key value is required');
      return;
    }

    try {
      await saveApiKey({
        id: editingKey?.id,
        name: name.trim(),
        envVarName: envVarName.trim(),
        value,
        scope,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const isEdit = editingKey !== null;
  const canSubmit = name.trim() && envVarName.trim() && value && !envVarError && !apiKeySaving;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface-raised">
              <Key className="size-4 text-text-muted" />
            </div>
            <div>
              <DialogTitle>{isEdit ? 'Edit API Key' : 'Add API Key'}</DialogTitle>
              <DialogDescription>
                {isEdit
                  ? 'Update the key details. You must re-enter the value.'
                  : 'Store an API key for auto-filling in MCP server installations.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {storageStatus && storageStatus.encryptionMethod !== 'os-keychain' && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle className="size-3.5 shrink-0" />
            OS keychain unavailable — keys encrypted with AES-256 locally. Install gnome-keyring for
            OS-level protection.
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="apikey-name" className="text-xs">
              Name
            </Label>
            <Input
              id="apikey-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. OpenAI Production"
              className="h-8 text-sm"
              autoFocus
            />
          </div>

          {/* Env var name */}
          <div className="space-y-1.5">
            <Label htmlFor="apikey-envvar" className="text-xs">
              Environment Variable Name
            </Label>
            <Input
              id="apikey-envvar"
              value={envVarName}
              onChange={(e) => {
                setEnvVarName(e.target.value);
                validateEnvVar(e.target.value);
              }}
              placeholder="e.g. OPENAI_API_KEY"
              className={`h-8 font-mono text-sm ${envVarError ? 'border-red-500/50' : ''}`}
            />
            {envVarError && <p className="text-xs text-red-400">{envVarError}</p>}
          </div>

          {/* Value */}
          <div className="space-y-1.5">
            <Label htmlFor="apikey-value" className="text-xs">
              Value
            </Label>
            <Input
              id="apikey-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={isEdit ? 'Re-enter key value' : 'sk-...'}
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

          {/* Error display */}
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {apiKeySaving ? 'Saving...' : isEdit ? 'Update' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
