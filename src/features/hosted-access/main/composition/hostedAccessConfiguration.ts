import {
  type GenericOidcRoleMapping,
  validateGenericOidcRoleMapping,
} from '../infrastructure/GenericOidcIdentityProvider';
import { readProtectedHostedAuthSecret } from '../infrastructure/NodeHostedIdentityCrypto';

import type { HostedAuthMode } from '../../contracts';
import type { HostedAuthHostPlatform } from '../../core/application';

export type HostedAccessEnvironment = Readonly<Record<string, string | undefined>>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MINIMUM_OIDC_SESSION_IDLE_MS = MINUTE;
const MAXIMUM_OIDC_SESSION_IDLE_MS = 60 * MINUTE;
const MINIMUM_OIDC_SESSION_ABSOLUTE_MS = 5 * MINUTE;
const MAXIMUM_OIDC_SESSION_ABSOLUTE_MS = DAY;

export function required(environment: HostedAccessEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`hosted_auth_config_missing:${name}`);
  return value;
}

function integer(environment: HostedAccessEnvironment, name: string, fallback: number): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`hosted_auth_config_invalid:${name}`);
  }
  return parsed;
}

export function requiredNonNegativeInteger(
  environment: HostedAccessEnvironment,
  name: string
): number {
  const value = required(environment, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`hosted_auth_config_invalid:${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`hosted_auth_config_invalid:${name}`);
  }
  return parsed;
}

export function boundedInteger(
  environment: HostedAccessEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = integer(environment, name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`hosted_auth_config_invalid:${name}`);
  }
  return value;
}

export function oidcSessionPolicy(environment: HostedAccessEnvironment): {
  readonly sessionIdleTtlMs: number;
  readonly sessionAbsoluteTtlMs: number;
} {
  const sessionIdleTtlMs = boundedInteger(
    environment,
    'AUTH_SESSION_IDLE_MS',
    15 * MINUTE,
    MINIMUM_OIDC_SESSION_IDLE_MS,
    MAXIMUM_OIDC_SESSION_IDLE_MS
  );
  const sessionAbsoluteTtlMs = boundedInteger(
    environment,
    'AUTH_SESSION_ABSOLUTE_MS',
    8 * 60 * MINUTE,
    MINIMUM_OIDC_SESSION_ABSOLUTE_MS,
    MAXIMUM_OIDC_SESSION_ABSOLUTE_MS
  );
  if (sessionIdleTtlMs > sessionAbsoluteTtlMs) {
    throw new Error('hosted_auth_config_invalid:AUTH_SESSION_IDLE_MS');
  }
  return Object.freeze({ sessionIdleTtlMs, sessionAbsoluteTtlMs });
}

export function csv(value: string | undefined): readonly string[] {
  return Object.freeze(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function authMode(environment: HostedAccessEnvironment): HostedAuthMode {
  const mode = required(environment, 'AUTH_MODE');
  if (mode !== 'personal' && mode !== 'oidc') {
    throw new Error('hosted_auth_config_invalid:AUTH_MODE');
  }
  return mode;
}

export function multiRootActive(environment: HostedAccessEnvironment): boolean {
  const value = environment.HOSTED_DASHBOARD_MULTI_ROOT_ACTIVE;
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('hosted_auth_config_invalid:HOSTED_DASHBOARD_MULTI_ROOT_ACTIVE');
}

export function roleMapping(environment: HostedAccessEnvironment): GenericOidcRoleMapping {
  const defaultRole = environment.OIDC_DEFAULT_ROLE ?? 'viewer';
  if (!['admin', 'member', 'viewer'].includes(defaultRole)) {
    throw new Error('hosted_auth_config_invalid:OIDC_DEFAULT_ROLE');
  }
  try {
    return validateGenericOidcRoleMapping({
      claimPath: environment.OIDC_ROLE_CLAIM ?? 'realm_access.roles',
      owner: csv(environment.OIDC_OWNER_ROLE_VALUES),
      admin: csv(environment.OIDC_ADMIN_ROLE_VALUES),
      member: csv(environment.OIDC_MEMBER_ROLE_VALUES),
      viewer: csv(environment.OIDC_VIEWER_ROLE_VALUES),
      defaultRole: defaultRole as 'admin' | 'member' | 'viewer',
    });
  } catch (error) {
    throw new Error(
      `hosted_auth_config_invalid:${error instanceof Error ? error.message : 'OIDC_ROLE_MAPPING'}`,
      { cause: error }
    );
  }
}

export async function clientSecret(
  environment: HostedAccessEnvironment,
  platform: HostedAuthHostPlatform
): Promise<string | undefined> {
  if (environment.OIDC_CLIENT_SECRET !== undefined) {
    throw new Error('hosted_auth_config_forbidden:OIDC_CLIENT_SECRET');
  }
  if (environment.OIDC_CLIENT_SECRET_FILE) {
    return readProtectedHostedAuthSecret(environment.OIDC_CLIENT_SECRET_FILE, platform);
  }
  return undefined;
}
