import { Chat, ConnectorError } from '@thinwrap/notifications';

import { validateProviderCredential } from '../../../core/domain/routing';

import type {
  DeliverySender,
  StoredDeliveryChannel,
} from '../../../core/application/NotificationChannelsService';
import type { DeliveryFailureCode, DeliveryProvider } from '../../../contracts';

/** No arbitrary URLs, local endpoints, redirects, or bearer-URL leakage. */
function createGuardedFetch(provider: DeliveryProvider, secret: string): typeof fetch {
  return async (input, init) => {
    const requested = new URL(typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url);
    const expected = provider === 'telegram'
      ? new URL('https://api.telegram.org/bot' + encodeURIComponent(secret) + '/sendMessage')
      : new URL(secret);
    if (requested.protocol !== 'https:' || requested.port !== '' ||
      requested.username || requested.password ||
      requested.hostname !== expected.hostname || requested.pathname !== expected.pathname ||
      (provider !== 'discord' && requested.search !== expected.search) ||
      (provider === 'discord' &&
        [...requested.searchParams.keys()].some((key) => key !== 'wait' && key !== 'thread_id'))) {
      throw new Error('Untrusted notification endpoint');
    }
    return fetch(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  };
}

function classifyFailure(error: unknown): DeliveryFailureCode {
  if (error instanceof ConnectorError) {
    if (error.statusCode === 429) return 'rate_limited';
    if ([401, 403, 404].includes(error.statusCode ?? -1)) return 'authentication_failed';
    if (error.providerCode === 'provider_unavailable') return 'network_error';
  }
  return 'delivery_failed';
}

/** Stateless OSS provider adapters, no executables, server, or Electron dependency. */
export class ThinwrapDeliverySender implements DeliverySender {
  async send(channel: StoredDeliveryChannel, secret: string, message: string): Promise<{
    success: boolean;
    code?: DeliveryFailureCode;
  }> {
    try {
      validateProviderCredential(channel.provider, secret);
      const secureFetch = createGuardedFetch(channel.provider, secret);
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
      } else {
        success = (await new Chat('google-chat', { webhookUrl: secret, fetch: secureFetch })
          .send({ body: message })).success;
      }
      return success ? { success: true } : { success: false, code: 'delivery_failed' };
    } catch (error) {
      // Do not return error.message/cause/raw: webhook URL itself is a secret.
      return { success: false, code: classifyFailure(error) };
    }
  }
}
