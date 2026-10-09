import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { manualCapturePaths } from './macManualReadiness.js';
import { canonical, fileProof, requireThat } from './contract.js';
import { executablePath } from './github.js';
import { closedWindowsResumeExecutor, RELEASE216_TOOLING } from './nativeReadinessAuthority.js';
import { RELEASE220_EXECUTION as full220Pins } from './release220ExecutionPins.js';
import { RELEASE220_MAC_EXECUTION as mac220Pins } from './release220MacExecutionPins.js';
import { RELEASE220_WINDOWS_EXECUTION as windows220Pins } from './release220WindowsExecutionPins.js';
import type { RELEASE220_WINDOWS_RESUME_EXECUTION as resume220Pins } from './release220WindowsResumeExecutionPins.js';
import type { RELEASE220_WINDOWS_REMAINING_EXECUTION as remaining220Pins } from './release220WindowsRemainingExecutionPins.js';
import type { Release220ExecutionProof } from './nativeReadinessAuthority.js';
import type { ExecutionProof, ExecutionTree } from './nativeReadinessAuthority.js';
import type {
  NativeArtifact,
  NativeJob,
  NativeReadinessPort,
  NativeRun,
} from './nativeReadiness.js';

export function validateNativeArchivePaths(paths: string[]): void {
  const manual = ['TEST-mac-manual-evidence/native-manual-receipt.json', ...manualCapturePaths];
  if (paths.some((entry) => manual.includes(entry))) {
    requireThat(
      canonical(paths) === canonical(manual),
      'Exact manual receipt and three native captures required'
    );
    return;
  }
  requireThat(
    paths.length > 0 && paths.length <= 2 && new Set(paths).size === paths.length,
    'Unexpected native outcome entries'
  );
  for (const entry of paths)
    requireThat(
      /^[A-Za-z0-9._/-]+\.json$/.test(entry) &&
        !entry.startsWith('/') &&
        entry.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
      'Unsafe native entry path'
    );
}

const execute = promisify(execFile);
const MAX_ENTRY = 16 * 1024 * 1024;
async function command(binary: 'gh' | 'unzip', args: string[]): Promise<string> {
  return (await execute(binary, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: MAX_ENTRY }))
    .stdout;
}
async function api<T>(endpoint: string): Promise<T> {
  return JSON.parse(
    await command('gh', ['api', endpoint, '-H', 'Accept: application/vnd.github+json'])
  ) as T;
}
function repository(value: string) {
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), 'Invalid native repository');
  return `repos/${value}`;
}
function id(value: number) {
  requireThat(Number.isSafeInteger(value) && value > 0, 'Invalid native GitHub identity');
  return value;
}
async function download(endpoint: string, destination: string): Promise<void> {
  // Actions archive requests use JSON Accept. Octet-stream Accept is for release assets.
  const child = spawn(
    await executablePath('gh'),
    ['api', endpoint, '-H', 'Accept: application/vnd.github+json'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (value: string) => {
    stderr = `${stderr}${value}`.slice(-4096);
  });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 180_000);
  try {
    const completed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Native artifact download failed (${code}): ${stderr}`))
      );
    });
    await Promise.all([
      pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' })),
      completed,
    ]);
  } catch (error) {
    // A failed file stream must not leave gh downloading after its deadline is cleared.
    child.kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
/** Read-only GitHub adapter; credentials are handled entirely by installed gh. */
export class GitHubNativeReadinessPort implements NativeReadinessPort {
  async executionProof(repo: string, executionSha: string): Promise<ExecutionProof> {
    requireThat(/^[a-f0-9]{40}$/.test(executionSha), 'Invalid execution commit');
    const root = repository(repo);
    const [commit, comparison] = await Promise.all([
      api<ExecutionProof['commit']>(`${root}/git/commits/${executionSha}`),
      api<ExecutionProof['comparison']>(`${root}/compare/${RELEASE216_TOOLING}...${executionSha}`),
    ]);
    requireThat(
      commit.sha === executionSha && /^[a-f0-9]{40}$/.test(commit.tree.sha),
      'Wrong execution commit'
    );
    const [baseTree, executionTree] = await Promise.all([
      api<ExecutionTree>(`${root}/git/trees/cb7c434ebe9aae6a631f64292746af75e48a753d?recursive=1`),
      api<ExecutionTree>(`${root}/git/trees/${commit.tree.sha}?recursive=1`),
    ]);
    return { repository: repo, commit, comparison, baseTree, executionTree };
  }

  async release220ExecutionProof(): Promise<Release220ExecutionProof> {
    const repo = full220Pins.repository;
    const root = repository(repo);
    const [commit, comparison, baseTree, executionTree, ci, jobs, baseCi, baseJobs] =
      await Promise.all([
        api<ExecutionProof['commit']>(`${root}/git/commits/${full220Pins.head}`),
        api<Release220ExecutionProof['comparison']>(
          `${root}/compare/${full220Pins.base}...${full220Pins.head}`
        ),
        api<ExecutionTree>(`${root}/git/trees/${full220Pins.baseTree}?recursive=1`),
        api<ExecutionTree>(`${root}/git/trees/${full220Pins.tree}?recursive=1`),
        api<Release220ExecutionProof['ci']>(`${root}/actions/runs/${full220Pins.ciRun}`),
        this.jobs(repo, full220Pins.ciRun, full220Pins.ciAttempt),
        api<Release220ExecutionProof['ci']>(`${root}/actions/runs/${full220Pins.baseCiRun}`),
        this.jobs(repo, full220Pins.baseCiRun, full220Pins.ciAttempt),
      ]);
    return {
      repository: repo,
      commit,
      comparison,
      baseTree,
      executionTree,
      ci,
      jobs,
      baseCi,
      baseJobs,
    };
  }

  async release220MacExecutionProof(): Promise<ExecutionProof> {
    return this.closed220ExecutionProof(mac220Pins);
  }

  async release220WindowsExecutionProof(): Promise<ExecutionProof> {
    return this.closed220ExecutionProof(windows220Pins);
  }
  async release220WindowsResumeExecutionProof(executionSha?: string): Promise<ExecutionProof> {
    return this.closed220ExecutionProof(closedWindowsResumeExecutor(executionSha));
  }

  private async closed220ExecutionProof(
    executor:
      | typeof mac220Pins
      | typeof windows220Pins
      | typeof resume220Pins
      | typeof remaining220Pins
  ): Promise<ExecutionProof> {
    const root = repository(executor.repository);
    const [commit, comparison, baseTree, executionTree] = await Promise.all([
      api<ExecutionProof['commit']>(`${root}/git/commits/${executor.head}`),
      api<ExecutionProof['comparison']>(`${root}/compare/${executor.base}...${executor.head}`),
      api<ExecutionTree>(`${root}/git/trees/${executor.baseTree}?recursive=1`),
      api<ExecutionTree>(`${root}/git/trees/${executor.tree}?recursive=1`),
    ]);
    return { repository: executor.repository, commit, comparison, baseTree, executionTree };
  }

  run(repo: string, runId: number): Promise<NativeRun> {
    return api(`${repository(repo)}/actions/runs/${id(runId)}`);
  }
  runAttempt(repo: string, runId: number, attempt: number): Promise<NativeRun> {
    return api(`${repository(repo)}/actions/runs/${id(runId)}/attempts/${id(attempt)}`);
  }
  async jobs(repo: string, runId: number, attempt: number): Promise<NativeJob[]> {
    const pages = JSON.parse(
      await command('gh', [
        'api',
        `${repository(repo)}/actions/runs/${id(runId)}/attempts/${id(attempt)}/jobs?per_page=100`,
        '--paginate',
        '--slurp',
        '-H',
        'Accept: application/vnd.github+json',
      ])
    ) as { jobs: NativeJob[] }[];
    requireThat(
      Array.isArray(pages) && pages.every((page) => Array.isArray(page.jobs)),
      'Invalid native attempt jobs'
    );
    return pages.flatMap((page) => page.jobs);
  }
  artifact(repo: string, artifactId: number): Promise<NativeArtifact> {
    return api(`${repository(repo)}/actions/artifacts/${id(artifactId)}`);
  }
  async workflow(repo: string, toolingSha: string, workflowPath: string): Promise<string> {
    requireThat(
      /^[a-f0-9]{40}$/.test(toolingSha) &&
        /^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(workflowPath),
      'Unsafe immutable workflow reference'
    );
    const content = await api<{ encoding: string; content: string }>(
      `${repository(repo)}/contents/${workflowPath}?ref=${toolingSha}`
    );
    requireThat(
      content.encoding === 'base64' && typeof content.content === 'string',
      'Missing immutable workflow source'
    );
    return Buffer.from(content.content, 'base64').toString('utf8');
  }
  async archive(
    repo: string,
    artifactId: number,
    paths: string[]
  ): Promise<{ sha256: string; entries: Record<string, Buffer> }> {
    validateNativeArchivePaths(paths);
    const directory = await mkdtemp(path.join(tmpdir(), 'TEST-native-readiness-'));
    try {
      const zip = path.join(directory, 'artifact.zip');
      await download(`${repository(repo)}/actions/artifacts/${id(artifactId)}/zip`, zip);
      const proof = await fileProof(zip, 'artifact.zip');
      const entries = (await command('unzip', ['-Z1', zip])).split(/\r?\n/).filter(Boolean);
      requireThat(
        entries.every(
          (entry) =>
            !entry.startsWith('/') &&
            !entry.includes('\\') &&
            entry.split('/').every((part) => part !== '..')
        ),
        'Unsafe native archive member'
      );
      const result: Record<string, Buffer> = {};
      for (const entry of paths) {
        requireThat(
          entries.filter((name) => name === entry).length === 1,
          `Missing/duplicate native ZIP entry: ${entry}`
        );
        // No archive is extracted to disk. Only closed, exact outcome and native capture paths are read.
        const bytes = await execute('unzip', ['-p', zip, entry], {
          encoding: 'buffer',
          timeout: 30_000,
          maxBuffer: MAX_ENTRY,
        });
        result[entry] = bytes.stdout;
      }
      return { sha256: proof.sha256, entries: result };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
