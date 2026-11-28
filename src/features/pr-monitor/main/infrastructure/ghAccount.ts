import { execCli } from '@main/utils/childProcess';
import { buildMergedCliPath } from '@main/utils/cliPathMerge';

import { findGitHubCli } from './ghTransport';

/** Probe the credential gh actually uses; /user works before auth status gained JSON in 2.81. */
export async function authenticatedGhAccount(signal?: AbortSignal): Promise<string | null> {
  const binary = findGitHubCli();
  if (!binary || signal?.aborted) return null;
  try {
    const { stdout } = await execCli(
      binary,
      ['api', '--hostname', 'github.com', '--method', 'GET', '/user', '--jq', '{login: .login}'],
      {
        env: {
          ...process.env,
          PATH: buildMergedCliPath(binary),
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: 'cat',
        },
        signal,
        timeout: 20_000,
        stdoutMaxBuffer: 32 * 1024,
        stderrMaxBuffer: 4096,
      }
    );
    if (signal?.aborted) return null;
    const value: unknown = JSON.parse(stdout);
    if (
      !value ||
      typeof value !== 'object' ||
      !('login' in value) ||
      typeof value.login !== 'string' ||
      !/^[a-z\d][a-z\d-]{0,38}$/i.test(value.login)
    )
      return null;
    return value.login.toLowerCase();
  } catch {
    return null;
  }
}
