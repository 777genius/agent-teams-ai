import { readTargetRevision } from "@vioxen/subscription-runtime/worker-core";
import { LocalGitRevisionReader } from "./codex-goal-git-revision.js";
import { assertSafeGitCommitSha } from "./codex-goal-mcp-project-git.js";
import { resolvePath, stringValue, } from "./codex-goal-mcp-values.js";
export async function targetCommitFromArgs(args) {
    const commit = stringValue(args.targetCommit);
    if (commit) {
        assertSafeGitCommitSha(commit);
        return commit;
    }
    const workspacePath = stringValue(args.targetWorkspacePath);
    if (!workspacePath)
        return undefined;
    const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
    const target = await readTargetRevision(new LocalGitRevisionReader(), {
        workspacePath: resolvePath(cwd, workspacePath),
    });
    return target.commit;
}
export function optionalTargetCommit(targetCommit) {
    return targetCommit === undefined ? {} : { targetCommit };
}
//# sourceMappingURL=codex-goal-mcp-target-commit.js.map