import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';
import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import type {
  MemberWorkSyncRuntimeTicket,
  MemberWorkSyncRuntimeTicketAdmissionCode,
  MemberWorkSyncRuntimeTicketAdmissionPort,
} from '../../../core/application';

export type NativeWorkSyncAdmissionProviderId = 'codex' | 'anthropic';

export interface NativeWorkSyncAdmissionCapability {
  schemaVersion: 1;
  recoveryProtocolVersion: 2;
  teamName: string;
  teamIncarnation: string;
  memberName: string;
  providerId: NativeWorkSyncAdmissionProviderId;
  runtimeMode: 'app-server' | 'repl';
  runtimeInstanceId: string;
  generation: number;
  processorReady: boolean;
}

type NativeCommand =
  | {
      schemaVersion: 1;
      requestId: string;
      op: 'reserve';
      scope: {
        teamName: string;
        teamIncarnation: string;
        memberName: string;
        runtimeInstanceId: string;
      };
      intentId: string;
      admissionPayloadHash: string;
      expectedGeneration: number;
      reservationNonce: string;
      controlRevision: number;
      commandDeadline: string;
      issuedAt: string;
    }
  | {
      schemaVersion: 1;
      requestId: string;
      op: 'cancel';
      scope: {
        teamName: string;
        teamIncarnation: string;
        memberName: string;
        runtimeInstanceId: string;
      };
      intentId: string;
      reservationNonce: string;
      expectedGeneration: number;
      admissionPayloadHash?: string;
      issuedAt: string;
    }
  | {
      schemaVersion: 1;
      requestId: string;
      op: 'sync_control';
      scope: {
        teamName: string;
        teamIncarnation: string;
        memberName: string;
        runtimeInstanceId: string;
      };
      controlRevision: number;
      stopped: boolean;
      issuedAt: string;
    };

interface NativeAck {
  schemaVersion: 1;
  requestId: string;
  op: NativeCommand['op'];
  ok: boolean;
  code?: string;
  intentId?: string;
  reservationNonce?: string;
  runtimeInstanceId: string;
  generation: number;
  controlRevision: number;
  localAdmissionClosed: boolean;
}

function isNativeAckOp(value: unknown): value is NativeCommand['op'] {
  return value === 'reserve' || value === 'cancel' || value === 'sync_control';
}

function parseNativeAck(raw: string): NativeAck | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const ack = parsed as Record<string, unknown>;
  if (ack.schemaVersion !== 1 || !isNativeAckOp(ack.op) || typeof ack.requestId !== 'string') {
    return null;
  }
  if (typeof ack.ok !== 'boolean' || typeof ack.runtimeInstanceId !== 'string') {
    return null;
  }
  if (typeof ack.generation !== 'number' || typeof ack.controlRevision !== 'number') {
    return null;
  }
  if (typeof ack.localAdmissionClosed !== 'boolean') {
    return null;
  }
  return {
    schemaVersion: 1,
    requestId: ack.requestId,
    op: ack.op,
    ok: ack.ok,
    ...(typeof ack.code === 'string' ? { code: ack.code } : {}),
    ...(typeof ack.intentId === 'string' ? { intentId: ack.intentId } : {}),
    ...(typeof ack.reservationNonce === 'string' ? { reservationNonce: ack.reservationNonce } : {}),
    runtimeInstanceId: ack.runtimeInstanceId,
    generation: ack.generation,
    controlRevision: ack.controlRevision,
    localAdmissionClosed: ack.localAdmissionClosed,
  };
}

function ackMatchesCommand(ack: NativeAck, command: NativeCommand): boolean {
  if (ack.requestId !== command.requestId || ack.op !== command.op) {
    return false;
  }
  if (ack.runtimeInstanceId !== command.scope.runtimeInstanceId) {
    return false;
  }
  if (command.op === 'reserve') {
    if (ack.ok && ack.code === 'reserved') {
      return ack.intentId === command.intentId && ack.reservationNonce === command.reservationNonce;
    }
    return true;
  }
  if (command.op === 'cancel' && ack.ok) {
    return (
      !ack.intentId ||
      (ack.intentId === command.intentId &&
        (!ack.reservationNonce || ack.reservationNonce === command.reservationNonce))
    );
  }
  return true;
}

export function buildNativeWorkSyncAdmissionRoot(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): string {
  return join(
    input.teamsBasePath,
    input.teamName,
    'members',
    encodeTeamMemberStorageKey(input.memberName),
    '.member-work-sync',
    'runtime-admission'
  );
}

export async function readNativeWorkSyncCurrentRuntimeInstanceId(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<string | null> {
  const root = buildNativeWorkSyncAdmissionRoot(input);
  try {
    const live = JSON.parse(await readFile(join(root, 'control.json'), 'utf8')) as {
      runtimeInstanceId?: string;
    };
    if (typeof live.runtimeInstanceId === 'string' && live.runtimeInstanceId.trim()) {
      return live.runtimeInstanceId.trim();
    }
  } catch {
    // fall through to capability
  }
  try {
    const capability = JSON.parse(await readFile(join(root, 'capability.json'), 'utf8')) as {
      runtimeInstanceId?: string;
    };
    if (typeof capability.runtimeInstanceId === 'string' && capability.runtimeInstanceId.trim()) {
      return capability.runtimeInstanceId.trim();
    }
  } catch {
    return null;
  }
  return null;
}

async function publishNoReplace(
  path: string,
  body: string
): Promise<'created' | 'existing-same' | 'conflict'> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' });
    return 'created';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw error;
    }
    const existing = await readFile(path, 'utf8');
    return existing === body ? 'existing-same' : 'conflict';
  }
}

async function waitForAck(
  path: string,
  deadlineMs: number,
  signal?: AbortSignal
): Promise<NativeAck> {
  while (Date.now() < deadlineMs) {
    if (signal?.aborted) {
      throw Object.assign(new Error('aborted'), { code: 'unknown' });
    }
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = parseNativeAck(raw);
      if (parsed) {
        return parsed;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Object.assign(new Error('ack timeout'), { code: 'unknown' });
}

function mapRefusal(code: string | undefined): MemberWorkSyncRuntimeTicketAdmissionCode {
  if (
    code === 'busy' ||
    code === 'stopped' ||
    code === 'instance_mismatch' ||
    code === 'conflict' ||
    code === 'unknown'
  ) {
    return code;
  }
  return 'unknown';
}

export class NativeMailboxMemberWorkSyncRuntimeTicketAdmission implements MemberWorkSyncRuntimeTicketAdmissionPort {
  constructor(
    private readonly deps: {
      teamsBasePath: string;
      expectedProviderId: NativeWorkSyncAdmissionProviderId;
      now?: () => Date;
      ackTimeoutMs?: number;
    }
  ) {}

  async inspectCapability(input: {
    teamName: string;
    memberName: string;
  }): Promise<
    | { status: 'ready'; capability: NativeWorkSyncAdmissionCapability }
    | { status: 'missing' }
    | { status: 'unknown' }
  > {
    const path = join(
      buildNativeWorkSyncAdmissionRoot({
        teamsBasePath: this.deps.teamsBasePath,
        teamName: input.teamName,
        memberName: input.memberName,
      }),
      'capability.json'
    );
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? { status: 'missing' } : { status: 'unknown' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'unknown' };
    }
    const capability = parsed as NativeWorkSyncAdmissionCapability;
    if (
      capability?.schemaVersion !== 1 ||
      capability.recoveryProtocolVersion !== 2 ||
      typeof capability.providerId !== 'string' ||
      typeof capability.runtimeInstanceId !== 'string'
    ) {
      return { status: 'unknown' };
    }
    if (
      capability.providerId !== this.deps.expectedProviderId ||
      capability.processorReady !== true
    ) {
      return { status: 'missing' };
    }
    return { status: 'ready', capability };
  }

  async readCapability(input: {
    teamName: string;
    memberName: string;
  }): Promise<NativeWorkSyncAdmissionCapability | null> {
    const inspected = await this.inspectCapability(input);
    return inspected.status === 'ready' ? inspected.capability : null;
  }

  async admit(input: {
    teamName: string;
    memberName: string;
    teamIncarnation: string;
    intentId: string;
    admissionPayloadHash: string;
    expectedGeneration: number;
    runtimeInstanceId?: string;
    controlRevision: number;
  }) {
    const inspected = await this.inspectCapability(input);
    if (inspected.status === 'unknown') {
      return { admitted: false as const, code: 'unknown' as const };
    }
    if (inspected.status === 'missing') {
      return { admitted: false as const, code: 'not_early' as const };
    }
    const capability = inspected.capability;
    const runtimeInstanceId = input.runtimeInstanceId ?? capability.runtimeInstanceId;
    if (runtimeInstanceId !== capability.runtimeInstanceId) {
      return { admitted: false as const, code: 'instance_mismatch' as const };
    }
    const requestId = randomUUID();
    const reservationNonce = randomUUID();
    const now = (this.deps.now ?? (() => new Date()))();
    const timeoutMs = this.deps.ackTimeoutMs ?? 5_000;
    const command: NativeCommand = {
      schemaVersion: 1,
      requestId,
      op: 'reserve',
      scope: {
        teamName: input.teamName,
        teamIncarnation: input.teamIncarnation,
        memberName: input.memberName,
        runtimeInstanceId,
      },
      intentId: input.intentId,
      admissionPayloadHash: input.admissionPayloadHash,
      expectedGeneration: input.expectedGeneration,
      reservationNonce,
      controlRevision: input.controlRevision,
      commandDeadline: new Date(now.getTime() + timeoutMs).toISOString(),
      issuedAt: now.toISOString(),
    };
    try {
      const ack = await this.exchange(input, runtimeInstanceId, command, timeoutMs);
      if (!ack.ok || ack.code !== 'reserved' || !ack.reservationNonce) {
        return { admitted: false as const, code: mapRefusal(ack.code) };
      }
      const ticket: MemberWorkSyncRuntimeTicket = {
        teamName: input.teamName,
        teamIncarnation: input.teamIncarnation,
        memberName: input.memberName,
        runtimeInstanceId: ack.runtimeInstanceId,
        expectedGeneration: ack.generation,
        ticketId: ack.reservationNonce,
        intentId: ack.intentId ?? input.intentId,
        controlRevision: ack.controlRevision,
        admissionPayloadHash: input.admissionPayloadHash,
      };
      return { admitted: true as const, ticket };
    } catch {
      await this.cancel({
        teamName: input.teamName,
        teamIncarnation: input.teamIncarnation,
        memberName: input.memberName,
        runtimeInstanceId,
        expectedGeneration: input.expectedGeneration,
        ticketId: reservationNonce,
        intentId: input.intentId,
        controlRevision: input.controlRevision,
        admissionPayloadHash: input.admissionPayloadHash,
      }).catch(() => undefined);
      return { admitted: false as const, code: 'unknown' as const };
    }
  }

  async cancel(ticket: MemberWorkSyncRuntimeTicket): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))();
    await this.exchange(
      ticket,
      ticket.runtimeInstanceId,
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        op: 'cancel',
        scope: {
          teamName: ticket.teamName,
          teamIncarnation: ticket.teamIncarnation,
          memberName: ticket.memberName,
          runtimeInstanceId: ticket.runtimeInstanceId,
        },
        intentId: ticket.intentId,
        reservationNonce: ticket.ticketId,
        expectedGeneration: ticket.expectedGeneration,
        admissionPayloadHash: ticket.admissionPayloadHash,
        issuedAt: now.toISOString(),
      },
      this.deps.ackTimeoutMs ?? 5_000
    ).catch(() => undefined);
  }

  async syncControl(input: {
    teamName: string;
    memberName: string;
    teamIncarnation?: string;
    runtimeInstanceId: string;
    controlRevision: number;
    stopped: boolean;
  }): Promise<
    | { ok: true; code: 'closed' | 'open'; controlRevision: number }
    | { ok: false; code: 'unknown' | 'superseded' | 'conflict' | 'instance_mismatch' }
  > {
    const capability = await this.readCapability(input);
    if (!capability) {
      return { ok: false as const, code: 'unknown' as const };
    }
    const now = (this.deps.now ?? (() => new Date()))();
    try {
      const ack = await this.exchange(
        input,
        input.runtimeInstanceId || capability.runtimeInstanceId,
        {
          schemaVersion: 1,
          requestId: randomUUID(),
          op: 'sync_control',
          scope: {
            teamName: input.teamName,
            teamIncarnation: input.teamIncarnation || capability.teamIncarnation,
            memberName: input.memberName,
            runtimeInstanceId: input.runtimeInstanceId || capability.runtimeInstanceId,
          },
          controlRevision: input.controlRevision,
          stopped: input.stopped,
          issuedAt: now.toISOString(),
        },
        this.deps.ackTimeoutMs ?? 5_000
      );
      if (!ack.ok) {
        if (
          ack.code === 'superseded' ||
          ack.code === 'conflict' ||
          ack.code === 'instance_mismatch'
        ) {
          return {
            ok: false as const,
            code: ack.code,
          };
        }
        return { ok: false as const, code: 'unknown' as const };
      }
      return {
        ok: true as const,
        code: ack.localAdmissionClosed ? ('closed' as const) : ('open' as const),
        controlRevision: ack.controlRevision,
      };
    } catch {
      return { ok: false as const, code: 'unknown' as const };
    }
  }

  async readLiveControl(input: { teamName: string; memberName: string }) {
    const path = join(
      buildNativeWorkSyncAdmissionRoot({
        teamsBasePath: this.deps.teamsBasePath,
        teamName: input.teamName,
        memberName: input.memberName,
      }),
      'control.json'
    );
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        runtimeInstanceId?: string;
        controlRevision?: number;
        stopped?: boolean;
        handshakeCompleted?: boolean;
      };
      if (
        typeof parsed.runtimeInstanceId !== 'string' ||
        typeof parsed.controlRevision !== 'number' ||
        parsed.handshakeCompleted !== true
      ) {
        return null;
      }
      return {
        runtimeInstanceId: parsed.runtimeInstanceId,
        controlRevision: parsed.controlRevision,
        stopped: parsed.stopped === true,
        handshakeCompleted: true,
      };
    } catch {
      return null;
    }
  }

  async confirmReserved(
    ticket: MemberWorkSyncRuntimeTicket
  ): Promise<{ ok: true } | { ok: false; code: 'stale' | 'unknown' }> {
    const root = buildNativeWorkSyncAdmissionRoot({
      teamsBasePath: this.deps.teamsBasePath,
      teamName: ticket.teamName,
      memberName: ticket.memberName,
    });
    try {
      const parsed = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8')) as {
        runtimeInstanceId?: string;
        status?: string;
        continuation?: {
          runtimeInstanceId?: string;
          reservationNonce?: string;
          intentId?: string;
          expectedGeneration?: number;
        } | null;
      };
      const continuation = parsed.continuation;
      if (
        parsed.runtimeInstanceId !== ticket.runtimeInstanceId ||
        parsed.status !== 'dispatching' ||
        !continuation ||
        continuation.reservationNonce !== ticket.ticketId ||
        continuation.intentId !== ticket.intentId ||
        continuation.runtimeInstanceId !== ticket.runtimeInstanceId ||
        (continuation.expectedGeneration != null &&
          continuation.expectedGeneration !== ticket.expectedGeneration)
      ) {
        return { ok: false, code: 'stale' };
      }
      return { ok: true };
    } catch {
      return { ok: false, code: 'unknown' };
    }
  }

  private async exchange(
    identity: { teamName: string; memberName: string },
    runtimeInstanceId: string,
    command: NativeCommand,
    timeoutMs: number
  ): Promise<NativeAck> {
    const root = buildNativeWorkSyncAdmissionRoot({
      teamsBasePath: this.deps.teamsBasePath,
      teamName: identity.teamName,
      memberName: identity.memberName,
    });
    const commandPath = join(root, runtimeInstanceId, 'commands', `${command.requestId}.json`);
    const ackPath = join(root, runtimeInstanceId, 'acks', `${command.requestId}.json`);
    const published = await publishNoReplace(commandPath, `${JSON.stringify(command)}\n`);
    if (published === 'conflict') {
      throw Object.assign(new Error('command conflict'), { code: 'conflict' });
    }
    const ack = await waitForAck(ackPath, Date.now() + timeoutMs);
    if (!ackMatchesCommand(ack, command)) {
      throw Object.assign(new Error('ack identity mismatch'), { code: 'unknown' });
    }
    return ack;
  }
}
