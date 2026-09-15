import { NativeMailboxMemberWorkSyncRuntimeTicketAdmission } from '../adapters/output/NativeMailboxMemberWorkSyncRuntimeTicketAdmission';

import { createUnsupportedMemberWorkSyncRuntimeTicketAdmission } from './createUnsupportedMemberWorkSyncRuntimeTicketAdmission';

import type {
  MemberWorkSyncRuntimeTicket,
  MemberWorkSyncRuntimeTicketAdmissionPort,
} from '../../core/application';

export function createMemberWorkSyncRuntimeTicketAdmissionRouter(input: {
  teamsBasePath: string;
  opencodeAdmission?: MemberWorkSyncRuntimeTicketAdmissionPort;
  ackTimeoutMs?: number;
  now?: () => Date;
}): MemberWorkSyncRuntimeTicketAdmissionPort {
  const unsupported = createUnsupportedMemberWorkSyncRuntimeTicketAdmission();
  const codex = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
    teamsBasePath: input.teamsBasePath,
    expectedProviderId: 'codex',
    ackTimeoutMs: input.ackTimeoutMs,
    now: input.now,
  });
  const anthropic = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
    teamsBasePath: input.teamsBasePath,
    expectedProviderId: 'anthropic',
    ackTimeoutMs: input.ackTimeoutMs,
    now: input.now,
  });

  const nativeFor = (providerId: string | undefined) => {
    if (providerId === 'codex') return codex;
    if (providerId === 'anthropic' || providerId === 'claude') return anthropic;
    return null;
  };

  return {
    async admit(request) {
      const preferred = nativeFor(request.providerId);
      const candidates = preferred
        ? [
            preferred,
            ...(request.providerId === 'opencode' && input.opencodeAdmission
              ? [input.opencodeAdmission]
              : []),
          ]
        : request.providerId === 'opencode' && input.opencodeAdmission
          ? [input.opencodeAdmission]
          : [codex, anthropic];
      for (const candidate of candidates) {
        const result = await candidate.admit(request);
        if (result.admitted || result.code !== 'not_early') {
          return result;
        }
      }
      if (input.opencodeAdmission && request.providerId !== 'opencode') {
        const result = await input.opencodeAdmission.admit(request);
        if (result.admitted || result.code !== 'not_early') {
          return result;
        }
      }
      return unsupported.admit(request);
    },
    async cancel(ticket: MemberWorkSyncRuntimeTicket) {
      await Promise.allSettled([
        codex.cancel(ticket),
        anthropic.cancel(ticket),
        input.opencodeAdmission?.cancel(ticket),
      ]);
    },
    async syncControl(request) {
      const capability =
        (await codex.readCapability(request)) ?? (await anthropic.readCapability(request));
      if (capability?.providerId === 'anthropic') {
        return anthropic.syncControl(request);
      }
      if (capability?.providerId === 'codex') {
        return codex.syncControl(request);
      }
      if (input.opencodeAdmission?.syncControl) {
        return input.opencodeAdmission.syncControl(request);
      }
      return { ok: false, code: 'unknown' as const };
    },
    async readLiveControl(request) {
      return (await codex.readLiveControl(request)) ?? (await anthropic.readLiveControl(request));
    },
    async confirmReserved(ticket) {
      const codexResult = await codex.confirmReserved(ticket);
      if (codexResult.ok) {
        return codexResult;
      }
      const anthropicResult = await anthropic.confirmReserved(ticket);
      if (anthropicResult.ok) {
        return anthropicResult;
      }
      if (input.opencodeAdmission?.confirmReserved) {
        return input.opencodeAdmission.confirmReserved(ticket);
      }
      return { ok: false as const, code: 'unknown' as const };
    },
  };
}
