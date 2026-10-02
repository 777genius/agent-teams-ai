import { classifyUpdaterFailure } from '@shared/utils/updaterRecovery';
import { describe, expect, it } from 'vitest';

describe('updater recovery policy', () => {
  it.each([
    'Could not get code signature for running application',
    'The update is improperly signed',
    'The code signature of the update does not match the running application',
    'Code signature at URL file:///tmp/update.app did not pass validation',
    'ERR_UPDATER_INVALID_SIGNATURE',
    'Team identifier does not match',
  ])('requires manual recovery for signature failure: %s', (error) => {
    expect(classifyUpdaterFailure(error)).toBe('signature');
  });

  it.each([
    'ECONNRESET',
    'ETIMEDOUT',
    'HTTP 503',
    'net::ERR_INTERNET_DISCONNECTED',
    'status code: 429',
    '503 Service Unavailable\n{"error": "unavailable"}',
    '429 Too Many Requests',
    'Cannot download "https://example.test/update.zip", status 503: Service Unavailable',
  ])('allows retry for transient failure: %s', (error) => {
    expect(classifyUpdaterFailure(error)).toBe('network');
  });

  it.each([
    'ENOSPC',
    'EACCES',
    'Unknown error',
    'HTTP 404',
    'failed to parse metadata',
    'no published version',
  ])('does not invent a cause or promise retry for: %s', (error) => {
    expect(classifyUpdaterFailure(error)).toBe('generic');
  });
});
