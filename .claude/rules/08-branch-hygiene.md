# Branch and Refactor Hygiene

## Branches

- Work on feature branches. Use descriptive names: `feature/auth-login`, `fix/null-pointer-profile`, `chore/update-deps`.
- Before creating a PR, ensure the branch is up to date with the base branch.
- After merge, delete the branch. First commit on `main` is acceptable for fresh repos.
- Keep feature branches short-lived: merge within 1-2 days. Use feature flags for incomplete work that lands on main.

## Before Refactoring

- Verify clean git state — all work committed or stashed.
- Run the full test suite to establish a passing baseline.
- Document the refactoring scope: what changes, what is preserved.
- Commit frequently during the refactor. Run tests after each step.
