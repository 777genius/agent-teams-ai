import {
  DELIVERY_EVENT_LABELS,
  type DeliveryEvent,
  type DeliveryProvider,
  NOTIFICATION_DELIVERY_EVENTS,
  type SaveDeliveryChannelRequest,
} from '../../contracts';

import type { DetectedError } from '@shared/types/notifications';

export function isDeliveryEvent(value: unknown): value is DeliveryEvent {
  return (
    typeof value === 'string' && (NOTIFICATION_DELIVERY_EVENTS as readonly string[]).includes(value)
  );
}

export function normalizeChannelInput(value: unknown): SaveDeliveryChannelRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid channel data');
  const input = value as Partial<SaveDeliveryChannelRequest>;
  const provider = input.provider;
  if (
    typeof provider !== 'string' ||
    !['telegram', 'discord', 'slack', 'ms-teams', 'google-chat'].includes(provider)
  ) {
    throw new Error('Unsupported delivery provider');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 80) throw new Error('Channel name must be 1–80 characters');
  if (input.enabled !== true && input.enabled !== false) throw new Error('Invalid enabled value');
  if (
    !Array.isArray(input.events) ||
    input.events.length > NOTIFICATION_DELIVERY_EVENTS.length ||
    input.events.some((event) => !isDeliveryEvent(event))
  ) {
    throw new Error('Invalid notification events');
  }
  if (
    input.expectedEvents !== undefined &&
    (!input.id ||
      !Array.isArray(input.expectedEvents) ||
      input.expectedEvents.length > NOTIFICATION_DELIVERY_EVENTS.length ||
      input.expectedEvents.some((event) => !isDeliveryEvent(event)))
  ) {
    throw new Error('Invalid expected notification events');
  }
  if (input.expectedEnabled !== undefined && (!input.id || typeof input.expectedEnabled !== 'boolean')) {
    throw new Error('Invalid expected channel enabled state');
  }
  const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
  if (provider === 'telegram' && !/^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,})$/.test(chatId)) {
    throw new Error('Telegram requires a valid chat ID or channel username');
  }
  if (
    input.id !== undefined &&
    (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id))
  ) {
    throw new Error('Invalid channel ID');
  }
  if (input.secret !== undefined && typeof input.secret !== 'string') {
    throw new Error('Invalid channel credential');
  }
  return {
    id: input.id,
    name,
    provider: provider as DeliveryProvider,
    enabled: input.enabled,
    events: [...new Set(input.events)],
    expectedEvents: input.expectedEvents ? [...new Set(input.expectedEvents)] : undefined,
    expectedEnabled: input.expectedEnabled,
    chatId: provider === 'telegram' ? chatId : undefined,
    secret: input.secret?.trim() || undefined,
  };
}

/** Validate before storing any credential or allowing a remote request. */
export function validateProviderCredential(provider: DeliveryProvider, credential: string): void {
  if (credential.length > 4096 || credential.length < 8) throw new Error('Invalid credential');
  if (provider === 'telegram') {
    if (!/^[0-9]{6,15}:[A-Za-z0-9_-]{20,}$/.test(credential)) {
      throw new Error('Invalid Telegram bot token');
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(credential);
  } catch {
    throw new Error('Invalid HTTPS webhook URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.hash ||
    /[\r\n]/.test(credential)
  ) {
    throw new Error('Only official HTTPS webhook URLs are supported');
  }
  const host = url.hostname.toLowerCase();
  switch (provider) {
    case 'discord':
      if (
        !['discord.com', 'discordapp.com'].includes(host) ||
        !/^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      ) {
        throw new Error('Invalid Discord webhook URL');
      }
      break;
    case 'slack':
      if (
        host !== 'hooks.slack.com' ||
        !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
      ) {
        throw new Error('Invalid Slack webhook URL');
      }
      break;
    case 'ms-teams':
      if (
        !(
          host === 'outlook.office.com' ||
          host.endsWith('.webhook.office.com') ||
          host.endsWith('.logic.azure.com') ||
          host.endsWith('.api.powerplatform.com')
        )
      ) {
        throw new Error('Invalid Microsoft Teams webhook host');
      }
      break;
    case 'google-chat':
      if (
        host !== 'chat.googleapis.com' ||
        !/^\/v1\/spaces\/[^/]+\/messages$/.test(url.pathname) ||
        !url.searchParams.has('key') ||
        !url.searchParams.has('token')
      ) {
        throw new Error('Invalid Google Chat webhook URL');
      }
      break;
    default:
      throw new Error('Unsupported delivery provider');
  }
}

/** No raw prompts, inbox contents, usernames or internal agent messages leave the app. */
export function toOutboundNotification(notification: DetectedError): {
  event: DeliveryEvent;
  message: string;
} | null {
  if (
    notification.category !== 'team' ||
    !isDeliveryEvent(notification.teamEventType) ||
    notification.isRead
  )
    return null;
  const event = notification.teamEventType;
  // Only fixed, non-sensitive labels are forwarded. Team names are intentionally omitted.
  return { event, message: 'Agent Teams: ' + DELIVERY_EVENT_LABELS[event] + '.' };
}
