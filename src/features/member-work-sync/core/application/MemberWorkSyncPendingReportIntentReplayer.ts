import { MemberWorkSyncReporter } from './MemberWorkSyncReporter';

import type {
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportIntentStatus,
  MemberWorkSyncReportResult,
} from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export interface MemberWorkSyncPendingReportReplaySummary {
  processed: number;
  accepted: number;
  rejected: number;
  superseded: number;
}

function statusForResult(input: {
  accepted: boolean;
  code: string;
}): MemberWorkSyncReportIntentStatus {
  if (input.accepted) {
    return 'accepted';
  }
  if (
    input.code === 'member_inactive' ||
    input.code === 'team_runtime_inactive' ||
    input.code === 'member_runtime_inactive'
  ) {
    return 'superseded';
  }
  return 'rejected';
}

export class MemberWorkSyncPendingReportIntentReplayer {
  private readonly reporter: MemberWorkSyncReporter;

  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {
    this.reporter = new MemberWorkSyncReporter(deps);
  }

  async replayTeam(teamName: string): Promise<MemberWorkSyncPendingReportReplaySummary> {
    const store = this.deps.reportStore;
    if (!store?.listPendingReports || !store.markPendingReportProcessed) {
      return { processed: 0, accepted: 0, rejected: 0, superseded: 0 };
    }

    const intents = await store.listPendingReports(teamName);
    const summary: MemberWorkSyncPendingReportReplaySummary = {
      processed: 0,
      accepted: 0,
      rejected: 0,
      superseded: 0,
    };

    for (const intent of intents) {
      let status: MemberWorkSyncReportIntentStatus = 'rejected';
      let resultCode = 'replay_failed';
      try {
        const result = await this.executeReplay(intent);
        status = statusForResult(result);
        resultCode = result.code;
      } catch (error) {
        this.deps.logger?.warn('member work sync pending report replay failed', {
          teamName,
          intentId: intent.id,
          error: String(error),
        });
        continue;
      }
      summary.processed += 1;
      if (status === 'accepted') {
        summary.accepted += 1;
      } else if (status === 'superseded') {
        summary.superseded += 1;
      } else {
        summary.rejected += 1;
      }
      await store.markPendingReportProcessed(teamName, intent.id, {
        status,
        resultCode,
        processedAt: this.deps.clock.now().toISOString(),
      });
    }

    return summary;
  }

  private async executeReplay(
    intent: MemberWorkSyncReportIntent
  ): Promise<MemberWorkSyncReportResult> {
    const result = await this.reporter.execute({
      ...intent.request,
      source: intent.request.source ?? 'mcp',
    });
    const freshToken = await this.getFreshTokenForExpiredFallbackReport(intent, result);
    if (!freshToken) {
      return result;
    }
    return this.reporter.execute({
      ...intent.request,
      agendaFingerprint: freshToken.agendaFingerprint,
      reportToken: freshToken.reportToken,
      source: intent.request.source ?? 'mcp',
    });
  }

  private async getFreshTokenForExpiredFallbackReport(
    intent: MemberWorkSyncReportIntent,
    result: MemberWorkSyncReportResult
  ): Promise<{ agendaFingerprint: string; reportToken: string } | null> {
    if (
      result.accepted ||
      result.code !== 'invalid_report_token' ||
      intent.reason !== 'control_api_unavailable' ||
      !intent.request.reportToken ||
      !result.status.reportToken ||
      result.status.agenda.fingerprint !== intent.request.agendaFingerprint ||
      !this.deps.reportToken
    ) {
      return null;
    }

    const validation = await this.deps.reportToken.verify({
      token: intent.request.reportToken,
      teamName: result.status.teamName,
      memberName: result.status.memberName,
      agendaFingerprint: result.status.agenda.fingerprint,
      nowIso: this.deps.clock.now().toISOString(),
    });
    if (validation.ok || validation.reason !== 'expired') {
      return null;
    }

    return {
      agendaFingerprint: result.status.agenda.fingerprint,
      reportToken: result.status.reportToken,
    };
  }
}
