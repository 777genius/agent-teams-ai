import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  revokeApiAuthorityHints,
  selectApiAuthorityHints,
} from '../../../src/features/local-http-auth/main/infrastructure/apiAuthorityParentHints';
import { RetainedApiPublicationError } from '../../../src/features/local-http-auth/main/infrastructure/authorityErrors';
import { apiProfileScope } from '../../../src/features/local-http-auth/main/infrastructure/authorityPaths';
import {
  publishApiAuthority,
  removeApiAuthority,
} from '../../../src/features/local-http-auth/main/infrastructure/authorityStore';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock(
  '../../../src/features/local-http-auth/main/infrastructure/publicationHelperClient',
  () => ({
    requestPublication: mocks.request,
    publicationRootMode: () => 'existing',
  }),
);
const root = '/private/profile';
function authority() {
  return {
    schemaVersion: 1 as const,
    service: 'api' as const,
    profileScope: apiProfileScope(root),
    instanceId: randomUUID(),
    generation: randomUUID(),
    baseUrl: 'http://127.0.0.1:1234',
    token: 'x'.repeat(32),
  };
}
const keys = [
  'CLAUDE_TEAM_CONTROL_AUTH_REF',
  'CLAUDE_TEAM_CONTROL_AUTH_TOKEN',
  'CLAUDE_TEAM_CONTROL_URL',
];
const saved = keys.map((key) => process.env[key]);
afterEach(() => {
  revokeApiAuthorityHints();
  keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  });
  vi.clearAllMocks();
});
describe('authority publication parent facade', () => {
  it('derives reference locally and preserves retained error identity with fixed cause', async () => {
    const input = authority();
    mocks.request.mockResolvedValue({
      outcome: 'published',
      code: 'none',
      hintAction: 'keep',
    });
    const reference = await publishApiAuthority(root, input);
    expect(reference).toBe(
      `${root}/local-http-auth/api-${input.instanceId}.ref.json`,
    );
    mocks.request.mockResolvedValue({
      outcome: 'retained',
      code: 'retained-discovery',
      hintAction: 'keep',
    });
    const error = await publishApiAuthority(root, input).catch(
      (value) => value,
    );
    expect(error).toBeInstanceOf(RetainedApiPublicationError);
    expect(error.referencePath).toBe(reference);
    expect(JSON.stringify(error)).not.toContain(input.token);
  });
  it('preserves the fixed immutable failure and never accepts a child-returned path', async () => {
    mocks.request.mockResolvedValue({
      outcome: 'failed',
      code: 'immutable-generation',
      hintAction: 'keep',
    });
    await expect(publishApiAuthority(root, authority())).rejects.toThrow(
      'immutable',
    );
  });
  it('revokes exact current hints even after cleanup failure but preserves a newer identical selection epoch', async () => {
    const input = authority();
    const reference = `${root}/local-http-auth/api-${input.instanceId}.ref.json`;
    selectApiAuthorityHints(root, input, reference);
    mocks.request.mockResolvedValue({
      outcome: 'failed',
      code: 'storage-failed',
      hintAction: 'revoke-matching',
    });
    await expect(removeApiAuthority(root, input)).rejects.toThrow(
      'removal failed',
    );
    expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBeUndefined();
    selectApiAuthorityHints(root, input, reference);
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldRemoval = removeApiAuthority(root, input);
    // Identical bytes are a fresh owner decision, so a stale result cannot revoke them.
    selectApiAuthorityHints(root, input, reference);
    finish({ outcome: 'removed', code: 'none', hintAction: 'revoke-matching' });
    await oldRemoval;
    expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_REF).toBe(reference);
    expect(process.env.CLAUDE_TEAM_CONTROL_AUTH_TOKEN).toBe(input.token);
  });
});
