/**
 * ApiKeyFormDialog — create or edit an API key entry.
 * Edit mode pre-fills all fields except the value (which must be re-entered).
 */

import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
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
  currentProjectPath: string | null;
  currentProjectLabel: string | null;
  onClose: () => void;
}

type Scope = 'user' | 'project';

export const ApiKeyFormDialog = ({
  open,
  editingKey,
  currentProjectPath,
  currentProjectLabel,
  onClose,
}: ApiKeyFormDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('extensions');
  const saveApiKey = useStore((s) => s.saveApiKey);
  const apiKeySaving = useStore((s) => s.apiKeySaving);
  const storageStatus = useStore((s) => s.apiKeyStorageStatus);

  const [name, setName] = useState('');
  const [envVarName, setEnvVarName] = useState('');
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<Scope>('user');
  const [error, setError] = useState<string | null>(null);
  const [envVarError, setEnvVarError] = useState<string | null>(null);
  const editingProjectPath =
    editingKey?.scope === 'project' ? (editingKey.projectPath ?? null) : null;
  const effectiveProjectPath = editingProjectPath ?? currentProjectPath;
  const effectiveProjectLabel =
    effectiveProjectPath && effectiveProjectPath === currentProjectPath
      ? currentProjectLabel
      : effectiveProjectPath;
  const canUseProjectScope = Boolean(effectiveProjectPath);

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

  useEffect(() => {
    if (open && scope === 'project' && !canUseProjectScope) {
      setScope('user');
    }
  }, [canUseProjectScope, open, scope]);

  const validateEnvVar = (v: string) => {
    if (!v.trim()) {
      setEnvVarError(null);
      return;
    }
    if (!ENV_KEY_RE.test(v)) {
      setEnvVarError(t('apiKeys.form.errors.invalidEnvVarFormat'));
    } else {
      setEnvVarError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError(t('apiKeys.form.errors.nameRequired'));
      return;
    }
    if (!envVarName.trim()) {
      setError(t('apiKeys.form.errors.envVarRequired'));
      return;
    }
    if (!ENV_KEY_RE.test(envVarName)) {
      setError(t('apiKeys.form.errors.invalidEnvVar'));
      return;
    }
    if (!value) {
      setError(t('apiKeys.form.errors.valueRequired'));
      return;
    }
    if (scope === 'project' && !effectiveProjectPath) {
      setError(t('apiKeys.form.errors.projectScopeRequiresProject'));
      return;
    }

    try {
      await saveApiKey({
        id: editingKey?.id,
        name: name.trim(),
        envVarName: envVarName.trim(),
        value,
        scope,
        projectPath: scope === 'project' ? (effectiveProjectPath ?? undefined) : undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('apiKeys.form.errors.saveFailed'));
    }
  };

  const isEdit = editingKey !== null;
  const canSubmit =
    name.trim() &&
    envVarName.trim() &&
    value &&
    !envVarError &&
    !apiKeySaving &&
    (scope !== 'project' || canUseProjectScope);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface-raised">
              <Key className="size-4 text-text-muted" />
            </div>
            <div>
              <DialogTitle>
                {isEdit ? t('apiKeys.form.editTitle') : t('apiKeys.form.addTitle')}
              </DialogTitle>
              <DialogDescription>
                {isEdit ? t('apiKeys.form.editDescription') : t('apiKeys.form.addDescription')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {storageStatus && storageStatus.encryptionMethod !== 'os-keychain' && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle className="size-3.5 shrink-0" />
            {t('apiKeys.form.keychainUnavailable')}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="apikey-name" className="text-xs">
              {t('apiKeys.form.name')}
            </Label>
            <Input
              id="apikey-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('apiKeys.form.namePlaceholder')}
              className="h-8 text-sm"
              autoFocus
            />
          </div>

          {/* Env var name */}
          <div className="space-y-1.5">
            <Label htmlFor="apikey-envvar" className="text-xs">
              {t('apiKeys.form.environmentVariableName')}
            </Label>
            <Input
              id="apikey-envvar"
              value={envVarName}
              onChange={(e) => {
                setEnvVarName(e.target.value);
                validateEnvVar(e.target.value);
              }}
              placeholder={t('apiKeys.form.envVarPlaceholder')}
              className={`h-8 font-mono text-sm ${envVarError ? 'border-red-500/50' : ''}`}
            />
            {envVarError && <p className="text-xs text-red-400">{envVarError}</p>}
          </div>

          {/* Value */}
          <div className="space-y-1.5">
            <Label htmlFor="apikey-value" className="text-xs">
              {t('apiKeys.form.value')}
            </Label>
            <Input
              id="apikey-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                isEdit ? t('apiKeys.form.reenterValue') : t('apiKeys.form.valuePlaceholder')
              }
              className="h-8 text-sm"
            />
          </div>

          {/* Scope */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('apiKeys.form.scope')}</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['user', 'project'] as const).map((scopeOption) => (
                  <SelectItem
                    key={scopeOption}
                    value={scopeOption}
                    disabled={scopeOption === 'project' && !canUseProjectScope}
                  >
                    {scopeOption === 'project'
                      ? effectiveProjectPath
                        ? t('apiKeys.form.projectScopeLabel', { project: effectiveProjectLabel })
                        : t('apiKeys.form.projectUnavailable')
                      : t('apiKeys.form.userScopeLabel')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {scope === 'project' && effectiveProjectPath && (
              <p className="text-xs text-text-muted">
                {t('apiKeys.form.boundTo', { path: effectiveProjectPath })}
              </p>
            )}
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
              {t('apiKeys.form.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {apiKeySaving
                ? t('apiKeys.form.saving')
                : isEdit
                  ? t('apiKeys.form.update')
                  : t('apiKeys.form.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
