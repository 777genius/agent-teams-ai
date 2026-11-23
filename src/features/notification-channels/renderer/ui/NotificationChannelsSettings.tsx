import { useEffect, useState } from 'react';

import {
  DELIVERY_EVENT_LABELS,
  DELIVERY_PROVIDERS,
  NOTIFICATION_DELIVERY_EVENTS,
} from '../../contracts';
import { api } from '@renderer/api';
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
import { BellPlus, CheckCircle2, Send, Trash2 } from 'lucide-react';

import type {
  ChannelTestStatus,
  DeliveryChannelDto,
  DeliveryEvent,
  DeliveryProvider,
  SaveDeliveryChannelRequest,
} from '../../contracts';

const NEW_CHANNEL: SaveDeliveryChannelRequest = {
  name: '',
  provider: 'telegram',
  enabled: false,
  events: ['user_inbox', 'task_clarification', 'task_review_requested', 'task_blocked'],
  chatId: '',
  secret: '',
};

function newChannel(): SaveDeliveryChannelRequest {
  return { ...NEW_CHANNEL, events: [...NEW_CHANNEL.events] };
}

function displayTest(status?: ChannelTestStatus): string {
  if (!status) return 'Not tested';
  return status.success ? 'Test delivered' : 'Test failed: ' + (status.code ?? 'delivery_failed');
}

export function NotificationChannelsSettings(): React.JSX.Element {
  const [channels, setChannels] = useState<DeliveryChannelDto[]>([]);
  const [draft, setDraft] = useState<SaveDeliveryChannelRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.notificationChannels.list()
      .then((items) => { if (active) setChannels(items); })
      .catch(() => { if (active) setError('Could not load notification destinations.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const refresh = async (): Promise<void> => {
    setChannels(await api.notificationChannels.list());
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch {
      // The API never exposes vendor errors that may include webhook credentials.
      setError('Could not complete the action. Check your settings and try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!draft) return;
    void run(async () => {
      await api.notificationChannels.save({
        ...draft,
        secret: draft.secret?.trim() || undefined,
      });
      setDraft(null);
    });
  };

  const edit = (channel: DeliveryChannelDto): void => {
    setDraft({
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      enabled: channel.enabled,
      events: [...channel.events],
      chatId: channel.chatId ?? '',
      secret: '',
    });
    setError(null);
  };

  const toggle = (channel: DeliveryChannelDto, enabled: boolean): void => {
    void run(async () => {
      await api.notificationChannels.save({
        id: channel.id,
        name: channel.name,
        provider: channel.provider,
        enabled,
        events: channel.events,
        chatId: channel.chatId,
      });
    });
  };

  const remove = (id: string): void => {
    if (deletePending !== id) {
      setDeletePending(id);
      return;
    }
    void run(async () => {
      await api.notificationChannels.remove(id);
      setDeletePending(null);
      if (draft?.id === id) setDraft(null);
    });
  };

  const test = (id: string): void => {
    void run(async () => {
      await api.notificationChannels.test(id);
    });
  };

  const updateDraft = (changes: Partial<SaveDeliveryChannelRequest>): void => {
    setDraft((prev) => prev ? { ...prev, ...changes } : prev);
  };

  const toggleEvent = (event: DeliveryEvent, checked: boolean): void => {
    if (!draft) return;
    updateDraft({
      events: checked
        ? [...new Set([...draft.events, event])]
        : draft.events.filter((item) => item !== event),
    });
  };

  return (
    <section aria-label="Delivery channels" className="my-5 rounded-lg border p-4"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-raised)' }}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <BellPlus className="size-4" /> Delivery Channels
          </h3>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Optional Telegram, Discord, Slack and other destinations. Desktop alerts stay unchanged.
            Only the event type is sent, never agent messages.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline"
          disabled={busy || draft !== null || channels.length >= 20}
          onClick={() => setDraft(newChannel())}>
          Add channel
        </Button>
      </div>

      {error && <p role="alert" className="mb-3 text-xs text-red-400">{error}</p>}
      {loading && <p className="text-xs">Loading channels…</p>}

      <div className="space-y-2">
        {channels.map((channel) => (
          <div key={channel.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            style={{ borderColor: 'var(--color-border)' }}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{channel.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {DELIVERY_PROVIDERS.find((item) => item.id === channel.provider)?.label}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs"
                style={{ color: 'var(--color-text-muted)' }}>
                {channel.lastTest?.success && <CheckCircle2 className="size-3 text-green-500" />}
                {displayTest(channel.lastTest)} · {channel.events.length} event types
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox aria-label={'Enable ' + channel.name} checked={channel.enabled}
                disabled={busy} onCheckedChange={(value) => toggle(channel, value === true)} />
              Enabled
            </label>
            <Button type="button" size="sm" variant="outline" disabled={busy}
              onClick={() => test(channel.id)}><Send className="size-3.5" /> Test</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || draft !== null}
              onClick={() => edit(channel)}>Edit</Button>
            <Button type="button" size="sm"
              variant={deletePending === channel.id ? 'destructive' : 'ghost'}
              disabled={busy} onClick={() => remove(channel.id)}>
              <Trash2 className="size-3.5" /> {deletePending === channel.id ? 'Confirm delete' : 'Delete'}
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
        <div className="mt-4 space-y-3 rounded-md border p-4"
          style={{ borderColor: 'var(--color-border)' }}>
          <h4 className="text-sm font-medium">
            {draft.id ? 'Edit delivery channel' : 'Add delivery channel'}
          </h4>
          <label className="block space-y-1 text-xs">
            <span>Display name</span>
            <Input autoComplete="off" value={draft.name} maxLength={80} disabled={busy}
              onChange={(event) => updateDraft({ name: event.target.value })}
              placeholder="My Telegram" />
          </label>
          <div className="space-y-1">
            <label className="text-xs">Provider</label>
            <Select value={draft.provider} disabled={busy}
              onValueChange={(value) => updateDraft({
                provider: value as DeliveryProvider,
                chatId: '',
                secret: '',
              })}>
              <SelectTrigger aria-label="Delivery provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DELIVERY_PROVIDERS.map((provider) =>
                  <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {DELIVERY_PROVIDERS.find((item) => item.id === draft.provider)?.hint}
            </p>
          </div>
          {draft.provider === 'telegram' && (
            <label className="block space-y-1 text-xs">
              <span>Chat ID or @channelname (open a chat with your bot first)</span>
              <Input value={draft.chatId ?? ''} autoComplete="off" disabled={busy}
                onChange={(event) => updateDraft({ chatId: event.target.value })} />
            </label>
          )}
          <label className="block space-y-1 text-xs">
            <span>{draft.provider === 'telegram' ? 'Bot token' : 'Official webhook URL'}</span>
            <Input type="password" autoComplete="new-password" disabled={busy}
              value={draft.secret ?? ''} onChange={(event) => updateDraft({ secret: event.target.value })}
              placeholder={draft.id ? 'Leave blank to keep current credential' : 'Required'} />
          </label>
          <div className="space-y-2">
            <p className="text-xs font-medium">Send these events</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {NOTIFICATION_DELIVERY_EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-2 text-xs">
                  <Checkbox checked={draft.events.includes(event)} disabled={busy}
                    onCheckedChange={(checked) => toggleEvent(event, checked === true)} />
                  {DELIVERY_EVENT_LABELS[event]}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={draft.enabled} disabled={busy}
              onCheckedChange={(checked) => updateDraft({ enabled: checked === true })} />
            Enable automatic delivery
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || !draft.name.trim() ||
              (draft.provider === 'telegram' && !draft.chatId?.trim()) ||
              (!draft.id && !draft.secret?.trim())} onClick={save}>
              Save channel
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy}
              onClick={() => setDraft(null)}>Cancel</Button>
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            After saving, click Test to verify delivery. Secrets are encrypted locally.
          </p>
        </div>
      )}
    </section>
  );
}
