import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import lock from '../managed-git.lock.json' with { type: 'json' };
import { downloadArchive, gitExecutable, validateArchiveEntries } from './stage-managed-git.mjs';

test('pinned Git runtime includes every desktop release target and immutable digests', () => {
  assert.deepEqual(Object.keys(lock.assets).sort(), [
    'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64',
  ]);
  assert.equal(lock.tag, 'v2.56.0-2');
  for (const asset of Object.values(lock.assets)) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.match(asset.filename, /^dugite-native-v2\.56\.0-a44aeca-.+\.tar\.gz$/);
  }
});

test('archive path validator rejects traversal and absolute names', () => {
  assert.doesNotThrow(() => validateArchiveEntries(['./bin/git', 'etc/gitconfig', 'libexec/git-core/git-lfs']));
  for (const entry of ['../outside', '/tmp/escape', './bin/../../outside', 'C:/outside', '..\\escape']) {
    assert.throws(() => validateArchiveEntries([entry]), /Unsafe Git archive member/);
  }
});

test('packaged Git entrypoints match Dugite Native native layouts', () => {
  assert.equal(gitExecutable('darwin-arm64', '/bundle'), path.join('/bundle', 'bin', 'git'));
  assert.equal(gitExecutable('linux-x64', '/bundle'), path.join('/bundle', 'bin', 'git'));
  assert.equal(gitExecutable('win32-x64', '/bundle'), path.join('/bundle', 'cmd', 'git.exe'));
  assert.equal(gitExecutable('win32-arm64', '/bundle'), path.join('/bundle', 'cmd', 'git.exe'));
});

async function withArchiveDestination(check) {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-git-retry-'));
  try {
    await check(path.join(directory, 'archive.tar.gz'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('retries a 503 response once, writing only the successful pinned archive', async () => {
  await withArchiveDestination(async (destination) => {
    let requests = 0;
    const pauses = [];
    await writeFile(destination, 'stale partial bytes');
    await downloadArchive('https://example.invalid/asset.tar.gz', destination, {
      request: async (_url, options) => {
        assert.equal(options.redirect, 'follow');
        requests += 1;
        return requests === 1
          ? new Response(null, { status: 503 })
          : new Response('complete pinned archive', { status: 200 });
      },
      pause: async (ms) => { pauses.push(ms); },
    });
    assert.equal(requests, 2);
    assert.deepEqual(pauses, [1000]);
    assert.equal(await readFile(destination, 'utf8'), 'complete pinned archive');
  });
});

test('retries only an HTTP/2 REFUSED_STREAM transport failure', async () => {
  await withArchiveDestination(async (destination) => {
    let requests = 0;
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'), {
        code: 'ERR_HTTP2_STREAM_ERROR',
      }),
    });
    await downloadArchive('https://example.invalid/asset.tar.gz', destination, {
      request: async () => {
        requests += 1;
        if (requests === 1) throw refused;
        return new Response('recovered archive');
      },
      pause: async () => {},
    });
    assert.equal(requests, 2);
    assert.equal(await readFile(destination, 'utf8'), 'recovered archive');
  });
});

test('permanent HTTP failure never retries and deletes partial archive data', async () => {
  await withArchiveDestination(async (destination) => {
    await writeFile(destination, 'stale data');
    let requests = 0;
    await assert.rejects(downloadArchive('https://example.invalid/asset.tar.gz', destination, {
      request: async () => { requests += 1; return new Response(null, { status: 404 }); },
      pause: async () => { throw new Error('unexpected retry'); },
    }), /HTTP 404/);
    assert.equal(requests, 1);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  });
});

test('retry budget stops after three transient failures and leaves no archive', async () => {
  await withArchiveDestination(async (destination) => {
    let requests = 0;
    const pauses = [];
    await assert.rejects(downloadArchive('https://example.invalid/asset.tar.gz', destination, {
      request: async () => { requests += 1; return new Response(null, { status: 504 }); },
      pause: async (ms) => { pauses.push(ms); },
    }), /HTTP 504/);
    assert.equal(requests, 3);
    assert.deepEqual(pauses, [1000, 2000]);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  });
});

test('non-refused HTTP/2 stream errors do not retry', async () => {
  await withArchiveDestination(async (destination) => {
    let requests = 0;
    await assert.rejects(downloadArchive('https://example.invalid/asset.tar.gz', destination, {
      request: async () => {
        requests += 1;
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR'), {
            code: 'ERR_HTTP2_STREAM_ERROR',
          }),
        });
      },
      pause: async () => { throw new Error('unexpected retry'); },
    }), /fetch failed/);
    assert.equal(requests, 1);
  });
});

test('retries if a native AggregateError contains a transient timeout', async () => {
  await withArchiveDestination(async (destination) => {
    let requests = 0;
    const connectErrors = new AggregateError([
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' }),
    ], 'Multiple connection attempts failed');
    await downloadArchive('https://example.invalid/asset.tar.gz', destination, {
      request: async () => {
        requests += 1;
        if (requests === 1) throw new TypeError('fetch failed', { cause: connectErrors });
        return new Response('recovered aggregate download');
      },
      pause: async () => {},
    });
    assert.equal(requests, 2);
    assert.equal(await readFile(destination, 'utf8'), 'recovered aggregate download');
  });
});

test('does not retry an AggregateError containing only permanent connection failures', async () => {
  await withArchiveDestination(async (destination) => {
    let requests = 0;
    await assert.rejects(downloadArchive('https://example.invalid/asset.tar.gz', destination, {
      request: async () => {
        requests += 1;
        throw new TypeError('fetch failed', { cause: new AggregateError([
          Object.assign(new Error('name not found'), { code: 'ENOTFOUND' }),
          Object.assign(new Error('certificate invalid'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
        ], 'Permanent failures') });
      },
      pause: async () => { throw new Error('unexpected retry'); },
    }), /fetch failed/);
    assert.equal(requests, 1);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  });
});

test('clears a partial response body before a successful transport retry', async () => {
  await withArchiveDestination(async (destination) => {
    let requests = 0;
    await downloadArchive('https://example.invalid/asset.tar.gz', destination, {
      request: async () => {
        requests += 1;
        if (requests !== 1) {
          await assert.rejects(readFile(destination), { code: 'ENOENT' });
          return new Response('complete archive after retry');
        }
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new TextEncoder().encode('partial stale archive bytes'));
            } else {
              controller.error(Object.assign(new Error('connection reset mid-response'), {
                code: 'ECONNRESET',
              }));
            }
          },
        }), { status: 200 });
      },
      pause: async () => {},
    });
    assert.equal(requests, 2);
    assert.equal(await readFile(destination, 'utf8'), 'complete archive after retry');
  });
});
