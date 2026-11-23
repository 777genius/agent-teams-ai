import { useEffect, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { resolveLocalSettingsUrl } from '../utils/localSettingsOrigin';

import type { DeliveryChannelDto, DeliveryEvent, SaveDeliveryChannelRequest } from '../../contracts';

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

export function useNotificationChannelsSettings() {
  const [localSettingsUrl] = useState(() => {
    if (typeof window === 'undefined') return null;
    return resolveLocalSettingsUrl(window.location.origin, window.location.search, isElectronMode());
  });
  const [channels, setChannels] = useState<DeliveryChannelDto[]>([]);
  const [draft, setDraft] = useState<SaveDeliveryChannelRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (localSettingsUrl) {
      setLoading(false);
      return;
    }
    let active = true;
    api.notificationChannels.list()
      .then((items) => { if (active) setChannels(items); })
      .catch(() => { if (active) setError('Could not load notification destinations.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [localSettingsUrl]);

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

  const providerChanged = Boolean(draft?.id &&
    channels.find((item) => item.id === draft.id)?.provider !== draft.provider);
  const credentialMissing = Boolean(draft?.id &&
    channels.find((item) => item.id === draft.id)?.hasCredential === false);

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


  const start = (): void => setDraft(newChannel());
  const cancel = (): void => setDraft(null);

  return {
    channels, draft, loading, busy, deletePending, error, localSettingsUrl,
    save, edit, toggle, remove, test, providerChanged, credentialMissing, updateDraft, toggleEvent, start, cancel,
  };
}
