import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { digest, isPreviousRelease, requireThat } from './contract.js';
import type {
  Asset,
  BuildProof,
  Mode,
  NativeEvidenceReference,
  NativeProbeArtifact,
  Release,
  ReleasePort,
  StageInput,
} from './contract.js';

export class ReleaseHttpError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null) {
    super(message);
    this.httpStatus = httpStatus;
  }
}
class CliError extends ReleaseHttpError {
  constructor(
    executable: string,
    operation: string | undefined,
    code: number | null,
    stderr: string
  ) {
    const status = /\(HTTP (\d{3})\)/.exec(stderr)?.[1];
    super(
      `${executable} ${operation} failed (${code}): ${stderr}`,
      executable === 'gh' && status ? Number(status) : null
    );
  }
}
async function executablePath(name: 'gh' | 'unzip'): Promise<string> {
  for (const directory of (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Try the next installed CLI location. */
    }
  }
  throw new Error(`Required installed CLI unavailable: ${name}`);
}
async function command(
  args: string[],
  destination?: string,
  executable: 'gh' | 'unzip' = 'gh'
): Promise<string> {
  const child = spawn(await executablePath(executable), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors: Buffer[] = [];
  child.stderr.on('data', (b: Buffer) => errors.push(b));
  const chunks: Buffer[] = [];
  const result = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new CliError(executable, args[0], code, Buffer.concat(errors).toString()))
    );
  });
  if (destination)
    await Promise.all([
      pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' })),
      result,
    ]);
  else {
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    await result;
  }
  return Buffer.concat(chunks).toString();
}
async function api<T>(endpoint: string): Promise<T> {
  return JSON.parse(await command(['api', endpoint])) as T;
}
async function anonymous(url: string, options?: RequestInit): Promise<Release | undefined> {
  const signal = AbortSignal.timeout(30_000);
  try {
    const response = await fetch(url, { ...options, signal });
    if (!response.ok)
      throw new ReleaseHttpError(
        `Anonymous request unavailable: ${url} (HTTP ${response.status})`,
        response.status
      );
    // Keep GET body consumption inside the deadline: headers alone do not prove
    // that GitHub completed the response. HEAD proofs do not consume a body.
    return options?.method === 'HEAD' ? undefined : ((await response.json()) as Release);
  } catch (error) {
    if (
      signal.aborted &&
      signal.reason instanceof Error &&
      signal.reason.name === 'TimeoutError' &&
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    )
      throw new ReleaseHttpError(`Anonymous request timed out: ${url}`, 408);
    throw error;
  }
}
export interface NativeProducerMetadata {
  run: { head_sha: string; run_attempt: number; status: string; path: string };
  job: {
    run_id: number;
    name: string;
    status: string;
    conclusion: string;
    started_at: string;
    completed_at: string;
    steps: {
      name: string;
      status: string;
      conclusion: string;
      started_at: string;
      completed_at: string;
    }[];
  };
  attemptJobIds: number[];
  artifact: {
    name: string;
    digest: string;
    expired: boolean;
    created_at: string;
    workflow_run: { id: number; head_sha: string };
  };
}
export interface GitHubBuildRun {
  head_sha: string;
  run_attempt: number;
  path: string;
  event: string;
}
function trustedBuildProducer(run: GitHubBuildRun, mode: Mode): boolean {
  switch (run.path) {
    case '.github/workflows/release.yml':
      return run.event === 'push' || run.event === 'workflow_dispatch';
    case '.github/workflows/build-linux-windows-draft.yml':
      return mode === 'carry-mac' && run.event === 'workflow_dispatch';
    default:
      return false;
  }
}
export function validateNativeProducer(
  ref: NativeEvidenceReference,
  metadata: NativeProducerMetadata
): void {
  const { run, job, artifact } = metadata;
  requireThat(
    run.path === '.github/workflows/updater-mac-source.yml' &&
      run.head_sha === ref.toolingSha &&
      run.run_attempt === ref.runAttempt &&
      run.status === 'completed' &&
      metadata.attemptJobIds.includes(ref.jobId) &&
      job.run_id === ref.runId &&
      job.name === 'mac-source-signatures' &&
      job.status === 'completed' &&
      job.conclusion === 'success',
    'Native evidence producer did not succeed in trusted workflow/job/attempt at reviewed tooling SHA'
  );
  const expectedName = `mac-source-signature-evidence-${ref.runId}-${ref.runAttempt}`;
  requireThat(
    !artifact.expired &&
      artifact.name === expectedName &&
      ref.artifactName === expectedName &&
      artifact.digest === `sha256:${ref.artifactSha256}` &&
      artifact.workflow_run.id === ref.runId &&
      artifact.workflow_run.head_sha === ref.toolingSha,
    'Native evidence artifact identity/digest/attempt mismatch'
  );
  requireThat(Array.isArray(job.steps), 'Native evidence producer upload steps missing');
  const uploads = job.steps.filter(
    (step) => step.name === 'Preserve aggregate evidence and diagnostics'
  );
  const upload = uploads[0];
  requireThat(
    uploads.length === 1 && upload?.status === 'completed' && upload.conclusion === 'success',
    'Native evidence producer upload step missing, ambiguous, or unsuccessful'
  );
  const [jobStart, jobEnd, uploadStart, uploadEnd, created] = [
    job.started_at,
    job.completed_at,
    upload.started_at,
    upload.completed_at,
    artifact.created_at,
  ].map(Date.parse);
  requireThat(
    typeof jobStart === 'number' &&
      typeof jobEnd === 'number' &&
      typeof uploadStart === 'number' &&
      typeof uploadEnd === 'number' &&
      typeof created === 'number' &&
      [jobStart, jobEnd, uploadStart, uploadEnd, created].every(Number.isFinite) &&
      jobStart <= uploadStart &&
      uploadStart <= uploadEnd &&
      uploadEnd <= jobEnd &&
      created >= uploadStart &&
      created < uploadEnd + 1000,
    'Native evidence artifact was not created by the successful producer upload step'
  );
  // GitHub step timestamps have second precision; only the final fractional second
  // is admitted. The attempt-specific immutable artifact name also remains mandatory.
}
export class GitHubReleasePort implements ReleasePort {
  async releaseById(repository: string, id: number): Promise<Release> {
    requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Unsafe repository');
    requireThat(Number.isSafeInteger(id) && id > 0, 'Invalid numeric release identity');
    const release = await api<Release>(`repos/${repository}/releases/${id}`);
    requireThat(release.id === id, 'Numeric release endpoint returned another identity');
    const pages = JSON.parse(
      await command([
        'api',
        `repos/${repository}/releases/${id}/assets?per_page=100`,
        '--paginate',
        '--slurp',
      ])
    ) as Asset[][];
    requireThat(Array.isArray(pages) && pages.every(Array.isArray), 'Invalid release asset pages');
    return { ...release, assets: pages.flat() };
  }
  async setVisibility(
    repository: string,
    target: StageInput['target'],
    draft: boolean
  ): Promise<void> {
    requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Unsafe repository');
    requireThat(
      Number.isSafeInteger(target.id) && target.id > 0,
      'Invalid numeric release identity'
    );
    requireThat(
      /^v\d+\.\d+\.\d+$/.test(target.tag) && /^[a-f0-9]{40}$/.test(target.applicationSha),
      'Invalid pinned release tag/application SHA'
    );
    await command([
      'api',
      `repos/${repository}/releases/${target.id}`,
      '--method',
      'PATCH',
      '-f',
      `tag_name=${target.tag}`,
      '-f',
      `target_commitish=${target.applicationSha}`,
      '-F',
      `draft=${draft}`,
      '-F',
      'prerelease=false',
      '-f',
      `make_latest=${!draft}`,
    ]);
  }
  private async releaseByTag(repository: string, tag: string): Promise<Release> {
    try {
      const release = await api<Release>(`repos/${repository}/releases/tags/${tag}`);
      requireThat(release.tag_name === tag, 'Release tag endpoint returned a different tag');
      return release;
    } catch (error) {
      // GitHub's tag endpoint can hide authenticated drafts. Only its explicit
      // HTTP 404 permits discovery; auth, rate-limit and transport errors propagate.
      if (!(error instanceof CliError) || error.httpStatus !== 404) throw error;
    }
    const pages = JSON.parse(
      await command(['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp'])
    ) as Release[][];
    requireThat(
      Array.isArray(pages) && pages.every(Array.isArray),
      'Invalid authenticated release list'
    );
    const matches = pages.flat().filter((release) => release.tag_name === tag);
    requireThat(
      matches.length === 1,
      'Authenticated release discovery requires one exact tag match'
    );
    const listed = matches[0];
    requireThat(
      listed && Number.isSafeInteger(listed.id) && listed.id > 0 && listed.draft === true,
      'Tag endpoint 404 discovery is restricted to an authenticated draft'
    );
    const release = await api<Release>(`repos/${repository}/releases/${listed.id}`);
    requireThat(
      release.id === listed.id &&
        release.tag_name === tag &&
        release.draft === true &&
        release.prerelease === listed.prerelease &&
        release.target_commitish === listed.target_commitish,
      'Discovered draft identity/state changed during ID read'
    );
    return release;
  }
  async release(repository: string, tag: string): Promise<Release> {
    const release = await this.releaseByTag(repository, tag);
    const assets = JSON.parse(
      await command([
        'api',
        `repos/${repository}/releases/${release.id}/assets?per_page=100`,
        '--paginate',
        '--slurp',
      ])
    ) as Asset[][];
    release.assets = assets.flat();
    return release;
  }
  async tagSha(repository: string, tag: string): Promise<string> {
    return (await api<{ sha: string }>(`repos/${repository}/commits/${tag}`)).sha;
  }
  async latest(repository: string): Promise<Release> {
    return api<Release>(`repos/${repository}/releases/latest`);
  }
  async minimum(repository: string, sha: string): Promise<string> {
    const encoded = await api<{ content: string }>(
      `repos/${repository}/contents/package.json?ref=${sha}`
    );
    const manifest = JSON.parse(Buffer.from(encoded.content, 'base64').toString()) as {
      version: string;
      build?: { mac?: { minimumSystemVersion?: string } };
    };
    requireThat(
      manifest.build?.mac?.minimumSystemVersion,
      'Application commit has no macOS minimum'
    );
    return manifest.build.mac.minimumSystemVersion;
  }
  async download(repository: string, asset: Asset, destination: string): Promise<void> {
    await command(
      [
        'api',
        `repos/${repository}/releases/assets/${asset.id}`,
        '-H',
        'Accept: application/octet-stream',
      ],
      destination
    );
  }
  async upload(repository: string, releaseId: number, file: string): Promise<void> {
    requireThat(
      Number.isSafeInteger(releaseId) && releaseId > 0,
      'Numeric draft release ID required'
    );
    await command([
      'api',
      `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(path.basename(file))}`,
      '--hostname',
      'github.com',
      '--method',
      'POST',
      '-H',
      'Content-Type: application/octet-stream',
      '--input',
      file,
    ]);
  }
  async verifyBuild(repository: string, sha: string, proof: BuildProof, mode: Mode): Promise<void> {
    requireThat(
      Number.isSafeInteger(proof.runId) &&
        proof.runId > 0 &&
        Number.isSafeInteger(proof.attempt) &&
        proof.attempt > 0 &&
        proof.jobIds.length >= 3 &&
        new Set(proof.jobIds).size === proof.jobIds.length,
      'Explicit build run/attempt/jobs required'
    );
    const run = await api<GitHubBuildRun>(`repos/${repository}/actions/runs/${proof.runId}`);
    requireThat(
      run.head_sha === sha && run.run_attempt === proof.attempt,
      'Build run application SHA/attempt mismatch'
    );
    requireThat(
      trustedBuildProducer(run, mode),
      'Build producer workflow/event/mode is not trusted'
    );
    const pages = JSON.parse(
      await command([
        'api',
        `repos/${repository}/actions/runs/${proof.runId}/attempts/${proof.attempt}/jobs?per_page=100`,
        '--paginate',
        '--slurp',
      ])
    ) as { jobs: { id: number; run_id: number; conclusion: string; name: string }[] }[];
    const attemptJobs = pages.flatMap((p) => p.jobs);
    const jobs = proof.jobIds.map((id) => {
      const job = attemptJobs.find((j) => j.id === id);
      requireThat(job, 'Build job belongs to a different attempt');
      return job;
    });
    for (const job of jobs)
      requireThat(
        job.run_id === proof.runId && job.conclusion === 'success',
        'Reused platform build job did not succeed'
      );
    requireThat(
      jobs.some((j) => /release-win.*\bx64\b/i.test(j.name)) &&
        jobs.some((j) => /release-win.*\barm64\b/i.test(j.name)) &&
        jobs.some((j) => /release-linux/i.test(j.name)),
      'Successful Windows x64/ARM64 and Linux build jobs required'
    );
    if (mode === 'full')
      requireThat(
        jobs.some((j) => /release-mac.*\bx64\b/i.test(j.name)) &&
          jobs.some((j) => /release-mac.*\barm64\b/i.test(j.name)),
        'Successful Mac x64/ARM64 build jobs required in full mode'
      );
  }
  async publicAsset(repository: string, tag: string, name: string): Promise<void> {
    await anonymous(`https://github.com/${repository}/releases/download/${tag}/${name}`, {
      method: 'HEAD',
      redirect: 'follow',
    });
  }
  async publicLatestAsset(repository: string, name: string): Promise<void> {
    await anonymous(`https://github.com/${repository}/releases/latest/download/${name}`, {
      method: 'HEAD',
      redirect: 'follow',
    });
  }
  async publicRelease(repository: string, tag: string, expectedTarget = false): Promise<void> {
    let release: Release | undefined;
    try {
      release = await anonymous(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
    } catch (error) {
      if (expectedTarget && error instanceof ReleaseHttpError && error.httpStatus === 404)
        throw new ReleaseHttpError(
          `Expected published target is not anonymously visible: ${tag}`,
          408
        );
      throw error;
    }
    requireThat(
      release && !release.draft && !release.prerelease && release.tag_name === tag,
      'Anonymous release visibility mismatch'
    );
  }
  async publicLatest(
    repository: string,
    tag: string,
    previous?: StageInput['latest']
  ): Promise<void> {
    const release = await anonymous(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (release && !release.draft && !release.prerelease && release.tag_name === tag) return;
    if (release && isPreviousRelease(release, previous))
      throw new ReleaseHttpError('Anonymous latest still exposes the frozen previous release', 408);
    throw new Error('Anonymous latest tag mismatch');
  }
  async verifyNative(ref: NativeEvidenceReference): Promise<NativeProbeArtifact> {
    requireThat(
      ref.repository === '777genius/agent-teams-ai' &&
        /^[a-f0-9]{40}$/.test(ref.toolingSha) &&
        /^[a-f0-9]{64}$/.test(ref.artifactSha256),
      'Invalid native evidence reference'
    );
    for (const id of [ref.runId, ref.runAttempt, ref.jobId, ref.artifactId])
      requireThat(Number.isSafeInteger(id) && id > 0, 'Invalid native producer identity');
    const run = await api<NativeProducerMetadata['run']>(
      `repos/${ref.repository}/actions/runs/${ref.runId}`
    );
    const job = await api<NativeProducerMetadata['job']>(
      `repos/${ref.repository}/actions/jobs/${ref.jobId}`
    );
    const pages = JSON.parse(
      await command([
        'api',
        `repos/${ref.repository}/actions/runs/${ref.runId}/attempts/${ref.runAttempt}/jobs?per_page=100`,
        '--paginate',
        '--slurp',
      ])
    ) as { jobs: { id: number }[] }[];
    const artifact = await api<NativeProducerMetadata['artifact']>(
      `repos/${ref.repository}/actions/artifacts/${ref.artifactId}`
    );
    validateNativeProducer(ref, {
      run,
      job,
      artifact,
      attemptJobIds: pages.flatMap((p) => p.jobs.map((j) => j.id)),
    });
    const directory = await mkdtemp(path.join(tmpdir(), 'TEST-mac-evidence-'));
    try {
      const zip = path.join(directory, 'evidence.zip');
      await command(
        ['api', `repos/${ref.repository}/actions/artifacts/${ref.artifactId}/zip`],
        zip
      );
      requireThat(
        digest(await readFile(zip)) === ref.artifactSha256,
        'Native artifact actual byte digest mismatch'
      );
      // Read just the known entry; never extract untrusted paths into the filesystem.
      return JSON.parse(
        await command(['-p', zip, 'mac-source-signature-evidence.json'], undefined, 'unzip')
      ) as NativeProbeArtifact;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
