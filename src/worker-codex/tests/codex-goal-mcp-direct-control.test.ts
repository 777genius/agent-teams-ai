import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";

const execFileAsync = promisify(execFile);

describe("codex goal MCP direct-run control", () => {
  it("does not require tmux to stop a direct job that already has a terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-stop-direct-terminal-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-stop-direct-terminal-task";
    const outputPath = join(jobRootDir, `${taskId}.latest-result.json`);

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a");
      await writeFile(outputPath, `${JSON.stringify({
        status: "completed",
        task: { updatedAt: new Date().toISOString() },
      })}\n`);
      await writeFile(join(jobRootDir, `${taskId}.progress.json`), `${JSON.stringify({
        schemaVersion: 1,
        taskId,
        status: "running",
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      })}\n`);

      const { client, server } = await connectedClient();
      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-stop-direct-terminal",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          outputPath,
          logPath: join(jobRootDir, `${taskId}.log`),
          tmuxSession: "",
        });

        const stopped = await callToolJson(client, "codex_goal_stop", {
          registryRootDir,
          jobId: "job-stop-direct-terminal",
          confirmStop: true,
        });

        expect(stopped).toMatchObject({
          ok: true,
          mode: "stop",
          reason: "terminal_result_already_present",
          jobId: "job-stop-direct-terminal",
          statusBefore: {
            resultStatus: "completed",
            progressProcessAlive: true,
          },
        });
        expect(stopped).not.toMatchObject({ reason: "tmux_session_required" });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("diagnoses next-safe-point guidance that is pending for an already-running direct job", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-control-direct-mcp-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-control-direct-task";

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a");
      await writeFile(join(jobRootDir, `${taskId}.progress.json`), `${JSON.stringify({
        schemaVersion: 1,
        taskId,
        status: "running",
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      })}\n`);

      const { client, server } = await connectedClient();
      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-control-direct",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          logPath: join(jobRootDir, `${taskId}.log`),
          tmuxSession: "",
        });

        const enqueued = await callToolJson(client, "codex_goal_control_enqueue", {
          registryRootDir,
          jobId: "job-control-direct",
          intent: "guidance",
          deliveryMode: "next_safe_point",
          body: "Do not expose this raw guidance body.",
          idempotencyKey: "guidance-direct-next-safe-point",
          callerKind: "agent",
          callerId: "lead-agent",
        });

        expect(enqueued).toMatchObject({
          ok: true,
          jobId: "job-control-direct",
          deliveryDiagnostic: {
            workerAlive: true,
            workerSupervisorKind: "direct",
            workerAliveReason: "pid",
            signalState: "pending",
            deliveryMode: "next_safe_point",
            deliverable: true,
            reason: "pending_until_next_safe_point",
            recommendedTool: "codex_goal_send_guidance",
          },
        });
        expect(JSON.stringify(enqueued).includes("Do not expose this raw guidance body")).toBe(false);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function connectedClient(): Promise<{
  readonly client: Client;
  readonly server: ReturnType<typeof createCodexGoalMcpServer>;
}> {
  const server = createCodexGoalMcpServer();
  const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

async function callToolJson(
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

async function writeFakeAuth(authRootDir: string, account: string): Promise<void> {
  const accountDir = join(authRootDir, account);
  await mkdir(accountDir, { recursive: true });
  await writeFile(
    join(accountDir, "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-06-03T00:00:00.000Z",
      tokens: {
        refresh_token: "test-refresh-token",
        access_token: "test-access-token",
        id_token: fakeJwt({
          email: "test@example.com",
          sub: "test-oauth-sub",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "test-chatgpt-account",
            chatgpt_user_id: "test-chatgpt-user",
          },
        }),
        expiry: Math.floor(Date.now() / 1000) + 3600,
      },
    })}\n`,
  );
}

function fakeJwt(claims: Readonly<Record<string, unknown>>): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(claims),
    "",
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64url");
}
