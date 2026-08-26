import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { getTeamBootstrapStatePath } from './TeamBootstrapStateReader';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';

const MAX_BOOTSTRAP_STATE_BYTES = 256 * 1024;

export async function inspectBootstrapStateForInvocationAbsence(
  teamName: string,
  launchCommandId: string
): Promise<'ignore' | 'veto' | 'conservative'> {
  const statePath = getTeamBootstrapStatePath(teamName);
  let validated: fs.Stats;
  try {
    validated = await fs.promises.lstat(statePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ignore' : 'conservative';
  }
  if (
    validated.isSymbolicLink() ||
    !validated.isFile() ||
    validated.size > MAX_BOOTSTRAP_STATE_BYTES
  ) {
    return 'conservative';
  }
  try {
    const handle = await fs.promises.open(statePath, 'r');
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size > MAX_BOOTSTRAP_STATE_BYTES ||
        opened.size !== validated.size ||
        (validated.ino !== 0 && opened.ino !== 0 && opened.ino !== validated.ino) ||
        (validated.dev !== 0 && opened.dev !== 0 && opened.dev !== validated.dev)
      ) {
        return 'conservative';
      }
      const parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'conservative';
      const raw = parsed as Record<string, unknown>;
      const persistedCommandId =
        typeof raw.launchCommandId === 'string'
          ? raw.launchCommandId.trim()
          : typeof raw.runId === 'string'
            ? raw.runId.trim()
            : '';
      if (!persistedCommandId) return 'conservative';
      return persistedCommandId === launchCommandId ? 'veto' : 'ignore';
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return 'conservative';
  }
}

/** Conservative expiry proof for the dispatch-before-spawn crash window. */
export async function proveNoRosterLaunchInvocationResources(
  teamName: string,
  launchCommandId: string
): Promise<boolean> {
  const snapshot = await new TeamLaunchStateStore().read(teamName).catch(() => undefined);
  if (snapshot === undefined) return false;
  if (
    snapshot &&
    Object.values(snapshot.members).some(
      (member) =>
        member.runtimeRunId === launchCommandId ||
        (member.runtimeAlive && member.runtimeRunId === launchCommandId)
    )
  ) {
    return false;
  }
  const bootstrapState = await inspectBootstrapStateForInvocationAbsence(teamName, launchCommandId);
  if (bootstrapState !== 'ignore') return false;
  const runtimeRoot = path.join(getTeamsBasePath(), teamName, '.opencode-runtime');
  const pending = [runtimeRoot];
  let inspected = 0;
  while (pending.length > 0 && inspected < 256) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > 256) return false;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        const content = await fs.promises.readFile(entryPath, 'utf8').catch(() => null);
        if (content === null || content.includes(launchCommandId)) return false;
      }
    }
  }
  if (process.platform !== 'linux') return false;
  let processIds: string[];
  try {
    processIds = (await fs.promises.readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return false;
  }
  const teamNeedle = `${path.sep}${teamName}${path.sep}`;
  for (const pid of processIds) {
    try {
      const command = (await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(
        /\0/g,
        ' '
      );
      if (command.includes(launchCommandId) || command.includes(teamNeedle)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}
