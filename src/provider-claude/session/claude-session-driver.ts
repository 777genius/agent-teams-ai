import type {
  ProviderFailure,
  ProviderSessionDriver,
  RedactorPort,
  RefreshedSession,
  RunnerPort,
  RuntimeWarning,
  SessionArtifact,
  SessionValidationResult,
  WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  claudeProviderId,
  claudeSessionCapabilities,
} from "../capabilities";
import {
  invalidClaudeSessionFailure,
  validateClaudeSessionArtifact,
} from "./session-artifact";
import { classifyClaudeFailure } from "../protocol/failure-classifier";

export class ClaudeSessionDriver implements ProviderSessionDriver {
  readonly providerId = claudeProviderId;
  readonly supportedArtifactKinds: readonly SessionArtifact["kind"][] = [
    "json-file",
    "env-token",
  ];
  readonly capabilities = claudeSessionCapabilities;

  async validateSession(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<SessionValidationResult> {
    try {
      const validation = validateClaudeSessionArtifact(input.session);
      registerClaudeSecrets(input.redactor, validation.session.oauthToken);
      return {
        status: "valid",
        warnings: validation.warnings,
      };
    } catch (error) {
      return {
        status: "invalid",
        failure: invalidClaudeSessionFailure(error),
      };
    }
  }

  async refreshSession(input: {
    readonly session: SessionArtifact;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<RefreshedSession> {
    const validation = await this.validateSession({
      session: input.session,
      redactor: input.redactor,
    });
    if (validation.status === "invalid") {
      return {
        artifact: input.session,
        providerState: validation.failure.reconnectRequired
          ? "needs-reconnect"
          : "permission-required",
        warnings: [],
      };
    }
    return {
      artifact: input.session,
      providerState: "unchanged",
      warnings: refreshUnsupportedWarning(validation.warnings),
    };
  }

  classifySessionFailure(error: unknown): ProviderFailure {
    return classifyClaudeFailure(error);
  }
}

export function registerClaudeSecrets(
  redactor: RedactorPort,
  oauthToken: string,
): void {
  redactor.registerSecret(oauthToken, "claude-oauth-token");
}

function refreshUnsupportedWarning(
  warnings: readonly RuntimeWarning[],
): readonly RuntimeWarning[] {
  return [
    ...warnings,
    {
      code: "claude_session_refresh_unavailable",
      safeMessage: "Claude session refresh is not implemented by this adapter.",
    },
  ];
}
