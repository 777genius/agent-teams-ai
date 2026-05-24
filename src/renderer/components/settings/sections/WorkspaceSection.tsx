/**
 * WorkspaceSection - Settings section for managing saved SSH connection profiles.
 *
 * Provides CRUD UI for:
 * - Listing saved SSH profiles
 * - Adding new profiles (name, host, port, username, auth method)
 * - Inline editing existing profile fields
 * - Deleting profiles with confirmation
 *
 * Profile changes persist via ConfigManager and trigger context list refresh.
 */

import { useCallback, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { Edit2, Loader2, Plus, Save, Server, Trash2, X } from 'lucide-react';

import { SettingsSectionHeader } from '../components/SettingsSectionHeader';
import { SettingsSelect } from '../components/SettingsSelect';

import type { SshAuthMethod, SshConnectionProfile } from '@shared/types';

const inputClass = 'w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-1';
const inputStyle = {
  backgroundColor: 'var(--color-surface-raised)',
  borderColor: 'var(--color-border)',
  color: 'var(--color-text)',
};

const authMethodOptionValues: readonly SshAuthMethod[] = [
  'auto',
  'agent',
  'privateKey',
  'password',
];
const authMethodLabelKeys = {
  agent: 'workspaceProfiles.authMethods.agent',
  auto: 'workspaceProfiles.authMethods.auto',
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- SSH auth method label key, not a credential.
  password: 'workspaceProfiles.authMethods.password',
  privateKey: 'workspaceProfiles.authMethods.privateKey',
} as const satisfies Record<SshAuthMethod, string>;

const defaultForm = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'auto' as SshAuthMethod,
  privateKeyPath: '',
};

export const WorkspaceSection = (): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const [profiles, setProfiles] = useState<SshConnectionProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const authMethodOptions = authMethodOptionValues.map((value) => ({
    value,
    label: t(authMethodLabelKeys[value]),
  }));

  // Form state
  const [formName, setFormName] = useState(defaultForm.name);
  const [formHost, setFormHost] = useState(defaultForm.host);
  const [formPort, setFormPort] = useState(defaultForm.port);
  const [formUsername, setFormUsername] = useState(defaultForm.username);
  const [formAuthMethod, setFormAuthMethod] = useState<SshAuthMethod>(defaultForm.authMethod);
  const [formPrivateKeyPath, setFormPrivateKeyPath] = useState(defaultForm.privateKeyPath);

  const resetForm = useCallback(() => {
    setFormName(defaultForm.name);
    setFormHost(defaultForm.host);
    setFormPort(defaultForm.port);
    setFormUsername(defaultForm.username);
    setFormAuthMethod(defaultForm.authMethod);
    setFormPrivateKeyPath(defaultForm.privateKeyPath);
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const config = await api.config.get();
      // AppConfig type doesn't include ssh field, but ConfigManager returns it at runtime
      const loaded = config.ssh;
      setProfiles(loaded?.profiles ?? []);
    } catch (error) {
      console.error('[WorkspaceSection] Failed to load profiles:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // Populate form when editing starts
  useEffect(() => {
    if (editingId) {
      const profile = profiles.find((p) => p.id === editingId);
      if (profile) {
        setFormName(profile.name);
        setFormHost(profile.host);
        setFormPort(String(profile.port));
        setFormUsername(profile.username);
        setFormAuthMethod(profile.authMethod);
        setFormPrivateKeyPath(profile.privateKeyPath ?? '');
      }
    }
  }, [editingId, profiles]);

  const handleAdd = async (): Promise<void> => {
    const newProfile: SshConnectionProfile = {
      id: crypto.randomUUID(),
      name: formName.trim(),
      host: formHost.trim(),
      port: parseInt(formPort, 10) || 22,
      username: formUsername.trim(),
      authMethod: formAuthMethod,
      privateKeyPath: formAuthMethod === 'privateKey' ? formPrivateKeyPath.trim() : undefined,
    };

    await api.config.update('ssh', { profiles: [...profiles, newProfile] });
    await loadProfiles();
    resetForm();
    setShowAddForm(false);
    void useStore.getState().fetchAvailableContexts();
  };

  const handleEdit = async (): Promise<void> => {
    const updatedProfiles = profiles.map((p) =>
      p.id === editingId
        ? {
            ...p,
            name: formName.trim(),
            host: formHost.trim(),
            port: parseInt(formPort, 10) || 22,
            username: formUsername.trim(),
            authMethod: formAuthMethod,
            privateKeyPath: formAuthMethod === 'privateKey' ? formPrivateKeyPath.trim() : undefined,
          }
        : p
    );

    await api.config.update('ssh', { profiles: updatedProfiles });
    await loadProfiles();
    setEditingId(null);
    resetForm();
    void useStore.getState().fetchAvailableContexts();
  };

  const handleDelete = async (id: string): Promise<void> => {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;

    const confirmed = await confirm({
      title: t('workspaceProfiles.deleteConfirm.title'),
      message: t('workspaceProfiles.deleteConfirm.message', { name: profile.name }),
      confirmLabel: t('workspaceProfiles.deleteConfirm.confirmLabel'),
      variant: 'danger',
    });
    if (!confirmed) return;

    const filtered = profiles.filter((p) => p.id !== id);
    await api.config.update('ssh', { profiles: filtered });
    await loadProfiles();
    void useStore.getState().fetchAvailableContexts();
  };

  const isFormValid =
    formName.trim() !== '' && formHost.trim() !== '' && formUsername.trim() !== '';

  const renderForm = (onSave: () => Promise<void>, onCancel: () => void): React.JSX.Element => (
    <div
      className="space-y-3 rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-surface-raised)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="ws-profile-name"
            className="mb-1 block text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {t('workspaceProfiles.form.name')}
          </label>
          <input
            id="ws-profile-name"
            type="text"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder={t('workspaceProfiles.form.namePlaceholder')}
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div>
          <label
            htmlFor="ws-profile-host"
            className="mb-1 block text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {t('workspaceProfiles.form.host')}
          </label>
          <input
            id="ws-profile-host"
            type="text"
            value={formHost}
            onChange={(e) => setFormHost(e.target.value)}
            placeholder={t('workspaceProfiles.form.hostPlaceholder')}
            className={inputClass}
            style={inputStyle}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="ws-profile-port"
            className="mb-1 block text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {t('workspaceProfiles.form.port')}
          </label>
          <input
            id="ws-profile-port"
            type="text"
            value={formPort}
            onChange={(e) => setFormPort(e.target.value)}
            placeholder="22"
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div>
          <label
            htmlFor="ws-profile-username"
            className="mb-1 block text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {t('workspaceProfiles.form.username')}
          </label>
          <input
            id="ws-profile-username"
            type="text"
            value={formUsername}
            onChange={(e) => setFormUsername(e.target.value)}
            placeholder={t('workspaceProfiles.form.usernamePlaceholder')}
            className={inputClass}
            style={inputStyle}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {t('workspaceProfiles.form.authentication')}
        </label>
        <SettingsSelect
          value={formAuthMethod}
          options={authMethodOptions}
          onChange={setFormAuthMethod}
          fullWidth
        />
      </div>

      {formAuthMethod === 'privateKey' && (
        <div>
          <label
            htmlFor="ws-profile-private-key-path"
            className="mb-1 block text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {t('workspaceProfiles.form.privateKeyPath')}
          </label>
          <input
            id="ws-profile-private-key-path"
            type="text"
            value={formPrivateKeyPath}
            onChange={(e) => setFormPrivateKeyPath(e.target.value)}
            placeholder="~/.ssh/id_rsa"
            className={inputClass}
            style={inputStyle}
          />
        </div>
      )}

      {formAuthMethod === 'password' && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {t('workspaceProfiles.form.passwordPrompt')}
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => void onSave()}
          disabled={!isFormValid}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
          style={{
            backgroundColor: 'var(--color-surface-raised)',
            color: 'var(--color-text)',
          }}
        >
          <Save className="size-3.5" />
          {t('workspaceProfiles.actions.save')}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--color-text-muted)',
          }}
        >
          <X className="size-3.5" />
          {t('workspaceProfiles.actions.cancel')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t('workspaceProfiles.title')} />
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        {t('workspaceProfiles.description')}
      </p>

      {loading && (
        <div className="flex items-center gap-2 py-4" style={{ color: 'var(--color-text-muted)' }}>
          <Loader2 className="size-4 animate-spin" />
          <span className="text-sm">{t('workspaceProfiles.loading')}</span>
        </div>
      )}

      {!loading && profiles.length === 0 && !showAddForm && (
        <div
          className="rounded-md border py-8 text-center"
          style={{
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-muted)',
          }}
        >
          <Server className="mx-auto mb-2 size-8 opacity-40" />
          <p className="text-sm">{t('workspaceProfiles.empty.title')}</p>
          <p className="mt-1 text-xs">{t('workspaceProfiles.empty.description')}</p>
        </div>
      )}

      {!loading && (
        <div className="space-y-3">
          {profiles.map((profile) =>
            editingId === profile.id ? (
              <div key={profile.id}>
                {renderForm(handleEdit, () => {
                  setEditingId(null);
                  resetForm();
                })}
              </div>
            ) : (
              <div
                key={profile.id}
                className="flex items-center gap-3 rounded-md border p-4"
                style={{
                  backgroundColor: 'var(--color-surface-raised)',
                  borderColor: 'var(--color-border)',
                }}
              >
                <Server className="size-4 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium"
                    style={{ color: 'var(--color-text)' }}
                  >
                    {profile.name}
                  </p>
                  <p className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {profile.username}@{profile.host}:{profile.port}
                  </p>
                </div>
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs"
                  style={{
                    backgroundColor: 'var(--color-surface)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {profile.authMethod}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setEditingId(profile.id)}
                      className="shrink-0 rounded p-1 transition-colors hover:bg-surface-raised"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      <Edit2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {t('workspaceProfiles.actions.editProfile')}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => void handleDelete(profile.id)}
                      className="shrink-0 rounded p-1 transition-colors hover:bg-surface-raised"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {t('workspaceProfiles.actions.deleteProfile')}
                  </TooltipContent>
                </Tooltip>
              </div>
            )
          )}
        </div>
      )}

      {!loading && (
        <div>
          {showAddForm ? (
            renderForm(handleAdd, () => {
              setShowAddForm(false);
              resetForm();
            })
          ) : (
            <button
              onClick={() => {
                resetForm();
                setShowAddForm(true);
              }}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <Plus className="size-3.5" />
              {t('workspaceProfiles.actions.addProfile')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
