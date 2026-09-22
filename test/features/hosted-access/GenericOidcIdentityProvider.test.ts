import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

import { parseOidcLoginAttemptId } from '@features/hosted-access';
import {
  GenericOidcIdentityProvider,
  type GenericOidcIdentityProviderConfig,
} from '@features/hosted-access/main/infrastructure/GenericOidcIdentityProvider';
import { describe, expect, it } from 'vitest';

import type { JsonWebKey } from 'node:crypto';

const ISSUER = 'https://idp.test/realms/agent-teams';
const CLIENT_ID = 'agent-teams-hosted';
const REDIRECT_URI = 'https://agent-teams.test/api/auth/oidc/callback';
const NOW = 1_800_000_000_000;
const ATTEMPT_ID = parseOidcLoginAttemptId('ola_1234567890abcdef');
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- Registered OIDC event claim name.
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const secondJwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
  format: 'jwk',
});
const providerCrypto: GenericOidcIdentityProviderConfig['crypto'] = {
  randomBytes,
  base64UrlEncode: (bytes) => Buffer.from(bytes).toString('base64url'),
  sha256Base64Url: (value) => createHash('sha256').update(value).digest('base64url'),
  secureEqual: (left, right) => {
    const leftHash = createHash('sha256').update(left).digest();
    const rightHash = createHash('sha256').update(right).digest();
    return timingSafeEqual(leftHash, rightHash);
  },
  verifyOidcSignature: (input) => {
    const key = createPublicKey({ key: input.jwk as JsonWebKey, format: 'jwk' });
    let verificationKey: Parameters<typeof verifySignature>[2] = key;
    if (input.algorithm.startsWith('PS')) {
      verificationKey = {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: Number(input.algorithm.slice(-3)) / 8,
      };
    } else if (input.algorithm.startsWith('ES')) {
      verificationKey = { key, dsaEncoding: 'ieee-p1363' as const };
    }
    return verifySignature(
      input.algorithm === 'EdDSA' ? null : `sha${input.algorithm.slice(-3)}`,
      Buffer.from(input.signingInput),
      verificationKey,
      input.signature
    );
  },
};

function jwt(
  claims: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {}
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...headerOverrides })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function formBody(init: RequestInit | undefined): URLSearchParams {
  if (!(init?.body instanceof URLSearchParams)) throw new Error('expected_form_request_body');
  return init.body;
}

function providerHarness(
  override: Partial<GenericOidcIdentityProviderConfig> = {},
  claimsOverride: Record<string, unknown> = {},
  tokenResponseStatus = 200,
  metadataOverride: Record<string, unknown> = {},
  jwksOverride: readonly Record<string, unknown>[] = [
    { ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' },
  ]
) {
  const requests: { url: string; init?: RequestInit }[] = [];
  let nonce = '';
  let issuedIdToken = '';
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = requestUrl(input);
    requests.push({ url, init });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Promise.resolve(
        response({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
          ...metadataOverride,
        })
      );
    }
    if (url.endsWith('/protocol/openid-connect/certs')) {
      return Promise.resolve(response({ keys: jwksOverride }));
    }
    if (url.endsWith('/protocol/openid-connect/token')) {
      issuedIdToken = jwt({
        iss: ISSUER,
        sub: 'subject-123',
        aud: CLIENT_ID,
        exp: NOW / 1000 + 300,
        iat: NOW / 1000,
        nonce,
        sid: 'provider-session-1',
        name: 'Synthetic User',
        realm_access: { roles: ['agent-teams-member'] },
        ...claimsOverride,
      });
      return Promise.resolve(
        response(
          {
            id_token: issuedIdToken,
          },
          tokenResponseStatus
        )
      );
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const provider = new GenericOidcIdentityProvider({
    id: 'test-oidc',
    displayName: 'Test IdP',
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'client-secret',
    redirectUri: REDIRECT_URI,
    crypto: providerCrypto,
    roleMapping: {
      claimPath: 'realm_access.roles',
      owner: ['agent-teams-owner'],
      admin: ['agent-teams-admin'],
      member: ['agent-teams-member'],
      viewer: ['agent-teams-viewer'],
      defaultRole: 'viewer',
    },
    fetch,
    now: () => NOW,
    ...override,
  });
  return {
    provider,
    requests,
    setNonce(value: string) {
      nonce = value;
    },
    issuedIdToken() {
      return issuedIdToken;
    },
  };
}

describe('GenericOidcIdentityProvider', () => {
  it('uses authorization code, state, nonce and S256 PKCE and validates the ID token', async () => {
    const harness = providerHarness();
    const begun = await harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' });
    harness.setNonce(begun.nonce);
    const authorization = new URL(begun.redirectUrl);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('scope')).toBe('openid profile');
    expect(authorization.searchParams.get('state')).toBe(begun.state);
    expect(authorization.searchParams.get('nonce')).toBe(begun.nonce);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(begun.pkceVerifier).digest('base64url')
    );

    const claims = await harness.provider.completeLogin({
      attemptId: ATTEMPT_ID,
      expectedState: begun.state,
      nonce: begun.nonce,
      pkceVerifier: begun.pkceVerifier,
      callbackUrl: new URL(`${REDIRECT_URI}?code=synthetic&state=${begun.state}`),
    });
    expect(claims).toEqual({
      issuer: ISSUER,
      subject: 'subject-123',
      displayName: 'Synthetic User',
      role: 'member',
      providerSessionId: 'provider-session-1',
    });

    const exchange = harness.requests.find(({ url }) => url.endsWith('/token'));
    expect(formBody(exchange?.init).toString()).toContain(
      `code_verifier=${encodeURIComponent(begun.pkceVerifier)}`
    );
    expect((exchange?.init?.headers as Record<string, string>).authorization).toMatch(/^Basic /);
  });

  it('uses provider-advertised client_secret_post without placing the secret in headers', async () => {
    const harness = providerHarness({}, {}, 200, {
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
    const begun = await harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' });
    harness.setNonce(begun.nonce);
    await harness.provider.completeLogin({
      attemptId: ATTEMPT_ID,
      expectedState: begun.state,
      nonce: begun.nonce,
      pkceVerifier: begun.pkceVerifier,
      callbackUrl: new URL(`${REDIRECT_URI}?code=synthetic&state=${begun.state}`),
    });

    const exchange = harness.requests.find(({ url }) => url.endsWith('/token'));
    const headers = exchange?.init?.headers as Record<string, string>;
    const body = formBody(exchange?.init);
    expect(headers.authorization).toBeUndefined();
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe('client-secret');
  });

  it('uses none only for a public client', async () => {
    const publicHarness = providerHarness({ clientSecret: undefined }, {}, 200, {
      token_endpoint_auth_methods_supported: ['none'],
    });
    const begun = await publicHarness.provider.beginLogin({
      attemptId: ATTEMPT_ID,
      returnTo: '/',
    });
    publicHarness.setNonce(begun.nonce);
    await publicHarness.provider.completeLogin({
      attemptId: ATTEMPT_ID,
      expectedState: begun.state,
      nonce: begun.nonce,
      pkceVerifier: begun.pkceVerifier,
      callbackUrl: new URL(`${REDIRECT_URI}?code=synthetic&state=${begun.state}`),
    });
    const publicExchange = publicHarness.requests.find(({ url }) => url.endsWith('/token'));
    expect((publicExchange?.init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(formBody(publicExchange?.init).get('client_secret')).toBeNull();
  });

  it.each(['private_key_jwt', 'none'])(
    'rejects advertised %s instead of downgrading a configured confidential client',
    async (method) => {
      const unsupported = providerHarness({}, {}, 200, {
        token_endpoint_auth_methods_supported: [method],
      });
      const unsupportedLogin = await unsupported.provider.beginLogin({
        attemptId: ATTEMPT_ID,
        returnTo: '/',
      });
      unsupported.setNonce(unsupportedLogin.nonce);
      await expect(
        unsupported.provider.completeLogin({
          attemptId: ATTEMPT_ID,
          expectedState: unsupportedLogin.state,
          nonce: unsupportedLogin.nonce,
          pkceVerifier: unsupportedLogin.pkceVerifier,
          callbackUrl: new URL(`${REDIRECT_URI}?code=synthetic&state=${unsupportedLogin.state}`),
        })
      ).rejects.toThrow('oidc_token_auth_method_unsupported');
      expect(unsupported.requests.some(({ url }) => url.endsWith('/token'))).toBe(false);
    }
  );

  it.each(['client_secret_basic', [], ['client_secret_basic', 42], ['client_secret_\nbasic']])(
    'rejects malformed token endpoint authentication metadata %#',
    async (methods) => {
      const harness = providerHarness({}, {}, 200, {
        token_endpoint_auth_methods_supported: methods,
      });
      await expect(
        harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' })
      ).rejects.toThrow('oidc_metadata_invalid');
    }
  );

  it('keeps OIDC semantics when custom scopes omit or duplicate openid', async () => {
    const harness = providerHarness({ scopes: ['profile', 'email', 'profile'] });
    const begun = await harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' });
    expect(new URL(begun.redirectUrl).searchParams.get('scope')).toBe('openid profile email');
  });

  it('accepts profile-rich ID tokens above 1 KiB and rejects compact JWTs above 128 KiB', async () => {
    const profileHarness = providerHarness(
      {},
      {
        groups: Array.from(
          { length: 64 },
          (_, index) => `/engineering/agent-teams/service-${String(index).padStart(2, '0')}`
        ),
      }
    );
    const profileLogin = await profileHarness.provider.beginLogin({
      attemptId: ATTEMPT_ID,
      returnTo: '/',
    });
    profileHarness.setNonce(profileLogin.nonce);
    await expect(
      profileHarness.provider.completeLogin({
        attemptId: ATTEMPT_ID,
        expectedState: profileLogin.state,
        nonce: profileLogin.nonce,
        pkceVerifier: profileLogin.pkceVerifier,
        callbackUrl: new URL(
          `${REDIRECT_URI}?code=synthetic&state=${encodeURIComponent(profileLogin.state)}`
        ),
      })
    ).resolves.toMatchObject({ role: 'member' });
    expect(Buffer.byteLength(profileHarness.issuedIdToken(), 'utf8')).toBeGreaterThan(1024);
    expect(Buffer.byteLength(profileHarness.issuedIdToken(), 'utf8')).toBeLessThanOrEqual(
      128 * 1024
    );

    const oversizedHarness = providerHarness({}, { groups: ['x'.repeat(128 * 1024)] });
    const oversizedLogin = await oversizedHarness.provider.beginLogin({
      attemptId: ATTEMPT_ID,
      returnTo: '/',
    });
    oversizedHarness.setNonce(oversizedLogin.nonce);
    await expect(
      oversizedHarness.provider.completeLogin({
        attemptId: ATTEMPT_ID,
        expectedState: oversizedLogin.state,
        nonce: oversizedLogin.nonce,
        pkceVerifier: oversizedLogin.pkceVerifier,
        callbackUrl: new URL(
          `${REDIRECT_URI}?code=synthetic&state=${encodeURIComponent(oversizedLogin.state)}`
        ),
      })
    ).rejects.toThrow('oidc_token_malformed');
    expect(Buffer.byteLength(oversizedHarness.issuedIdToken(), 'utf8')).toBeGreaterThan(128 * 1024);
  });

  it.each([
    { scopes: ['profile email'] },
    { scopes: ['profile', 'bad\\scope'] },
    { issuer: `${ISSUER}?tenant=attacker` },
    { issuer: `${ISSUER}#fragment` },
    { redirectUri: `${REDIRECT_URI}#fragment` },
  ])('rejects malformed OIDC configuration %#', (override) => {
    expect(() => providerHarness(override)).toThrow(
      /^oidc_(?:scopes|issuer|redirect_uri)_invalid$/
    );
  });

  it('rejects owner as a runtime default even if an untyped caller bypasses the contract', () => {
    expect(() =>
      providerHarness({
        roleMapping: {
          claimPath: 'realm_access.roles',
          owner: ['agent-teams-owner'],
          admin: [],
          member: [],
          viewer: [],
          defaultRole: 'owner',
        } as never,
      })
    ).toThrow('oidc_default_role_invalid');
  });

  it('rejects ambiguous or malformed role mappings before contacting the provider', () => {
    expect(() =>
      providerHarness({
        roleMapping: {
          claimPath: 'realm_access.roles',
          owner: ['shared-role'],
          admin: [],
          member: ['shared-role'],
          viewer: [],
          defaultRole: 'viewer',
        },
      })
    ).toThrow('oidc_role_mapping_ambiguous');
    expect(() =>
      providerHarness({
        roleMapping: {
          claimPath: 'realm_access..roles',
          owner: [],
          admin: [],
          member: [],
          viewer: [],
          defaultRole: 'viewer',
        },
      })
    ).toThrow('oidc_role_claim_path_invalid');
    expect(() =>
      providerHarness({
        roleMapping: {
          claimPath: 'realm_access.roles',
          owner: [],
          admin: [],
          member: ['member\u0000role'],
          viewer: [],
          defaultRole: 'viewer',
        },
      })
    ).toThrow('oidc_role_mapping_invalid');
  });

  it('uses an immutable validated role mapping snapshot', async () => {
    const memberRoles = ['agent-teams-member'];
    const harness = providerHarness({
      roleMapping: {
        claimPath: 'realm_access.roles',
        owner: [],
        admin: [],
        member: memberRoles,
        viewer: [],
        defaultRole: 'viewer',
      },
    });
    memberRoles[0] = 'mutated-after-composition';
    const begun = await harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' });
    harness.setNonce(begun.nonce);

    await expect(
      harness.provider.completeLogin({
        attemptId: ATTEMPT_ID,
        expectedState: begun.state,
        nonce: begun.nonce,
        pkceVerifier: begun.pkceVerifier,
        callbackUrl: new URL(`${REDIRECT_URI}?code=synthetic&state=${begun.state}`),
      })
    ).resolves.toMatchObject({ role: 'member' });
  });

  it('rejects state mismatch before exchanging a code', async () => {
    const harness = providerHarness();
    const begun = await harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' });
    await expect(
      harness.provider.completeLogin({
        attemptId: ATTEMPT_ID,
        expectedState: begun.state,
        nonce: begun.nonce,
        pkceVerifier: begun.pkceVerifier,
        callbackUrl: new URL(`${REDIRECT_URI}?code=synthetic&state=attacker`),
      })
    ).rejects.toThrow('oidc_state_mismatch');
    expect(harness.requests.filter(({ url }) => url.endsWith('/token'))).toHaveLength(0);
  });

  it.each([
    ['a callback on a different origin', 'wrong-origin'],
    ['duplicate state parameters', 'duplicate-state'],
    ['duplicate authorization codes', 'duplicate-code'],
    ['mixed authorization code and error parameters', 'mixed-result'],
  ])('rejects %s before exchanging a code', async (_description, scenario) => {
    const harness = providerHarness();
    const begun = await harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' });
    let callbackUrl: URL;
    switch (scenario) {
      case 'wrong-origin':
        callbackUrl = new URL(
          `https://attacker.test/api/auth/oidc/callback?code=synthetic&state=${begun.state}`
        );
        break;
      case 'duplicate-state':
        callbackUrl = new URL(
          `${REDIRECT_URI}?code=synthetic&state=${begun.state}&state=${begun.state}`
        );
        break;
      case 'duplicate-code':
        callbackUrl = new URL(`${REDIRECT_URI}?code=synthetic&code=attacker&state=${begun.state}`);
        break;
      default:
        callbackUrl = new URL(
          `${REDIRECT_URI}?code=synthetic&error=access_denied&state=${begun.state}`
        );
    }
    await expect(
      harness.provider.completeLogin({
        attemptId: ATTEMPT_ID,
        expectedState: begun.state,
        nonce: begun.nonce,
        pkceVerifier: begun.pkceVerifier,
        callbackUrl,
      })
    ).rejects.toThrow(
      scenario === 'wrong-origin' ? 'oidc_callback_url_invalid' : 'oidc_callback_parameters_invalid'
    );
    expect(harness.requests.filter(({ url }) => url.endsWith('/token'))).toHaveLength(0);
  });

  it.each([
    [{ nonce: 'wrong' }, 'oidc_token_nonce_invalid'],
    [{ iss: 'https://attacker.test' }, 'oidc_token_issuer_invalid'],
    [{ aud: 'other-client' }, 'oidc_token_audience_invalid'],
    [{ azp: 'other-client' }, 'oidc_token_audience_invalid'],
    [{ exp: NOW / 1000 - 120 }, 'oidc_token_expiry_invalid'],
    [{ exp: NOW / 1000 + 25 * 60 * 60 }, 'oidc_token_expiry_invalid'],
    [{ iat: NOW / 1000 - 25 * 60 * 60 }, 'oidc_token_expiry_invalid'],
    [{ iat: undefined }, 'oidc_token_expiry_invalid'],
    [{ nbf: NOW / 1000 + 120 }, 'oidc_token_expiry_invalid'],
  ])('rejects invalid claims %#', async (override, error) => {
    const harness = providerHarness({}, override);
    const begun = await harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' });
    harness.setNonce(begun.nonce);
    await expect(
      harness.provider.completeLogin({
        attemptId: ATTEMPT_ID,
        expectedState: begun.state,
        nonce: begun.nonce,
        pkceVerifier: begun.pkceVerifier,
        callbackUrl: new URL(`${REDIRECT_URI}?code=synthetic&state=${begun.state}`),
      })
    ).rejects.toThrow(error);
  });

  it('validates a signed back-channel logout event', async () => {
    const harness = providerHarness();
    const logout = jwt({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'subject-123',
      sid: 'provider-session-1',
      jti: 'logout-1',
      iat: NOW / 1000,
      exp: NOW / 1000 + 120,
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    });
    await expect(harness.provider.verifyBackchannelLogout(logout)).resolves.toEqual({
      issuer: ISSUER,
      subject: 'subject-123',
      providerSessionId: 'provider-session-1',
      jti: 'logout-1',
      expiresAt: NOW + 180_000,
    });
  });

  it('rejects a missing kid before verification when multiple signing keys are compatible', async () => {
    let verificationAttempts = 0;
    const harness = providerHarness(
      {
        crypto: {
          ...providerCrypto,
          verifyOidcSignature: (input) => {
            verificationAttempts += 1;
            return providerCrypto.verifyOidcSignature(input);
          },
        },
      },
      {},
      200,
      {},
      [
        { ...jwk, kid: 'first-key', alg: 'RS256', use: 'sig' },
        { ...secondJwk, kid: 'second-key', alg: 'RS256', use: 'sig' },
      ]
    );
    const logout = jwt(
      {
        iss: ISSUER,
        aud: CLIENT_ID,
        sid: 'provider-session-1',
        jti: 'logout-missing-kid',
        iat: NOW / 1000,
        exp: NOW / 1000 + 120,
        events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      },
      { kid: undefined }
    );

    await expect(harness.provider.verifyBackchannelLogout(logout)).rejects.toThrow(
      'oidc_token_key_id_ambiguous'
    );
    expect(verificationAttempts).toBe(0);
  });

  it('rejects a stale back-channel logout token even before durable replay consumption', async () => {
    const harness = providerHarness();
    const logout = jwt({
      iss: ISSUER,
      aud: CLIENT_ID,
      sid: 'provider-session-1',
      jti: 'logout-stale',
      iat: NOW / 1000 - 400,
      exp: NOW / 1000 + 120,
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    });
    await expect(harness.provider.verifyBackchannelLogout(logout)).rejects.toThrow(
      'oidc_backchannel_iat_invalid'
    );
  });

  it('rejects a back-channel logout event with a non-empty event value', async () => {
    const harness = providerHarness();
    const logout = jwt({
      iss: ISSUER,
      aud: CLIENT_ID,
      sid: 'provider-session-1',
      jti: 'logout-malformed-event',
      iat: NOW / 1000,
      exp: NOW / 1000 + 120,
      events: {
        [BACKCHANNEL_LOGOUT_EVENT]: { attackerControlled: true },
      },
    });
    await expect(harness.provider.verifyBackchannelLogout(logout)).rejects.toThrow(
      'oidc_backchannel_events_invalid'
    );
  });

  it('rejects symmetric JWT algorithms before consulting provider keys', async () => {
    const harness = providerHarness();
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        sid: 'provider-session-1',
        jti: 'logout-symmetric',
        iat: NOW / 1000,
        exp: NOW / 1000 + 120,
        events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      })
    ).toString('base64url');
    await expect(
      harness.provider.verifyBackchannelLogout(`${header}.${claims}.forged`)
    ).rejects.toThrow('oidc_token_algorithm_invalid');
  });

  it.each([{ crit: ['exp'] }, { b64: false }, { crit: [], b64: true }])(
    'rejects unsupported critical JOSE header semantics %#',
    async (header) => {
      const harness = providerHarness();
      const logout = jwt(
        {
          iss: ISSUER,
          aud: CLIENT_ID,
          sid: 'provider-session-1',
          jti: 'logout-critical-header',
          iat: NOW / 1000,
          exp: NOW / 1000 + 120,
          events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
        },
        header
      );
      await expect(harness.provider.verifyBackchannelLogout(logout)).rejects.toThrow(
        'oidc_token_critical_header_unsupported'
      );
    }
  );

  it('returns an explicit IdP unavailable error and never changes mode', async () => {
    const harness = providerHarness({
      fetch: () => Promise.reject(new Error('offline')),
    });
    await expect(
      harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' })
    ).rejects.toThrow('oidc_provider_unavailable');
  });

  it.each([408, 425, 429, 500, 503])(
    'classifies retryable token endpoint status %i as explicitly unavailable',
    async (status) => {
      const harness = providerHarness({}, {}, status);
      const begun = await harness.provider.beginLogin({ attemptId: ATTEMPT_ID, returnTo: '/' });
      await expect(
        harness.provider.completeLogin({
          attemptId: ATTEMPT_ID,
          expectedState: begun.state,
          nonce: begun.nonce,
          pkceVerifier: begun.pkceVerifier,
          callbackUrl: new URL(`${REDIRECT_URI}?code=synthetic&state=${begun.state}`),
        })
      ).rejects.toThrow('oidc_provider_unavailable');
    }
  );
});
