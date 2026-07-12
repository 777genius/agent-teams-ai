# Hosted-web orchestration tools

These dependency-free Node.js tools turn the evidence and worker orchestration rules into deterministic,
fail-closed checks. They never launch a worker or change an evidence artifact.

| Tool                                 | Purpose                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `generate-evidence-catalog.mjs`      | Hash and sort a metadata source into a new catalog path. Refuses to overwrite an existing output.                |
| `validate-evidence-catalog.mjs`      | Validate catalog semantics, supersession links, exact paths, canonical SHA, and on-disk hashes.                  |
| `validate-worker-start.mjs`          | Diagnostic validation of one worker's exact start inputs; never authorizes launch by itself.                     |
| `validate-orchestration-state.mjs`   | Validate work-key uniqueness, retry limits, statuses, and reciprocal acyclic supersession.                       |
| `validate-worker-admission.mjs`      | Required combined launch gate binding one contract to one exactly matching queued registry record.               |
| `orchestration-state.mjs`            | Capacity-aware initial admission and immutable atomic-refill candidate construction.                             |
| `materialize-p1-s0-worker-start.mjs` | Purely render the exact P1.S0 runtime `preStartAdmission` object from planned child paths and the worktree HEAD. |

Run the focused contract tests with:

```text
node --test test/architecture/hosted-web/orchestration/*.test.mjs
```

The atomic-refill helper enforces serialized `maxInFlight` eligibility, preserves the predecessor's
refillable terminal status, validates a complete before/after state, and does not mutate its input.
Actual multi-host atomicity requires the separate durable shared-runtime enforcement described in
`docs/hosted-web-phases/ORCHESTRATION_GUARDS.md`.

The P1.S0 materializer is a pure broker input renderer, not an authority source. The broker first
creates only the isolated worktree. Before any job, prompt, or registry record exists, render the
runtime bridge input from the planned child paths and exact worktree HEAD:

```text
node scripts/hosted-web/orchestration/materialize-p1-s0-worker-start.mjs \
  --job-id <planned-job-id> \
  --worker-id <planned-worker-id> \
  --job-root <planned-absolute-job-root> \
  --workspace-root <existing-isolated-worktree> \
  --prompt-path <planned-absolute-prompt-path> \
  --expected-phase-start-sha <exact-worktree-head>
```

The command reads only the worktree HEAD and writes nothing. It emits the exact `preStartAdmission`
JSON with relative validator paths, one queued shadow record, and required checks bound to the
runtime-owned `jobRoot/pre-start-admission/{contract,state}.json` artifacts. Pass that object to one
`refill_worker` call that reuses the worktree, writes the prompt and admission artifacts, validates,
creates the authoritative job record, and starts only after the gate succeeds.
