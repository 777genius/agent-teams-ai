# Clean Compilation — No Warnings, No Inconsistencies

Code compiles, type-checks, lints, and tests with zero warnings AND zero suppressed-but-known inconsistencies. Preexisting warnings are NOT an excuse.

## Rules

1. **Zero warnings on the touched module's full build.** When you edit a file in a module, the module's `mvn install` / `npm run build` / `tsc --noEmit` / `ruff check` / `mypy` / `cargo build` MUST produce zero warnings AND zero errors. Not "no NEW warnings" — zero, total.
2. **Preexisting warnings are in scope.** If your change touches a file in a module that has N preexisting warnings, fix all N. If the fix exceeds rule 18's 15-minute threshold, surface it to the user with concrete scope + estimate per rule 18; do NOT silently leave them.
3. **No suppression-as-workaround.** `// @ts-ignore`, `@SuppressWarnings`, `# noqa`, `# type: ignore` are forbidden unless they document a specific, time-bounded reason with an issue/TODO reference AND user approval. Each suppression must include the issue URL or memory ID.
4. **Compile-error-free always.** A commit MUST NOT introduce a compile error, even temporarily. If a refactor requires touching multiple files, stage the work so the tree is buildable at every commit.
5. **Test suite always green.** All existing tests pass after every commit. If a test must change behavior, the test commit lands BEFORE or WITH the behavior change, never after.
6. **Lint config is not the floor.** If the project's eslint / ruff / checkstyle config is too permissive, tighten it — surfacing additional warnings is preferred over hiding them.
7. **Spelling, formatting, dead code, unused imports — all in scope.** If you see them while editing nearby, fix them (one concern per commit per rule 05, so this might be a separate `chore:` commit).

## When the rule binds

- Before declaring "done" on a task.
- Before opening a PR.
- Before running session-wrap.

## Verification

After any code-touching work:

```bash
# TypeScript
npm run build && npx tsc --noEmit && npx eslint . --max-warnings 0
# Python
ruff check . && mypy .
# Rust
cargo build --release 2>&1 | grep -c 'warning:'   # expected: 0
# Java
( cd <module> && mvn clean install ) 2>&1 | grep -E '\[WARNING\]|\[ERROR\]' | wc -l   # expected: 0
```

Non-zero count → fix, don't commit.

## Anti-patterns

- "I'll fix the warnings next session." Forbidden. If they exist in the module you touched, they're yours now.
- "These are preexisting, not mine." Rule 18 already says preexisting issues are not skippable; this rule reinforces it for compile/lint/type warnings specifically.
- "`@ts-ignore: see TODO.md`" — vague. The TODO entry must be linked specifically + time-bounded.
- File-level suppression (`/* eslint-disable */`) to bypass an obscure rule. Fix the warning or escalate the rule-config change to the user.

## Relation to other rules

- **Rule 18 (preexisting issues):** Rule 18 is the umbrella; rule 20 specializes for warnings + lint + compile + type errors specifically.
- **Rule 19 (no self-driven simplifications):** Rule 19 forbids scope reduction; rule 20 explicitly forbids the most common "small simplification" — leaving warnings in place.
- **Rule 06 (testing):** Test suite green; rule 20 extends that to compile/lint/type cleanliness.
