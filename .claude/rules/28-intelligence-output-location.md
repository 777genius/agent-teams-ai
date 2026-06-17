# Code Intelligence Output Location (Meta-Repos)

When running `/quanta:refresh-intelligence` (or any future skill that produces `.api-surface/` / `.code-intelligence/` artifacts) against a **multi-submodule meta-repo**, outputs MUST land in `code-intelligence/<submodule>/` at the meta-repo root — NEVER inside the submodule's own working tree.

## When the rule binds

ONLY when the project is a **meta-repo** containing git submodules whose intelligence is produced through the consuming meta-repo. The project's `CLAUDE.md` should declare this layout explicitly under a "Meta-repo" section listing the submodule paths; if it does not, this rule is dormant.

For single-repo projects (the common case), `/quanta:refresh-intelligence` writes `.api-surface/` and `.code-intelligence/` inside the project's own tree as documented in the skill — this rule does not change that behaviour.

## Why

- Submodules are independent git repos with their own commit histories. Writing artifacts into them dirties their working trees and pollutes their state with files we have no intention of pushing upstream.
- The meta-repo IS the right home for cross-cutting analysis output — it already aggregates the submodules; adding intelligence next to the submodule pointers keeps everything in one git history.
- Submodule `.gitignore` files don't necessarily cover `.api-surface/` / `.code-intelligence/` — and patching them per-submodule is invasive (each is a separate upstream PR).

## Required layout

```
<meta-repo>/
├── code-intelligence/                  ← always here, never inside submodules
│   ├── <sub>/
│   │   ├── .api-surface/               ← AST extractor output (manifest + per-module JSONs)
│   │   ├── repo-map.json               ← PageRank-scored signature map
│   │   ├── hierarchy.json              ← 3-level dir/file/symbol summary
│   │   └── _status.json                ← run metadata (status, head SHA, modules, symbols, duration)
│   └── … (one dir per submodule)
└── <submodule>/                        ← left alone — never write artifacts here
```

## How to comply

1. **Always invoke a project wrapper script** (typical name: `scripts/refresh-intelligence.sh`) that redirects outputs to the correct location via `--output` / `--api-surface-dir` / stdout redirection. Do NOT call `/quanta:refresh-intelligence` directly with default arguments when working in a meta-repo — that writes inside the submodules.

2. **If the upstream skill changes** (new languages, new tools) and the wrapper falls behind, update the wrapper rather than running the upstream skill ad-hoc. The wrapper's contract — "outputs land under `code-intelligence/<sub>/`" — must hold for every supported language and every artifact type.

3. **If you discover artifacts written into a submodule** (e.g., `<sub>/.api-surface/`, `<sub>/.code-intelligence/`), treat it as a bug:
   - Delete the misplaced artifacts (don't commit them in the submodule).
   - Re-run the wrapper to repopulate the correct location.
   - Update the wrapper if a new code path bypassed the redirection.

4. **Each `code-intelligence/<sub>/` MUST contain `_status.json`** — even for subrepos that produce no real intelligence. The status marker prevents the next run from confusing "skipped because not-applicable" with "missing because never run".

## Freshness anchor

The wrapper compares each submodule's HEAD SHA against `code-intelligence/<sub>/.api-surface/manifest.json:gitRevision` (when present). If you move artifacts to a different location, the freshness check breaks silently — every run will re-extract. Don't.

## Relation to other rules

- **Rule 27 (borrowed-reference-repos):** submodules in a meta-repo are similar in spirit — independent trees whose state you must not contaminate. This rule is the meta-repo case; rule 27 is the borrowed-repo case.
