import { resolveCodexGoalJobRegistryRoot } from "../codex-goal-jobs.js";
export function registryRootFromInput(args) {
    return resolveCodexGoalJobRegistryRoot({
        ...(args.registryRootDir ? { registryRootDir: args.registryRootDir } : {}),
        ...(args.cwd ? { cwd: args.cwd } : {}),
    });
}
//# sourceMappingURL=codex-goal-use-case-inputs.js.map