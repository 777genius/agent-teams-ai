# Borrowed Reference Repositories — Read-Only

When the project reads from external repositories as reference (pattern sources, library examples, skill libraries), those repos are **read-only**. No writes of any kind to their working trees.

## Where the list lives

The project's `CLAUDE.md` or `.claude/CLAUDE.md` should declare the borrowed-reference list under a "Reference repositories" section, e.g.:

```
## Reference repositories (read-only)
- /path/to/repo-a  — pattern source for X
- /path/to/repo-b  — pattern source for Y
- /path/to/repo-c  — skill library
```

If no list is declared, this rule is dormant for that project.

## Hard rules

1. **No write of any kind** to listed working trees. Not even a touch of mtime via a probe.
2. **No `git push`** to their upstream remotes.
3. **No `git commit`** into their local working trees.
4. **No skill invocation that writes into them.** When invoking write-capable skills, ensure the cwd is the working project tree or a subdir of it.

## What "fork into our project" actually means

Create a new repository under our own namespace and re-author the project structure from scratch. We **do not** `git clone` the original and rebrand it — that would carry unrelated history. We copy code patterns + structure + good naming, but commit as a fresh tree.

This protects the originals from contamination, and avoids inheriting a code history that has nothing to do with our project.

## What to do if the originals have a useful change after we fork

- Read it. Cite it in our fork's docs.
- Re-implement the equivalent in our tree under our own commit.
- Note in a Memora memory tagged `borrowed-from-<origin>` that the original moved and our fork mirrored the pattern.
- Never rebase against the original. Never cherry-pick.

## Verification

Before any session that read from reference repos completes (and especially before any commit in the consuming project):

```bash
for repo in "${BORROWED_REPOS[@]}"; do
  ( cd "$repo" && git status -sb )
done
```

If any shows modifications, treat it as a bug: identify the cause, restore the file (`git checkout -- <path>`), and commit nothing in the consuming project until the borrowed tree is clean.

## Reason

Reference repos accumulate value as patterns + canonical implementations to learn from. Contaminating them — even accidentally with a probe that touches mtime — costs trust and breaks the next session's `git status` baseline.
