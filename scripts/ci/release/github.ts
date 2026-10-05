import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { digest, requireThat } from './contract.js';
import type {
  Asset,
  BuildProof,
  Mode,
  NativeEvidenceReference,
  NativeProbeArtifact,
  Release,
  ReleasePort,
} from './contract.js';

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
        : reject(
            new Error(
              `${executable} ${args[0]} failed (${code}): ${Buffer.concat(errors).toString()}`
            )
          )
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
export class GitHubReleasePort implements ReleasePort {
  async release(repository: string, tag: string): Promise<Release> {
    const release = await api<Release>(`repos/${repository}/releases/tags/${tag}`);
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
  async upload(repository: string, tag: string, file: string): Promise<void> {
    await command(['release', 'upload', tag, file, '--repo', repository]);
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
    const run = await api<{ head_sha: string; run_attempt: number; event: string }>(
      `repos/${repository}/actions/runs/${proof.runId}`
    );
    requireThat(
      run.head_sha === sha && run.run_attempt === proof.attempt,
      'Build run application SHA/attempt mismatch'
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
    const response = await fetch(
      `https://github.com/${repository}/releases/download/${tag}/${name}`,
      { method: 'HEAD', redirect: 'follow' }
    );
    requireThat(response.ok, `Anonymous asset unavailable: ${tag}/${name}`);
  }
  async publicRelease(repository: string, tag: string): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    requireThat(response.ok, `Anonymous release unavailable: ${tag}`);
    const release = (await response.json()) as Release;
    requireThat(
      !release.draft && !release.prerelease && release.tag_name === tag,
      'Anonymous release visibility mismatch'
    );
  }
  async publicLatest(repository: string, tag: string): Promise<void> {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    requireThat(response.ok, 'Anonymous latest release unavailable');
    const release = (await response.json()) as Release;
    requireThat(
      !release.draft && !release.prerelease && release.tag_name === tag,
      'Anonymous latest tag mismatch'
    );
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
    const run = await api<{ head_sha: string; run_attempt: number; status: string; path: string }>(
      `repos/${ref.repository}/actions/runs/${ref.runId}`
    );
    const job = await api<{ run_id: number; conclusion: string }>(
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
    requireThat(
      pages.some((p) => p.jobs.some((j) => j.id === ref.jobId)),
      'Native evidence job belongs to a different run attempt'
    );
    const artifact = await api<{
      name: string;
      digest: string;
      expired: boolean;
      workflow_run: { id: number; head_sha: string };
    }>(`repos/${ref.repository}/actions/artifacts/${ref.artifactId}`);
    requireThat(
      run.path === '.github/workflows/updater-mac-source.yml' &&
        run.head_sha === ref.toolingSha &&
        run.run_attempt === ref.runAttempt &&
        run.status === 'completed' &&
        job.run_id === ref.runId &&
        job.conclusion === 'success',
      'Native evidence producer did not succeed in trusted workflow at reviewed tooling SHA'
    );
    requireThat(
      !artifact.expired &&
        artifact.name === ref.artifactName &&
        artifact.digest === `sha256:${ref.artifactSha256}` &&
        artifact.workflow_run.id === ref.runId &&
        artifact.workflow_run.head_sha === ref.toolingSha,
      'Native evidence artifact identity/digest mismatch'
    );
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
