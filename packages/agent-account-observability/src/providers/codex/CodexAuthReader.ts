import { readFile } from "node:fs/promises";
import {
  AgentProvider,
  AuthSessionStatus,
  ObservationEvidenceConfidence,
  ObservationEvidenceKind,
  ObservationEvidenceSource,
} from "../../domain/enums";
import type {
  AuthSession,
  ObservationEvidence,
  ProviderAccountIdentity,
} from "../../domain/model";
import type { AuthSessionReaderPort } from "../../application/ports";
import {
  decodeJwtPayload,
  hashAccountKey,
  maskEmail,
  readRecord,
  stringValue,
} from "./codexUtils";
import type { CodexAccountSlot } from "./codexTypes";

export class CodexAuthJsonReader implements AuthSessionReaderPort {
  async readAuthSession(input: {
    readonly account: CodexAccountSlot;
    readonly now: Date;
  }): Promise<AuthSession> {
    const path = input.account.authJsonPath ?? `${input.account.authHome}/auth.json`;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return {
        status: AuthSessionStatus.Unavailable,
        checkedAt: input.now,
        reason: "auth_json_missing",
      };
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      const identity = identityFromAuthJson(parsed, input.account);
      return {
        status: AuthSessionStatus.Authenticated,
        checkedAt: input.now,
        identity,
      };
    } catch {
      return {
        status: AuthSessionStatus.Unknown,
        checkedAt: input.now,
        reason: "auth_json_invalid",
      };
    }
  }

  evidence(input: { readonly observedAt: Date }): ObservationEvidence {
    return {
      source: ObservationEvidenceSource.CodexAuthJson,
      kind: ObservationEvidenceKind.Auth,
      confidence: ObservationEvidenceConfidence.Medium,
      observedAt: input.observedAt,
      message: "auth_json_read",
    };
  }
}

export function identityFromAuthJson(
  authJson: unknown,
  account: CodexAccountSlot,
): ProviderAccountIdentity {
  const root = readRecord(authJson);
  const tokens = readRecord(root?.tokens);
  const claims = decodeJwtPayload(stringValue(tokens?.id_token));
  const authClaims = readRecord(claims?.["https://api.openai.com/auth"]);
  const providerAccountId = firstString([
    tokens?.account_id,
    tokens?.chatgpt_account_id,
    root?.account_id,
    root?.chatgpt_account_id,
    claims?.account_id,
    claims?.chatgpt_account_id,
    claims?.["https://api.openai.com/auth.chatgpt_account_id"],
    authClaims?.chatgpt_account_id,
    authClaims?.account_id,
    claims?.sub,
    account.providerAccountId,
  ]);
  const email = firstString([
    claims?.email,
    claims?.["https://api.openai.com/auth.email"],
    authClaims?.email,
    root?.email,
    account.email,
  ]);
  const accountKeyHash = providerAccountId
    ? hashAccountKey({
        provider: AgentProvider.Codex,
        accountKey: providerAccountId,
      })
    : undefined;

  return {
    safeIdentity: email
      ? maskEmail(email)
      : accountKeyHash
        ? `codex:${accountKeyHash.slice(0, 8)}`
        : `codex:${account.slotId}`,
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(accountKeyHash ? { accountKeyHash } : {}),
    ...(email ? { email } : {}),
  };
}

function firstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return undefined;
}
