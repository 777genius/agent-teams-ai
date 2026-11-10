import { expect, it } from 'vitest';

import { formatProviderConnectError } from '../../../../src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementPresentation';

it('explains an existing shared credential without blaming authentication or prompting a replacement', () => {
  const message = formatProviderConnectError('OpenRouter', {
    code: 'auth-failed',
    recoverable: true,
    message:
      'V2 connection cannot replace an existing OpenCode credential. Existing V1 authentication was preserved.',
  });
  expect(message).toContain('already has a saved API key');
  expect(message).toContain('Use the existing connection');
  expect(message).not.toContain('could not verify');
});
