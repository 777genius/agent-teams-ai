import { expect, it } from 'vitest';

import { ManagementHttpCapability } from '../../../src/features/extension-management/main/infrastructure/ManagementHttpCapability';

it('accepts only a live well-formed grant and revokes it on rotation or shutdown', () => {
  const authority = new ManagementHttpCapability();
  expect(() => authority.browserUrl(4141)).toThrow('Start browser access');
  authority.rotate();
  const url = new URL(authority.browserUrl(4141));
  const token = new URLSearchParams(url.hash.slice(1)).get('management-access')!;
  const authorization = `Bearer ${token}`;
  expect(url.origin).toBe('http://127.0.0.1:4141');
  expect(url.search).toBe('');
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(authority.accepts(authorization)).toBe(true);
  for (const invalid of [
    undefined,
    '',
    'Bearer invalid',
    `Basic ${token}`,
    `Bearer ${'0'.repeat(64)}`,
    `${authorization}, ${authorization}`,
  ])
    expect(authority.accepts(invalid)).toBe(false);
  expect(JSON.stringify(authority)).not.toContain(token);
  authority.rotate();
  expect(authority.accepts(authorization)).toBe(false);
  const replacement = new URL(authority.browserUrl(4141)).hash.split('=')[1];
  expect(authority.accepts(`Bearer ${replacement}`)).toBe(true);
  authority.revoke();
  expect(authority.accepts(`Bearer ${replacement}`)).toBe(false);
  expect(() => authority.browserUrl(4141)).toThrow('Start browser access');
});
