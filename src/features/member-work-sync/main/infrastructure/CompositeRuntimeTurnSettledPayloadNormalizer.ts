import type {
  RuntimeTurnSettledPayloadNormalization,
  RuntimeTurnSettledPayloadNormalizerPort,
} from '../../core/application';
import type { RuntimeTurnSettledProvider } from '../../core/domain';

export class CompositeRuntimeTurnSettledPayloadNormalizer
  implements RuntimeTurnSettledPayloadNormalizerPort
{
  constructor(
    private readonly normalizers: readonly RuntimeTurnSettledPayloadNormalizerPort[]
  ) {}

  normalize(input: {
    provider: RuntimeTurnSettledProvider;
    raw: string;
    recordedAt: string;
  }): RuntimeTurnSettledPayloadNormalization {
    let lastUnsupportedReason = 'unsupported_provider';
    for (const normalizer of this.normalizers) {
      const result = normalizer.normalize(input);
      if (result.ok) {
        return result;
      }
      if (result.reason !== 'unsupported_provider') {
        return result;
      }
      lastUnsupportedReason = result.reason;
    }
    return { ok: false, reason: lastUnsupportedReason };
  }
}
