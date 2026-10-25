import { describe, expect, it } from 'vitest';

import { buildSetupAuthSelector } from './runtimeProviderManagementInternals';

import type { RuntimeProviderSetupAuthOptionDto } from '@features/runtime-provider-management/contracts';

function option(
  overrides: Partial<RuntimeProviderSetupAuthOptionDto>
): RuntimeProviderSetupAuthOptionDto {
  return {
    id: 'api:curated',
    method: 'api',
    methodIndex: null,
    label: 'Key',
    supported: true,
    disabledReason: null,
    secret: { key: 'key', label: 'Key', placeholder: 'Paste key', required: true },
    prompts: [],
    ...overrides,
  };
}

describe('buildSetupAuthSelector', () => {
  it('sends no selector for the plain native key method', () => {
    // The OpenCode V2 runtime refuses a key connect that names an auth option.
    expect(buildSetupAuthSelector(option({}))).toEqual({});
    expect(buildSetupAuthSelector(null)).toEqual({});
  });

  it('keeps the selector when the option needs it', () => {
    expect(buildSetupAuthSelector(option({ id: 'api:0', methodIndex: 0 }))).toEqual({
      authMethodIndex: 0,
      authOptionId: 'api:0',
    });
    expect(
      buildSetupAuthSelector(option({ id: 'oauth:1', method: 'oauth', methodIndex: 1 }))
    ).toEqual({
      authMethodIndex: 1,
      authOptionId: 'oauth:1',
    });
    expect(
      buildSetupAuthSelector(
        option({
          prompts: [
            {
              key: 'region',
              type: 'text',
              label: 'Region',
              placeholder: null,
              required: true,
              secret: false,
              options: [],
              when: null,
            },
          ],
        })
      )
    ).toEqual({ authOptionId: 'api:curated' });
  });
});
