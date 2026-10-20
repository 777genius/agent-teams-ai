import React, { useCallback, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { SettingRow, SettingsSectionHeader } from '@renderer/components/settings/components';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Network, Plus } from 'lucide-react';

import {
  deleteGatewayProfile,
  listGatewayBindings,
  listGatewayProfiles,
  saveGatewayProfile,
} from '../adapters/gatewayProviderApi';

import type {
  GatewayMemberBindingDto,
  GatewayProfileDto,
} from '@features/gateway-provider/contracts';

interface ProfileFormState {
  id?: string;
  displayName: string;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  initialBaseUrl: string;
  boundCount: number;
}

const emptyForm = (): ProfileFormState => ({
  displayName: '',
  baseUrl: '',
  allowPrivateNetwork: false,
  initialBaseUrl: '',
  boundCount: 0,
});

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings → Gateway providers: CRUD for gateway profiles.
 * There is no separate connection test — the connection is validated when a
 * teammate API key is probed on the team member row (§7.2).
 */
export const GatewayProvidersSettingsSection = (): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const [profiles, setProfiles] = useState<GatewayProfileDto[]>([]);
  const [bindings, setBindings] = useState<GatewayMemberBindingDto[]>([]);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<ProfileFormState | null>(null);
  const [formError, setFormError] = useState('');
  const [formGuidance, setFormGuidance] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextProfiles, nextBindings] = await Promise.all([
        listGatewayProfiles(),
        listGatewayBindings(),
      ]);
      setProfiles(nextProfiles);
      setBindings(nextBindings);
      setLoadError('');
    } catch (error) {
      setLoadError(resolveErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const boundCountByProfileId = new Map<string, number>();
  for (const binding of bindings) {
    boundCountByProfileId.set(
      binding.profileId,
      (boundCountByProfileId.get(binding.profileId) ?? 0) + 1
    );
  }

  const openCreate = (): void => {
    setForm(emptyForm());
    setFormError('');
    setFormGuidance('');
  };

  const openEdit = (profile: GatewayProfileDto): void => {
    setForm({
      id: profile.id,
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      allowPrivateNetwork: profile.allowPrivateNetwork,
      initialBaseUrl: profile.baseUrl,
      boundCount: boundCountByProfileId.get(profile.id) ?? 0,
    });
    setFormError('');
    setFormGuidance('');
  };

  const handleSave = async (): Promise<void> => {
    if (!form) return;
    const displayName = form.displayName.trim();
    const baseUrl = form.baseUrl.trim();
    if (!displayName || !baseUrl) {
      setFormError(t('gatewayProviders.errors.fieldsRequired'));
      return;
    }
    setSaving(true);
    setFormError('');
    setFormGuidance('');
    try {
      await saveGatewayProfile({
        id: form.id,
        displayName,
        baseUrl,
        allowPrivateNetwork: form.allowPrivateNetwork,
      });
      setForm(null);
      await refresh();
    } catch (error) {
      const message = resolveErrorMessage(error);
      setFormError(message);
      const urlChanged = form.initialBaseUrl !== baseUrl;
      if ((form.id && form.boundCount > 0 && urlChanged) || /unbind/i.test(message)) {
        setFormGuidance(t('gatewayProviders.errors.boundUrl'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (profile: GatewayProfileDto): Promise<void> => {
    setLoadError('');
    try {
      await deleteGatewayProfile(profile.id);
      await refresh();
    } catch (error) {
      setLoadError(resolveErrorMessage(error));
    }
  };

  return (
    <div>
      <SettingsSectionHeader title={t('gatewayProviders.title')} icon={<Network className="size-3.5" />} />
      <p className="mb-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {t('gatewayProviders.description')}
      </p>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {t('gatewayProviders.hints.probeIsTest')}
        </p>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={openCreate}>
          <Plus className="size-3.5" />
          {t('gatewayProviders.addProfile')}
        </Button>
      </div>
      {loadError ? (
        <p role="alert" className="mb-2 text-xs text-red-400">
          {loadError}
        </p>
      ) : null}
      <div>
        {profiles.length === 0 && !loadError ? (
          <p className="py-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {t('gatewayProviders.empty')}
          </p>
        ) : null}
        {profiles.map((profile) => (
          <SettingRow
            key={profile.id}
            label={profile.displayName}
            description={`${profile.baseUrl} · ${t('gatewayProviders.boundTeammates', {
              total: boundCountByProfileId.get(profile.id) ?? 0,
            })}${profile.allowPrivateNetwork ? ` · ${t('gatewayProviders.badges.privateNetwork')}` : ''}`}
          >
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => openEdit(profile)}>
                {t('gatewayProviders.actions.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-700 hover:text-red-700 dark:text-red-300"
                onClick={() => void handleDelete(profile)}
              >
                {t('gatewayProviders.actions.delete')}
              </Button>
            </div>
          </SettingRow>
        ))}
      </div>
      <p className="mt-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {t('gatewayProviders.hints.deleteKeepsHistory')}
      </p>
      <Dialog open={form !== null} onOpenChange={(open) => (open ? undefined : setForm(null))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {form?.id
                ? t('gatewayProviders.dialog.editTitle')
                : t('gatewayProviders.dialog.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('gatewayProviders.dialog.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="gateway-profile-name" className="text-xs">
                {t('gatewayProviders.fields.displayName')}
              </Label>
              <Input
                id="gateway-profile-name"
                className="h-8 text-xs"
                value={form?.displayName ?? ''}
                onChange={(event) =>
                  setForm((prev) => (prev ? { ...prev, displayName: event.target.value } : prev))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gateway-profile-url" className="text-xs">
                {t('gatewayProviders.fields.baseUrl')}
              </Label>
              <Input
                id="gateway-profile-url"
                className="h-8 text-xs"
                value={form?.baseUrl ?? ''}
                placeholder="https://gateway.example.com"
                onChange={(event) =>
                  setForm((prev) => (prev ? { ...prev, baseUrl: event.target.value } : prev))
                }
              />
              <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                {t('gatewayProviders.fields.baseUrlHint')}
              </p>
            </div>
            <div className="flex items-start gap-2 rounded-md bg-amber-300/[0.05] px-3 py-2.5 text-xs text-amber-100">
              <Checkbox
                id="gateway-profile-private-network"
                className="mt-0.5"
                checked={form?.allowPrivateNetwork ?? false}
                onCheckedChange={(checked) =>
                  setForm((prev) =>
                    prev ? { ...prev, allowPrivateNetwork: checked === true } : prev
                  )
                }
              />
              <Label htmlFor="gateway-profile-private-network" className="font-normal">
                <span className="block">{t('gatewayProviders.fields.allowPrivateNetwork')}</span>
                <span className="mt-0.5 block text-[11px] text-amber-100/70">
                  {t('gatewayProviders.fields.allowPrivateNetworkHint')}
                </span>
              </Label>
            </div>
            {formError ? (
              <p role="alert" className="text-xs text-red-400">
                {formError}
              </p>
            ) : null}
            {formGuidance ? (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {formGuidance}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setForm(null)} disabled={saving}>
              {t('gatewayProviders.actions.cancel')}
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              {t('gatewayProviders.actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
