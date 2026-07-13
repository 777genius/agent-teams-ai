import { describe, expect, it } from 'vitest';

import {
  getRuntimeProviderSetupPresentation,
  selectRuntimeProviderSetupAuthOptionId,
} from './runtimeProviderConnection';

import type { RuntimeProviderSetupFormDto } from '../../contracts';

function setupForm(): RuntimeProviderSetupFormDto {
  return {
    runtimeId: 'opencode',
    providerId: 'mixed-provider',
    displayName: 'Mixed Provider',
    method: 'oauth',
    supported: true,
    title: 'Connect Mixed Provider',
    description: 'Connect the provider.',
    submitLabel: 'Continue in browser',
    disabledReason: null,
    source: 'oauth',
    secret: null,
    prompts: [],
    authOptions: [
      {
        id: 'oauth:0',
        method: 'oauth',
        methodIndex: 0,
        label: 'Browser sign-in',
        supported: true,
        disabledReason: null,
        secret: null,
        prompts: [],
      },
      {
        id: 'api:1',
        method: 'api',
        methodIndex: 1,
        label: 'Subscription key',
        supported: true,
        disabledReason: null,
        secret: {
          key: 'key',
          label: 'Subscription key',
          placeholder: 'Paste key',
          required: true,
        },
        prompts: [],
      },
    ],
    defaultAuthOptionId: 'oauth:0',
  };
}

describe('runtime provider connection intent', () => {
  it('preserves the connected auth method when reconnecting a mixed provider', () => {
    expect(
      selectRuntimeProviderSetupAuthOptionId({
        form: setupForm(),
        intent: 'reconnect',
        connectedAuthHint: 'api',
      })
    ).toBe('api:1');
  });

  it('keeps the provider default for initial connection', () => {
    expect(
      selectRuntimeProviderSetupAuthOptionId({
        form: setupForm(),
        intent: 'connect',
        connectedAuthHint: 'api',
      })
    ).toBe('oauth:0');
  });

  it('explains transactional replacement without exposing or pre-filling the old key', () => {
    const presentation = getRuntimeProviderSetupPresentation({
      form: setupForm(),
      intent: 'reconnect',
      selectedAuthOptionId: 'api:1',
    });

    expect(presentation).toEqual({
      kind: 'replace-api-credential',
      prefersBrowserCode: false,
    });
  });

  it('uses reauthorization language for OAuth reconnects', () => {
    const presentation = getRuntimeProviderSetupPresentation({
      form: setupForm(),
      intent: 'reconnect',
      selectedAuthOptionId: 'oauth:0',
    });

    expect(presentation).toEqual({
      kind: 'reauthorize-oauth',
      prefersBrowserCode: false,
    });
  });
});
