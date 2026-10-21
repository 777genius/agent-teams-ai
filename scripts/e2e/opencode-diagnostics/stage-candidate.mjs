import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { extractArchive, publishRuntimePayload } from '../../lib/runtime-payload-cache.mjs';

const candidateRepository = '777genius/agent_teams_orchestrator';

// Complete Windows deliveries exceed 100,000 entries when directories are counted.
// Keep verification IO bounded while checking every entry of the full payload.
const maxPayloadReceiptEntries = 131_072;

// Only retry an explicit transient HTTP response for the same immutable artifact.
// Digest, extraction and physical payload verification remain outside this boundary.
export async function downloadCandidateArchive(
  artifactId,
  { execute = execFileSync, wait = delay, warn = console.warn } = {}
) {
  assert(Number.isSafeInteger(artifactId) && artifactId > 0, 'Invalid candidate artifact ID');
  const endpoint = `repos/${candidateRepository}/actions/artifacts/${artifactId}/zip`;
  for (let attempt = 1; ; attempt++) {
    try {
      return execute('gh', ['api', endpoint], {
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : '';
      const status = /^gh: HTTP (429|502|503|504)\r?\n?$/.exec(stderr)?.[1];
      if (
        attempt >= 3 ||
        error?.status !== 1 ||
        error?.signal !== null ||
        error?.code !== undefined ||
        !status
      )
        throw error;
      const milliseconds = attempt * 2_000;
      warn(
        `Candidate artifact ${artifactId}: HTTP ${status}; transfer attempt ${attempt}/3 failed, retrying in ${milliseconds}ms`
      );
      await wait(milliseconds);
    }
  }
}

function candidateBunVersion(value) {
  const version = value === undefined ? '1.3.11' : value;
  assert(['1.3.11', '1.4.3'].includes(version), 'Unsupported candidate Bun version');
  return version;
}

// Bound API work and reject partial/changing listings before selecting a producer or artifact.
export function candidatePages(api, endpoint, key) {
  const perPage = 100;
  const maxPages = 100;
  const items = [];
  const ids = new Set();
  let total;
  for (let page = 1; page <= maxPages; page++) {
    const result = api(`${endpoint}?per_page=${perPage}&page=${page}`);
    assert(
      Number.isSafeInteger(result.total_count) && result.total_count >= 0,
      'Invalid candidate listing total'
    );
    assert(result.total_count <= perPage * maxPages, 'Candidate listing exceeds pagination cap');
    total ??= result.total_count;
    assert.equal(result.total_count, total, 'Candidate listing changed during pagination');
    assert(Array.isArray(result[key]), 'Invalid candidate listing page');
    assert.equal(
      result[key].length,
      Math.min(perPage, total - items.length),
      'Incomplete candidate listing page'
    );
    for (const item of result[key]) {
      assert(
        Number.isSafeInteger(item.id) && item.id > 0 && !ids.has(item.id),
        'Invalid or repeated candidate listing identity'
      );
      ids.add(item.id);
      items.push(item);
    }
    if (items.length === total) return items;
  }
  assert.fail('Candidate pagination cap reached');
}

// One physical identity check shared by staging and explicitly opted-in packaged qualification.
export async function verifyCandidatePayload(root, expected, { packaged = false } = {}) {
  assert(expected?.testOnly === true && /^[a-f0-9]{40}$/.test(expected.sourceSha ?? ''));
  assert(/^\d+\.\d+\.\d+$/.test(expected.sourceVersion ?? ''));
  const bunVersion = candidateBunVersion(expected.bunVersion);
  const digest = async (relative) => {
    const file = path.join(root, relative);
    const leaf = await lstat(file);
    assert(leaf.isFile() && !leaf.isSymbolicLink(), 'Candidate companion must be regular');
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  };
  assert.equal((await readFile(path.join(root, 'COMMIT_SHA'), 'utf8')).trim(), expected.sourceSha);
  assert.equal((await readFile(path.join(root, 'VERSION'), 'utf8')).trim(), expected.sourceVersion);
  const delivery = JSON.parse(await readFile(path.join(root, 'opencode-delivery.json'), 'utf8'));
  assert(
    delivery.schema === 1 &&
      delivery.platform === 'win32' &&
      delivery.arch === 'x64' &&
      delivery.bunVersion === bunVersion
  );
  assert(/^[a-f0-9]{64}$/.test(delivery.bunSha256) && /^[a-f0-9]{64}$/.test(delivery.entrySha256));
  const binary = await readFile(path.join(root, 'claude-multimodel.exe'));
  assert(binary.length > 1024 && binary.subarray(0, 2).toString() === 'MZ');
  const identity = {
    bunVersion,
    binarySha256: await digest('claude-multimodel.exe'),
    entrySha256: await digest('local-cli/cli.js'),
    bunSha256: await digest('bun/bun.exe'),
    deliverySha256: await digest('opencode-delivery.json'),
    commitSha256: await digest('COMMIT_SHA'),
    versionSha256: await digest('VERSION'),
  };
  assert.equal(identity.entrySha256, delivery.entrySha256, 'Candidate JS delivery mismatch');
  assert.equal(identity.bunSha256, delivery.bunSha256, 'Candidate Bun delivery mismatch');
  for (const file of [
    'local-cli/opencode-v2-graphs.json',
    'local-cli/opencodeV2Server.js',
    'local-cli/opencodeV2ExecutionServer.js',
    'local-cli/opencodeV2RunOwner.js',
  ])
    await digest(file);
  const cursor = await lstat(path.join(root, 'cursor-managed'));
  assert(cursor.isDirectory() && !cursor.isSymbolicLink());
  for (const [key, value] of Object.entries(identity))
    if (expected[key]) assert.equal(value, expected[key]);
  if (expected.payloadReceiptSha256) {
    assert.equal(await digest('.archive-payload.json'), expected.payloadReceiptSha256);
    const receipt = JSON.parse(await readFile(path.join(root, '.archive-payload.json'), 'utf8'));
    assert.equal(receipt.version, 1);
    assert.equal(receipt.archiveSha256, expected.payloadArchiveSha256);
    assert.equal(receipt.binaryName, 'claude-multimodel.exe');
    assert(Array.isArray(receipt.entries), 'Candidate payload receipt entries must be a list');
    assert(
      receipt.entries.length <= maxPayloadReceiptEntries,
      'Candidate payload receipt exceeds entry limit'
    );
    // Pinned builder-util copyDir omits these markers and directories without copied files.
    const marker = (file) => ['.DS_Store', '.gitkeep'].includes(path.posix.basename(file));
    const pruned = (file) =>
      (expected.allowedPrunedRoots ?? []).some(
        (removed) =>
          typeof removed === 'string' &&
          removed.startsWith('local-cli/node_modules/') &&
          !removed.split(/[\\/]/).includes('..') &&
          (file === removed || file.startsWith(`${removed}/`))
      );
    const retainedFiles = receipt.entries
      .filter(([file, sha]) => sha !== 'directory' && !marker(file) && !pruned(file))
      .map(([file]) => file);
    for (const [file, sha] of receipt.entries) {
      assert(
        typeof file === 'string' && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..')
      );
      const leaf = await lstat(path.join(root, file)).catch((error) => {
        if (
          packaged &&
          error.code === 'ENOENT' &&
          (pruned(file) ||
            (sha !== 'directory' && marker(file)) ||
            (sha === 'directory' &&
              !retainedFiles.some((retained) => retained.startsWith(`${file}/`))))
        )
          return null;
        throw error;
      });
      if (!leaf) continue;
      if (sha === 'directory') assert(leaf.isDirectory() && !leaf.isSymbolicLink());
      else {
        assert(/^[a-f0-9]{64}$/.test(sha));
        assert.equal(await digest(file), sha, `Candidate companion changed: ${file}`);
      }
    }
  }
  return identity;
}

async function stageCandidate() {
  // Explicit CI-only test packaging. Never edits runtime.lock or publishes a release.
  const repo = candidateRepository;
  const runId = process.env.RUNTIME_CANDIDATE_RUN;
  const sha = process.env.RUNTIME_CANDIDATE_SHA;
  const bunVersion = candidateBunVersion(process.env.RUNTIME_CANDIDATE_BUN_VERSION);
  assert(process.env.GITHUB_ACTIONS === 'true' && process.platform === 'win32');
  assert(/^\d+$/.test(runId ?? ''), 'Expected numeric candidate CI run');
  assert(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Expected exact candidate source SHA');
  const gh = (...args) =>
    execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const api = (endpoint) => JSON.parse(gh('api', endpoint));
  const run = api(`repos/${repo}/actions/runs/${runId}`);
  assert.equal(run.head_sha, sha, 'Candidate source mismatch');
  assert.equal(run.head_repository.full_name, repo, 'Foreign candidate repository');
  assert.equal(run.path, '.github/workflows/ci.yml', 'Not the runtime CI workflow');
  // Qualification can run alongside the remaining CI suites. Delivery still requires full CI.
  const jobs = candidatePages(api, `repos/${repo}/actions/runs/${runId}/jobs`, 'jobs');
  const producers = jobs.filter((job) => job.name === 'Packaged delivery (win32-x64)');
  assert.equal(producers.length, 1, 'Missing or ambiguous candidate producer');
  assert.equal(producers[0].status, 'completed', 'Candidate producer has not completed');
  assert.equal(producers[0].conclusion, 'success', 'Windows candidate producer did not pass');
  const pkg = api(`repos/${repo}/contents/package.json?ref=${sha}`);
  const sourceVersion = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')).version;
  const lock = JSON.parse(await readFile('runtime.lock.json', 'utf8'));
  assert(/^\d+\.\d+\.\d+$/.test(sourceVersion), 'Invalid candidate source version');
  const name = `packaged-delivery-win32-x64-${sha}`;
  const listing = candidatePages(api, `repos/${repo}/actions/runs/${runId}/artifacts`, 'artifacts');
  const matches = listing.filter((item) => item.name === name && !item.expired);
  assert.equal(matches.length, 1, 'Missing or ambiguous candidate artifact');
  const artifact = matches[0];
  assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ''), 'Missing artifact integrity digest');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencode-candidate-'));
  try {
    // Verify the archive itself against GitHub's immutable artifact digest before extraction.
    const archive = await downloadCandidateArchive(artifact.id);
    assert.equal(`sha256:${createHash('sha256').update(archive).digest('hex')}`, artifact.digest);
    const archivePath = path.join(temp, 'candidate.zip');
    await writeFile(archivePath, archive);
    const extract = path.join(temp, 'payload');
    const execute = (command, args, options = {}) =>
      execFileSync(command, args, { stdio: 'inherit', ...options });
    extractArchive(archivePath, extract, 'zip', execute);
    const payloadArchive = path.join(extract, 'candidate-win32-x64.tar.gz');
    const payloadArchiveSha256 = createHash('sha256')
      .update(await readFile(payloadArchive))
      .digest('hex');
    const unpacked = path.join(temp, 'runtime-payload');
    extractArchive(payloadArchive, unpacked, 'tar.gz', execute);
    const payload = path.join(unpacked, 'runtime');
    const provenance = {
      schemaVersion: 2,
      testOnly: true,
      repository: repo,
      runId,
      sourceSha: sha,
      sourceVersion,
      bunVersion,
      publishedVersion: lock.version,
      producerJobId: producers[0].id,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      payloadArchiveSha256,
    };
    Object.assign(provenance, await verifyCandidatePayload(payload, provenance));
    await writeFile(path.join(payload, 'TEST-CANDIDATE.json'), JSON.stringify(provenance, null, 2));
    publishRuntimePayload(
      path.join(payload, 'claude-multimodel.exe'),
      path.resolve('resources/runtime'),
      payloadArchiveSha256
    );
    provenance.payloadReceiptSha256 = createHash('sha256')
      .update(await readFile('resources/runtime/.archive-payload.json'))
      .digest('hex');
    await verifyCandidatePayload(path.resolve('resources/runtime'), provenance);
    // Derive only from the verified complete source, before afterPack removes foreign variants.
    const { getKnownPrunableNativeArtifactRoot, detectBinaryMetadata, isBinaryCompatible } =
      createRequire(import.meta.url)('../../electron-builder/afterPack.cjs')._internal;
    const receipt = JSON.parse(await readFile('resources/runtime/.archive-payload.json', 'utf8'));
    const removed = new Set();
    for (const [file, digest] of receipt.entries) {
      if (digest === 'directory') continue;
      const physical = path.resolve('resources/runtime', file);
      const prune = await getKnownPrunableNativeArtifactRoot(
        path.resolve('.'),
        physical,
        'win32',
        'x64'
      );
      if (!prune) continue;
      const metadata = await detectBinaryMetadata(physical);
      if (metadata && !isBinaryCompatible(metadata.format, metadata.archs, 'win32', 'x64'))
        removed.add(
          path.relative(path.resolve('resources/runtime'), prune).split(path.sep).join('/')
        );
    }
    provenance.allowedPrunedRoots = [...removed].sort();
    await writeFile('runtime-candidate-evidence.json', JSON.stringify(provenance, null, 2));
    console.log(JSON.stringify(provenance));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await stageCandidate();
}
