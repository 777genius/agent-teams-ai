import { useEffect, useRef, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';

import { isLocalSettingsOrigin, resolveLocalSettingsUrl } from '../utils/localSettingsOrigin';

import type {
  DeliveryChannelDto,
  DeliveryEvent,
  SaveDeliveryChannelRequest,
} from '../../contracts';

const NEW_CHANNEL: SaveDeliveryChannelRequest = {
  name: '',
  provider: 'telegram',
  enabled: false,
  events: [],
  chatId: '',
  secret: '',
};

function newChannel(): SaveDeliveryChannelRequest {
  return { ...NEW_CHANNEL, events: [...NEW_CHANNEL.events] };
}

export function useNotificationChannelsSettings() {
  const [localSettingsUrl] = useState(() => {
    if (typeof window === 'undefined') return null;
    return resolveLocalSettingsUrl(
      window.location.origin,
      window.location.search,
      isElectronMode()
    );
  });
  const [remoteSettingsUnavailable] = useState(
    () =>
      typeof window !== 'undefined' &&
      !isLocalSettingsOrigin(window.location.origin, isElectronMode())
  );
  const [channels, setChannels] = useState<DeliveryChannelDto[]>([]);
  const [draft, setDraft] = useState<SaveDeliveryChannelRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Serialize rapid edits and toggles from this UI; the service rejects stale writes
  // coming from another window or the local API.
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (localSettingsUrl || remoteSettingsUnavailable) {
      setLoading(false);
      return;
    }
    let active = true;
    api.notificationChannels
      .list()
      .then((items) => {
        if (active) setChannels(items);
      })
      .catch(() => {
        if (active) setError('Could not load notification destinations.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [localSettingsUrl, remoteSettingsUnavailable]);

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
      // Credentials may be edited while another window changes destinations.
      // Preserve current subscriptions instead of overwriting with stale draft.events.
      const current = draft.id
        ? (await api.notificationChannels.list()).find((item) => item.id === draft.id)
        : null;
      if (draft.id && !current) throw new Error('Channel unavailable');
      await api.notificationChannels.save({
        ...draft,
        ...(current
          ? { events: current.events, expectedEvents: current.events, expectedEnabled: current.enabled }
          : {}),
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
    mutationQueue.current = mutationQueue.current.then(() => run(async () => {
      const current = (await api.notificationChannels.list()).find((item) => item.id === channel.id);
      if (!current) throw new Error('Channel unavailable');
      await api.notificationChannels.save({
        id: current.id,
        name: current.name,
        provider: current.provider,
        enabled,
        events: current.events,
        expectedEvents: current.events,
        expectedEnabled: current.enabled,
        chatId: current.chatId,
      });
    }));
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

  const providerChanged = Boolean(
    draft?.id && channels.find((item) => item.id === draft.id)?.provider !== draft.provider
  );
  const credentialMissing = Boolean(
    draft?.id && channels.find((item) => item.id === draft.id)?.hasCredential === false
  );

  const updateDraft = (changes: Partial<SaveDeliveryChannelRequest>): void => {
    setDraft((prev) => (prev ? { ...prev, ...changes } : prev));
  };

  /** The row selector owns event subscriptions; credentials and provider stay unchanged. */
  const route = (
    channel: DeliveryChannelDto,
    events: readonly DeliveryEvent[],
    checked: boolean
  ): void => {
    if (!channel.enabled || !channel.hasCredential) return;
    mutationQueue.current = mutationQueue.current.then(() => run(async () => {
      // Read the current membership before writing. A previous save may have
      // succeeded even if refreshing its UI snapshot failed afterward.
      const fresh = (await api.notificationChannels.list()).find((item) => item.id === channel.id);
      if (!fresh?.enabled || !fresh.hasCredential) {
        throw new Error('Channel unavailable');
      }
      const updated = checked
        ? [...new Set([...fresh.events, ...events])]
        : fresh.events.filter((event) => !events.includes(event));
      await api.notificationChannels.save({
        id: fresh.id,
        name: fresh.name,
        provider: fresh.provider,
        enabled: fresh.enabled,
        events: updated,
        expectedEvents: fresh.events,
        expectedEnabled: fresh.enabled,
        chatId: fresh.chatId,
      });
    }));
  };

  const start = (): void => setDraft(newChannel());
  const cancel = (): void => setDraft(null);

  return {
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
    refresh,
    providerChanged,
    credentialMissing,
    updateDraft,
    route,
    start,
    cancel,
  };
}
