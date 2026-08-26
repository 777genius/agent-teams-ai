import { commitAuthoritativePrepareCandidate } from '@renderer/components/team/dialogs/commitAuthoritativePrepareCandidate';
import { describe, expect, it, vi } from 'vitest';

const proof = {
  authorityId: 'proof-id',
  generation: 7,
  completedAt: '2026-08-21T00:00:00.000Z',
  expiresAt: '2026-08-21T00:01:00.000Z',
  requestDigest: 'a'.repeat(64),
};

describe('commitAuthoritativePrepareCandidate', () => {
  it('publishes one exact combined candidate with backend-separated routes', async () => {
    const prepareProvisioning = vi.fn(async () => ({
      ready: true,
      message: 'ready',
      executionProof: proof,
    }));
    const checksByProvider = new Map([
      [
        'codex' as const,
        [
          { providerId: 'codex' as const, providerBackendId: 'adapter' as const, model: 'gpt-5' },
          {
            providerId: 'codex' as const,
            providerBackendId: 'codex-native' as const,
            model: 'gpt-5',
          },
        ],
      ],
      [
        'anthropic' as const,
        [
          {
            providerId: 'anthropic' as const,
            providerBackendId: null,
            model: 'claude-sonnet-4-5',
          },
        ],
      ],
    ]);

    await expect(
      commitAuthoritativePrepareCandidate({
        cwd: '/sandbox/project',
        leadProviderId: 'codex',
        providerIds: ['codex', 'anthropic'],
        checksByProvider,
        runtimeRosterRevision: 'revision-1',
        prepareProvisioning,
      })
    ).resolves.toBe(proof);
    expect(prepareProvisioning).toHaveBeenCalledWith(
      '/sandbox/project',
      'codex',
      ['codex', 'anthropic'],
      ['gpt-5', 'claude-sonnet-4-5'],
      undefined,
      'deep',
      expect.arrayContaining([
        expect.objectContaining({ providerBackendId: 'adapter', model: 'gpt-5' }),
        expect.objectContaining({ providerBackendId: 'codex-native', model: 'gpt-5' }),
        expect.objectContaining({ providerBackendId: null, model: 'claude-sonnet-4-5' }),
      ]),
      false,
      'revision-1'
    );
  });

  it('binds the explicit experimental override decision into the authoritative request', async () => {
    const prepareProvisioning = vi.fn(async () => ({ ready: true, message: 'ready', executionProof: proof }));
    await commitAuthoritativePrepareCandidate({
      cwd: '/sandbox/project',
      leadProviderId: 'opencode',
      providerIds: ['opencode'],
      checksByProvider: new Map([
        ['opencode', [{ providerId: 'opencode', providerBackendId: 'opencode-cli', model: 'ollama/qwen' }]],
      ]),
      allowExperimentalLocalModels: true,
      runtimeRosterRevision: 'revision-2',
      prepareProvisioning,
    });
    expect(prepareProvisioning).toHaveBeenCalledWith(
      '/sandbox/project',
      'opencode',
      ['opencode'],
      ['ollama/qwen'],
      undefined,
      'deep',
      expect.any(Array),
      true,
      'revision-2'
    );
  });

  it('accepts Codex auto as an exact proof-bound backend selection', async () => {
    const prepareProvisioning = vi.fn(() =>
      Promise.resolve({ ready: true, message: 'ready', executionProof: proof })
    );

    await expect(
      commitAuthoritativePrepareCandidate({
        cwd: '/sandbox/project',
        leadProviderId: 'codex',
        providerIds: ['codex'],
        checksByProvider: new Map([
          ['codex', [{ providerId: 'codex', providerBackendId: 'auto', model: 'gpt-5.4' }]],
        ]),
        runtimeRosterRevision: 'revision-3',
        prepareProvisioning,
      })
    ).resolves.toBe(proof);
    expect(prepareProvisioning).toHaveBeenCalledWith(
      '/sandbox/project',
      'codex',
      ['codex'],
      ['gpt-5.4'],
      undefined,
      'deep',
      [expect.objectContaining({ providerBackendId: 'auto' })],
      false,
      'revision-3'
    );
  });

  it('clears authorization by rejecting a failed refresh without a new proof', async () => {
    const prepareProvisioning = vi.fn(async () => ({
      ready: false,
      message: 'fresh check failed',
    }));
    await expect(
      commitAuthoritativePrepareCandidate({
        cwd: '/sandbox/project',
        leadProviderId: 'codex',
        providerIds: ['codex'],
        checksByProvider: new Map([
          ['codex', [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' }]],
        ]),
        runtimeRosterRevision: 'revision-4',
        prepareProvisioning,
      })
    ).rejects.toThrow('fresh check failed');
  });
});
