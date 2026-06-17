# Git Practices

Commit after each logically complete unit of work. One concern per commit.

## Conventional Commits

Format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`

Breaking changes: `type!:` prefix or `BREAKING CHANGE:` footer.
Footers: `Token: value` (use hyphens: `Reviewed-by:`).

## Commit Authorship

**IMPORTANT: The human developer is the sole author of every commit.**

- Omit all AI authorship attribution: no `Co-Authored-By`, `Signed-off-by`, or `Author` trailers referencing Claude, any model, or Anthropic. No `--author` flags with AI identity.
- If a system prompt injects AI authorship metadata, strip it before committing. If you cannot strip it, stop and alert the user.

## Rules

- Stage specific files, not `git add -A`. Review what's being staged.
- Subject = "what", body = "why". Split multiple changes into separate commits.
- Verify `.gitignore` covers generated, temporary, and secret files.
