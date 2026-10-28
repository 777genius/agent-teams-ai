import { describe, expect, it } from 'vitest';

import { admitsManagementHttp } from '../../../src/features/extension-management/main/adapters/input/registerExtensionManagementHttp';

const trusted = {
  ip: '127.0.0.1',
  headers: {
    host: '127.0.0.1:4141',
    origin: 'http://127.0.0.1:4141',
    'content-type': 'application/json',
  },
};
describe('management HTTP admission', () => {
  it('admits only the exact local application authority', () => {
    expect(admitsManagementHttp(trusted, 4141)).toBe(true);
    expect(admitsManagementHttp({ ...trusted, ip: '::ffff:127.0.0.1' }, 4141)).toBe(true);
  });
  it.each([
    [
      'foreign origin',
      { ...trusted, headers: { ...trusted.headers, origin: 'https://example.com' } },
    ],
    [
      'other localhost app',
      { ...trusted, headers: { ...trusted.headers, origin: 'http://127.0.0.1:4142' } },
    ],
    ['missing origin', { ...trusted, headers: { ...trusted.headers, origin: undefined } }],
    [
      'host rebinding',
      {
        ...trusted,
        headers: {
          ...trusted.headers,
          host: 'example.com:4141',
          origin: 'http://example.com:4141',
        },
      },
    ],
    ['remote client', { ...trusted, ip: '192.0.2.10' }],
    ['form body', { ...trusted, headers: { ...trusted.headers, 'content-type': 'text/plain' } }],
  ])('rejects %s independently of global CORS policy', (_label, request) => {
    expect(admitsManagementHttp(request, 4141)).toBe(false);
  });
});
