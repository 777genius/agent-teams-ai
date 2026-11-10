// Selected donor: agent_teams_orchestrator@969afc56, GitChangePathProvider only.
import { spawn } from 'node:child_process';

export type GitChangeRelation = {
  kind: 'rename' | 'copy';
  oldPath: string;
  newPath: string;
};

export type GitChangePathEntry = {
  path: string;
  status: string;
  relation?: GitChangeRelation;
};

export type GitChangePathResult = {
  entries: Map<string, GitChangePathEntry>;
  paths: Set<string>;
  warnings: string[];
};

type ParseOptions = {
  maxPaths?: number;
  label?: string;
};

type RunOptions = {
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
};

const DEFAULT_MAX_PATHS = 500;

function resultFromEntries(
  entries: Map<string, GitChangePathEntry>,
  warnings: string[] = []
): GitChangePathResult {
  return {
    entries,
    paths: new Set(entries.keys()),
    warnings,
  };
}

function relationKindForStatus(status: string): GitChangeRelation['kind'] | null {
  if (status.startsWith('C') || status.includes('C')) {
    return 'copy';
  }
  if (status.startsWith('R') || status.includes('R')) {
    return 'rename';
  }
  return null;
}

function addEntry(
  entries: Map<string, GitChangePathEntry>,
  entry: GitChangePathEntry,
  maxPaths: number,
  warnings: string[],
  label: string
): boolean {
  if (!entries.has(entry.path) && entries.size >= maxPaths) {
    warnings.push(`${label} path cap reached at ${maxPaths} paths; remaining paths skipped.`);
    return false;
  }
  const existing = entries.get(entry.path);
  const relation = entry.relation ?? existing?.relation;
  entries.set(entry.path, {
    ...existing,
    ...entry,
    ...(relation ? { relation } : {}),
  });
  return true;
}

export function parseGitStatusPorcelainZ(
  stdout: string,
  options: ParseOptions = {}
): GitChangePathResult {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const label = options.label ?? 'git status';
  const warnings: string[] = [];
  const entries = new Map<string, GitChangePathEntry>();
  const records = stdout.split('\0');
  const hadPartialTrailingRecord = stdout.length > 0 && !stdout.endsWith('\0');
  const recordCount = hadPartialTrailingRecord ? records.length - 1 : records.length;

  for (let i = 0; i < recordCount; i++) {
    const record = records[i];
    if (!record) {
      continue;
    }
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) {
      continue;
    }

    const relationKind = relationKindForStatus(status);
    if (relationKind) {
      const previousPath = i + 1 < recordCount ? records[i + 1] : undefined;
      if (previousPath) {
        const relation: GitChangeRelation = {
          kind: relationKind,
          oldPath: previousPath,
          newPath: filePath,
        };
        if (!addEntry(entries, { path: filePath, status, relation }, maxPaths, warnings, label)) {
          break;
        }
        if (
          !addEntry(entries, { path: previousPath, status, relation }, maxPaths, warnings, label)
        ) {
          break;
        }
        i += 1;
        continue;
      }
      warnings.push(`${label} relation record for ${filePath} was missing its previous path.`);
    }

    if (!addEntry(entries, { path: filePath, status }, maxPaths, warnings, label)) {
      break;
    }
  }

  if (hadPartialTrailingRecord) {
    warnings.push(`${label} output ended with a partial record; trailing record skipped.`);
  }
  return resultFromEntries(entries, warnings);
}

export function parseGitNameStatusZ(
  stdout: string,
  options: ParseOptions = {}
): GitChangePathResult {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const label = options.label ?? 'git diff --name-status';
  const warnings: string[] = [];
  const entries = new Map<string, GitChangePathEntry>();
  const records = stdout.split('\0');
  const hadPartialTrailingRecord = stdout.length > 0 && !stdout.endsWith('\0');
  const recordCount = hadPartialTrailingRecord ? records.length - 1 : records.length;

  for (let i = 0; i < recordCount; i++) {
    const status = records[i];
    if (!status) {
      continue;
    }

    const relationKind = relationKindForStatus(status);
    if (relationKind) {
      const oldPath = i + 1 < recordCount ? records[i + 1] : undefined;
      const newPath = i + 2 < recordCount ? records[i + 2] : undefined;
      if (!oldPath || !newPath) {
        warnings.push(`${label} relation record ${status} was incomplete.`);
        break;
      }
      const relation: GitChangeRelation = { kind: relationKind, oldPath, newPath };
      if (!addEntry(entries, { path: oldPath, status, relation }, maxPaths, warnings, label)) {
        break;
      }
      if (!addEntry(entries, { path: newPath, status, relation }, maxPaths, warnings, label)) {
        break;
      }
      i += 2;
      continue;
    }

    const filePath = i + 1 < recordCount ? records[i + 1] : undefined;
    if (!filePath) {
      warnings.push(`${label} record ${status} was missing its path.`);
      break;
    }
    if (!addEntry(entries, { path: filePath, status }, maxPaths, warnings, label)) {
      break;
    }
    i += 1;
  }

  if (hadPartialTrailingRecord) {
    warnings.push(`${label} output ended with a partial record; trailing record skipped.`);
  }
  return resultFromEntries(entries, warnings);
}

async function runGitCapped(
  args: string[],
  options: RunOptions
): Promise<{
  stdout: string;
  code: number;
  warnings: string[];
}> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const warnings: string[] = [];
    const commandLabel = `git ${args.join(' ')}`;

    const settle = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks).toString('utf8'),
        code,
        warnings,
      });
    };

    const timer = setTimeout(() => {
      warnings.push(`${commandLabel} timed out after ${options.timeoutMs}ms.`);
      child.kill('SIGTERM');
      settle(1);
    }, options.timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      const remaining = options.maxBytes - totalBytes;
      if (remaining <= 0) {
        warnings.push(
          `${commandLabel} output exceeded ${options.maxBytes} bytes; output truncated.`
        );
        child.kill('SIGTERM');
        settle(1);
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        totalBytes += remaining;
        warnings.push(
          `${commandLabel} output exceeded ${options.maxBytes} bytes; output truncated.`
        );
        child.kill('SIGTERM');
        settle(1);
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.length;
    });

    child.on('error', (error) => {
      warnings.push(`${commandLabel} failed to start: ${String(error)}.`);
      settle(1);
    });
    child.on('close', (code) => settle(code ?? 1));
  });
}

/** Capped discovery only: all preimages are subsequently read from actual disk. */
export async function getGitWorkspacePaths(params: {
  gitRoot: string;
  timeoutMs: number;
  maxBytes: number;
  maxPaths: number;
}): Promise<GitChangePathResult> {
  const result = await runGitCapped(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: params.gitRoot,
      timeoutMs: params.timeoutMs,
      maxBytes: params.maxBytes,
    }
  );
  const paths = result.stdout.split('\0').filter(Boolean);
  const warnings = [...result.warnings];
  if (result.code !== 0) warnings.push('Git workspace census unavailable or partial.');
  if (paths.length > params.maxPaths) warnings.push('Git workspace census path cap reached.');
  if (result.stdout && !result.stdout.endsWith('\0'))
    warnings.push('Git workspace census partial record.');
  return resultFromEntries(
    new Map(paths.slice(0, params.maxPaths).map((path) => [path, { path, status: '' }])),
    warnings
  );
}

export async function getGitStatusPathEntries(params: {
  gitRoot: string;
  timeoutMs: number;
  maxBytes: number;
  maxPaths: number;
}): Promise<GitChangePathResult> {
  const result = await runGitCapped(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: params.gitRoot,
    timeoutMs: params.timeoutMs,
    maxBytes: params.maxBytes,
  });
  if (result.code !== 0 && result.stdout.length === 0) {
    return resultFromEntries(new Map(), [
      ...result.warnings,
      'Unable to read git status for task-change ledger.',
    ]);
  }
  const parsed = parseGitStatusPorcelainZ(result.stdout, {
    maxPaths: params.maxPaths,
    label: 'git status',
  });
  return resultFromEntries(parsed.entries, [...result.warnings, ...parsed.warnings]);
}

export async function getGitCommittedPathEntries(params: {
  gitRoot: string;
  beforeHead: string;
  afterHead: string;
  timeoutMs: number;
  maxBytes: number;
  maxPaths: number;
}): Promise<GitChangePathResult> {
  const result = await runGitCapped(
    [
      'diff',
      '--name-status',
      '-z',
      '--find-copies-harder',
      `${params.beforeHead}..${params.afterHead}`,
    ],
    {
      cwd: params.gitRoot,
      timeoutMs: params.timeoutMs,
      maxBytes: params.maxBytes,
    }
  );
  if (result.code !== 0 && result.stdout.length === 0) {
    return resultFromEntries(new Map(), [
      ...result.warnings,
      'Unable to read committed diff for shell command.',
    ]);
  }
  const parsed = parseGitNameStatusZ(result.stdout, {
    maxPaths: params.maxPaths,
    label: 'git diff --name-status',
  });
  return resultFromEntries(parsed.entries, [...result.warnings, ...parsed.warnings]);
}
