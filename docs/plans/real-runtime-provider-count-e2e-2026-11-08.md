# Real pinned-runtime provider connection E2E (2026-11-08)

## Scope
Close the residual evidence gap after merged PR #1144: the existing desktop E2E runs a fixture CLI, and its fixed connected rows do not prove the shipped runtime implements `--summary --filter connected`. Do not modify #1148's owned UI fixture/catalog tests.

1. Run exactly the shipped, SHA256-pinned `claude-multimodel` executable from `runtime.lock.json` in a disposable isolated home/project, with no imported user credentials or network-inference actions.
2. Exercise genuine read-only `runtime providers directory --runtime opencode --json --summary --filter all/connected --limit 100` commands. Compare to an independently executed full-directory request; check response envelope, filtered states, counts, pagination, absence of scope leakage, and redacted finite timing evidence.
3. In deterministic contract tests, exercise a 200-entry unfiltered catalog and a bounded connected-only page. The pinned real CLI sandbox may expose fewer than 100 providers; do not represent that as a real high-volume test. Verify that the header can use a complete connected summary without loading models.
4. Measure subprocess count, latency and output bytes on cold/warm reads. Do not treat fixture timing as a real-user performance number. Publish sanitized artifact under CI, without file paths, environment variables or credentials.
5. Prefer reusing the existing runtime stager and integration runner; no new IPC endpoints, app config, schedulers, flags or launch permission changes.

## Negative and positive evidence
* Negative: genuine runtime in credential-free sandbox; not an OAuth/inference verification. This proves real CLI command/JSON/filter semantics **only**; this PR does not exercise desktop Electron IPC.
* Positive, required for the summary-filter gate: a controlled synthetic local provider with a disposable saved test credential. A connected count of zero alone does not qualify positive filtering. The synthetic credential never authorizes production inference.
* Fail closed on unexpected **summary** command errors, timeouts, inconsistent metadata or partial stdout. Keep diagnostic category only, not raw output, in evidence.
* Qualification levels must remain separate: `summaryFilterQualified` may be true when the genuine pinned CLI correctly reports a positive synthetic connection; `fullCatalogReconciled` requires a complete, healthy independent full directory. The full host-backed catalog may be unavailable in an isolated no-credentials runner. Record that explicitly as **unqualified** without falsely claiming a complete catalog E2E. No real-account/OAuth qualification is possible from these fixtures.
* Do not label this PR a real-desktop-IPC E2E. #1148 exercises the Electron IPC path using a fixture CLI; real-runtime-to-desktop IPC remains a distinct future qualification.

## Plan / acceptance
* Inspect current source, pinned assets, command time budgets and competing PRs; implement narrow script/test/workflow.
* Capture **summary/filter-only** evidence on Linux and Windows with pinned artifacts; store the independent full-directory status even if the OpenCode host is unavailable. Explicitly state which qualification was achieved; no reliance on provider secrets.
* Run unit tests, lint, full CI, native Electron E2E where relevant, CodeQL, 2 reviewer passes, address findings, then merge and post-merge validate.
* Remaining live-account requirement: dedicated ephemeral accounts supplied to a test environment; never infer this passed without them.

## Change budget
Target 200–450 lines including runner, pure tests, CI job. Keep no production-code modification unless real CLI evidence demonstrates a defect.
