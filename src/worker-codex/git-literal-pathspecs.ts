/**
 * Project-owned paths are repository-relative file names, never Git pathspecs.
 * Keep this policy at the process boundary so pathspec magic cannot reinterpret
 * a validated file name such as `:(exclude)feature.ts`.
 */
export function withLiteralGitPathspecs(
  args: readonly string[],
): readonly string[] {
  return ["--literal-pathspecs", ...args];
}
