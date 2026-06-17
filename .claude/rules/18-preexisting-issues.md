# Preexisting Issues

Never ignore problems you encounter in the codebase, even if they are outside the current task scope.

## Rules

- When you encounter a bug, lint error, type error, broken test, or code smell while working on a task, do not skip it.
- If the fix is straightforward (under ~15 minutes of work), fix it in a separate commit with a clear message explaining what was wrong.
- If the fix is complex (large refactor, architectural change, risk of regression), stop and inform the user: describe the issue, its severity, where it lives, and propose a plan to fix it. Do not attempt complex fixes without approval.
- Never suppress warnings, disable lint rules, or add `// @ts-ignore` to hide preexisting issues. Surface them.
- When fixing a preexisting issue, add a test that would have caught it if one does not already exist.
- Track issues you cannot fix immediately: flag them to the user and, if Memora is available, create an issue memory.
