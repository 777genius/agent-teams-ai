import { isHostedRole } from '../../core/domain';

import type { HostedRole } from '../../contracts';
import type {
  HostedAuthHostPlatform,
  IdentityProviderBackchannelLogout,
  IdentityProviderBeginContext,
  IdentityProviderBeginResult,
  IdentityProviderClaims,
  IdentityProviderCompleteContext,
  IdentityProviderLogoutContext,
  OidcIdentityProvider,
} from '../../core/application';

interface OidcMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
  readonly token_endpoint_auth_methods_supported?: readonly string[];
}

interface JsonWebKey {
  readonly kid?: string;
  readonly kty: string;
  readonly alg?: string;
  readonly use?: string;
  readonly [key: string]: unknown;
}

interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
  readonly crit?: unknown;
  readonly b64?: unknown;
}

interface JwtClaims {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly azp?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly nbf?: unknown;
  readonly nonce?: unknown;
  readonly sid?: unknown;
  readonly jti?: unknown;
  readonly events?: unknown;
  readonly name?: unknown;
  readonly preferred_username?: unknown;
  readonly email?: unknown;
  readonly [key: string]: unknown;
}

export interface GenericOidcRoleMapping {
  readonly claimPath: string;
  readonly owner: readonly string[];
  readonly admin: readonly string[];
  readonly member: readonly string[];
  readonly viewer: readonly string[];
  readonly defaultRole: Exclude<HostedRole, 'owner'>;
}

export interface GenericOidcIdentityProviderConfig {
  readonly id: string;
  readonly displayName: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly roleMapping: GenericOidcRoleMapping;
  readonly crypto: Pick<
    HostedAuthHostPlatform,
    'base64UrlEncode' | 'randomBytes' | 'secureEqual' | 'sha256Base64Url' | 'verifyOidcSignature'
  >;
  readonly clockSkewSeconds?: number;
  readonly metadataCacheMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly allowInsecureHttpForTests?: boolean;
}

const SIGNATURE_ALGORITHMS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);
const MAXIMUM_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MAXIMUM_COMPACT_JWT_BYTES = 128 * 1024;
const MAXIMUM_OIDC_JSON_BYTES = 1024 * 1024;
const MAXIMUM_OIDC_SCOPES = 64;
const MAXIMUM_OIDC_SCOPE_LENGTH = 4_096;
const MAXIMUM_TOKEN_ENDPOINT_AUTH_METHODS = 32;
const MAXIMUM_TOKEN_ENDPOINT_AUTH_METHOD_LENGTH = 128;
const MAXIMUM_ROLE_CLAIM_PATH_LENGTH = 512;
const MAXIMUM_ROLE_CLAIM_SEGMENT_LENGTH = 128;
const MAXIMUM_ROLE_MAPPING_VALUES = 256;
const MAXIMUM_ROLE_MAPPING_VALUES_PER_ROLE = 128;
const MAXIMUM_ROLE_MAPPING_VALUE_LENGTH = 256;
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- Registered OIDC event claim name; no network request.
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

function formEncodeCredential(value: string): string {
  return new URLSearchParams([['credential', value]]).toString().slice('credential='.length);
}

function parseJsonObject(value: string, errorCode: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(errorCode);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(errorCode);
  }
}

async function readJsonObject(
  response: Response,
  errorCode: string
): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_OIDC_JSON_BYTES) ||
    response.body === null
  ) {
    throw new Error(errorCode);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAXIMUM_OIDC_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(errorCode);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error('oidc_provider_unavailable');
  }
  return parseJsonObject(
    Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      length
    ).toString('utf8'),
    errorCode
  );
}

function decodeJwt(token: string): {
  readonly signingInput: string;
  readonly signature: Uint8Array;
  readonly header: JwtHeader;
  readonly claims: JwtClaims;
} {
  if (Buffer.byteLength(token, 'utf8') > MAXIMUM_COMPACT_JWT_BYTES) {
    throw new Error('oidc_token_malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('oidc_token_malformed');
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (!encodedHeader || !encodedClaims || !encodedSignature) {
    throw new Error('oidc_token_malformed');
  }
  const header = parseJsonObject(
    Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    'oidc_token_header_invalid'
  );
  const claims = parseJsonObject(
    Buffer.from(encodedClaims, 'base64url').toString('utf8'),
    'oidc_token_claims_invalid'
  );
  if (typeof header.alg !== 'string' || !SIGNATURE_ALGORITHMS.has(header.alg)) {
    throw new Error('oidc_token_algorithm_invalid');
  }
  if (header.kid !== undefined && typeof header.kid !== 'string') {
    throw new Error('oidc_token_key_id_invalid');
  }
  if (header.crit !== undefined || header.b64 !== undefined) {
    // This implementation supports only the compact JWT profile used by OIDC.
    // JWS extensions named by `crit` cannot be ignored, and RFC 7797 `b64`
    // changes the signing-input semantics even when it is not listed correctly.
    throw new Error('oidc_token_critical_header_unsupported');
  }
  return {
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature: Buffer.from(encodedSignature, 'base64url'),
    header: header as unknown as JwtHeader,
    claims,
  };
}

function claimStrings(claims: JwtClaims, path: string): readonly string[] {
  let value: unknown = claims;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    if (!Object.hasOwn(value, segment)) return [];
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value === 'string') return Object.freeze([value]);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return Object.freeze([...value]);
  }
  return [];
}

function mappedRole(claims: JwtClaims, mapping: GenericOidcRoleMapping): HostedRole {
  const values = new Set(claimStrings(claims, mapping.claimPath));
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
    if (mapping[role].some((value) => values.has(value))) return role;
  }
  return mapping.defaultRole;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function validateGenericOidcRoleMapping(
  mapping: GenericOidcRoleMapping
): GenericOidcRoleMapping {
  const runtimeDefaultRole: unknown = mapping.defaultRole;
  if (!isHostedRole(runtimeDefaultRole) || runtimeDefaultRole === 'owner') {
    throw new Error('oidc_default_role_invalid');
  }
  if (
    typeof mapping.claimPath !== 'string' ||
    mapping.claimPath.length === 0 ||
    mapping.claimPath.length > MAXIMUM_ROLE_CLAIM_PATH_LENGTH ||
    hasControlCharacter(mapping.claimPath)
  ) {
    throw new Error('oidc_role_claim_path_invalid');
  }
  const claimSegments = mapping.claimPath.split('.');
  if (
    claimSegments.some(
      (segment) => segment.length === 0 || segment.length > MAXIMUM_ROLE_CLAIM_SEGMENT_LENGTH
    )
  ) {
    throw new Error('oidc_role_claim_path_invalid');
  }

  const roles = ['owner', 'admin', 'member', 'viewer'] as const;
  const observedValues = new Map<string, HostedRole>();
  let valueCount = 0;
  const validated = Object.fromEntries(
    roles.map((role) => {
      const values: unknown = mapping[role];
      if (!Array.isArray(values) || values.length > MAXIMUM_ROLE_MAPPING_VALUES_PER_ROLE) {
        throw new Error('oidc_role_mapping_invalid');
      }
      const unique = new Set<string>();
      for (const value of values) {
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > MAXIMUM_ROLE_MAPPING_VALUE_LENGTH ||
          hasControlCharacter(value)
        ) {
          throw new Error('oidc_role_mapping_invalid');
        }
        const observedRole = observedValues.get(value);
        if (observedRole !== undefined && observedRole !== role) {
          throw new Error('oidc_role_mapping_ambiguous');
        }
        observedValues.set(value, role);
        unique.add(value);
      }
      valueCount += unique.size;
      return [role, Object.freeze([...unique])] as const;
    })
  ) as unknown as Pick<GenericOidcRoleMapping, 'owner' | 'admin' | 'member' | 'viewer'>;
  if (valueCount > MAXIMUM_ROLE_MAPPING_VALUES) {
    throw new Error('oidc_role_mapping_invalid');
  }
  return Object.freeze({
    claimPath: mapping.claimPath,
    ...validated,
    defaultRole: runtimeDefaultRole,
  });
}

function stringClaim(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new Error(code);
  }
  return value;
}

function isOAuthScopeToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code === 0x21 || (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e);
  });
}

function isCompatibleSigningKey(key: JsonWebKey, algorithm: string): boolean {
  const expectedKeyType =
    algorithm.startsWith('RS') || algorithm.startsWith('PS')
      ? 'RSA'
      : algorithm.startsWith('ES')
        ? 'EC'
        : 'OKP';
  return (
    key.kty === expectedKeyType &&
    (key.alg === undefined || key.alg === algorithm) &&
    (key.use === undefined || key.use === 'sig')
  );
}

type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

function tokenEndpointAuthMethod(
  metadata: OidcMetadata,
  hasClientSecret: boolean
): TokenEndpointAuthMethod {
  const advertised = metadata.token_endpoint_auth_methods_supported;
  if (advertised === undefined) return hasClientSecret ? 'client_secret_basic' : 'none';
  if (hasClientSecret) {
    if (advertised.includes('client_secret_basic')) return 'client_secret_basic';
    if (advertised.includes('client_secret_post')) return 'client_secret_post';
  } else if (advertised.includes('none')) {
    return 'none';
  }
  throw new Error('oidc_token_auth_method_unsupported');
}

export class GenericOidcIdentityProvider implements OidcIdentityProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly scopes: readonly string[];
  private readonly roleMapping: GenericOidcRoleMapping;
  private metadataCache: { readonly value: OidcMetadata; readonly expiresAt: number } | null = null;
  private jwksCache: { readonly value: readonly JsonWebKey[]; readonly expiresAt: number } | null =
    null;
  private lastUnknownKidRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly config: GenericOidcIdentityProviderConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.roleMapping = validateGenericOidcRoleMapping(config.roleMapping);
    this.assertUrl(config.issuer, 'oidc_issuer_invalid', false);
    this.assertUrl(config.redirectUri, 'oidc_redirect_uri_invalid', true);
    const configuredScopes = config.scopes ?? ['openid', 'profile'];
    if (
      configuredScopes.length > MAXIMUM_OIDC_SCOPES ||
      configuredScopes.some((scope) => !isOAuthScopeToken(scope))
    ) {
      throw new Error('oidc_scopes_invalid');
    }
    this.scopes = Object.freeze([...new Set(['openid', ...configuredScopes])]);
    if (this.scopes.join(' ').length > MAXIMUM_OIDC_SCOPE_LENGTH) {
      throw new Error('oidc_scopes_invalid');
    }
  }

  async beginLogin(context: IdentityProviderBeginContext): Promise<IdentityProviderBeginResult> {
    const metadata = await this.metadata();
    const state = this.config.crypto.base64UrlEncode(this.config.crypto.randomBytes(32));
    const nonce = this.config.crypto.base64UrlEncode(this.config.crypto.randomBytes(32));
    const pkceVerifier = this.config.crypto.base64UrlEncode(this.config.crypto.randomBytes(64));
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.searchParams.set('client_id', this.config.clientId);
    authorization.searchParams.set('redirect_uri', this.config.redirectUri);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('scope', this.scopes.join(' '));
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('nonce', nonce);
    authorization.searchParams.set(
      'code_challenge',
      this.config.crypto.sha256Base64Url(pkceVerifier)
    );
    authorization.searchParams.set('code_challenge_method', 'S256');
    return Object.freeze({
      redirectUrl: authorization.toString(),
      attemptId: context.attemptId,
      state,
      nonce,
      pkceVerifier,
    });
  }

  async completeLogin(context: IdentityProviderCompleteContext): Promise<IdentityProviderClaims> {
    const expectedCallback = new URL(this.config.redirectUri);
    if (
      context.callbackUrl.origin !== expectedCallback.origin ||
      context.callbackUrl.pathname !== expectedCallback.pathname ||
      context.callbackUrl.hash !== ''
    ) {
      throw new Error('oidc_callback_url_invalid');
    }
    const callbackStates = context.callbackUrl.searchParams.getAll('state');
    const codes = context.callbackUrl.searchParams.getAll('code');
    const errors = context.callbackUrl.searchParams.getAll('error');
    if (
      callbackStates.length !== 1 ||
      codes.length > 1 ||
      errors.length > 1 ||
      (codes.length > 0 && errors.length > 0)
    ) {
      throw new Error('oidc_callback_parameters_invalid');
    }
    const callbackState = callbackStates[0];
    const error = errors[0];
    if (!this.config.crypto.secureEqual(callbackState, context.expectedState)) {
      throw new Error('oidc_state_mismatch');
    }
    if (error) throw new Error('oidc_provider_error');
    const code = codes[0];
    if (!code) throw new Error('oidc_authorization_code_missing');

    const metadata = await this.metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: context.pkceVerifier,
    });
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const authenticationMethod = tokenEndpointAuthMethod(
      metadata,
      Boolean(this.config.clientSecret)
    );
    if (authenticationMethod === 'client_secret_basic') {
      headers.authorization = `Basic ${Buffer.from(
        `${formEncodeCredential(this.config.clientId)}:${formEncodeCredential(
          this.config.clientSecret!
        )}`
      ).toString('base64')}`;
      body.delete('client_id');
    } else if (authenticationMethod === 'client_secret_post') {
      body.set('client_secret', this.config.clientSecret!);
    }
    const response = await this.fetch(metadata.token_endpoint, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
    });
    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new Error('oidc_provider_unavailable');
    }
    if (!response.ok) throw new Error('oidc_token_exchange_rejected');
    const tokenResponse = await readJsonObject(response, 'oidc_token_response_invalid');
    if (typeof tokenResponse.id_token !== 'string' || tokenResponse.id_token.length === 0) {
      throw new Error('oidc_id_token_missing');
    }
    const idToken = tokenResponse.id_token;
    const claims = await this.verifyJwt(idToken, context.nonce);
    const issuer = stringClaim(claims.iss, 'oidc_issuer_missing');
    const subject = stringClaim(claims.sub, 'oidc_subject_missing');
    const displayName = [claims.name, claims.preferred_username, claims.email, subject].find(
      (value): value is string => typeof value === 'string' && value.length > 0
    )!;
    return Object.freeze({
      issuer,
      subject,
      displayName: displayName.slice(0, 256),
      role: mappedRole(claims, this.roleMapping),
      providerSessionId: typeof claims.sid === 'string' ? claims.sid : null,
    });
  }

  async logout(
    context: IdentityProviderLogoutContext
  ): Promise<{ readonly redirectUrl: string | null }> {
    const endpoint = (await this.metadata()).end_session_endpoint;
    if (!endpoint) return Object.freeze({ redirectUrl: null });
    const url = new URL(endpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('post_logout_redirect_uri', context.postLogoutRedirectUri);
    return Object.freeze({ redirectUrl: url.toString() });
  }

  async verifyBackchannelLogout(token: string): Promise<IdentityProviderBackchannelLogout> {
    const claims = await this.verifyJwt(token, null);
    if (
      typeof claims.events !== 'object' ||
      claims.events === null ||
      Array.isArray(claims.events) ||
      !Object.hasOwn(claims.events, BACKCHANNEL_LOGOUT_EVENT) ||
      claims.nonce !== undefined
    ) {
      throw new Error('oidc_backchannel_events_invalid');
    }
    const logoutEvent = (claims.events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
    if (
      typeof logoutEvent !== 'object' ||
      logoutEvent === null ||
      Array.isArray(logoutEvent) ||
      Reflect.ownKeys(logoutEvent).length !== 0
    ) {
      throw new Error('oidc_backchannel_events_invalid');
    }
    const issuer = stringClaim(claims.iss, 'oidc_issuer_missing');
    const subject =
      claims.sub === undefined
        ? undefined
        : stringClaim(claims.sub, 'oidc_backchannel_subject_invalid');
    const providerSessionId =
      claims.sid === undefined
        ? undefined
        : stringClaim(claims.sid, 'oidc_backchannel_session_invalid');
    if (!subject && !providerSessionId) throw new Error('oidc_backchannel_subject_missing');
    const nowSeconds = Math.floor((this.config.now?.() ?? Date.now()) / 1000);
    const skew = this.config.clockSkewSeconds ?? 60;
    if (
      typeof claims.iat !== 'number' ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat < nowSeconds - 5 * 60 - skew
    ) {
      throw new Error('oidc_backchannel_iat_invalid');
    }
    return Object.freeze({
      issuer,
      subject,
      providerSessionId,
      jti: stringClaim(claims.jti, 'oidc_backchannel_jti_missing'),
      // Retain replay state through the same validation leeway that can admit
      // a just-expired token.
      expiresAt: (Number(claims.exp) + skew) * 1000,
    });
  }

  private async verifyJwt(token: string, expectedNonce: string | null): Promise<JwtClaims> {
    const decoded = decodeJwt(token);
    const verificationNow = this.config.now?.() ?? Date.now();
    const usedCachedJwks = this.jwksCache !== null && verificationNow < this.jwksCache.expiresAt;
    let keys = await this.jwks();
    let candidates = keys.filter(
      (key) =>
        (decoded.header.kid === undefined || key.kid === decoded.header.kid) &&
        isCompatibleSigningKey(key, decoded.header.alg)
    );
    if (decoded.header.kid === undefined && candidates.length > 1) {
      throw new Error('oidc_token_key_id_ambiguous');
    }
    if (
      candidates.length === 0 &&
      decoded.header.kid !== undefined &&
      usedCachedJwks &&
      verificationNow - this.lastUnknownKidRefreshAt >= 60_000
    ) {
      this.lastUnknownKidRefreshAt = verificationNow;
      this.jwksCache = null;
      keys = await this.jwks();
      candidates = keys.filter(
        (key) => key.kid === decoded.header.kid && isCompatibleSigningKey(key, decoded.header.alg)
      );
    }
    const verified = candidates.some((key) => {
      try {
        return this.config.crypto.verifyOidcSignature({
          algorithm: decoded.header.alg,
          jwk: key,
          signingInput: decoded.signingInput,
          signature: decoded.signature,
        });
      } catch {
        return false;
      }
    });
    if (!verified) throw new Error('oidc_token_signature_invalid');

    const metadata = await this.metadata();
    const claims = decoded.claims;
    if (claims.iss !== metadata.issuer || claims.iss !== this.config.issuer) {
      throw new Error('oidc_token_issuer_invalid');
    }
    const audiences =
      typeof claims.aud === 'string'
        ? [claims.aud]
        : Array.isArray(claims.aud) && claims.aud.every((value) => typeof value === 'string')
          ? claims.aud
          : [];
    if (
      !audiences.includes(this.config.clientId) ||
      (claims.azp !== undefined && claims.azp !== this.config.clientId) ||
      (audiences.length > 1 && claims.azp !== this.config.clientId)
    ) {
      throw new Error('oidc_token_audience_invalid');
    }
    const nowSeconds = Math.floor((this.config.now?.() ?? Date.now()) / 1000);
    const skew = this.config.clockSkewSeconds ?? 60;
    if (
      typeof claims.exp !== 'number' ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= nowSeconds - skew ||
      claims.exp > nowSeconds + MAXIMUM_TOKEN_LIFETIME_SECONDS + skew ||
      typeof claims.iat !== 'number' ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat > nowSeconds + skew ||
      claims.iat >= claims.exp ||
      claims.exp - claims.iat > MAXIMUM_TOKEN_LIFETIME_SECONDS ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' ||
          !Number.isSafeInteger(claims.nbf) ||
          claims.nbf > nowSeconds + skew))
    ) {
      throw new Error('oidc_token_expiry_invalid');
    }
    if (
      expectedNonce !== null &&
      (typeof claims.nonce !== 'string' ||
        !this.config.crypto.secureEqual(claims.nonce, expectedNonce))
    ) {
      throw new Error('oidc_token_nonce_invalid');
    }
    return claims;
  }

  private async metadata(): Promise<OidcMetadata> {
    const now = this.config.now?.() ?? Date.now();
    if (this.metadataCache && now < this.metadataCache.expiresAt) {
      return this.metadataCache.value;
    }
    const issuer = this.config.issuer.replace(/\/$/, '');
    const response = await this.fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error('oidc_provider_unavailable');
    const value = (await readJsonObject(
      response,
      'oidc_metadata_invalid'
    )) as unknown as OidcMetadata;
    if (value.issuer !== this.config.issuer) throw new Error('oidc_metadata_issuer_mismatch');
    for (const [url, error] of [
      [value.authorization_endpoint, 'oidc_authorization_endpoint_invalid'],
      [value.token_endpoint, 'oidc_token_endpoint_invalid'],
      [value.jwks_uri, 'oidc_jwks_uri_invalid'],
    ] as const) {
      this.assertUrl(url, error, true);
    }
    if (value.end_session_endpoint) {
      this.assertUrl(value.end_session_endpoint, 'oidc_logout_endpoint_invalid', true);
    }
    const authenticationMethods: unknown = value.token_endpoint_auth_methods_supported;
    if (
      authenticationMethods !== undefined &&
      (!Array.isArray(authenticationMethods) ||
        authenticationMethods.length === 0 ||
        authenticationMethods.length > MAXIMUM_TOKEN_ENDPOINT_AUTH_METHODS ||
        authenticationMethods.some(
          (method) =>
            typeof method !== 'string' ||
            method.length === 0 ||
            method.length > MAXIMUM_TOKEN_ENDPOINT_AUTH_METHOD_LENGTH ||
            hasControlCharacter(method)
        ))
    ) {
      throw new Error('oidc_metadata_invalid');
    }
    this.metadataCache = {
      value: Object.freeze({
        ...value,
        ...(authenticationMethods === undefined
          ? {}
          : {
              token_endpoint_auth_methods_supported: Object.freeze([
                ...new Set(authenticationMethods as string[]),
              ]),
            }),
      }),
      expiresAt: now + (this.config.metadataCacheMs ?? 5 * 60_000),
    };
    return this.metadataCache.value;
  }

  private async jwks(): Promise<readonly JsonWebKey[]> {
    const now = this.config.now?.() ?? Date.now();
    if (this.jwksCache && now < this.jwksCache.expiresAt) return this.jwksCache.value;
    const response = await this.fetch((await this.metadata()).jwks_uri, {
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error('oidc_provider_unavailable');
    const value = await readJsonObject(response, 'oidc_jwks_invalid');
    if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 128) {
      throw new Error('oidc_jwks_invalid');
    }
    const keys = value.keys.filter(
      (key): key is JsonWebKey =>
        typeof key === 'object' &&
        key !== null &&
        typeof (key as { kty?: unknown }).kty === 'string'
    );
    if (keys.length === 0) throw new Error('oidc_jwks_invalid');
    this.jwksCache = {
      value: Object.freeze(keys),
      expiresAt: now + (this.config.metadataCacheMs ?? 5 * 60_000),
    };
    return this.jwksCache.value;
  }

  private async fetch(input: string, init: RequestInit): Promise<Response> {
    try {
      return await (this.config.fetch ?? globalThis.fetch)(input, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('oidc_provider_unavailable');
    }
  }

  private assertUrl(value: string, code: string, allowQuery: boolean): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(code);
    }
    if (
      url.username ||
      url.password ||
      url.hash ||
      (!allowQuery && url.search) ||
      (url.protocol !== 'https:' &&
        !(this.config.allowInsecureHttpForTests && url.protocol === 'http:'))
    ) {
      throw new Error(code);
    }
  }
}
