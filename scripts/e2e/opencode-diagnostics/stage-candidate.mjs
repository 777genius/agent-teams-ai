import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Bound API work and reject partial/changing listings before selecting a producer or artifact.
export function candidatePages(api, endpoint, key) {
  const perPage = 100;
  const maxPages = 100;
  const items = [];
  const ids = new Set();
  let total;
  for (let page = 1; page <= maxPages; page++) {
    const result = api(`${endpoint}?per_page=${perPage}&page=${page}`);
    assert(Number.isSafeInteger(result.total_count) && result.total_count >= 0,
      'Invalid candidate listing total');
    assert(result.total_count <= perPage * maxPages, 'Candidate listing exceeds pagination cap');
    total ??= result.total_count;
    assert.equal(result.total_count, total, 'Candidate listing changed during pagination');
    assert(Array.isArray(result[key]), 'Invalid candidate listing page');
    assert.equal(result[key].length, Math.min(perPage, total - items.length),
      'Incomplete candidate listing page');
    for (const item of result[key]) {
      assert(Number.isSafeInteger(item.id) && item.id > 0 && !ids.has(item.id),
        'Invalid or repeated candidate listing identity');
      ids.add(item.id);
      items.push(item);
    }
    if (items.length === total) return items;
  }
  assert.fail('Candidate pagination cap reached');
}

async function stageCandidate() {
  // Explicit CI-only test packaging. Never edits runtime.lock or publishes a release.
  const repo = '777genius/agent_teams_orchestrator';
  const runId = process.env.RUNTIME_CANDIDATE_RUN;
  const sha = process.env.RUNTIME_CANDIDATE_SHA;
  assert(process.env.GITHUB_ACTIONS === 'true' && process.platform === 'win32');
  assert(/^\d+$/.test(runId ?? ''), 'Expected numeric candidate CI run');
  assert(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Expected exact candidate source SHA');
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const api = (endpoint) => JSON.parse(gh('api', endpoint));
  const run = api(`repos/${repo}/actions/runs/${runId}`);
  assert.equal(run.head_sha, sha, 'Candidate source mismatch');
  assert.equal(run.head_repository.full_name, repo, 'Foreign candidate repository');
  assert.equal(run.path, '.github/workflows/ci.yml', 'Not the runtime CI workflow');
  // Qualification can run alongside the remaining CI suites. Delivery still requires full CI.
  const jobs = candidatePages(api, `repos/${repo}/actions/runs/${runId}/jobs`, 'jobs');
  const producers = jobs.filter(job => job.name === 'Windows packaged backfill (candidate)');
  assert.equal(producers.length, 1, 'Missing or ambiguous candidate producer');
  assert.equal(producers[0].conclusion, 'success', 'Windows candidate producer did not pass');
  const pkg = api(`repos/${repo}/contents/package.json?ref=${sha}`);
  const sourceVersion = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')).version;
  const lock = JSON.parse(await readFile('runtime.lock.json', 'utf8'));
  assert.equal(sourceVersion, lock.version, 'Candidate packaging requires the same payload version');
  const name = `opencode-windows-runtime-candidate-${sha}`;
  const listing = candidatePages(api, `repos/${repo}/actions/runs/${runId}/artifacts`, 'artifacts');
  const matches = listing.filter(item => item.name === name && !item.expired);
  assert.equal(matches.length, 1, 'Missing or ambiguous candidate artifact');
  const artifact = matches[0];
  assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ''), 'Missing artifact integrity digest');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencode-candidate-'));
  try {
    // Verify the archive itself against GitHub's immutable artifact digest before extraction.
    const archive = execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${artifact.id}/zip`], {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    assert.equal(`sha256:${createHash('sha256').update(archive).digest('hex')}`, artifact.digest);
    const archivePath = path.join(temp, 'candidate.zip');
    await writeFile(archivePath, archive);
    const extract = path.join(temp, 'payload');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:OC_CANDIDATE_ARCHIVE -DestinationPath $env:OC_CANDIDATE_EXTRACT'], {
      env: { ...process.env, OC_CANDIDATE_ARCHIVE: archivePath, OC_CANDIDATE_EXTRACT: extract },
      stdio: 'inherit',
    });
    const binary = path.join(extract, 'cli.exe');
    const bytes = await readFile(binary);
    assert(bytes.length > 1024 && bytes.subarray(0, 2).toString() === 'MZ', 'Not a Windows executable');
    const binarySha256 = createHash('sha256').update(bytes).digest('hex');
    await copyFile(binary, 'resources/runtime/claude-multimodel.exe');
    const provenance = { schemaVersion: 1, testOnly: true, repository: repo, runId, sourceSha: sha,
      sourceVersion, producerJobId: producers[0].id, artifactId: artifact.id, artifactDigest: artifact.digest, binarySha256 };
    await writeFile('resources/runtime/TEST-CANDIDATE.json', JSON.stringify(provenance, null, 2));
    await writeFile('runtime-candidate-evidence.json', JSON.stringify(provenance, null, 2));
    console.log(JSON.stringify(provenance));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await stageCandidate();
}
