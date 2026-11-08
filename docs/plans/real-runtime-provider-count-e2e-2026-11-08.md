# Real pinned-runtime provider connection E2E (2026-11-08)

## Scope
Close the residual evidence gap after merged PR #1144: the existing desktop E2E runs a fixture CLI, and its fixed connected rows do not prove the shipped runtime implements `--summary --filter connected`. Do not modify #1148's owned UI fixture/catalog tests.

1. Run exactly the shipped, SHA256-pinned `claude-multimodel` executable from `runtime.lock.json` in a disposable isolated home/project, with no imported user credentials or network-inference actions.
2. Exercise genuine read-only `runtime providers directory --runtime opencode --json --summary --filter all/connected --limit 100` commands. Compare to an independently executed full-directory request; check response envelope, filtered states, counts, pagination, absence of scope leakage, and redacted finite timing evidence.
3. For >100 full-catalog entries, prove the summary response and connected filter are bounded and that the header can use the summarized connected count without requesting hundreds of models. Do not assume positive real authentications in CI.
4. Measure subprocess count, latency and output bytes on cold/warm reads. Do not treat fixture timing as a real-user performance number. Publish sanitized artifact under CI, without file paths, environment variables or credentials.
5. Prefer reusing the existing runtime stager and integration runner; no new IPC endpoints, app config, schedulers, flags or launch permission changes.

## Negative and positive evidence
* Negative: genuine runtime in credential-free sandbox; not an OAuth/inference verification. This proves real CLI flag semantics and IPC contract, not success with arbitrary subscriptions.
* Positive: optional controlled synthetic read-only local test provider / isolated OpenCode instance if supported by published runtime, with no production keys and never a real model request. Do not risk a user profile to obtain a positive case.
* Fail closed on unexpected command errors, timeouts, inconsistent metadata or partial stdout. Keep diagnostic category only, not raw output, in evidence.

## Plan / acceptance
* Inspect current source, pinned assets, command time budgets and competing PRs; implement narrow script/test/workflow.
* Capture evidence on Linux and Windows with pinned artifacts; no reliance on provider secrets.
* Run unit tests, lint, full CI, native Electron E2E where relevant, CodeQL, 2 reviewer passes, address findings, then merge and post-merge validate.
* Remaining live-account requirement: dedicated ephemeral accounts supplied to a test environment; never infer this passed without them.

## Change budget
Target 200–450 lines including runner, pure tests, CI job. Keep no production-code modification unless real CLI evidence demonstrates a defect.
