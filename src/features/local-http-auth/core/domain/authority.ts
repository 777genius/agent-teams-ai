import type { ApiAuthority } from '../../contracts';

export function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Expected an HTTP endpoint without credentials, query or path');
  return url.origin;
}

export function validateAuthority(value: unknown, profileScope: string): ApiAuthority {
  if (!value || typeof value !== 'object') throw new Error('Invalid API authority');
  const descriptor = value as Partial<ApiAuthority>;
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.service !== 'api' ||
    descriptor.profileScope !== profileScope ||
    typeof descriptor.instanceId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(descriptor.instanceId) ||
    typeof descriptor.generation !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(descriptor.generation) ||
    typeof descriptor.token !== 'string' ||
    !/^\S{32,512}$/.test(descriptor.token) ||
    typeof descriptor.baseUrl !== 'string' ||
    normalizeEndpoint(descriptor.baseUrl) !== descriptor.baseUrl
  )
    throw new Error('Invalid API authority');
  return descriptor as ApiAuthority;
}
