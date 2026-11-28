import { describe, expect, it, vi } from 'vitest';

import { GitHubAuthorizationError } from '../../../src/features/pr-monitor/core/application/deviceAuthorization';
import { createGitHubDeviceIssuer } from '../../../src/features/pr-monitor/main/infrastructure/githubOAuth';

describe('bounded GitHub device issuer responses', () => {
  it('preserves terminal HTTP 401 when response cleanup rejects', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('TEST_CLEANUP_FAILED');
    });
    const response = new Response(new ReadableStream({ cancel }), { status: 401 });
    const fetcher = vi.fn<typeof fetch>(async () => response);
    await expect(
      createGitHubDeviceIssuer(fetcher).identity('TEST_TOKEN', new AbortController().signal)
    ).rejects.toBeInstanceOf(GitHubAuthorizationError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['size', 'utf8'] as const)(
    'cancels an unfinished %s response without masking its original failure',
    async (failure) => {
      const cancel = vi.fn(async () => {
        throw new Error('TEST_CLEANUP_FAILED');
      });
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(failure === 'size' ? new Uint8Array(65_537) : new Uint8Array([255]));
          },
          cancel,
        })
      );
      const fetcher = vi.fn<typeof fetch>(async () => response);
      const pending = createGitHubDeviceIssuer(fetcher).request({}, new AbortController().signal);
      if (failure === 'size') await expect(pending).rejects.toThrow('Invalid sign-in response.');
      else await expect(pending).rejects.toBeInstanceOf(TypeError);
      expect(cancel).toHaveBeenCalledOnce();
    }
  );
});
