import {
  parseOptionalLaunchProviderBackendId,
  parseOptionalProviderBackendId,
} from '@main/ipc/teamIpcRequestParsers';
import { describe, expect, it } from 'vitest';

import type { TeamProviderBackendId, TeamProviderId } from '@shared/types';

const backendIds: TeamProviderBackendId[] = [
  'auto',
  'adapter',
  'api',
  'cli-sdk',
  'codex-native',
  'opencode-cli',
];
const validPairs: Array<[TeamProviderId, TeamProviderBackendId]> = [
  ['codex', 'auto'],
  ['codex', 'adapter'],
  ['codex', 'api'],
  ['codex', 'codex-native'],
  ['gemini', 'auto'],
  ['gemini', 'api'],
  ['gemini', 'cli-sdk'],
  ['opencode', 'adapter'],
  ['opencode', 'opencode-cli'],
];
const validPairKeys = new Set(
  validPairs.map(([providerId, backendId]) => `${providerId}:${backendId}`)
);
const invalidPairs = (['anthropic', 'codex', 'gemini', 'opencode'] as TeamProviderId[]).flatMap(
  (providerId) =>
    backendIds
      .filter((backendId) => !validPairKeys.has(`${providerId}:${backendId}`))
      .map((backendId) => [providerId, backendId] as const)
);

describe('team IPC provider backend parsers', () => {
  it.each(['api', 'adapter', 'auto'] as const)(
    'preserves live explicit Codex backend %s for roster and launch requests',
    (providerBackendId) => {
      expect(parseOptionalProviderBackendId(providerBackendId, 'codex')).toEqual({
        valid: true,
        value: providerBackendId,
      });
      expect(parseOptionalLaunchProviderBackendId(providerBackendId, 'codex')).toEqual({
        valid: true,
        value: providerBackendId,
      });
    }
  );

  it.each(validPairs)(
    'accepts valid %s/%s pair over both IPC parser paths',
    (providerId, backendId) => {
      expect(parseOptionalProviderBackendId(backendId, providerId)).toEqual({
        valid: true,
        value: backendId,
      });
      expect(parseOptionalLaunchProviderBackendId(backendId, providerId)).toEqual({
        valid: true,
        value: backendId,
      });
    }
  );

  it.each(invalidPairs)(
    'rejects incompatible %s/%s pair over both IPC parser paths',
    (providerId, backendId) => {
      expect(parseOptionalProviderBackendId(backendId, providerId)).toMatchObject({ valid: false });
      expect(parseOptionalLaunchProviderBackendId(backendId, providerId)).toMatchObject({
        valid: false,
      });
    }
  );
});
