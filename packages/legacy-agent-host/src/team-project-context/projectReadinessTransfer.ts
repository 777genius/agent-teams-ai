import { digest } from '../team/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { CreationModelReadinessTransfer, LocalModelReadinessTransfer } from '../composition/prepareTeamModelReadiness.js';
import type { TeamSavedSettings } from '../team/rosterContracts.js';

export type ProjectModelReadinessTransfer = LocalModelReadinessTransfer & {
  kind: 'project'; logicalBindingDigest: string; sourceRevision: string; probeRevision: string;
  logicalMembers: { memberId: string; name: string; role: 'lead' | 'member' }[];
};
const origins = new WeakMap<ProjectModelReadinessTransfer, { fingerprint: string; current(): void }>();
/** Pure DTO plus private in-process provenance; a wire object cannot impersonate this publication join. */
export function captureProjectReadinessTransfer(input: ProjectModelReadinessTransfer, current: () => void): ProjectModelReadinessTransfer {
  current();
  const captured = structuredClone(input);
  origins.set(captured, { fingerprint: digest(captured), current });
  return captured;
}
export function assertProjectReadinessTransfer(input: ProjectModelReadinessTransfer): void {
  const origin = origins.get(input);
  if (!origin || origin.fingerprint !== digest(input)) throw new TeamOwnerError('forbidden');
  origin.current();
}

const creations = new WeakMap<CreationModelReadinessTransfer, {
  fingerprint: string; savedSettings: TeamSavedSettings; current(): void;
}>();
export function captureCreatedProjectReadinessTransfer(input: CreationModelReadinessTransfer,
  savedSettings: TeamSavedSettings, current: () => void): CreationModelReadinessTransfer {
  current();
  const captured = structuredClone(input);
  creations.set(captured, { fingerprint: digest(captured), savedSettings: structuredClone(savedSettings), current });
  return captured;
}
export function readCreatedProjectReadinessTransfer(input: CreationModelReadinessTransfer): TeamSavedSettings | undefined {
  const origin = creations.get(input);
  if (!origin) return undefined;
  if (origin.fingerprint !== digest(input)) throw new TeamOwnerError('forbidden');
  origin.current();
  return structuredClone(origin.savedSettings);
}
