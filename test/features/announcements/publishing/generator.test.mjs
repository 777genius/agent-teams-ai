import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { generateAnnouncements } from '../../../../scripts/announcements/generate.mjs';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(meta = {}) {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'announcement-publishing-'));
  roots.push(repoDir);
  const sourceDir = path.join(repoDir, 'source');
  const outputDir = path.join(repoDir, 'public', 'announcements');
  const dir = path.join(sourceDir, 'example');
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(sourceDir, 'feed.config.json'), '{"autoShowEnabled":false}');
  await writeFile(path.join(dir, 'body.md'), '# News\r\n![image](assets/banner.png)\r\n');
  await writeFile(path.join(dir, 'assets/banner.png'), Buffer.from([137, 80, 78, 71]));
  const value = {
    id: 'example',
    title: ' Example ',
    publishedAt: '2026-09-04T12:00:00Z',
    status: 'published',
    heroImage: 'assets/banner.png',
    ...meta,
  };
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(value));
  return { sourceDir, outputDir, repoDir, dir, value };
}
async function metadata(f, changes) {
  await writeFile(path.join(f.dir, 'meta.json'), JSON.stringify({ ...f.value, ...changes }));
}
function git(f, ...args) {
  return execFileSync('git', ['-C', f.repoDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(f) {
  git(f, 'init', '-q');
  git(f, 'add', 'source');
  git(
    f,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture'
  );
  return git(f, 'rev-parse', 'HEAD');
}

test('deterministic bytes, defaults, CRLF hash and local HTTP paths', async () => {
  const f = await fixture();
  const feed = await generateAnnouncements(f);
  const bytes = await readFile(path.join(f.outputDir, 'feed.v1.json'));
  assert.deepEqual(await generateAnnouncements(f), feed);
  assert.deepEqual(await readFile(path.join(f.outputDir, 'feed.v1.json')), bytes);
  assert.equal(feed.items[0].validUntil, '2026-09-18T12:00:00.000Z');
  assert.equal(feed.items[0].minUsageMinutes, 30);
  assert.equal(feed.items[0].showToNewUsers, true);
  assert.match(
    feed.items[0].heroImagePath,
    /^\/announcements\/content\/example\/[a-f0-9]{64}\/assets\/banner\.png$/
  );
  const server = createServer(async (req, res) => {
    try {
      res.end(await readFile(path.join(path.dirname(f.outputDir), req.url)));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const remote = await (await globalThis.fetch(`${base}/announcements/feed.v1.json`)).json();
    const body = Buffer.from(
      await (await globalThis.fetch(base + remote.items[0].bodyPath)).arrayBuffer()
    );
    assert.equal(createHash('sha256').update(body).digest('hex'), remote.items[0].bodySha256);
    assert.ok(body.includes('\r\n'));
    assert.equal((await globalThis.fetch(base + '/announcements/missing.md')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('image-only edits change bundle and revision, body edits change checksum', async () => {
  const f = await fixture();
  const first = await generateAnnouncements(f);
  await writeFile(path.join(f.dir, 'assets/banner.png'), 'changed');
  const second = await generateAnnouncements(f);
  assert.notEqual(first.items[0].bodyPath, second.items[0].bodyPath);
  assert.notEqual(first.revision, second.revision);
  assert.equal(first.items[0].bodySha256, second.items[0].bodySha256);
  await writeFile(path.join(f.dir, 'body.md'), 'New body');
  assert.notEqual((await generateAnnouncements(f)).items[0].bodySha256, second.items[0].bodySha256);
});

test('draft/withdrawn omitted, archived/future retained, false and zero preserved', async () => {
  for (const status of ['draft', 'withdrawn', 'archived', 'published']) {
    const f = await fixture({
      status,
      minUsageMinutes: 0,
      showToNewUsers: false,
      publishedAt: '2099-01-01T00:00:00Z',
    });
    const feed = await generateAnnouncements(f);
    assert.equal(feed.items.length, ['draft', 'withdrawn'].includes(status) ? 0 : 1);
    if (feed.items[0]) {
      assert.equal(feed.items[0].minUsageMinutes, 0);
      assert.equal(feed.items[0].showToNewUsers, false);
    }
  }
});

test('bad metadata rejects entire build', async () => {
  const f = await fixture();
  for (const changes of [
    { validUntil: null },
    { validUntil: '' },
    { validUntil: '2020-01-01T00:00:00Z' },
    { publishedAt: '2026-02-30T12:00:00Z' },
    { publishedAt: '2026-01-01' },
    { publishedAt: '2026-01-01T24:00:00Z' },
    { minUsageMinutes: null },
    { minUsageMinutes: -1 },
    { minUsageMinutes: 1.5 },
    { minUsageMinutes: Number.MAX_SAFE_INTEGER },
    { showToNewUsers: 'false' },
    { heroImage: null },
    { heroImage: '../banner.png' },
    { heroImage: 'https://example.com/banner.png' },
    { id: '../example' },
    { status: 'other' },
    { title: '<script>' },
  ]) {
    await metadata(f, changes);
    await assert.rejects(generateAnnouncements(f), /Announcements:/);
  }
});

test('missing body/image, traversal, symlinks, nonportable files, invalid utf8 and limits reject', async () => {
  const f = await fixture();
  for (const body of [
    '![bad](../private.png)',
    '![bad](assets/missing.png)',
    '![bad][ref]\n\n[ref]: assets/missing.png',
    '![bad](https://example.com/a.png)',
  ]) {
    await writeFile(path.join(f.dir, 'body.md'), body);
    await assert.rejects(generateAnnouncements(f), /image/);
  }
  await writeFile(path.join(f.dir, 'body.md'), Buffer.from([255]));
  await assert.rejects(generateAnnouncements(f), /UTF-8/);
  await writeFile(path.join(f.dir, 'body.md'), Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(generateAnnouncements(f), /size limit/);
  await rm(path.join(f.dir, 'body.md'));
  await assert.rejects(generateAnnouncements(f), /ENOENT/);
  await writeFile(path.join(f.dir, 'body.md'), 'ok');
  await metadata(f, { heroImage: 'assets/missing.png' });
  await assert.rejects(generateAnnouncements(f), /heroImage/);
  await metadata(f, { heroImage: 'assets/banner.png' });
  await writeFile(path.join(f.dir, 'assets/con.png'), 'bad');
  await assert.rejects(generateAnnouncements(f), /nonportable/);
  await rm(path.join(f.dir, 'assets/con.png'));
  await symlink(path.join(f.dir, 'body.md'), path.join(f.dir, 'assets/link.png'));
  await assert.rejects(generateAnnouncements(f), /symlink/);
});

test('ignores image syntax inside fenced and inline code', async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.dir, 'body.md'),
    [
      '# Markdown image examples',
      '',
      '```markdown',
      '![remote](https://example.com/image.png)',
      '```',
      '',
      '`![missing](assets/missing.png)`',
    ].join('\n')
  );
  const feed = await generateAnnouncements(f);
  assert.equal(feed.items.length, 1);
});

test('immutable Git comparison normalizes dates/defaults and prohibits removal or draft rollback', async () => {
  const f = await fixture();
  const baseRef = commit(f);
  await metadata(f, {
    publishedAt: '2026-09-04T14:00:00+02:00',
    showToNewUsers: true,
    title: 'Updated',
  });
  await generateAnnouncements({ ...f, baseRef, checkOnly: true });
  for (const changes of [
    { publishedAt: '2026-09-05T12:00:00Z' },
    { showToNewUsers: false },
    { status: 'draft' },
  ]) {
    await metadata(f, changes);
    await assert.rejects(
      generateAnnouncements({ ...f, baseRef, checkOnly: true }),
      /immutable|draft/
    );
  }
  await metadata(f, { status: 'withdrawn' });
  await generateAnnouncements({ ...f, baseRef, checkOnly: true });
  await rm(f.dir, { recursive: true });
  await assert.rejects(
    generateAnnouncements({ ...f, baseRef, checkOnly: true }),
    /cannot be deleted/
  );
});

test('draft mutable and missing/unavailable Git base fails closed', async () => {
  const f = await fixture({ status: 'draft' });
  const baseRef = commit(f);
  await metadata(f, { publishedAt: '2027-01-01T00:00:00Z', showToNewUsers: false });
  await generateAnnouncements({ ...f, baseRef, checkOnly: true });
  await assert.rejects(generateAnnouncements({ ...f, checkOnly: true }), /Git base/);
  await assert.rejects(generateAnnouncements({ ...f, baseRef: 'missing-base', checkOnly: true }));
});

test('empty feed and generator only replaces its own output', async () => {
  const f = await fixture();
  await rm(f.dir, { recursive: true });
  await mkdir(path.dirname(f.outputDir), { recursive: true });
  await writeFile(path.join(path.dirname(f.outputDir), 'keep.txt'), 'keep');
  assert.deepEqual((await generateAnnouncements(f)).items, []);
  assert.equal(await readFile(path.join(path.dirname(f.outputDir), 'keep.txt'), 'utf8'), 'keep');
});

test('asset size, root/output symlinks and malformed config fail before replacing prior feed', async () => {
  const f = await fixture();
  await generateAnnouncements(f);
  const previous = await readFile(path.join(f.outputDir, 'feed.v1.json'));
  await writeFile(path.join(f.dir, 'assets/banner.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(generateAnnouncements(f), /size limit/);
  assert.deepEqual(await readFile(path.join(f.outputDir, 'feed.v1.json')), previous);
  await writeFile(path.join(f.dir, 'assets/banner.png'), 'ok');
  await writeFile(path.join(f.sourceDir, 'feed.config.json'), '{"autoShowEnabled":null}');
  await assert.rejects(generateAnnouncements(f), /autoShowEnabled/);
  await writeFile(path.join(f.sourceDir, 'feed.config.json'), '{"autoShowEnabled":false}');
  const alias = path.join(f.repoDir, 'source-alias');
  await symlink(f.sourceDir, alias);
  await assert.rejects(generateAnnouncements({ ...f, sourceDir: alias }), /symlink/);
  const outputAlias = path.join(f.repoDir, 'output-alias');
  await symlink(f.outputDir, outputAlias);
  await assert.rejects(generateAnnouncements({ ...f, outputDir: outputAlias }), /symlink/);
});

test('allows 64 unique assets and deduplicates heroImage against Markdown references', async () => {
  const f = await fixture();
  const references = ['![banner](assets/banner.png)'];
  for (let index = 0; index < 63; index++) {
    const name = `image-${String(index).padStart(2, '0')}.png`;
    await writeFile(path.join(f.dir, 'assets', name), 'x');
    references.push(`![${index}](assets/${name})`);
  }
  await writeFile(path.join(f.dir, 'assets', 'unused.png'), 'unused');
  await writeFile(path.join(f.dir, 'body.md'), references.join('\n'));
  const feed = await generateAnnouncements(f);
  const bundleDir = path.dirname(
    path.join(path.dirname(f.outputDir), feed.items[0].bodyPath.replace(/^\//, ''))
  );
  await assert.rejects(readFile(path.join(bundleDir, 'assets', 'unused.png')), /ENOENT/);

  await writeFile(path.join(f.dir, 'assets', 'image-63.png'), 'x');
  await writeFile(
    path.join(f.dir, 'body.md'),
    `${references.join('\n')}\n![64](assets/image-63.png)`
  );
  await assert.rejects(generateAnnouncements(f), /exceeds 64 unique assets/);
});

test('allows exactly 20 MiB of document assets and rejects one byte over', async () => {
  const f = await fixture();
  const references = ['![banner](assets/banner.png)'];
  const bytesPerAsset = (20 * 1024 * 1024 - 4) / 4;
  for (let index = 0; index < 4; index++) {
    const name = `large-${index}.png`;
    await writeFile(path.join(f.dir, 'assets', name), Buffer.alloc(bytesPerAsset));
    references.push(`![${index}](assets/${name})`);
  }
  await writeFile(path.join(f.dir, 'body.md'), references.join('\n'));
  await generateAnnouncements(f);

  await writeFile(path.join(f.dir, 'assets', 'over.png'), 'x');
  await writeFile(
    path.join(f.dir, 'body.md'),
    `${references.join('\n')}\n![over](assets/over.png)`
  );
  await assert.rejects(generateAnnouncements(f), /exceed 20 MiB in aggregate/);
});
