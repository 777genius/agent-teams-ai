import assert from 'node:assert/strict';
import test from 'node:test';
import { candidatePages } from './stage-candidate.mjs';

for (const key of ['jobs', 'artifacts']) {
  test(`${key}: collects candidates and ambiguity beyond the first 100 entries`, () => {
    const entries = Array.from({ length: 201 }, (_, i) => ({ id: i + 1, name: 'other' }));
    entries[150].name = 'candidate';
    entries[200].name = 'candidate';
    const calls = [];
    const actual = candidatePages(
      (endpoint) => {
        calls.push(endpoint);
        const page = Number(new URL(`https://example.test/${endpoint}`).searchParams.get('page'));
        return { total_count: entries.length, [key]: entries.slice((page - 1) * 100, page * 100) };
      },
      `runs/42/${key}`,
      key
    );
    assert.deepEqual(actual, entries);
    assert.equal(actual.filter((item) => item.name === 'candidate').length, 2);
    assert.deepEqual(
      calls,
      [1, 2, 3].map((page) => `runs/42/${key}?per_page=100&page=${page}`)
    );
  });
}

test('empty and exact full-page listings finish without unnecessary requests', () => {
  for (const count of [0, 100]) {
    let calls = 0;
    const entries = Array.from({ length: count }, (_, i) => ({ id: i + 1 }));
    assert.deepEqual(
      candidatePages(
        () => {
          calls++;
          return { total_count: count, jobs: entries };
        },
        'jobs',
        'jobs'
      ),
      entries
    );
    assert.equal(calls, 1);
  }
});

test('invalid totals, excessive listings and incomplete pages fail closed', () => {
  for (const result of [
    { jobs: [] },
    { total_count: -1, jobs: [] },
    { total_count: 0.5, jobs: [] },
    { total_count: 10001, jobs: [] },
    { total_count: 1, jobs: [] },
    { total_count: 0, jobs: [{ id: 1 }] },
    { total_count: 0 },
    { total_count: 1, jobs: [{ id: '1' }] },
  ])
    assert.throws(() => candidatePages(() => result, 'jobs', 'jobs'));
});

test('changed totals and overlapping identities fail closed on subsequent pages', () => {
  for (const second of [
    { total_count: 102, jobs: [{ id: 101 }, { id: 102 }] },
    { total_count: 101, jobs: [{ id: 100 }] },
    { total_count: 101, jobs: [] },
  ]) {
    let calls = 0;
    assert.throws(() =>
      candidatePages(
        () =>
          ++calls === 1
            ? { total_count: 101, jobs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }
            : second,
        'jobs',
        'jobs'
      )
    );
    assert.equal(calls, 2);
  }
});

test('the maximum listing completes within the explicit request cap', () => {
  let calls = 0;
  const items = candidatePages(
    () => {
      const offset = calls++ * 100;
      return {
        total_count: 10000,
        jobs: Array.from({ length: 100 }, (_, i) => ({ id: offset + i + 1 })),
      };
    },
    'jobs',
    'jobs'
  );
  assert.equal(items.length, 10000);
  assert.equal(calls, 100);
});

test('complete candidate publication replaces stale published JS/Bun and detects changed physical companions', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const { publishRuntimePayload } = await import('../../lib/runtime-payload-cache.mjs');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const { copyDir } = builderRequire('builder-util/out/fs.js');
  const { verifyCandidatePayload } = await import('./stage-candidate.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-complete-candidate-'));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    const source = path.join(root, 'source'),
      target = path.join(root, 'staged');
    for (const dir of ['local-cli', 'bun', 'cursor-managed'])
      await mkdir(path.join(source, dir), { recursive: true });
    for (const dir of ['local-cli/marker-only', 'local-cli/empty', 'local-cli/retained'])
      await mkdir(path.join(source, dir), { recursive: true });
    await writeFile(path.join(source, 'local-cli/marker-only/.gitkeep'), 'marker');
    await writeFile(path.join(source, 'local-cli/retained/.DS_Store'), 'marker');
    await writeFile(path.join(source, 'local-cli/retained/code.js'), 'ordinary code');
    await mkdir(target);
    await writeFile(path.join(target, 'only-published-117'), 'stale');
    const exe = Buffer.alloc(1025);
    exe.write('MZ');
    const js = Buffer.from('candidate 118 JS'),
      bun = Buffer.from('candidate Bun');
    const sha = 'a'.repeat(40);
    const delivery = {
      schema: 1,
      platform: 'win32',
      arch: 'x64',
      bunVersion: '1.3.11',
      entrySha256: hash(js),
      bunSha256: hash(bun),
    };
    for (const [file, bytes] of [
      ['claude-multimodel.exe', exe],
      ['local-cli/cli.js', js],
      ['bun/bun.exe', bun],
      ['COMMIT_SHA', sha],
      ['VERSION', '0.0.118'],
      ['opencode-delivery.json', JSON.stringify(delivery)],
      ['local-cli/opencode-v2-graphs.json', '{}'],
      ['local-cli/opencodeV2Server.js', 'server'],
      ['local-cli/opencodeV2ExecutionServer.js', 'execution'],
      ['local-cli/opencodeV2RunOwner.js', 'owner'],
      ['cursor-managed/plugin.js', 'plugin'],
    ])
      await writeFile(path.join(source, file), bytes);
    const expected = {
      testOnly: true,
      sourceSha: sha,
      sourceVersion: '0.0.118',
      payloadArchiveSha256: 'b'.repeat(64),
    };
    const verified = await verifyCandidatePayload(source, expected);
    assert.equal(verified.entrySha256, hash(js));
    assert.equal(verified.bunSha256, hash(bun));
    const deliveryPath = path.join(source, 'opencode-delivery.json');
    await writeFile(deliveryPath, JSON.stringify({ ...delivery, bunVersion: '1.4.3' }));
    const windowsPin = await verifyCandidatePayload(source, expected);
    assert.equal(windowsPin.bunSha256, hash(bun));
    assert.notEqual(windowsPin.deliverySha256, verified.deliverySha256);
    await assert.rejects(verifyCandidatePayload(source, { ...expected, ...verified }));
    await writeFile(deliveryPath, JSON.stringify({ ...delivery, bunVersion: '1.99.0' }));
    await assert.rejects(verifyCandidatePayload(source, expected));
    await writeFile(deliveryPath, JSON.stringify(delivery));
    publishRuntimePayload(
      path.join(source, 'claude-multimodel.exe'),
      target,
      expected.payloadArchiveSha256
    );
    await assert.rejects(readFile(path.join(target, 'only-published-117')));
    expected.payloadReceiptSha256 = hash(
      await readFile(path.join(target, '.archive-payload.json'))
    );
    Object.assign(expected, verified);
    await verifyCandidatePayload(target, expected);
    const receiptPath = path.join(target, '.archive-payload.json');
    const originalReceipt = await readFile(receiptPath);
    const oversizedReceipt = Buffer.from(
      JSON.stringify({
        ...JSON.parse(originalReceipt),
        entries: Array.from({ length: 131_073 }, (_, index) => [
          `absent-companion-${index}.js`,
          'c'.repeat(64),
        ]),
      })
    );
    await writeFile(receiptPath, oversizedReceipt);
    try {
      // The receipt hash is valid, but its first companion is absent. Require
      // the count guard to reject before attempting any receipt-entry IO.
      await assert.rejects(
        verifyCandidatePayload(target, {
          ...expected,
          payloadReceiptSha256: hash(oversizedReceipt),
        }),
        { code: 'ERR_ASSERTION', message: 'Candidate payload receipt exceeds entry limit' }
      );
    } finally {
      await writeFile(receiptPath, originalReceipt);
    }
    const packaged = path.join(root, 'packaged');
    await copyDir(target, packaged, { isUseHardLink: () => false });
    for (const omitted of [
      'local-cli/marker-only',
      'local-cli/empty',
      'local-cli/retained/.DS_Store',
    ])
      await assert.rejects(readFile(path.join(packaged, omitted)), { code: 'ENOENT' });
    await verifyCandidatePayload(packaged, expected, { packaged: true });
    await assert.rejects(
      verifyCandidatePayload(packaged, expected),
      'Source inventory stays strict'
    );
    const markerFile = path.join(target, 'local-cli/marker-only/.gitkeep');
    await rm(markerFile);
    await assert.rejects(
      verifyCandidatePayload(target, expected),
      'Source missing marker is refused'
    );
    await writeFile(markerFile, 'marker');
    const retainedFile = path.join(packaged, 'local-cli/retained/code.js');
    await writeFile(retainedFile, 'changed');
    await assert.rejects(verifyCandidatePayload(packaged, expected, { packaged: true }));
    await rm(retainedFile);
    await assert.rejects(verifyCandidatePayload(packaged, expected, { packaged: true }));
    await rm(path.dirname(retainedFile), { recursive: true });
    await assert.rejects(
      verifyCandidatePayload(packaged, expected, { packaged: true }),
      'Directory with an original retained descendant cannot disappear'
    );
    for (const file of [
      'claude-multimodel.exe',
      'local-cli/cli.js',
      'bun/bun.exe',
      'opencode-delivery.json',
      'COMMIT_SHA',
      'cursor-managed/plugin.js',
    ]) {
      const original = await readFile(path.join(target, file));
      await writeFile(path.join(target, file), 'changed');
      await assert.rejects(
        verifyCandidatePayload(target, expected),
        `changed ${file} must be refused`
      );
      await writeFile(path.join(target, file), original);
    }
    await assert.rejects(
      verifyCandidatePayload(target, { ...expected, sourceSha: 'c'.repeat(40) })
    );
    await assert.rejects(verifyCandidatePayload(target, { ...expected, sourceVersion: '0.0.117' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
