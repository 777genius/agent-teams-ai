import {
  parseHostedPromotionBegin,
  parseHostedPromotionBeginResult,
  parseHostedPromotionLookup,
  parseHostedPromotionRecord,
} from '../../contracts/hostedPromotionStorageContracts';

import type { HostedPromotionStorageGateway } from '../../contracts/hostedPromotionStorageContracts';
import type { InternalStorageWorkerTransport } from './InternalStorageWorkerTransport';

export function createHostedPromotionWorkerClient(
  call: InternalStorageWorkerTransport['call']
): HostedPromotionStorageGateway {
  return {
    begin: async (value, options) => {
      const input = parseHostedPromotionBegin(value);
      return parseHostedPromotionBeginResult(
        await call('hostedPromotion.begin', input, {
          signal: options.signal,
          timeoutAtMs: input.deadlineAtMs,
        })
      );
    },
    lookup: async (value) => {
      const result = await call('hostedPromotion.lookup', parseHostedPromotionLookup(value));
      return result === null ? null : parseHostedPromotionRecord(result);
    },
  };
}
