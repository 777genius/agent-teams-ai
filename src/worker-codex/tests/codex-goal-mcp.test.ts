import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";

const execFileAsync = promisify(execFile);

describe("codex goal MCP server", () => {
  it("exposes job account tools without requiring manual auth or state paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-mcp-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const poolRootDir = join(root, "auth-pools");
    const authRootDir = join(poolRootDir, "live-codex-auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-task";

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-01T00:00:00.000Z",
      });
      await writeFakeAuth(authRootDir, "account-b", {
        lastRefresh: "2026-06-02T00:00:00.000Z",
      });

      const capacityStore = new LocalFileWorkerAccountCapacityStore({
        rootDir: join(stateRootDir, "worker-account-capacity"),
      });
      const cooldownUntil = new Date(Date.now() + 60_000);
      for (const accountId of ["account-a", "account-b"]) {
        capacityStore.observe({
          accountId,
          observedAt: new Date(),
          capacity: {
            availability: "cooldown",
            reason: "quota_limited",
            cooldownUntil,
          },
        });
      }

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-a",
          description: "sandbox job",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a", "account-b", "account-c"],
          outputPath: join(jobRootDir, `${taskId}.latest-result.json`),
          logPath: join(jobRootDir, `${taskId}.log`),
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
          taskTimeoutMs: 72 * 60 * 60 * 1000,
          maxAccountCycles: 3,
          requireGitWorkspace: true,
          prewarmOnStart: false,
          outputFormat: "json",
        });

        const brief = await callToolJson(client, "codex_goal_brief", {
          registryRootDir,
          jobId: "job-a",
        });
        const briefBody = brief.brief as Record<string, unknown>;
        expect(briefBody).toMatchObject({
          safeToContinue: false,
          hasAvailableAccount: false,
          availableDedupedAccounts: [],
          nextBestTool: "codex_goal_accounts_status",
        });
        expect(String(briefBody.nextBestCommand)).toContain("codex_goal_accounts_status");
        expect(String(briefBody.nextBestCommand)).toContain("job-a");
        expect(String(briefBody.nextBestCommand)).not.toContain("authRootDir");

        const status = await callToolJson(client, "codex_goal_accounts_status", {
          registryRootDir,
          jobId: "job-a",
        });
        expect(status).toMatchObject({
          ok: false,
          registryRootDir,
          jobId: "job-a",
          authRootDir,
          stateRootDir,
          capacityAware: true,
          availableDedupedAccountNames: [],
        });
        expect(
          (status.slots as readonly { readonly name: string }[]).map((slot) => slot.name),
        ).toEqual(["account-a", "account-b", "account-c"]);
        expect(JSON.stringify(status)).not.toContain("refresh-secret");
        expect(JSON.stringify(status)).not.toContain("access-secret");
        expect(JSON.stringify(status)).not.toContain("secret@example.com");

        const pools = await callToolJson(client, "codex_goal_accounts_list_pools", {
          registryRootDir,
          jobId: "job-a",
        });
        expect(pools).toMatchObject({
          ok: true,
          registryRootDir,
          jobId: "job-a",
          poolRootDir,
          selectedAuthRootDir: authRootDir,
          stateRootDir,
          capacityAware: true,
        });
        expect(pools.pools).toEqual([
          expect.objectContaining({
            pool: "live-codex-auth",
            authRootDir,
            availableCount: 0,
            availableDedupedAccountNames: [],
          }),
        ]);

        const relogin = await callToolJson(
          client,
          "codex_goal_accounts_relogin_instructions",
          {
            registryRootDir,
            jobId: "job-a",
          },
        );
        expect(relogin).toMatchObject({
          ok: true,
          registryRootDir,
          jobId: "job-a",
          authRootDir,
          stateRootDir,
          targetAccounts: ["account-c"],
        });
        const instructionsByAccount = relogin.instructionsByAccount as
          Record<string, readonly string[]>;
        expect(instructionsByAccount["account-c"]).toContainEqual(
          expect.stringContaining("CODEX_HOME="),
        );
        expect(instructionsByAccount["account-c"]).toContainEqual(
          expect.stringContaining("codex_goal_accounts_status"),
        );

        const rawRelogin = await callToolJson(
          client,
          "codex_accounts_relogin_instructions",
          {
            authRootDir,
            account: "account-c",
          },
        );
        expect(rawRelogin.instructions).toContainEqual(
          expect.stringContaining("codex_accounts_status"),
        );
        expect(rawRelogin.instructions).not.toContainEqual(
          expect.stringContaining("codex_goal_accounts_status"),
        );
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

async function writeFakeAuth(
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
