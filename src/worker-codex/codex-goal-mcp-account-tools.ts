import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  accountNames,
  booleanValue,
  numberValue,
  resolvePath,
  stringValue,
} from "./codex-goal-mcp-values";
import {
  jobIdInputSchema,
  type AccountPoolMcpArgs,
  type JobAccountPoolMcpArgs,
  type JobIdMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  accountAuthRootFromArgs,
  accountPoolRootFromArgs,
  codexAccountReloginInstructions,
  codexAccountStatusPayload,
  listAccountPools,
} from "./codex-goal-mcp-accounts";
import {
  codexGoalAccountStatusPayload,
  codexGoalStateRootDir,
} from "./codex-goal-mcp-worker-control";
import {
  mcpJson,
  withMcpErrors,
} from "./codex-goal-mcp-response";
import {
  loadJobLaunch,
} from "./codex-goal-mcp-project-control-deps";

export function registerCodexGoalAccountTools(server: McpServer): void {
  server.registerTool(
    "codex_goal_accounts_status",
    {
      title: "Codex Goal Account Status",
      description:
        "Inspect a stored job's configured account slots by jobId, including job-specific capacity cooldowns.",
      inputSchema: {
        ...jobIdInputSchema(),
        liveCheck: z.boolean().optional(),
        codexBinaryPath: z.string().optional(),
        liveCheckTimeoutMs: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      return mcpJson({
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        ...(await codexGoalAccountStatusPayload(loaded.launch, {
          liveCheck: booleanValue(args.liveCheck) ?? false,
          ...(stringValue(args.codexBinaryPath)
            ? { codexBinaryPath: stringValue(args.codexBinaryPath) as string }
            : {}),
          ...(numberValue(args.liveCheckTimeoutMs)
            ? { liveCheckTimeoutMs: numberValue(args.liveCheckTimeoutMs) as number }
            : {}),
        })),
      });
    }),
  );

  server.registerTool(
    "codex_goal_accounts_list_pools",
    {
      title: "Codex Goal Account Pools",
      description:
        "List account pools for a stored job by jobId using the job state root for capacity-aware counts.",
      inputSchema: {
        ...jobIdInputSchema(),
        poolRootDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobAccountPoolMcpArgs);
      const poolRootDir = resolvePath(
        process.cwd(),
        stringValue((args as JobAccountPoolMcpArgs).poolRootDir) ??
          dirname(loaded.launch.config.authRootDir),
      );
      const stateRootDir = codexGoalStateRootDir(loaded.launch);
      const pools = await listAccountPools(poolRootDir, stateRootDir);
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        poolRootDir,
        selectedAuthRootDir: loaded.launch.config.authRootDir,
        stateRootDir,
        capacityAware: true,
        pools,
      });
    }),
  );

  server.registerTool(
    "codex_goal_accounts_relogin_instructions",
    {
      title: "Codex Goal Account Relogin Instructions",
      description:
        "Return safe manual relogin commands for a stored job's account slot by jobId.",
      inputSchema: {
        ...jobIdInputSchema(),
        account: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobAccountPoolMcpArgs);
      const status = await codexGoalAccountStatusPayload(loaded.launch);
      const requestedAccount = stringValue((args as JobAccountPoolMcpArgs).account);
      const targetAccounts = requestedAccount
        ? [requestedAccount]
        : status.slots
            .filter((slot) => slot.status !== "ready")
            .map((slot) => slot.name);
      const instructionsByAccount = Object.fromEntries(
        targetAccounts.map((account) => [
          account,
          codexAccountReloginInstructions({
            authRootDir: loaded.launch.config.authRootDir,
            account,
            afterLoginInstruction:
              "After login, run codex_goal_accounts_status for the job before starting workers.",
          }),
        ]),
      );
      return mcpJson({
        ok: targetAccounts.length > 0,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        authRootDir: loaded.launch.config.authRootDir,
        stateRootDir: codexGoalStateRootDir(loaded.launch),
        targetAccounts,
        reason: targetAccounts.length
          ? "manual_relogin_commands_ready"
          : "no_invalid_account_slots_detected",
        accountStatus: status,
        instructionsByAccount,
        instructions: targetAccounts.length
          ? Object.values(instructionsByAccount).flat()
          : [
              "No invalid account slots were detected for this job. Pass account if you want instructions for a specific slot.",
            ],
      });
    }),
  );

  server.registerTool(
    "codex_accounts_list_pools",
    {
      title: "List Codex Account Pools",
      description:
        "List account auth pools under a root directory without printing tokens.",
      inputSchema: {
        poolRootDir: z.string().optional(),
        stateRootDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const poolRootDir = accountPoolRootFromArgs(args as AccountPoolMcpArgs);
      const stateRootDir = stringValue(args.stateRootDir)
        ? resolvePath(process.cwd(), stringValue(args.stateRootDir) as string)
        : undefined;
      const pools = await listAccountPools(poolRootDir, stateRootDir);
      return mcpJson({
        ok: true,
        poolRootDir,
        capacityAware: Boolean(stateRootDir),
        ...(stateRootDir ? { stateRootDir } : {}),
        pools,
      });
    }),
  );

  server.registerTool(
    "codex_accounts_status",
    {
      title: "Codex Account Slot Status",
      description:
        "Inspect Codex account slot auth files without printing tokens.",
      inputSchema: {
        poolRootDir: z.string().optional(),
        pool: z.string().optional(),
        authRootDir: z.string().optional(),
        stateRootDir: z.string().optional(),
        accounts: z.union([z.string(), z.array(z.string())]).optional(),
        liveCheck: z.boolean().optional(),
        codexBinaryPath: z.string().optional(),
        liveCheckTimeoutMs: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const authRootDir = accountAuthRootFromArgs(args as AccountPoolMcpArgs);
      const accounts = accountNames(args.accounts);
      return mcpJson(await codexAccountStatusPayload({
        authRootDir,
        ...(accounts.length ? { accounts } : {}),
        ...(stringValue(args.stateRootDir)
          ? { stateRootDir: resolvePath(process.cwd(), stringValue(args.stateRootDir) as string) }
          : {}),
        liveCheck: booleanValue(args.liveCheck) ?? false,
        ...(stringValue(args.codexBinaryPath)
          ? { codexBinaryPath: stringValue(args.codexBinaryPath) as string }
          : {}),
        ...(numberValue(args.liveCheckTimeoutMs)
          ? { liveCheckTimeoutMs: numberValue(args.liveCheckTimeoutMs) as number }
          : {}),
      }));
    }),
  );

  server.registerTool(
    "codex_accounts_relogin_instructions",
    {
      title: "Codex Account Relogin Instructions",
      description:
        "Return safe manual relogin commands for account slots. Does not perform login.",
      inputSchema: {
        poolRootDir: z.string().optional(),
        pool: z.string().optional(),
        authRootDir: z.string().optional(),
        account: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const authRootDir = accountAuthRootFromArgs(args as AccountPoolMcpArgs);
      const account = stringValue(args.account) ?? "<account-slot>";
      return mcpJson({
        ok: true,
        authRootDir,
        account,
        instructions: codexAccountReloginInstructions({
          authRootDir,
          account,
          afterLoginInstruction:
            "After login, run codex_accounts_status for this pool before starting workers.",
        }),
      });
    }),
  );

}
