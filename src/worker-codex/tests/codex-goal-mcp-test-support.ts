import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ProjectControlAuditEventType,
  type WorkerControlDeliveryReceipt,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);

export async function removeStoredTmuxSession(
  registryRootDir: string,
  jobId: string,
): Promise<void> {
  const manifestPath = join(registryRootDir, jobId, "job.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  delete manifest.tmuxSession;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readProjectControlAudit(
  jobRootDir: string,
  taskId: string,
): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(
    join(jobRootDir, `${taskId}.project-control-events.jsonl`),
    "utf8",
  );
  return text.trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
}

export function auditDecision(event: Record<string, unknown>): Record<string, unknown> {
  const decision = event.decision;
  return decision && typeof decision === "object" && !Array.isArray(decision)
    ? decision as Record<string, unknown>
    : {};
}

export function policyAuditDecisions(
  events: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return events
    .filter((event) => event.type === ProjectControlAuditEventType.DecisionRecorded)
    .map((event) => auditDecision(event));
}

export async function gitInitRepository(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test User"]);
  await git(cwd, ["checkout", "-b", "main"]);
}

export async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

export async function gitStdout(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd });
  return result.stdout;
}

export async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as { readonly content?: readonly unknown[] }).content;
  const first = content?.[0] as
    | { readonly type?: string; readonly text?: string }
    | undefined;
  if (first?.type !== "text") throw new Error("expected text MCP response");
  return JSON.parse(first.text ?? "{}") as Record<string, unknown>;
}

export type TmuxExec = (args: readonly string[]) => Promise<void>;

export async function hasTmux(execTmux: TmuxExec = execTmuxCommand): Promise<boolean> {
  const session = `subscription-runtime-tmux-probe-${process.pid}-${Date.now()}`;
  try {
    await execTmux(["-V"]);
    await execTmux(["new-session", "-d", "-s", session, "sleep 60"]);
    return true;
  } catch {
    return false;
  } finally {
    try {
      await execTmux(["kill-session", "-t", session]);
    } catch {
      // Cleanup is best-effort: restricted CI may deny tmux session operations.
    }
  }
}

export async function execTmuxCommand(args: readonly string[]): Promise<void> {
  await execFileAsync("tmux", [...args], { timeout: 2_000 });
}

export async function writeFakeAuth(
  authRootDir: string,
  account: string,
  options: { readonly lastRefresh: string },
) {
  const accountDir = join(authRootDir, account);
  await mkdir(accountDir, { recursive: true });
  await writeFile(
    join(accountDir, "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: options.lastRefresh,
      tokens: {
        refresh_token: "refresh-secret",
        access_token: "access-secret",
        id_token: fakeJwt({
          email: "secret@example.com",
          sub: "oauth-sub-secret",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "chatgpt-account-secret",
            chatgpt_user_id: "chatgpt-user-secret",
          },
        }),
        expiry: Math.floor(Date.now() / 1000) + 3600,
      },
    })}\n`,
  );
}

export async function writeClaudeRunArtifacts(input: {
  readonly rootDir: string;
  readonly runId: string;
  readonly providerInstanceId: string;
  readonly workerId: string;
  readonly configDir: string;
  readonly workspacePath: string;
}): Promise<void> {
  const now = "2026-06-30T00:00:00.000Z";
  const runDir = join(input.rootDir, hashRunId(input.runId));
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      providerKind: "claude",
      runId: input.runId,
      createdAt: now,
      updatedAt: now,
      providerInstanceId: input.providerInstanceId,
      workerId: input.workerId,
      configDir: input.configDir,
      workspacePath: input.workspacePath,
    }, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, "progress.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      status: "completed",
      updatedAt: now,
      pid: process.pid,
      providerRunId: "provider-run-a",
      providerSessionId: "provider-session-a",
    }, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, "result.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      status: "completed",
      updatedAt: now,
      outputTextPreview: "completed with redacted output",
      telemetry: {
        providerRunId: "provider-run-a",
        providerSessionId: "provider-session-a",
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, "run.log"),
    `${JSON.stringify({
      occurredAt: now,
      event: "run.completed",
      providerRunId: "provider-run-a",
      providerSessionId: "provider-session-a",
    })}\n`,
  );
}

export function hashRunId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function fakeJwt(claims: Readonly<Record<string, unknown>>): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(claims),
    "",
  ].join(".");
}

export function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64url");
}

export function workerControlReceipt(input: {
  readonly signalId: string;
  readonly target: { readonly jobId: string };
  readonly deliveryAttemptId: string;
  readonly createdAt: Date;
}): WorkerControlDeliveryReceipt {
  return {
    schemaVersion: 1,
    receiptId: `${input.deliveryAttemptId}-receipt`,
    signalId: input.signalId,
    target: input.target,
    state: "accepted",
    createdAt: input.createdAt,
    deliveryAttemptId: input.deliveryAttemptId,
    metadata: {},
  };
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
