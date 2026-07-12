import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountAvailability,
  ObservationEvidenceConfidence,
  ObservationEvidenceKind,
  ObservationEvidenceSource,
} from "../../domain/enums";
import { recommendedActionForAvailability } from "../../domain/ObservationPolicy";
import type { AvailabilityDecision, ObservationEvidence } from "../../domain/model";
import type { AccountProbePort } from "../../application/ports";
import type {
  ProcessRunnerPort,
  ProcessRunnerResult,
} from "../../infrastructure/ProcessRunner";
import {
  errorText,
  isQuotaLimitedText,
  isReloginError,
} from "./codexUtils";
import type { CodexAccountSlot } from "./codexTypes";

export class CodexExecProbe implements AccountProbePort {
  constructor(
    private readonly dependencies: {
      readonly runner: ProcessRunnerPort;
      readonly codexBinaryPath?: string;
    },
  ) {}

  async probe(input: {
    readonly account: CodexAccountSlot;
    readonly now: Date;
    readonly timeoutMs?: number;
  }): Promise<AvailabilityDecision> {
    const cwd = await mkdtemp(join(tmpdir(), "agent-account-codex-probe-"));
    try {
      const result = await this.dependencies.runner.run({
        command:
          input.account.codexBinaryPath ??
          this.dependencies.codexBinaryPath ??
          "codex",
        args: [
          "exec",
          "--sandbox",
          "read-only",
          "--ignore-rules",
          "--ephemeral",
          "-C",
          cwd,
          "--skip-git-repo-check",
          "-",
        ],
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          CODEX_HOME: input.account.authHome,
          HOME: dirname(input.account.authHome),
          ...(input.account.authJsonPath
            ? { REVIEWROUTER_CODEX_AUTH_PATH: input.account.authJsonPath }
            : {}),
        },
        stdin: "Reply exactly OK. Do not run shell commands.",
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      return decisionFromProbeResult(result);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  evidence(input: { readonly observedAt: Date }): ObservationEvidence {
    return {
      source: ObservationEvidenceSource.CodexExecProbe,
      kind: ObservationEvidenceKind.Probe,
      confidence: ObservationEvidenceConfidence.High,
      observedAt: input.observedAt,
      message: "codex_exec_probe",
    };
  }
}

export function decisionFromProbeResult(
  result: ProcessRunnerResult,
): AvailabilityDecision {
  if (result.timedOut) {
    return decision(AccountAvailability.Unhealthy, "probe_timeout");
  }
  if (result.exitCode === 0) return decision(AccountAvailability.Available);
  const text = `${result.stdout}\n${result.stderr}`;
  if (isReloginError(text)) {
    return decision(AccountAvailability.ReloginRequired, "refresh_token_revoked");
  }
  if (isQuotaLimitedText(text)) {
    return decision(AccountAvailability.Limited, "quota_limited");
  }
  return decision(AccountAvailability.Unhealthy, errorText(text));
}

function decision(
  availability: AccountAvailability,
  reason?: string,
): AvailabilityDecision {
  return {
    availability,
    recommendedAction: recommendedActionForAvailability(availability),
    schedulerEligible: availability === AccountAvailability.Available,
    ...(reason ? { reason } : {}),
  };
}
