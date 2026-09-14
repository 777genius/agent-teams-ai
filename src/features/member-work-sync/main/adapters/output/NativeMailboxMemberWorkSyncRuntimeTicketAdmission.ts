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

type NativeAck = {
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
};

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
      return JSON.parse(raw) as NativeAck;
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

  async readCapability(input: {
    teamName: string;
    memberName: string;
  }): Promise<NativeWorkSyncAdmissionCapability | null> {
    const path = join(
      buildNativeWorkSyncAdmissionRoot({
        teamsBasePath: this.deps.teamsBasePath,
        teamName: input.teamName,
        memberName: input.memberName,
      }),
      'capability.json'
    );
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as NativeWorkSyncAdmissionCapability;
      if (
        parsed?.schemaVersion !== 1 ||
        parsed.recoveryProtocolVersion !== 2 ||
        parsed.providerId !== this.deps.expectedProviderId ||
        parsed.processorReady !== true
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
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
    const capability = await this.readCapability(input);
    if (!capability) {
      return { admitted: false as const, code: 'not_early' as const };
    }
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
            code: ack.code as 'superseded' | 'conflict' | 'instance_mismatch',
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
    return waitForAck(ackPath, Date.now() + timeoutMs);
  }
}
