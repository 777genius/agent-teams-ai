# Dependency Discipline

Add dependencies only with explicit user consent.

## Before Proposing a New Dependency

State: what it does, why it's needed, what alternatives exist (including stdlib), and its maintenance status.

## Rules

- Prefer stdlib and existing project dependencies over new ones.
- When a dependency is approved, document why in the commit message.
- Pin versions explicitly. Avoid floating ranges (`^`, `~`, `*`) in production dependencies.
- Commit lock files (package-lock.json, poetry.lock, Cargo.lock, go.sum). They enforce reproducible installs and pin transitive dependencies.
- Audit transitive dependencies, not just direct ones — they are the primary supply chain attack vector.
- Run vulnerability scanning in CI on every PR, not just periodically.
- Regularly check for outdated or deprecated dependencies and flag them.
