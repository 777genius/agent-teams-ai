import { useAppTranslation } from '@features/localization/renderer';

import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { BellPlus, CheckCircle2, ExternalLink, Send, Trash2 } from 'lucide-react';

import { DELIVERY_PROVIDERS } from '../../contracts';

import { CHANNEL_SETUP_DOCS_URL, PROVIDER_SETUP_GUIDES } from './providerSetupGuide';

import type { useNotificationChannelsSettings } from '../hooks/useNotificationChannelsSettings';

import type { ChannelTestStatus, DeliveryProvider } from '../../contracts';

function displayTest(status?: ChannelTestStatus): string {
  if (!status) return 'Not tested';
  if (status.success) return 'Provider accepted test message';
  const descriptions: Record<string, string> = {
    credentials_missing: 'Saved credential is missing',
    authentication_failed: 'Check the bot token or webhook URL',
    invalid_recipient: 'Check recipient permissions or chat ID',
    rate_limited: 'Provider rate limit; try later',
    network_error: 'Network or provider unavailable',
    delivery_failed: 'Provider rejected the test or request failed',
  };
  return descriptions[status.code ?? 'delivery_failed'];
}

export function NotificationChannelsSettings({
  autoDeliveryPauseReason = null,
  snoozedUntil = null,
  settings,
}: Readonly<{
  autoDeliveryPauseReason?: 'notifications_off' | 'snoozed' | null;
  snoozedUntil?: number | null;
  settings: ReturnType<typeof useNotificationChannelsSettings>;
}>): React.JSX.Element {
  const {
    channels,
    draft,
    loading,
    busy,
    deletePending,
    error,
    localSettingsUrl,
    remoteSettingsUnavailable,
    save,
    edit,
    toggle,
    remove,
    test,
    providerChanged,
    credentialMissing,
    updateDraft,
    start,
    cancel,
  } = settings;
  const { t, resolvedLanguage } = useAppTranslation('settings');
  const isRussian = resolvedLanguage?.toLowerCase().startsWith('ru') ?? false;
  const providerGuide = draft ? PROVIDER_SETUP_GUIDES[draft.provider] : null;
  if (localSettingsUrl || remoteSettingsUnavailable) {
    return (
      <section
        aria-label="Delivery channels"
        className="my-5 rounded-lg border p-4"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <h3 className="text-sm font-semibold">Delivery Channels</h3>
        <p className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Secure delivery-channel editing requires the app UI and API on the same loopback origin.
          This page cannot administer notification credentials from its current origin.
        </p>
        <p className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Open Agent Teams desktop → Settings → Notifications to manage channels. For standalone
          browser mode, build the renderer and serve it from the same local HTTP origin as the API.
          An API-only server cannot display the settings page.
        </p>
        {localSettingsUrl && !remoteSettingsUnavailable && (
          <a className="mt-2 inline-block text-xs underline" href={localSettingsUrl}>
            Open local app (requires renderer files)
          </a>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label="Delivery channels"
      className="my-5 rounded-lg border p-4"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-raised)' }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <BellPlus className="size-4" /> Delivery Channels
          </h3>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Telegram, Discord, Slack, Teams, and Google Chat. Configure each destination once,
            then select it beside notification types below. Only safe event labels are sent.
          </p>
          {autoDeliveryPauseReason && channels.length > 0 && (
            <p className="mt-2 text-xs text-amber-500" role="status">
              {autoDeliveryPauseReason === 'notifications_off'
                ? t('notifications.delivery.pausedDisabled')
                : snoozedUntil
                  ? t('notifications.delivery.pausedSnoozed', {
                      time: new Date(snoozedUntil).toLocaleTimeString(),
                    })
                  : t('notifications.delivery.pausedSnoozedUnknown')}
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || draft !== null || channels.length >= 20}
          onClick={start}
        >
          Add channel
        </Button>
      </div>

      {error && (
        <p role="alert" className="mb-3 text-xs text-red-400">
          {error}
        </p>
      )}
      {loading && <p className="text-xs">Loading channels…</p>}

      <div className="space-y-2">
        {channels.map((channel) => (
          <div
            key={channel.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{channel.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {DELIVERY_PROVIDERS.find((item) => item.id === channel.provider)?.label}
                </span>
              </div>
              <div
                className="mt-1 flex items-center gap-1 text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {channel.lastTest?.success && <CheckCircle2 className="size-3 text-green-500" />}
                {channel.hasCredential
                  ? displayTest(channel.lastTest)
                  : 'Credential unavailable: edit to re-enter'}{' '}
                · {channel.events.length} routed event types
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                aria-label={'Enable ' + channel.name}
                checked={channel.enabled}
                disabled={
                  busy || draft?.id === channel.id || (!channel.hasCredential && !channel.enabled)
                }
                onCheckedChange={(value) => toggle(channel, value === true)}
              />
              Enabled
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => test(channel.id)}
            >
              <Send className="size-3.5" /> Test
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || draft !== null}
              onClick={() => edit(channel)}
            >
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant={deletePending === channel.id ? 'destructive' : 'ghost'}
              disabled={busy}
              onClick={() => remove(channel.id)}
            >
              <Trash2 className="size-3.5" />{' '}
              {deletePending === channel.id ? 'Confirm delete' : 'Delete'}
            </Button>
          </div>
        ))}
      </div>

      {!loading && channels.length === 0 && !draft && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          No external channels configured. No data is sent to third-party services.
        </p>
      )}

      {draft && (
        <div
          className="mt-4 space-y-3 rounded-md border p-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <h4 className="text-sm font-medium">
            {draft.id ? 'Edit delivery channel' : 'Add delivery channel'}
          </h4>
          <label className="block space-y-1 text-xs">
            <span>Display name</span>
            <Input
              autoComplete="off"
              value={draft.name}
              maxLength={80}
              disabled={busy}
              onChange={(event) => updateDraft({ name: event.target.value })}
              placeholder="My Telegram"
            />
          </label>
          <div className="space-y-1">
            <label className="text-xs">Provider</label>
            <Select
              value={draft.provider}
              disabled={busy}
              onValueChange={(value) =>
                updateDraft({
                  provider: value as DeliveryProvider,
                  chatId: '',
                  secret: '',
                })
              }
            >
              <SelectTrigger aria-label="Delivery provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_PROVIDERS.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {DELIVERY_PROVIDERS.find((item) => item.id === draft.provider)?.hint}
            </p>
            {providerGuide && (
              <div className="mt-2 space-y-2 rounded-md border p-3 text-xs" style={{ borderColor: 'var(--color-border-subtle)' }}>
                <p>{isRussian ? providerGuide.instructionRu : providerGuide.instruction}</p>
                <p className="text-[var(--color-text-muted)]">
                  {isRussian ? 'Пример формата (нерабочие данные):' : 'Example format (not a real credential):'}
                </p>
                <code className="block break-all rounded bg-[var(--color-surface)] p-2 text-[11px]">
                  {providerGuide.example}
                </code>
                <div className="flex flex-wrap items-center gap-4">
                  <a href={providerGuide.officialUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
                    {providerGuide.officialLabel} <ExternalLink className="size-3" />
                  </a>
                  <a href={(isRussian
                      ? CHANNEL_SETUP_DOCS_URL.replace('/guide/', '/ru/guide/')
                      : CHANNEL_SETUP_DOCS_URL) +
                      '#' +
                      (draft.provider === 'ms-teams' ? 'microsoft-teams-workflows' : draft.provider)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
                    {isRussian ? 'Пошаговая инструкция Agent Teams' : 'Step-by-step setup guide'} <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
            )}
          </div>
          {draft.provider === 'telegram' && (
            <label className="block space-y-1 text-xs">
              <span>Chat ID or @channelname (open a chat with your bot first)</span>
              <Input
                value={draft.chatId ?? ''}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => updateDraft({ chatId: event.target.value })}
              />
            </label>
          )}
          <label className="block space-y-1 text-xs">
            <span>{draft.provider === 'telegram' ? 'Bot token from @BotFather' : 'Incoming webhook URL from the provider'}</span>
            <Input
              type="password"
              autoComplete="new-password"
              disabled={busy}
              value={draft.secret ?? ''}
              onChange={(event) => updateDraft({ secret: event.target.value })}
              placeholder={draft.id ? 'Leave blank to keep current credential' : 'Paste the complete secret URL or bot token'}
            />
          </label>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Select destinations beside each notification type below after saving.
          </p>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={draft.enabled}
              disabled={busy}
              onCheckedChange={(checked) => updateDraft({ enabled: checked === true })}
            />
            Enable automatic delivery
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={
                busy ||
                !draft.name.trim() ||
                (draft.provider === 'telegram' && !draft.chatId?.trim()) ||
                (!draft.id && !draft.secret?.trim()) ||
                ((providerChanged || credentialMissing) && !draft.secret?.trim())
              }
              onClick={save}
            >
              Save channel
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Next: save → click Test → enable the channel → select notification destinations below. Secrets are encrypted locally and never displayed again.
          </p>
        </div>
      )}
    </section>
  );
}
