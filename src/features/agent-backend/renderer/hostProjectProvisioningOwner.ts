import { parseHostTeamRunId } from '../contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../contracts/teamSelection';

import { captureHostProjectFamily } from './hostProjectBindings';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { TeamProvisioningProgress } from '@shared/types/team';

interface Owner {
  runId: string;
  teamName: string;
  executionTeamName: string;
  assertCurrent(): void;
}
const owners = new WeakMap<TeamProvisioningProgress, Owner>();

/** Display ownership only. The run ID always retains the actual execution handle and revision. */
export function projectHostProjectProgress(
  progress: TeamProvisioningProgress,
  snapshot: BackendConnectionSnapshot,
  assertCurrent: () => void
): TeamProvisioningProgress {
  const selection = parseHostTeamRunId(progress.runId),
    executionTeamName = hostTeamSelectionKey(selection.handleId);
  if (progress.teamName !== executionTeamName)
    throw new Error('Invalid physical Host progress owner');
  const family = captureHostProjectFamily(snapshot, executionTeamName);
  const teamName = hostTeamSelectionKey(family.logical.handle.handleId);
  assertCurrent();
  const result = { ...progress, teamName };
  owners.set(result, { runId: result.runId, teamName, executionTeamName, assertCurrent });
  return result;
}

/** Undefined means no proof; null means a captured proof was invalidated or its DTO changed. */
export function hostProjectProgressOwners(
  progress: TeamProvisioningProgress
): readonly string[] | null | undefined {
  const owner = owners.get(progress);
  if (!owner) return undefined;
  if (progress.runId !== owner.runId || progress.teamName !== owner.teamName) return null;
  try {
    owner.assertCurrent();
  } catch {
    return null;
  }
  return owner.teamName === owner.executionTeamName
    ? [owner.teamName]
    : [owner.teamName, owner.executionTeamName];
}

export function cloneHostProjectProgress(
  progress: TeamProvisioningProgress
): TeamProvisioningProgress {
  const owner = owners.get(progress),
    result = structuredClone(progress);
  if (owner) owners.set(result, owner);
  return result;
}
