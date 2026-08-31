import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// A separate Node process isolates native ESM filesystem fault injection.
const fixture = String.raw`
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const body = Buffer.from(Array.from({ length: 64 * 1024 + 19 }, (_, index) => index % 251));
const copied = Buffer.alloc(body.length);
const state = { writes: 0, published: false, synced: false, directorySynced: false, closes: 0 };
const stat = { dev: 1, ino: 2, size: body.length, mode: 0o600, mtimeMs: 100, ctimeMs: 100, isFile: () => true };
const source = {
  stat: async () => stat,
  read: async (buffer, offset, length, position) => ({
    bytesRead: body.copy(buffer, offset, position, position + length), buffer,
  }),
  close: async () => { state.closes += 1; },
};
const destination = {
  write: async (buffer, offset, length, position) => {
    const bytesWritten = process.argv[1] === 'stall' && state.writes > 0 ? 0 : Math.min(length, 8191);
    state.writes += 1;
    buffer.copy(copied, position, offset, offset + bytesWritten);
    return { bytesWritten, buffer };
  },
  sync: async () => { state.synced = true; },
  chmod: async () => {},
  close: async () => { state.closes += 1; },
};
fs.promises.open = async (path) => path === '/source' ? source : destination;
fs.promises.lstat = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
fs.promises.rename = async () => { state.published = true; };
fs.promises.unlink = async (path) => { state.lastUnlink = path; };
syncBuiltinESMExports();

const { copyVerifiedDescriptor } = await import(
  './scripts/hosted-web/phase-10/state-compatibility/recovery-descriptor-io.mjs'
);
try {
  await copyVerifiedDescriptor('/source', {
    fd: 42, sync: async () => { state.directorySynced = true; },
  }, 'entry.json', {
    byteLength: body.length, mode: 0o600, sha256: createHash('sha256').update(body).digest('hex'),
  }, false);
} catch (error) {
  state.error = error.message;
}
state.equal = copied.equals(body);
process.stdout.write(JSON.stringify(state));
`;

function run(mode: 'short' | 'stall') {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture, mode], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('recovery descriptor publication', () => {
  it('copies every byte across partial writes and buffer boundaries before publication', () => {
    const state = run('short');

    expect(state).toMatchObject({
      equal: true,
      published: true,
      synced: true,
      directorySynced: true,
      closes: 2,
    });
    expect(state.error).toBeUndefined();
    expect(state.writes).toBeGreaterThan(2);
  });

  it('rejects a stalled write without publishing or syncing incomplete bytes', () => {
    expect(run('stall')).toMatchObject({
      error: 'stopped_stack_archive_entry_write_truncated',
      writes: 2,
      published: false,
      synced: false,
      directorySynced: false,
      closes: 2,
      lastUnlink: '/proc/self/fd/42/entry.json.restore-copy',
    });
  });
});
