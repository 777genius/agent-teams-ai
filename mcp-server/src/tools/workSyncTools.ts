import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';
import { assertConfiguredTeam } from '../utils/teamConfig';

const controlContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
  controlUrl: z.string().optional(),
  waitTimeoutMs: z.number().int().min(1000).max(600000).optional(),
};

const reportStateSchema = z.enum(['still_working', 'blocked', 'caught_up']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildRequiredReportFollowUp(input: {
  status: unknown;
  teamName: string;
  memberName?: string;
  from?: string;
  controlUrl?: string;
}) {
  const status = asRecord(input.status);
  const agenda = asRecord(status?.agenda);
  const agendaFingerprint =
    typeof agenda?.fingerprint === 'string' && agenda.fingerprint.trim()
      ? agenda.fingerprint.trim()
      : null;
  const reportToken =
    typeof status?.reportToken === 'string' && status.reportToken.trim()
      ? status.reportToken.trim()
      : null;
  if (!status || !agendaFingerprint || !reportToken) {
    return input.status;
  }

  const inputMemberName = input.memberName?.trim();
  const fromMemberName = input.from?.trim();
  let memberName = '';
  if (typeof status.memberName === 'string') {
    memberName = status.memberName.trim();
  }
  if (fromMemberName) {
    memberName = fromMemberName;
  }
  if (inputMemberName) {
    memberName = inputMemberName;
  }
  const items = Array.isArray(agenda?.items) ? agenda.items : [];
  const taskIds = items
    .map((item) => asRecord(item)?.taskId)
    .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0);
  const state = items.length > 0 ? 'still_working' : 'caught_up';

  return {
    ...status,
    statusOnlyIncomplete: true,
    nextRequiredAction:
      'Do not stop after member_work_sync_status. Call member_work_sync_report in this same turn using nextRequiredToolCall.arguments.',
    nextRequiredToolCall: {
      tool: 'member_work_sync_report',
      arguments: {
        teamName: input.teamName,
        ...(memberName ? { memberName } : {}),
        ...(input.controlUrl ? { controlUrl: input.controlUrl } : {}),
        state,
        agendaFingerprint,
        reportToken,
        ...(taskIds.length ? { taskIds } : {}),
      },
    },
  };
}

export function registerWorkSyncTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'member_work_sync_status',
    description:
      'Read your current actionable-work agenda and agendaFingerprint before reporting whether you are still working, blocked, or caught up.',
    parameters: z.object({
      ...controlContextSchema,
      memberName: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
    }),
    execute: async ({ teamName, claudeDir, controlUrl, waitTimeoutMs, memberName, from }) => {
      assertConfiguredTeam(teamName, claudeDir);
      const status = await getController(teamName, claudeDir).workSync.memberWorkSyncStatus({
        ...(memberName ? { memberName } : {}),
        ...(from ? { from } : {}),
        ...(controlUrl ? { controlUrl } : {}),
        ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
      });
      return jsonTextContent(
        buildRequiredReportFollowUp({
          status,
          teamName,
          ...(memberName ? { memberName } : {}),
          ...(from ? { from } : {}),
          ...(controlUrl ? { controlUrl } : {}),
        })
      );
    },
  });

  server.addTool({
    name: 'member_work_sync_report',
    description:
      'Report your validated work-sync state for the current agendaFingerprint. This never completes tasks. Use still_working while actively continuing, blocked only when the board has blocker evidence, and caught_up only when the status agenda is empty.',
    parameters: z.object({
      ...controlContextSchema,
      memberName: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      state: reportStateSchema,
      agendaFingerprint: z.string().min(1),
      reportToken: z.string().min(1),
      taskIds: z.array(z.string().min(1)).optional(),
      note: z.string().optional(),
      leaseTtlMs: z.number().int().min(60000).max(3600000).optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      controlUrl,
      waitTimeoutMs,
      memberName,
      from,
      state,
      agendaFingerprint,
      reportToken,
      taskIds,
      note,
      leaseTtlMs,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return jsonTextContent(
        await getController(teamName, claudeDir).workSync.memberWorkSyncReport({
          ...(memberName ? { memberName } : {}),
          ...(from ? { from } : {}),
          state,
          agendaFingerprint,
          reportToken,
          ...(taskIds ? { taskIds } : {}),
          ...(note ? { note } : {}),
          ...(leaseTtlMs ? { leaseTtlMs } : {}),
          ...(controlUrl ? { controlUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
        })
      );
    },
  });
}
