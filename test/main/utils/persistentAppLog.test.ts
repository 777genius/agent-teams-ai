import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  formatPersistentLogMessage,
  installPersistentAppLog,
} from '../../../src/main/utils/persistentAppLog';
import { createLogger } from '../../../src/shared/utils/logger';

describe('persistentAppLog', () => {
  it('keeps diagnostic causes while redacting credentials and local paths', () => {
    const error = Object.assign(
      new Error(
        'WS connection timeout for /Users/alice/work/private-repo and /Volumes/Private/work ' +
          'with ANTHROPIC_AUTH_TOKEN=secret-value Authorization: Bearer abcdefghijklmnop'
      ),
      { code: 'ETIMEDOUT', category: 'timeout' }
    );

    const message = formatPersistentLogMessage([
      'Connection error',
      error,
      { email: 'alice@example.com', provider: 'anthropic' },
    ]);

    expect(message).toContain('WS connection timeout');
    expect(message).toContain('ETIMEDOUT');
    expect(message).toContain('timeout');
    expect(message).toContain('anthropic');
    expect(message).not.toContain('secret-value');
    expect(message).not.toContain('abcdefghijklmnop');
    expect(message).not.toContain('/Users/alice');
    expect(message).not.toContain('/Volumes/Private');
    expect(message).not.toContain('alice@example.com');
  });

  it('writes bounded NDJSON and rotates the previous segment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-teams-persistent-log-'));
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = installPersistentAppLog({
      directory,
      appVersion: '2.9.1-test',
      platform: 'darwin',
      maxBytes: 1024,
    });

    try {
      const logger = createLogger('RuntimeConnection');
      for (let index = 0; index < 8; index += 1) {
        logger.error(`WS connection timeout ${index} ${'x'.repeat(300)}`, {
          category: 'timeout',
        });
      }
      await handle.flush();

      const current = await readFile(handle.filePath, 'utf8');
      const rotated = await readFile(handle.rotatedFilePath, 'utf8');
      const records = `${rotated}${current}`
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.v === 1)).toBe(true);
      expect(records.every((record) => record.appVersion === '2.9.1-test')).toBe(true);
      expect(records.every((record) => record.namespace === 'RuntimeConnection')).toBe(true);
      expect(
        records.some((record) => String(record.message).includes('WS connection timeout'))
      ).toBe(true);
    } finally {
      handle.dispose();
      errorOutput.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
