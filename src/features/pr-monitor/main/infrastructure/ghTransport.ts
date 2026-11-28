import { execCli } from '@main/utils/childProcess';
import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { findFirstRuntimePathBinaryCandidate } from '@main/utils/runtimePathBinaryResolver';
import { isGitHubReadPath } from '@pr-monitor/github';

import type { RepositoryKey } from '@pr-monitor/core';
import type { GitHubResponse, GitHubTransport } from '@pr-monitor/github';

export function findGitHubCli(): string | null {
  return findFirstRuntimePathBinaryCandidate({
    executableNames: process.platform === 'win32' ? ['gh.exe'] : ['gh'],
  });
}

/** gh keeps credential custody. Only fixed-origin, repository-scoped GETs cross this boundary. */
export function createGhTransport(repository: RepositoryKey): GitHubTransport {
  const prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/`;
  return async (request) => {
    if (!isGitHubReadPath(request.path) || !request.path.startsWith(prefix)) {
      throw new Error('Invalid repository request.');
    }
    const binary = findGitHubCli();
    if (!binary) return { status: 401, headers: {}, body: null };
    const args = ['api', '--hostname', 'github.com', '--method', 'GET', '--include', request.path];
    for (const name of ['accept', 'if-none-match', 'x-github-api-version']) {
      const value = request.headers[name];
      if (value && !/[\r\n]/.test(value)) args.push('--header', `${name}: ${value}`);
    }
    try {
      const { stdout } = await execCli(binary, args, {
        env: {
          ...process.env,
          PATH: buildMergedCliPath(binary),
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: 'cat',
        },
        timeout: 20_000,
        stdoutMaxBuffer: 4 * 1024 * 1024,
        stderrMaxBuffer: 32 * 1024,
        signal: request.signal,
      });
      return parseGhResponse(stdout);
    } catch (error) {
      if (request.signal?.aborted) throw new Error('Request cancelled.');
      // gh returns nonzero for HTTP errors while retaining the included response.
      const output =
        error && typeof error === 'object' && 'stdout' in error ? error.stdout : undefined;
      if (typeof output === 'string' && /^HTTP\//.test(output)) return parseGhResponse(output);
      // Classify diagnostics without forwarding account identifiers or provider output.
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? error.stderr : undefined;
      if (typeof stderr === 'string' && /gh auth login|not logged|authentication/i.test(stderr))
        return { status: 401, headers: {}, body: null };
      throw new Error('GitHub could not be reached.');
    }
  };
}

export function parseGhResponse(output: string): GitHubResponse {
  const normalized = output.replaceAll('\r\n', '\n');
  const end = normalized.indexOf('\n\n');
  const lines = normalized.slice(0, end).split('\n');
  const status = /^HTTP\/\S+ (\d{3})/.exec(lines.shift() ?? '')?.[1];
  if (end < 0 || !status) throw new Error('Invalid GitHub response.');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const text = normalized.slice(end + 2).trim();
  return { status: Number(status), headers, body: text ? (JSON.parse(text) as unknown) : null };
}
