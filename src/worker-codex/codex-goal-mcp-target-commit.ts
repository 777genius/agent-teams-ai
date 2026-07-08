import { readTargetRevision } from "@vioxen/subscription-runtime/worker-core";
import { LocalGitRevisionReader } from "./codex-goal-git-revision";
import type { JobBriefMcpArgs } from "./codex-goal-mcp-inputs";
import { assertSafeGitCommitSha } from "./codex-goal-mcp-project-git";
import {
  resolvePath,
  stringValue,
} from "./codex-goal-mcp-values";

export async function targetCommitFromArgs(
  args: Pick<JobBriefMcpArgs, "cwd" | "targetCommit" | "targetWorkspacePath">,
): Promise<string | undefined> {
  const commit = stringValue(args.targetCommit);
  if (commit) {
    assertSafeGitCommitSha(commit);
    return commit;
  }
  const workspacePath = stringValue(args.targetWorkspacePath);
  if (!workspacePath) return undefined;
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const target = await readTargetRevision(new LocalGitRevisionReader(), {
    workspacePath: resolvePath(cwd, workspacePath),
  });
  return target.commit;
}

export function optionalTargetCommit(
  targetCommit: string | undefined,
): { readonly targetCommit?: string } {
  return targetCommit === undefined ? {} : { targetCommit };
}
