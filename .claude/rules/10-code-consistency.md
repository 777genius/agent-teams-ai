# Code Consistency

Before writing any code, read the existing codebase and match its patterns.

## Rules

- Before implementing, examine existing code in the same module/package: naming conventions, file organization, design patterns, error handling style, import ordering.
- Match what's there. If the project uses factories, use factories. If it's camelCase, use camelCase.
- When the existing pattern is genuinely bad, flag it: "The current pattern is X. I think Y would be better because [reason]. Want me to refactor consistently, or match existing style?"
- When a formatter or linter is configured, use it. When none exists, propose one from project start.
