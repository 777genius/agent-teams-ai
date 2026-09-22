// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createCodexAccountFeature } from '../../../../src/features/codex-account/main/composition/createCodexAccountFeature';
import { detectCodexLocalAccountState } from '../../../../src/features/codex-account/main/infrastructure/detectCodexLocalAccountArtifacts';

const describeLive = process.env.LIVE_CODEX_ACCOUNT_SMOKE === '1' ? describe : describe.skip;

describeLive('createCodexAccountFeature live smoke', () => {
  it('classifies the current local Codex account state consistently with local account artifacts', async () => {
    const localState = await detectCodexLocalAccountState();
    const feature = createCodexAccountFeature({
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      configManager: {
        getConfig: () => ({
          providerConnections: {
            codex: {
              preferredAuthMode: 'chatgpt' as const,
            },
          },
        }),
      },
    });

    try {
      const snapshot = await feature.refreshSnapshot({
        includeRateLimits: true,
        forceRefreshToken: true,
      });

      expect(snapshot.localAccountArtifactsPresent).toBe(localState.hasArtifacts);
      expect(snapshot.localActiveChatgptAccountPresent).toBe(
        localState.hasActiveChatgptAccount
      );

      if (localState.hasActiveChatgptAccount && snapshot.managedAccount?.type !== 'chatgpt') {
        expect(snapshot.launchAllowed).toBe(false);
        expect(snapshot.launchIssueMessage).toContain('Reconnect ChatGPT');
      }

      if (snapshot.managedAccount?.type === 'chatgpt') {
        expect(snapshot.effectiveAuthMode).toBe('chatgpt');
      }
    } finally {
      await feature.dispose();
    }
  });
});
