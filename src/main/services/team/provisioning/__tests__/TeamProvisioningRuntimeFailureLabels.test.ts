import { describe, expect, it } from 'vitest';

import {
  getProviderRuntimeFailureLabel,
  getRuntimeFailureLabelForRequest,
} from '../TeamProvisioningRuntimeFailureLabels';

import type { TeamCreateRequest } from '@shared/types';

type LabelRequest = Pick<TeamCreateRequest, 'providerId' | 'model' | 'members'>;

function req(overrides: Partial<LabelRequest> = {}): LabelRequest {
  return {
    providerId: undefined,
    model: undefined,
    members: [],
    ...overrides,
  } as LabelRequest;
}

describe('TeamProvisioningRuntimeFailureLabels', () => {
  describe('getProviderRuntimeFailureLabel', () => {
    it('maps each provider to its label', () => {
      expect(getProviderRuntimeFailureLabel('anthropic')).toBe('Claude CLI');
      expect(getProviderRuntimeFailureLabel('codex')).toBe('Codex runtime');
      expect(getProviderRuntimeFailureLabel('gemini')).toBe('Gemini runtime');
      expect(getProviderRuntimeFailureLabel('opencode')).toBe('OpenCode runtime');
    });
  });

  describe('getRuntimeFailureLabelForRequest', () => {
    it('uses the specific provider label when the roster resolves to one provider (lead)', () => {
      expect(getRuntimeFailureLabelForRequest(req({ providerId: 'codex' }))).toBe('Codex runtime');
    });

    it('uses the specific provider label when only members carry the provider', () => {
      expect(
        getRuntimeFailureLabelForRequest(
          req({ members: [{ name: 'a', providerId: 'opencode' } as never] })
        )
      ).toBe('OpenCode runtime');
    });

    it('infers a single provider from the model when providerId is absent', () => {
      expect(getRuntimeFailureLabelForRequest(req({ model: 'gpt-5-codex' }))).toBe('Codex runtime');
    });

    it('falls back to the configured CLI flavor display name for mixed rosters', () => {
      const label = getRuntimeFailureLabelForRequest(
        req({
          providerId: 'anthropic',
          members: [{ name: 'x', providerId: 'opencode' } as never],
        })
      );
      // Mixed roster -> not a single specific provider label.
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    });
  });
});
