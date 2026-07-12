import {
  AccountAvailability,
  AuthSessionStatus,
  ObservationEvidenceConfidence,
  ObservationEvidenceKind,
  ObservationEvidenceSource,
} from "../../domain/enums";
import { ObservationPolicy } from "../../domain/ObservationPolicy";
import type {
  AccountObservation,
  AuthSession,
  AvailabilityDecision,
  ObservationEvidence,
  QuotaSnapshot,
} from "../../domain/model";
import type {
  AccountProbePort,
  AuthSessionReaderPort,
  AgentAccountObserverPort,
} from "../../application/ports";
import { errorText } from "./codexUtils";
import type { CodexAccountSlot } from "./codexTypes";
import {
  codexMainQuotaSnapshot,
  type CodexAppServerQuotaReader,
} from "./CodexAppServerQuotaReader";

export class CodexAccountObserver implements AgentAccountObserverPort {
  private readonly policy = new ObservationPolicy();

  constructor(
    private readonly dependencies: {
      readonly appServerReader: CodexAppServerQuotaReader;
      readonly authReader?: AuthSessionReaderPort;
      readonly execProbe?: AccountProbePort;
    },
  ) {}

  async observe(input: {
    readonly account: CodexAccountSlot;
    readonly now: Date;
    readonly timeoutMs?: number;
  }): Promise<AccountObservation> {
    const evidence: ObservationEvidence[] = [];
    let auth: AuthSession | null = null;
    let quota: QuotaSnapshot | null = null;
    let appServerFailed = false;

    try {
      const appServer = await this.dependencies.appServerReader.readAuthAndQuota({
        account: input.account,
        now: input.now,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      auth = appServer.auth;
      quota = appServer.quota;
      evidence.push(...appServer.evidence);
    } catch (error) {
      appServerFailed = true;
      evidence.push({
        source: ObservationEvidenceSource.CodexAppServer,
        kind: ObservationEvidenceKind.Quota,
        confidence: ObservationEvidenceConfidence.High,
        observedAt: input.now,
        message: "codex_app_server_failed",
        details: { error: errorText(error).slice(0, 180) },
      });
    }

    if (!auth && this.dependencies.authReader) {
      auth = await this.dependencies.authReader.readAuthSession({
        account: input.account,
        now: input.now,
      });
      evidence.push({
        source: ObservationEvidenceSource.CodexAuthJson,
        kind: ObservationEvidenceKind.Auth,
        confidence: ObservationEvidenceConfidence.Medium,
        observedAt: input.now,
        message: "auth_json_read",
      });
    }

    auth ??= {
      status: AuthSessionStatus.Unknown,
      checkedAt: input.now,
      reason: appServerFailed ? "codex_app_server_failed" : "auth_not_observed",
    };

    let probeDecision: AvailabilityDecision | undefined;
    if (
      !quota &&
      auth.status !== AuthSessionStatus.ReloginRequired &&
      this.dependencies.execProbe
    ) {
      probeDecision = await this.dependencies.execProbe.probe({
        account: input.account,
        now: input.now,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      evidence.push({
        source: ObservationEvidenceSource.CodexExecProbe,
        kind: ObservationEvidenceKind.Probe,
        confidence: ObservationEvidenceConfidence.High,
        observedAt: input.now,
        message: "codex_exec_probe",
      });
    }

    const decision =
      appServerFailed && !quota && !probeDecision
        ? unknownDecision("quota_observation_failed")
        : this.policy.decide({
            auth,
            quota: codexMainQuotaSnapshot(quota),
            ...(probeDecision ? { probeDecision } : {}),
          });

    return {
      account: input.account,
      auth,
      quota,
      decision,
      evidence,
      checkedAt: input.now,
    };
  }
}

function unknownDecision(reason: string): AvailabilityDecision {
  return {
    availability: AccountAvailability.Unknown,
    recommendedAction: "inspect" as AvailabilityDecision["recommendedAction"],
    schedulerEligible: false,
    reason,
  };
}
