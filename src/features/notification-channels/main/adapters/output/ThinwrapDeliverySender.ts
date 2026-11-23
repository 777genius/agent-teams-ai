import { Chat, ConnectorError } from '@thinwrap/notifications';

import { validateProviderCredential } from '../../../core/domain/routing';

import type { DeliveryFailureCode, DeliveryProvider } from '../../../contracts';
import type {
  DeliverySender,
  StoredDeliveryChannel,
} from '../../../core/application/NotificationChannelsService';

/** No arbitrary URLs, local endpoints, redirects, or bearer-URL leakage. */
function createGuardedFetch(
  provider: DeliveryProvider,
  secret: string,
  onAccepted?: () => void
): typeof fetch {
  return async (input, init) => {
    const requested = new URL(typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url);
    const expected = provider === 'telegram'
      ? new URL('https://api.telegram.org/bot' + encodeURIComponent(secret).replace(/%3A/gi, ':') + '/sendMessage')
      : new URL(secret);
    if (requested.protocol !== 'https:' || requested.port !== '' ||
      requested.username || requested.password ||
      requested.hostname !== expected.hostname || requested.pathname !== expected.pathname ||
      (provider !== 'discord' && requested.search !== expected.search) ||
      (provider === 'discord' &&
        [...requested.searchParams.keys()].some((key) => key !== 'wait' && key !== 'thread_id'))) {
      throw new Error('Untrusted notification endpoint');
    }
    const response = await fetch(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    // Google Chat responds with HTTP acceptance before Thinwrap consumes JSON.
    // A broken response stream must not be mistaken for a rejected send.
    if (provider === 'google-chat' && response.ok) onAccepted?.();
    return response;
  };
}

function classifyFailure(error: unknown): DeliveryFailureCode {
  if (error instanceof ConnectorError) {
    // Respect the provider's classification: Telegram 403 is invalid_recipient,
    // while Teams may classify a 400 webhook error as auth_failed.
    switch (error.providerCode) {
      case 'auth_failed': return 'authentication_failed';
      case 'invalid_recipient': return 'invalid_recipient';
      case 'rate_limited': return 'rate_limited';
      case 'provider_unavailable': return 'network_error';
      default: return 'delivery_failed';
    }
  }
  return 'delivery_failed';
}

/** Stateless OSS provider adapters, no executables, server, or Electron dependency. */
export class ThinwrapDeliverySender implements DeliverySender {
  async send(channel: StoredDeliveryChannel, secret: string, message: string): Promise<{
    success: boolean;
    code?: DeliveryFailureCode;
  }> {
    let acceptedByGoogleChat = false;
    try {
      validateProviderCredential(channel.provider, secret);
      const secureFetch = createGuardedFetch(channel.provider, secret, () => {
        acceptedByGoogleChat = true;
      });
      let success: boolean;
      if (channel.provider === 'telegram') {
        success = (await new Chat('telegram', { botToken: secret, fetch: secureFetch })
          .send({ to: channel.chatId ?? '', body: message })).success;
      } else if (channel.provider === 'discord') {
        success = (await new Chat('discord', { webhookUrl: secret, fetch: secureFetch })
          .send({ body: message })).success;
      } else if (channel.provider === 'slack') {
        success = (await new Chat('slack', { webhookUrl: secret, fetch: secureFetch })
          .send({ body: message })).success;
      } else if (channel.provider === 'ms-teams') {
        success = (await new Chat('ms-teams', { webhookUrl: secret, fetch: secureFetch })
          .send({ body: message })).success;
      } else if (channel.provider === 'google-chat') {
        success = (await new Chat('google-chat', { webhookUrl: secret, fetch: secureFetch })
          .send({ body: message })).success;
      } else {
        throw new Error('Unsupported delivery provider');
      }
      return success ? { success: true } : { success: false, code: 'delivery_failed' };
    } catch (error) {
      // The Google Chat adapter parses response.json() *after* a successful
      // provider acceptance. Preserve that accepted state if body parsing fails.
      if (channel.provider === 'google-chat' && acceptedByGoogleChat) {
        return { success: true };
      }
      // Do not return error.message/cause/raw: webhook URL itself is a secret.
      return { success: false, code: classifyFailure(error) };
    }
  }
}
