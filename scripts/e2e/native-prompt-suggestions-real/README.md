# Native prompt suggestions: real Claude / Codex proof

Local, on-demand proof that the native next-message suggestions work with the **real vendors on
your own subscription**. CI covers the same flow with deterministic fake vendors; this is the
check you run before trusting a vendor upgrade or a suggestion-related change.

```bash
pnpm test:real:suggestions                 # Claude + Codex in parallel, through the captured Host
pnpm test:real:suggestions -- --vendor codex
pnpm test:real:suggestions:ui              # live Electron app (dev:mcp), Claude
pnpm test:real:suggestions:ui -- --vendor all
pnpm test:real:suggestions:ui -- --shipped-default   # config has no setting: the app's own default must apply
pnpm test:real:suggestions:ui -- --provider-off       # setting off: nothing may be offered (negative proof)
```

## What is proven

Host level (`packages/legacy-agent-host/tests/native-prompt-suggestions-real.real.ts`):

- a human DM gets a suggestion bound to that exact delivered input, with only the public notice fields;
- the read-only `nativePromptProof` is current for the owner, and rejected when forged or presented by another member;
- no suggestion appears for a message the run did not send;
- stop/close are clean, no vendor process outlives the Host, credential copies are untouched.

Desktop level (`ui.ts`): in the real app, with physical CDP key events, `Tab` inserts the suggestion,
`Escape` dismisses it, the `Insert` button inserts it, and **no suggestion ever sends a message**.

## Autonomous goal canary

The same disposable-process and credential-cleanup runner can execute the separate goal qualification:

```bash
pnpm test:real:suggestions -- --scenario autonomous-goal --vendor codex --preflight
pnpm test:real:suggestions -- --scenario autonomous-goal --vendor codex --strict
```

Select one provider per invocation (`claude` or the captured Codex `0.169.0` executable) and run with
the pinned Host Node `v24.21.0`. Preflight performs the existing binary, account-status and free-disk
checks only. It exits `3`, or `1` with `--strict`, and never qualifies inference.

`packages/legacy-agent-host/tests/autonomous-goal-real.real.ts` sends one actual human goal in Do
mode to a real lead and worker. The worker must leave its task in progress after writing a draft,
then finish the file on a genuine automatic continuation. The lead is instructed to verify the
result and must propose the final answer. The harness independently checks the final JSON
arithmetic and exact final publication, original Runtime input/operation identities, settled turns,
canonical continuation receipts and passive-read attempt counts. A separate second objective
exercises Stop during an actual worker input and rejects new automatic claims or final publication
afterward. Each objective is bounded to one elapsed hour; the productive objective allows eight
automatic attempts and the separate Stop objective allows four, twelve total in this invocation.
The earlier failed qualification conservatively retains its original twelve-attempt allowance;
its unknown effects are not refunded by a fresh TEST run.
The canary has a fifteen-minute test timeout and a separate sixteen-minute outer process deadline;
a stuck child is terminated as part of owned process-group cleanup. A nonzero test exit, signal,
timeout or failed cleanup cannot produce a passing goal receipt.
Failure receipts retain the original failing phase/reason separately from cleanup errors,
bounded public Host/open facts and original Runtime/goal/debit records. A bounded redacted
diagnostic log is saved beside the receipt before the runner removes its temporary tree.
Missing observations or unavailable records do not establish zero provider effects or released custody.

Receipts record source/dist/test/Node/binary hashes, actual provider and platform, and separate
productive-success and Stop outcomes. This uses real inference; the ordinary controlled-provider
tests and scripted native model servers are separate evidence. A short passing canary does not
establish the plan's separate six-to-eight-hour unattended qualification, Desktop controls, Delegate
mode or any provider/platform tuple that was not actually run. No goal-specific live result is
claimed merely because this harness exists.

## Outcomes and exit codes

| Exit | Meaning                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 0    | **pass** - proven                                                                                      |
| 1    | **fail** - the Host/app broke the contract, a process leaked, or the runner itself crashed              |
| 3    | **inconclusive** - nothing to judge: quota/login/binary problem, or the vendor produced no suggestion    |

Inconclusive is never green and never a regression. Add `--strict` to make it fail (Host runner).
Receipts are written to `~/.cache/agent-teams-real-e2e/` (last 40 kept; UI also stores screenshots).

## Vendor facts the runner already accounts for

- **Claude** often withholds a suggestion on a session's first turn (it depends on prompt-cache state, so
  a warm account can offer one immediately) and needs that cache, so the runner uses
  Sonnet, the full `claude_code` preset and read-only tools (Haiku or `tools: []` never suggests).
  Keychain auth needs `HOME`/`USER`/`LOGNAME`, so Claude runs against your real config directory
  in a temporary workspace. It stops after the first suggestion per member.
- **Codex** needs `>= 0.169.0` (`thread/sample`); 0.162 reports it unsupported. Suggestions are
  probabilistic (roughly 4 of 5 eligible turns), so the runner keeps asking up to `--rounds` turns.
  Each member gets an isolated `CODEX_HOME` with a **copy** of `~/.codex/auth.json`, deleted afterwards.
  Point at a newer binary with `REAL_CODEX_BIN`. A refreshed credential copy is reported as a warning.
- **Claude gates suggestions behind its own rollout flag**, which is account- and time-dependent. In one
  session the same Sonnet setup offered a suggestion on every first turn, then went silent for 20+ minutes;
  setting `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true` made them arrive at once again. The captured Host
  therefore adds that variable to the launch environment of every Claude member whose provider setting is
  on (`ClaudeMemberProvider`), and this proof relies on that mechanism: it sets nothing itself. If it ever
  goes silent while the Host is healthy, check that the variable is still in the child's environment.
- **The weakest Claude model (Haiku) offered nothing even with that flag forced** (0 of 7 turns across two
  runs), while Sonnet offered one on its first turn. So the model matters too: on Haiku the row never
  appears, which is the vendor not producing a suggestion, not a UI fault. (Measured here, not documented
  by Anthropic; the effort level was not isolated.)
- The composer row also needs the member's `hostMemberId`, which the renderer only learns from
  `team.roster.read`. If that read answers `hold`, the notice reaches the renderer but **no row is ever
  drawn**, and the only trace is the warning "Saved launch settings are unavailable". The Desktop proof
  therefore refuses to run when `better-sqlite3` is not built for Electron
  (`pnpm install --ignore-scripts`; fix with `node scripts/postinstall-electron.cjs`).
- `runtime.open` of a cold native session occasionally reports `open-unknown`; the suggestions runner retries once and
  records every attempt (`openAttempts` in its receipt). The goal canary does not retry an unknown original open.

## Environment

| Variable                                | Purpose                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `REAL_CLAUDE_BIN`, `REAL_CODEX_BIN`       | executable override (default: first on `PATH`)                                  |
| `REAL_CLAUDE_MODEL`, `REAL_CODEX_MODEL`   | model override (defaults: `claude-sonnet-4-6`, your Codex `config.toml` model)    |
| `REAL_CLAUDE_NATURAL_SUGGESTIONS`         | `1` = do not force Claude's suggestion flag                                     |
| `REAL_RECEIPT_DIR`                      | receipts directory                                                             |
| `PNPM_ENTRY`                            | Corepack `dist/pnpm.js` for the Desktop proof if not next to the running Node    |

Requirements: Node >= 24 (the Desktop proof needs exactly v24.21.0 on darwin-arm64), `pnpm install`
done, >= 1.5 GiB free disk. The Desktop proof needs the app dependencies installed at the repo root with
their native modules built (a plain `pnpm install`, not `--ignore-scripts`).

## Safety

- The runner removes its work directory (credential copies) on exit and on SIGINT/SIGTERM/SIGHUP.
- The original `~/.codex/auth.json` is never written; its hash is compared before/after.
- Suggestion prompts use harmless trivia. The goal canary writes small JSON files inside its disposable
  workspace. Both use the selected vendor's existing account; neither performs a new login.
