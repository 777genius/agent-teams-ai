import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { memberBinding } from './DeliveryRecovery.js';
import type { RuntimeMemberBinding, TeamGrant } from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { TeamPolicyPort, TeamStore } from './ports.js';

const { agentBlocks, protocols } = createRequire(import.meta.url)('agent-teams-controller') as {
  agentBlocks: { wrapAgentBlock(text: string): string };
  protocols: {
    buildActionModeProtocol(): string;
    buildActionModeProtocolText(description: string): string;
    MEMBER_DELEGATE_DESCRIPTION: string;
  };
};
const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/u.test(value);
const bindingValid = (value: RuntimeMemberBinding): boolean =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  ['backendId', 'teamId', 'runId', 'memberId', 'generation'].every((key) => {
    const field = (value as unknown as Record<string, unknown>)[key];
    return identity(field) && field.length <= 256;
  });
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export interface ContextEpoch {
  epochId: string;
  sessionRef: string;
  sourceRef: string;
  inputId?: string;
  operationRef?: string;
}
/** A private composition proof of an already durable Runtime preparation, not a new command. */
export interface ContextPreparationProof {
  schemaVersion: 1;
  epochIds: string[];
  teamProof: string;
  bindingFingerprint: string;
  intentFingerprint: string;
  inputId: string;
  operationRef: string;
  prefixHash: string;
  nativePayloadHash: string;
}
interface Candidate {
  binding: RuntimeMemberBinding;
  teamProof: string;
  inputId: string;
  operationRef: string;
  intentFingerprint: string;
  prefixHash: string;
  authorityRevision: number;
}
export interface TeamContextEpoch extends ContextEpoch {
  binding: RuntimeMemberBinding;
  candidate?: Candidate;
  represented?: ContextPreparationProof;
}
export interface TeamContextRequest {
  binding: RuntimeMemberBinding;
  sessionRef: string;
  inputId: string;
  operationRef: string;
  intentFingerprint: string;
  epochs: readonly ContextEpoch[];
  priorProofs: readonly ContextPreparationProof[];
  workspace: string;
  maxPrefixBytes: number;
}

/** Team owns current standing rules. Existing outbox identity and ordinary prompt bytes stay immutable. */
export class TeamContextReminders {
  constructor(
    private readonly options: {
      store: TeamStore;
      state(): OwnerState;
      policy: TeamPolicyPort;
      authorize(principalId: string): TeamGrant;
    }
  ) {}

  /** Captured valid D boundary, written under Runtime→Team fence before Runtime projection IO. */
  observe(principalId: string, binding: RuntimeMemberBinding, epoch: ContextEpoch): void {
    this.options.store.fenced(() => {
      this.options.authorize(principalId);
      const state = this.options.state();
      this.member(state, binding);
      const rows = structuredClone(state.contextEpochs ?? []);
      this.validate(rows);
      const expected = { ...structuredClone(epoch), binding: structuredClone(binding) };
      this.validate([expected]);
      const previous = this.findEpoch(rows, epoch.epochId);
      if (previous) {
        if (
          digest({ ...previous, candidate: undefined, represented: undefined }) !== digest(expected)
        )
          throw new TeamOwnerError('hold');
        return;
      }
      this.retireRepresented(rows);
      if (!hash(epoch.epochId) || rows.length >= 128) throw new TeamOwnerError('hold');
      rows.push(expected);
      this.write(state, rows);
    });
  }

  prepare(
    principalId: string,
    request: TeamContextRequest
  ): { prefix: string; epochIds: string[]; teamProof: string } | undefined {
    return this.options.store.fenced(() => {
      const grant = this.options.authorize(principalId),
        state = this.options.state();
      if (
        !identity(request.sessionRef) ||
        !identity(request.inputId) ||
        !identity(request.operationRef) ||
        !hash(request.intentFingerprint)
      )
        throw new TeamOwnerError('hold');
      const member = this.member(state, request.binding);
      const rows = structuredClone(state.contextEpochs ?? []);
      this.validate(rows);
      let changed = this.recoverArchivedPreparations(rows, request.binding);
      for (const proof of request.priorProofs)
        changed = this.represent(rows, request.binding, proof, { recoverArchived: true }) || changed;
      for (const epoch of request.epochs) {
        if (
          !hash(epoch.epochId) ||
          epoch.sessionRef !== request.sessionRef ||
          !epoch.sourceRef ||
          epoch.sourceRef.length > 1024
        )
          throw new TeamOwnerError('hold');
        const existing = this.findEpoch(rows, epoch.epochId);
        if (existing) {
          if (
            digest({ ...existing, candidate: undefined, represented: undefined }) !==
            digest({ ...epoch, binding: request.binding })
          )
            throw new TeamOwnerError('hold');
        } else {
          this.retireRepresented(rows);
          if (rows.length >= 128) throw new TeamOwnerError('hold');
          rows.push({ ...structuredClone(epoch), binding: structuredClone(request.binding) });
          changed = true;
        }
      }
      const pending = rows.filter(
        (row) =>
          !row.represented &&
          row.binding.backendId === request.binding.backendId &&
          row.binding.teamId === request.binding.teamId &&
          row.binding.memberId === request.binding.memberId
      );
      if (!pending.length) {
        if (changed) this.write(state, rows);
        return undefined;
      }
      const tasks = this.options.policy
        .taskBoard()
        .listTasks()
        .filter(
          (task) => !task.id.startsWith('_internal') && !task.deletedAt && task.status !== 'deleted'
        );
      if (state.members.length > 256) throw new TeamOwnerError('hold');
      const roster = state.members.map((row) => ({
        name: row.name,
        role: row.role,
        ...(row.settings?.role ? { description: row.settings.role } : {}),
      }));
      const board = tasks.length <= 256 ? tasks
        .map((task) => ({
          id: task.id,
          status: task.status,
          owner: task.owner ?? null,
          subject: task.subject ?? '',
          blockedBy: task.blockedBy ?? [],
        }))
        .sort((a, b) => a.id.localeCompare(b.id)) : undefined;
      const epochIds = pending.map((row) => row.epochId);
      const boardRead =
        `The retained board does not fit this reminder. Before choosing task work, read ${member.role === 'lead' ? 'lead_briefing' : 'task_briefing'} using the exposed tool schema; use task_get for a task's full details. An omitted snapshot does not mean there are no tasks.`;
      const rosterRead =
        'The current roster does not fit this reminder. Read the members in the first team_get response before choosing another teammate. Use only names in that current roster.';
      const buildPrefix = (rosterText: string, boardText: string) =>
        agentBlocks.wrapAgentBlock(
          [
            'Internal standing context restored after provider context compaction. Apply it before processing the original input below; this is not a separate work request.',
            `Context reset epochs: ${epochIds.join(', ')}`,
            `You are ${JSON.stringify(member.name)}, ${member.role} of team ${JSON.stringify(state.binding.teamName)}. Your captured workspace is ${JSON.stringify(request.workspace)}.`,
            'Use the exposed team MCP tools for shared tasks and messages. Supply stable commandId values for mutations. Native conversation completion never completes a shared task.',
            'Use the current durable roster below. Do not invent, relaunch, terminate, or change persistent teammates from ordinary work. The human recipient "user" is not a teammate.',
            member.role === 'lead' && state.members.some((row) => row.role === 'member')
              ? 'Coordinate assigned teammate work through the task board. Follow the human-selected action mode; delegation defaults never override ASK or an explicit request to do the work yourself.'
              : 'Work only within your assigned role and the current turn action mode; keep substantial work on the shared task board.',
            member.role === 'lead'
              ? protocols.buildActionModeProtocol()
              : protocols.buildActionModeProtocolText(protocols.MEMBER_DELEGATE_DESCRIPTION),
            member.settings?.role ? `Current role instructions:\n${member.settings.role}` : '',
            member.settings?.workflow ? `Current workflow:\n${member.settings.workflow}` : '',
            state.savedSettings?.prompt
              ? `Standing user instructions:\n${state.savedSettings.prompt}`
              : '',
            `Current roster:\n${rosterText}`,
            `Current task board:\n${boardText}`,
            'This block is internal context. Preserve ordinary user-facing message visibility and follow the original input below; do not send a separate reminder acknowledgement.',
          ]
            .filter(Boolean)
            .join('\n\n')
        ) + '\n\n';
      // Board/roster snapshots are advisory views with existing read tools. Keep
      // all standing instructions intact, and make every omitted view explicit.
      // Ordinary reminders keep their exact original bytes and proof identity.
      let prefix = buildPrefix(JSON.stringify(roster), board ? JSON.stringify(board) : boardRead);
      const budget = Math.min(request.maxPrefixBytes, 64 * 1024);
      if (Buffer.byteLength(prefix) > budget) prefix = buildPrefix(JSON.stringify(roster), boardRead);
      if (Buffer.byteLength(prefix) > budget) prefix = buildPrefix(rosterRead, boardRead);
      if (
        !Number.isSafeInteger(request.maxPrefixBytes) ||
        request.maxPrefixBytes < 0 ||
        Buffer.byteLength(prefix) > budget
      )
        throw new TeamOwnerError('hold');
      const teamProof = digest({
        binding: request.binding,
        epochIds,
        inputId: request.inputId,
        operationRef: request.operationRef,
        intentFingerprint: request.intentFingerprint,
        authorityRevision: grant.revision ?? 1,
        prefix,
      });
      for (const row of pending)
        row.candidate = {
          binding: structuredClone(request.binding),
          teamProof,
          inputId: request.inputId,
          operationRef: request.operationRef,
          intentFingerprint: request.intentFingerprint,
          prefixHash: textHash(prefix),
          authorityRevision: grant.revision ?? 1,
        };
      this.write(state, rows); // Pending only: this does not claim Runtime preparation or native handoff.
      return { prefix, epochIds, teamProof };
    });
  }

  prepared(
    principalId: string,
    binding: RuntimeMemberBinding,
    proof: ContextPreparationProof
  ): void {
    this.options.store.fenced(() => {
      this.options.authorize(principalId);
      const state = this.options.state();
      this.member(state, binding);
      const rows = structuredClone(state.contextEpochs ?? []);
      this.validate(rows);
      if (this.represent(rows, binding, proof, { recoverArchived: true })) this.write(state, rows);
    });
  }

  private recoverArchivedPreparations(rows: TeamContextEpoch[], binding: RuntimeMemberBinding): boolean {
    const sameMember = (value: RuntimeMemberBinding) =>
      value.backendId === binding.backendId && value.teamId === binding.teamId &&
      value.memberId === binding.memberId;
    let changed = false;
    for (const row of rows) {
      if (row.represented || !sameMember(row.binding)) continue;
      const archived = this.archivedEpoch(row.epochId);
      if (!archived) continue;
      const proof = archived.represented!;
      if (!sameMember(archived.candidate!.binding)) throw new TeamOwnerError('hold');
      // The archive durably records the original Runtime acknowledgement, not
      // native consumption. Recover its entire unchanged batch before replacing
      // any candidate, including when the current member has a new generation.
      for (const id of proof.epochIds) {
        const linked = this.findEpoch(rows, id, proof);
        if (!linked?.candidate || !sameMember(linked.binding) || !sameMember(linked.candidate.binding))
          throw new TeamOwnerError('hold');
      }
      changed = this.represent(rows, archived.candidate!.binding, proof, { recoverArchived: true }) || changed;
    }
    return changed;
  }

  private represent(
    rows: TeamContextEpoch[],
    binding: RuntimeMemberBinding,
    proof: ContextPreparationProof,
    options: { checkArchives?: boolean; selectedEpochId?: string; recoverArchived?: boolean } = {}
  ): boolean {
    const { checkArchives = true, selectedEpochId } = options;
    if (
      proof.bindingFingerprint !== textHash(JSON.stringify(memberBinding(binding))) ||
      proof.schemaVersion !== 1 ||
      !Array.isArray(proof.epochIds) ||
      !proof.epochIds.length ||
      proof.epochIds.length > 128 ||
      proof.epochIds.some((id) => !hash(id)) ||
      new Set(proof.epochIds).size !== proof.epochIds.length ||
      (selectedEpochId !== undefined && !proof.epochIds.includes(selectedEpochId)) ||
      !hash(proof.teamProof) ||
      !hash(proof.prefixHash) ||
      !hash(proof.nativePayloadHash) ||
      !hash(proof.intentFingerprint) ||
      !hash(proof.bindingFingerprint)
    )
      throw new TeamOwnerError('hold');
    let changed = false;
    let candidateFingerprint: string | undefined;
    for (const id of selectedEpochId === undefined ? proof.epochIds : [selectedEpochId]) {
      const row = checkArchives
        ? this.findEpoch(rows, id, options.recoverArchived ? proof : undefined)
        : rows.find((value) => value.epochId === id);
      if (
        !row ||
        !row.candidate ||
        digest(row.candidate.binding) !== digest(binding) ||
        row.candidate.teamProof !== proof.teamProof ||
        row.candidate.inputId !== proof.inputId ||
        row.candidate.operationRef !== proof.operationRef ||
        row.candidate.intentFingerprint !== proof.intentFingerprint ||
        row.candidate.prefixHash !== proof.prefixHash
      )
        throw new TeamOwnerError('hold');
      const candidate = digest(row.candidate);
      if (candidateFingerprint !== undefined && candidateFingerprint !== candidate)
        throw new TeamOwnerError('hold');
      candidateFingerprint = candidate;
      if (row.represented && digest(row.represented) !== digest(proof))
        throw new TeamOwnerError('hold');
      if (!row.represented) {
        if (!options.recoverArchived) throw new TeamOwnerError('hold');
        row.represented = structuredClone(proof);
        changed = true;
      }
    }
    return changed;
  }
  private member(state: OwnerState, binding: RuntimeMemberBinding) {
    const member = state.members.find(
      (row) =>
        row.delivery && digest(memberBinding(row.delivery)) === digest(memberBinding(binding))
    );
    if (
      !member ||
      !state.grants.some(
        (grant) =>
          !grant.revoked && grant.memberName === member.name && grant.permissions.includes('read')
      )
    )
      throw new TeamOwnerError('forbidden');
    return member;
  }
  private archivedEpoch(id: string): TeamContextEpoch | undefined {
    if (!hash(id)) throw new TeamOwnerError('hold');
    const row = this.options.store.read<TeamContextEpoch>(`context-epochs/${id}.json`);
    if (row === undefined) return undefined;
    if (!row || row.epochId !== id || !row.represented) throw new TeamOwnerError('hold');
    // Validate the complete original candidate/proof before using an archive as
    // deduplication evidence. No archive can stand in for a pending reset.
    this.validate([row], false);
    return row;
  }
  private findEpoch(
    rows: TeamContextEpoch[],
    id: string,
    replay?: ContextPreparationProof
  ): TeamContextEpoch | undefined {
    const active = rows.find((row) => row.epochId === id);
    const archived = this.archivedEpoch(id);
    if (
      active && archived && digest(active) !== digest(archived) &&
      // A lost state publication may leave only the original candidate active.
      // Only its exact Runtime proof can complete that archived phase change.
      (!replay || active.represented || digest({ ...active, represented: replay }) !== digest(archived))
    )
      throw new TeamOwnerError('hold');
    return active ?? archived;
  }
  private retireRepresented(rows: TeamContextEpoch[], bytePressure = false): void {
    if (rows.length < 128 && !bytePressure) return;
    for (const row of rows) {
      if (!row.represented) continue;
      const original = this.archivedEpoch(row.epochId);
      if (original && digest(original) !== digest(row)) throw new TeamOwnerError('hold');
      if (!original) this.options.store.write(`context-epochs/${row.epochId}.json`, row);
    }
    // Exact immutable archives are durable first. A failed subsequent state
    // write leaves harmless identical copies, reconciled by findEpoch on retry.
    const pending = rows.filter((row) => !row.represented);
    rows.splice(0, rows.length, ...pending);
  }
  private validate(rows: TeamContextEpoch[], checkArchives = true): void {
    if (
      !Array.isArray(rows) ||
      rows.length > 128 ||
      rows.some((row) => !row || !hash(row.epochId) || !bindingValid(row.binding)) ||
      new Set(rows.map((row) => row.epochId)).size !== rows.length
    )
      throw new TeamOwnerError('hold');
    for (const row of rows) {
      if (
        (row.represented !== undefined && !row.candidate) ||
        !identity(row.sessionRef) ||
        !identity(row.sourceRef) ||
        row.epochId !==
          textHash(
            JSON.stringify({
              binding: memberBinding(row.binding),
              sessionRef: row.sessionRef,
              sourceRef: row.sourceRef,
            })
          ) ||
        row.sessionRef.length > 1024 ||
        row.sourceRef.length > 1024 ||
        Object.values(row.binding).some(
          (value) => typeof value !== 'string' || !value || value.length > 256
        ) ||
        (row.inputId === undefined) !== (row.operationRef === undefined) ||
        (row.inputId !== undefined && (!identity(row.inputId) || !identity(row.operationRef)))
      )
        throw new TeamOwnerError('hold');
      if (
        row.candidate &&
        (!bindingValid(row.candidate.binding) ||
          !hash(row.candidate.teamProof) ||
          !hash(row.candidate.prefixHash) ||
          !hash(row.candidate.intentFingerprint) ||
          !identity(row.candidate.inputId) ||
          !identity(row.candidate.operationRef) ||
          !Number.isSafeInteger(row.candidate.authorityRevision) ||
          row.candidate.authorityRevision < 1)
      )
        throw new TeamOwnerError('hold');
    }
    for (const row of rows)
      if (row.represented)
        this.represent(
          rows,
          row.candidate!.binding,
          row.represented,
          { checkArchives, ...(!checkArchives ? { selectedEpochId: row.epochId } : {}) }
        );
  }
  private write(state: OwnerState, rows: TeamContextEpoch[]): void {
    const stored = this.options.store.read<OwnerState>('state.json');
    if (!stored || digest(stored.binding) !== digest(state.binding))
      throw new TeamOwnerError('hold');
    const next: OwnerState = { ...stored, contextEpochs: rows };
    if (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024)
      this.retireRepresented(rows, true);
    if (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024) throw new TeamOwnerError('hold');
    this.options.store.write('state.json', next);
  }
}
