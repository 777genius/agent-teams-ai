import { capturedWorkspaceIdentity as rootIdentity } from './capturedWorkspaceIdentity.js';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest, safeSegment } from '../team/identity.js';
import { teamCommandPath, validateCommandEntry } from '../team/commandEntries.js';
import { deliveryIdentity } from '../team/DeliveryRecovery.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import type { FileChangeSummary } from '@agent-teams/task-change-ledger/contracts';
import type { ReviewOriginScope } from '@agent-teams/task-change-ledger/review-transport';
import type { CapturedReviewEvidence as PrivateEvidence } from '@agent-teams/task-change-ledger';
import type { CommandReceipt, DeliveryIntent } from '../team/contracts.js';
import type { RuntimeSessionRecord } from '../runtime/contracts.js';
import { runtimeCaptureSourceSchema } from './runtimeCaptureSource.js';
import { validateRestoreJournal } from '../team-launch/validateRestoreJournal.js';
import { validateLaunchPreparation } from '../team-launch/launchPreparation.js';
import type { TeamLaunchRecord } from '../team-launch/contracts.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { HostedTeam } from './MemberEntry.js';

const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid captured review evidence');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\0\r\n]/u.test(value)) throw new Error('Invalid captured review identity');
  return value;
};
const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const stamp = (file: string) => {
  const info = lstatSync(file);
  if (info.isSymbolicLink() || realpathSync(file) !== file) throw new Error('Captured review source changed');
  return { info, value: digest({ dev: info.dev, ino: info.ino, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs }) };
};

export interface CapturedReviewWorkspaceSet {
  readonly roots: readonly { readonly path: string; readonly identity: string }[];
  readonly evidenceFingerprint: string;
  readonly actors: readonly { readonly actorId: string; readonly label: string }[];
  /** Rechecks original sources/config and filesystem identities, never finds a replacement. */
  assertCurrent(): void;
}

/** Derives request-local authority from already captured evidence. No registry, writes or native effects. */
export function resolveCapturedReviewWorkspaces(options: {
  team: HostedTeam;
  ownerStorageRoot: string;
  origin: ReviewOriginScope;
  actorId?: string;
  evidence: readonly PrivateEvidence[];
  files: readonly FileChangeSummary[];
  legacyProjectPath?: string;
  initialRuntimeMembers?: readonly RuntimeMemberProfile[];
  principalId: string;
}): CapturedReviewWorkspaceSet {
  const { evidence, origin, team } = options;
  if (!origin.taskId && !origin.memberName) throw new Error('Captured review origin is required');
  if (evidence.length > 2048) throw new Error('Captured review workspace evidence capped');
  const roots = new Map<string, string>();
  const actors = new Map<string, string>();
  const sources = new Map<string, { value: string; data: Record<string, unknown> }>();
  const ownerRoot = join(options.ownerStorageRoot, 'teams', safeSegment(team.definition.binding.teamName), '.host-owner');
  const read = (file: string, limit = 1024 * 1024): Record<string, unknown> => {
    const cached = sources.get(file);
    if (cached) return cached.data;
    if (!inside(options.ownerStorageRoot, file)) throw new Error('Foreign captured review source');
    let cursor = file;
    for (;;) {
      stamp(cursor);
      if (cursor === options.ownerStorageRoot) break;
      cursor = resolve(cursor, '..');
    }
    const before = stamp(file);
    if (!before.info.isFile() || before.info.size > limit) throw new Error('Captured review source unavailable');
    const data = row(JSON.parse(readFileSync(file, 'utf8')));
    if (stamp(file).value !== before.value) throw new Error('Captured review source changed');
    sources.set(file, { value: before.value, data });
    return data;
  };
  const add = (path: string, identity: string) => {
    if (roots.has(path) && roots.get(path) !== identity) throw new Error('Conflicting historical workspace identities');
    if (roots.size >= 64 && !roots.has(path)) throw new Error('Captured review workspace limit');
    if (rootIdentity(path) !== identity) throw new Error('Captured review workspace replaced');
    roots.set(path, identity);
  };
  const registrations = team.owner.runtimeCaptures(options.principalId);
  const registeredFingerprint = digest(registrations);
  const initialFingerprint = digest(options.initialRuntimeMembers ?? []);
  const corroborate = (binding: RuntimeSessionRecord['binding'], runtime: RuntimeSessionRecord, path: string) => {
    const registered = registrations.filter(value => value.launchId === binding.runId);
    if (registered.length > 1) throw new Error('Ambiguous captured launch');
    if (!registered.length) {
      // Initial profile sessions have no launch capture. An exact trusted native profile is
      // the only fallback; current saved cwd/member name never substitutes for it.
      const profiles = (options.initialRuntimeMembers ?? []).filter(profile =>
        profile.teamId === binding.teamId && profile.memberId === binding.memberId &&
        profile.sessionId === runtime.config?.sessionId && profile.generation === runtime.config.generation &&
        profile.configRevision === runtime.config.configRevision);
      if (profiles.length !== 1 || profiles[0]!.cwd !== path) throw new Error('Original workspace source unavailable');
      const known = team.definition.members.filter(member => member.memberId === binding.memberId);
      if (known.length !== 1) throw new Error('Original actor label unavailable');
      return known[0]!.name;
    }
    const registration = registered[0]!;
    const launch = read(join(ownerRoot, 'launches', `${runtimeDigest(binding.runId)}.json`)) as unknown as TeamLaunchRecord;
    if (launch.schemaVersion !== 1 || launch.definition?.launchId !== binding.runId ||
      runtimeDigest(launch.definition) !== launch.fingerprint) throw new Error('Captured launch changed');
    validateRestoreJournal(launch);
    validateLaunchPreparation(launch);
    const source = runtimeCaptureSourceSchema.parse(launch.definition.capture);
    if (source.commandId !== registration.commandId || source.configurationRevision !== registration.configurationRevision)
      throw new Error('Captured workspace source mismatch');
    const members = source.members.filter(member => member.memberId === binding.memberId);
    const selected = registration.members.filter(member => member.memberId === binding.memberId);
    const expected = [...launch.definition.members, ...(launch.restorations ?? []).map(value => value.member)];
    if (members.length !== 1 || selected.length !== 1 ||
      !(digest(normalizeBinding(selected[0]!.delivery)) === digest(binding) ||
        expected.some(member => member.memberId === binding.memberId &&
          (member.binding && digest(normalizeBinding(member.binding)) === digest(binding) ||
            member.restore && digest(normalizeBinding(member.restore.sourceBinding)) === digest(binding)))))
      throw new Error('Captured workspace member mismatch');
    const member = members[0]!;
    if ((member.role === 'lead' ? source.savedSettings.cwd : member.settings.cwd ?? source.savedSettings.cwd) !== path)
      throw new Error('Captured workspace configuration mismatch');
    return member.name;
  };
  const assertActor = (actorId: string, label: string) => {
    const roster = team.connection.readRoster();
    const rows = [...roster.members, ...roster.removedMembers];
    const named = rows.filter(member => member.name === label);
    if (!named.length || new Set(named.map(member => member.memberId)).size !== 1 ||
      named[0]!.memberId !== actorId || rows.some(member => member.memberId === actorId && member.name !== label))
      throw new Error('Captured review actor label changed or ambiguous');
  };
  const reviewedPaths = new Set(options.files.flatMap(file => [file.filePath, ...file.snippets.map(snippet => snippet.filePath)]));
  for (const event of evidence) {
    if (!reviewedPaths.has(event.filePath)) continue;
    const cause = row(event.causalBinding), workspace = row(cause.workspace);
    if (digest(cause) !== event.evidenceProof) throw new Error('Captured review binding proof mismatch');
    const binding = normalizeBinding(row(cause.binding) as unknown as RuntimeSessionRecord['binding']);
    if (binding.backendId !== team.definition.binding.backendId || binding.teamId !== team.definition.binding.teamId ||
      binding.memberId !== event.actorId || event.toolUseId !== cause.toolUseId || event.sessionId !== cause.sessionRef)
      throw new Error('Foreign captured review binding');
    if (origin.taskId ? cause.taskId !== origin.taskId || event.taskId !== origin.taskId : binding.memberId !== options.actorId)
      throw new Error('Captured review origin mismatch');
    const path = text(workspace.path), identity = text(workspace.identity);
    if (event.workspaceRoot !== path || !inside(path, event.filePath)) throw new Error('Captured review path mismatch');
    // Raw metadata is never enough on its own: the same original Runtime input and owner outbox must exist.
    const memberKey = runtimeDigest({ backendId: binding.backendId, teamId: binding.teamId, memberId: binding.memberId });
    const runtime = read(join(options.ownerStorageRoot, 'runtime-sessions', memberKey, `${runtimeDigest(binding)}.json`), 16 * 1024 * 1024) as unknown as RuntimeSessionRecord;
    if (runtime.schemaVersion !== 1 || digest(normalizeBinding(runtime.binding)) !== digest(binding) ||
      runtime.sessionRef !== cause.sessionRef || runtime.hostIncarnation !== cause.hostIncarnation ||
      runtime.config?.configRevision !== cause.configRevision ||
      runtime.openFingerprint !== runtimeDigest({ profileId: runtime.profileId, config: runtime.config }))
      throw new Error('Captured runtime configuration mismatch');
    const label = corroborate(binding, runtime, path);
    if (actors.has(binding.memberId) && actors.get(binding.memberId) !== label) throw new Error('Conflicting captured actor labels');
    assertActor(binding.memberId, label);
    actors.set(binding.memberId, label);
    const inputs = runtime.inputs.filter(input => input.intent.inputId === cause.inputId && input.operationRef === cause.operationRef);
    if (inputs.length !== 1) throw new Error('Captured runtime input mismatch');
    const input = inputs[0]!;
    if (input.fingerprint !== deliveryFingerprint(input.intent)) throw new Error('Captured runtime fingerprint mismatch');
    const outbox = read(join(ownerRoot, 'outbox', `${safeSegment(text(cause.deliveryId))}.json`)) as unknown as DeliveryIntent;
    if (outbox.phase === 'not_admitted' || digest(deliveryIdentity(outbox)) !== digest(deliveryIdentity(input.intent)) ||
      cause.inputId !== outbox.inputId || cause.messageId !== outbox.messageId || cause.deliveryId !== outbox.deliveryId)
      throw new Error('Captured owner outbox mismatch');
    const commandPath = teamCommandPath(outbox.commandId);
    const command = validateCommandEntry(read(join(ownerRoot, commandPath)) as unknown as CommandReceipt);
    if ('family' in command || command.phase !== 'completed' || command.commandId !== outbox.commandId ||
      command.effects.messageId !== outbox.messageId || command.binding.backendId !== binding.backendId || command.binding.teamId !== binding.teamId)
      throw new Error('Captured owner command mismatch');
    if (cause.taskId !== undefined) {
      if (cause.taskStartCommandId !== command.commandId ||
        !(command.command.operation === 'task.start' && command.command.payload.taskId === cause.taskId ||
          command.command.operation === 'task.create' && command.command.payload.startImmediately === true && command.effects.taskId === cause.taskId))
        throw new Error('Captured Task cause mismatch');
      const obligations = read(join(ownerRoot, commandPath.replace('commands/', 'task-obligations/')));
      if (!Array.isArray(obligations.deliveries) || obligations.fingerprint !== command.fingerprint ||
        obligations.deliveries.filter(value => digest(deliveryIdentity(value as DeliveryIntent)) === digest(deliveryIdentity(outbox))).length !== 1)
        throw new Error('Captured Task notification mismatch');
    } else if (command.command.operation !== 'message.send' || command.commandId !== cause.messageCommandId || command.effects.deliveryId !== outbox.deliveryId)
      throw new Error('Captured message cause mismatch');
    add(path, identity);
  }
  if (!evidence.length) {
    // Legacy rows without Host capture identity retain only the existing configured main-root authority.
    const path = options.legacyProjectPath;
    if (!path) throw new Error('Captured review workspace unavailable');
    add(path, rootIdentity(path));
  }
  if (!roots.size) throw new Error('Captured review workspace unavailable');
  const result = Object.freeze([...roots].map(([path, identity]) => Object.freeze({ path, identity })));
  return { roots: result, actors: Object.freeze([...actors].map(([actorId, label]) => Object.freeze({ actorId, label }))),
    evidenceFingerprint: digest(evidence), assertCurrent() {
    for (const [actorId, label] of actors) assertActor(actorId, label);
    if (digest(options.initialRuntimeMembers ?? []) !== initialFingerprint) throw new Error('Captured initial workspace source changed');
    if (digest(team.owner.runtimeCaptures(options.principalId)) !== registeredFingerprint) throw new Error('Captured workspace registrations changed');
    for (const root of result) if (rootIdentity(root.path) !== root.identity) throw new Error('Captured review workspace changed');
    for (const [file, source] of sources) if (stamp(file).value !== source.value) throw new Error('Captured review original source/config changed');
  } };
}
