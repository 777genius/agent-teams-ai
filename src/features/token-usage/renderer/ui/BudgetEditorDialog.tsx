import { useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/switch';

import {
  budgetTargetKey,
  createBudgetDraft,
  draftErrors,
  newBudgetDraft,
  settingsFromDraft,
} from '../utils/budgetDraft';

import type {
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetSettingsUpdateRequestDto,
  TokenUsageBudgetStatusDto,
} from '../../contracts';
import type { BudgetDraftLimit } from '../utils/budgetDraft';
import type React from 'react';

export type BudgetT = (key: string, options?: Record<string, unknown>) => string;

export const BudgetEditorDialog = ({
  config,
  options,
  selected,
  onClose,
  onSave,
  onReload,
  t,
}: {
  config: TokenUsageBudgetSettingsDto;
  options: TokenUsageBudgetStatusDto['options'];
  selected: string;
  onClose: () => void;
  onSave: (request: TokenUsageBudgetSettingsUpdateRequestDto) => Promise<void>;
  onReload: () => Promise<TokenUsageBudgetSettingsDto | null>;
  t: BudgetT;
}): React.JSX.Element => {
  const [draft, setDraft] = useState(() => createBudgetDraft(config));
  const [basis, setBasis] = useState(() => createBudgetDraft(config));
  const [revision, setRevision] = useState(config.updatedAt ?? null);
  const [dirty, setDirty] = useState(() => new Set<string>());
  const [conflicted, setConflicted] = useState(false);
  const [targetKey, setTargetKey] = useState(selected);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validate, setValidate] = useState(false);
  const [newThreshold, setNewThreshold] = useState('');
  const busy = saving || reloading;
  const value = draft[targetKey] ?? newBudgetDraft();
  const errors = draftErrors(value);
  const markDirty = (): void => setDirty((current) => new Set([...current, targetKey]));
  const update = (patch: Partial<BudgetDraftLimit>): void => {
    markDirty();
    setDraft((current) => ({
      ...current,
      [targetKey]: { ...(current[targetKey] ?? newBudgetDraft()), ...patch },
    }));
  };
  const reload = async (): Promise<void> => {
    if (busy || conflicted) return;
    setReloading(true);
    try {
      const settings = await onReload();
      if (!settings) {
        setError(t('tokenUsage.budgets.loadFailed'));
        return;
      }
      const fresh = createBudgetDraft(settings);
      if ([...dirty].some((key) => JSON.stringify(basis[key]) !== JSON.stringify(fresh[key]))) {
        // A new CAS revision cannot authorize overwriting a concurrently edited scope.
        setConflicted(true);
        setError(t('tokenUsage.budgets.editor.reconciliationRequired'));
        return;
      }
      const rebased = { ...fresh };
      for (const key of dirty) rebased[key] = draft[key] ?? null;
      setDraft(rebased);
      setBasis(fresh);
      setRevision(settings.updatedAt ?? null);
      setError(t('tokenUsage.budgets.editor.compareDraft'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('tokenUsage.budgets.loadFailed'));
    } finally {
      setReloading(false);
    }
  };
  const save = async (): Promise<void> => {
    if (busy || conflicted) return;
    setValidate(true);
    // A selected new scope is added only by editing; viewing it must not erase scopes.
    if (
      Object.values(draft).some(
        (entry) => entry !== null && Object.keys(draftErrors(entry)).length > 0
      )
    ) {
      setError(t('tokenUsage.budgets.editor.invalidDraft'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ settings: settingsFromDraft(draft), expectedUpdatedAt: revision });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('tokenUsage.budgets.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        closeDisabled={busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('tokenUsage.budgets.editor.title')}</DialogTitle>
          <DialogDescription>{t('tokenUsage.budgets.editor.description')}</DialogDescription>
        </DialogHeader>
        <Select
          value={targetKey}
          disabled={busy}
          onValueChange={(key) => {
            setTargetKey(key);
            setNewThreshold('');
          }}
        >
          <SelectTrigger aria-label={t('tokenUsage.budgets.editor.scope')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={budgetTargetKey(option)} value={budgetTargetKey(option)}>
                {option.scope === 'global' ? (
                  t('tokenUsage.budgets.allTeams')
                ) : (
                  <>
                    {t(`tokenUsage.budgets.${option.scope}`)} / {option.label}
                  </>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {draft[targetKey] === null && (
          <p className="text-xs text-amber-400">{t('tokenUsage.budgets.editor.deletePending')}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {(['tokens', 'usd'] as const).map((name) => (
            <label key={name} className="space-y-1 text-xs text-text-secondary">
              {t(`tokenUsage.budgets.${name === 'tokens' ? 'tokenLimit' : 'costLimit'}`)}
              <Input
                disabled={busy}
                inputMode="decimal"
                value={value[name]}
                aria-invalid={validate && Boolean(errors[name])}
                onChange={(event) => update({ [name]: event.target.value })}
              />
              {validate && errors[name] && (
                <span role="alert" className="text-red-400">
                  {t(`tokenUsage.budgets.editor.${errors[name]}`)}
                </span>
              )}
            </label>
          ))}
        </div>
        <label className="flex items-center justify-between gap-3 text-sm text-text-secondary">
          {t('tokenUsage.budgets.editor.notifications')}
          <Switch
            disabled={busy}
            checked={value.notificationsEnabled}
            onCheckedChange={(checked) => update({ notificationsEnabled: checked })}
          />
        </label>
        <div className="space-y-2">
          <div className="text-xs text-text-secondary">
            {t('tokenUsage.budgets.editor.thresholds')}
          </div>
          <div className="flex flex-wrap gap-2">
            {value.thresholds.map((threshold, index) => (
              <div
                key={index}
                className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1"
              >
                <Input
                  disabled={busy}
                  className="h-7 w-12 border-0 px-1 text-xs"
                  inputMode="numeric"
                  aria-label={t('tokenUsage.budgets.editor.threshold', { index: index + 1 })}
                  value={threshold}
                  onChange={(event) =>
                    update({
                      thresholds: value.thresholds.map((item, position) =>
                        position === index ? event.target.value : item
                      ),
                    })
                  }
                />
                <span className="text-xs text-text-muted">%</span>
                <Button
                  disabled={busy}
                  variant="ghost"
                  size="sm"
                  aria-label={t('tokenUsage.budgets.editor.removeThreshold', { index: index + 1 })}
                  onClick={() =>
                    update({
                      thresholds: value.thresholds.filter((_, position) => position !== index),
                    })
                  }
                >
                  x
                </Button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              disabled={busy || value.thresholds.length >= 10}
              className="w-20"
              inputMode="numeric"
              aria-label={t('tokenUsage.budgets.editor.newThreshold')}
              value={newThreshold}
              onChange={(event) => setNewThreshold(event.target.value)}
            />
            <Button
              disabled={busy || value.thresholds.length >= 10}
              variant="outline"
              onClick={() => {
                update({ thresholds: [...value.thresholds, newThreshold] });
                setNewThreshold('');
                setValidate(true);
              }}
            >
              {t('tokenUsage.budgets.editor.addThreshold')}
            </Button>
          </div>
          {(validate || value.thresholds.length > 10) && errors.thresholds && (
            <p role="alert" className="text-xs text-red-400">
              {t('tokenUsage.budgets.editor.invalidThresholds')}
            </p>
          )}
          {value.thresholds.length === 0 && (
            <p className="text-xs text-text-muted">{t('tokenUsage.budgets.editor.noThresholds')}</p>
          )}
        </div>
        {error && (
          <div role="alert" className="space-y-2 text-xs text-red-400">
            <p>{error}</p>
            <Button
              disabled={busy || conflicted}
              variant="outline"
              onClick={() => {
                void reload();
              }}
            >
              {t('tokenUsage.budgets.editor.reload')}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={busy || !draft[targetKey]}
            onClick={() => {
              markDirty();
              setDraft((current) => ({ ...current, [targetKey]: null }));
            }}
          >
            {t('tokenUsage.budgets.editor.delete')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('tokenUsage.budgets.editor.cancel')}
          </Button>
          <Button
            disabled={busy || conflicted}
            onClick={() => {
              void save();
            }}
          >
            {t(`tokenUsage.budgets.editor.${saving ? 'saving' : 'save'}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
