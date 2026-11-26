import { z } from 'zod';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { replaceRosterPayloadSchema } from '../team/rosterSchema.js';
import { teamRegistryRecordSchema } from '../team-registry/contracts.js';
import type { TeamStore } from '../team/ports.js';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const projectDefinitionPlanSchema = z.object({
  schemaVersion: z.literal(1), commandId: id, principalId: id, logicalHandleId: id,
  logicalScopeDigest: hash, authorityRevision: z.number().int().positive(),
  payload: replaceRosterPayloadSchema,
  children: z.array(z.object({ record: teamRegistryRecordSchema, commandId: id,
    authorityRevision: z.number().int().positive(), payload: replaceRosterPayloadSchema }).strict()).max(256),
  issued: z.array(id).max(256), completed: z.array(id).max(256),
  fingerprint: hash, phase: z.enum(['prepared', 'completed', 'abandoned']),
}).strict();
export type ProjectDefinitionPlan = z.infer<typeof projectDefinitionPlanSchema>;
const path = (commandId: string) => `project-definition/${digest(commandId)}.json`;
const currentPath = 'project-definition/current.json';
export function projectDefinitionFingerprint(plan: Omit<ProjectDefinitionPlan, 'fingerprint'> | ProjectDefinitionPlan): string {
  const { phase: _phase, issued: _issued, completed: _completed, ...rest } = plan;
  const { fingerprint: _fingerprint, ...intent } = rest as typeof rest & { fingerprint?: string };
  return digest(intent);
}
function parse(raw: unknown): ProjectDefinitionPlan {
  const parsed = projectDefinitionPlanSchema.safeParse(raw);
  if (!parsed.success || parsed.data.fingerprint !== projectDefinitionFingerprint(parsed.data)) throw new TeamOwnerError('hold');
  const plan = parsed.data, ids = plan.children.map(child => child.commandId);
  if (new Set(ids).size !== ids.length || new Set(plan.issued).size !== plan.issued.length ||
      new Set(plan.completed).size !== plan.completed.length || plan.issued.some(id => !ids.includes(id)) ||
      plan.completed.some(id => !plan.issued.includes(id)) ||
      plan.phase === 'completed' && plan.completed.length !== plan.children.length) throw new TeamOwnerError('hold');
  return plan;
}
export function readProjectDefinitionPlan(store: Pick<TeamStore, 'read'>, commandId: string): ProjectDefinitionPlan | undefined {
  const raw = store.read(currentPath), current = raw === undefined ? undefined : parse(raw);
  if (current?.commandId === commandId) return current;
  const archive = store.read(path(commandId));
  if (archive === undefined) return undefined;
  const value = parse(archive);
  if (value.commandId !== commandId || value.phase === 'prepared') throw new TeamOwnerError('hold');
  return value;
}
export function activeProjectDefinitionPlan(store: Pick<TeamStore, 'read'>): ProjectDefinitionPlan | undefined {
  const raw = store.read(currentPath);
  if (raw === undefined) return undefined;
  const plan = parse(raw);
  return plan.phase === 'prepared' ? plan : undefined;
}
export function assertProjectDefinitionIdle(store: Pick<TeamStore, 'read'>): void {
  if (activeProjectDefinitionPlan(store)) throw new TeamOwnerError('hold');
}
/** One atomic current record includes the complete intent; an archive acknowledgement cannot expose another plan. */
export function writeProjectDefinitionPlan(store: TeamStore, input: ProjectDefinitionPlan): void {
  const plan = parse(input);
  store.fenced(() => {
    const raw = store.read(currentPath), prior = raw === undefined ? undefined : parse(raw);
    if (prior && prior.commandId !== plan.commandId) {
      if (prior.phase === 'prepared') throw new TeamOwnerError('hold');
      store.write(path(prior.commandId), prior);
    }
    if (prior?.commandId === plan.commandId && prior.fingerprint !== plan.fingerprint) throw new TeamOwnerError('conflict');
    store.write(currentPath, plan);
    if (plan.phase !== 'prepared') store.write(path(plan.commandId), plan);
  });
}
