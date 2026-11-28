import { execCli } from '@main/utils/childProcess';
import { buildMergedCliPath } from '@main/utils/cliPathMerge';

import { findGitHubCli } from './ghTransport';

/** JSON status may exit zero even for invalid auth; inspect the active host state. */
export async function authenticatedGhAccount(signal?: AbortSignal): Promise<string | null> {
  const binary = findGitHubCli();
  if (!binary) return null;
  try {
    const { stdout } = await execCli(
      binary,
      ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'],
      {
        env: {
          ...process.env,
          PATH: buildMergedCliPath(binary),
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
        },
        signal,
        timeout: 20_000,
        stdoutMaxBuffer: 32 * 1024,
        stderrMaxBuffer: 4096,
      }
    );
    const value: unknown = JSON.parse(stdout);
    if (
      !value ||
      typeof value !== 'object' ||
      !('hosts' in value) ||
      !value.hosts ||
      typeof value.hosts !== 'object' ||
      !('github.com' in value.hosts)
    )
      return null;
    const hosts = value.hosts['github.com'];
    if (!Array.isArray(hosts)) return null;
    const account: unknown = hosts.find(
      (entry: unknown) =>
        entry && typeof entry === 'object' && 'active' in entry && entry.active === true
    );
    if (
      !account ||
      typeof account !== 'object' ||
      !('state' in account) ||
      account.state !== 'success' ||
      !('login' in account) ||
      typeof account.login !== 'string' ||
      !/^[a-z\d][a-z\d-]{0,38}$/i.test(account.login)
    )
      return null;
    return account.login.toLowerCase();
  } catch {
    return null;
  }
}
