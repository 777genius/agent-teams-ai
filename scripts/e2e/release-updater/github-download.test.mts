import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { downloadGithubFile } from './github-download.mts';

const executable = fileURLToPath(
  new URL('./fixtures/github-download/gh-fixture.mts', import.meta.url)
);
const cases = [
  {
    name: 'prepared Actions archive',
    endpoint: 'repos/TEST/transport/actions/artifacts/101/zip',
    sha256: 'c811c340504a8d52e33263b5c826ca33ab5fec8e54dc93365c02294bf2cc7d00',
  },
  {
    name: 'aggregate lane Actions archive',
    endpoint: 'repos/TEST/transport/actions/artifacts/102/zip',
    sha256: 'c811c340504a8d52e33263b5c826ca33ab5fec8e54dc93365c02294bf2cc7d00',
  },
  {
    name: 'original release binary',
    endpoint: 'repos/TEST/transport/releases/assets/201',
    sha256: 'e4fe5505168fe886f2429c7934db9c439ecaf27a7f3e789fc08e88247e72795a',
  },
];
// This turns red if Actions receives the release-assets media type, or binary streaming corrupts bytes.
for (const scenario of cases) {
  void test(scenario.name, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-github-download-'));
    try {
      const destination = path.join(root, 'payload');
      const result = await downloadGithubFile(executable, scenario.endpoint, destination);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.error, '');
      const bytes = await readFile(destination);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), scenario.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
void test('an existing owned destination cannot be overwritten', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-github-download-'));
  try {
    const destination = path.join(root, 'payload');
    await writeFile(destination, 'preserve me', { flag: 'wx' });
    const result = await downloadGithubFile(
      executable,
      'repos/TEST/transport/releases/assets/201',
      destination
    );
    assert.match(result.error, /EEXIST/);
    assert.equal(await readFile(destination, 'utf8'), 'preserve me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('unknown endpoints fail before spawning a command or creating a file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-github-download-'));
  try {
    const destination = path.join(root, 'payload');
    await assert.rejects(
      downloadGithubFile(
        '/does-not-exist',
        'repos/TEST/transport/actions/artifacts/0/zip',
        destination
      ),
      /Unsupported GitHub download endpoint/
    );
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// URL delimiters must fail before an HTTP request can target a different resource.
for (const endpoint of [
  'repos/TEST/transport?x/actions/artifacts/101/zip',
  'repos/TEST#fragment/transport/actions/artifacts/101/zip',
  'repos/TEST/transport#fragment/releases/assets/201',
  'repos/TEST?x/transport/releases/assets/201',
]) {
  void test(`URL delimiters are rejected: ${endpoint}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-github-download-'));
    try {
      const destination = path.join(root, 'payload');
      await assert.rejects(
        downloadGithubFile('/does-not-exist', endpoint, destination),
        /Unsupported GitHub download endpoint/
      );
      await assert.rejects(readFile(destination), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
