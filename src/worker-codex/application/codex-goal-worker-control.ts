import { join } from "node:path";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  WorkerControlService,
  type WorkerControlTarget,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import { codexAccountStatusPayload } from "./codex-goal-accounts";

export function codexGoalWorkerControlService(
  launch: CodexGoalLaunchInput,
): WorkerControlService {
  return new WorkerControlService({
    store: new LocalFileWorkerControlInboxStore({
      rootDir: codexGoalStateRootDir(launch),
    }),
  });
}

export function codexGoalWorkerControlTarget(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
}): WorkerControlTarget {
  return {
    jobId: input.manifest.jobId,
    taskId: input.launch.config.taskId,
    workspaceId: input.launch.config.workspacePath,
  };
}

export function codexGoalStateRootDir(launch: CodexGoalLaunchInput): string {
  return launch.config.stateRootDir ?? join(launch.config.jobRootDir, "state");
}

export async function codexGoalAccountStatusPayload(
  launch: CodexGoalLaunchInput,
  options: {
    readonly liveCheck?: boolean;
    readonly codexBinaryPath?: string;
    readonly liveCheckTimeoutMs?: number;
  } = {},
) {
  return codexAccountStatusPayload({
    authRootDir: launch.config.authRootDir,
    stateRootDir: codexGoalStateRootDir(launch),
    accounts: launch.config.accounts.map((account) => account.name),
    ...options,
  });
}
