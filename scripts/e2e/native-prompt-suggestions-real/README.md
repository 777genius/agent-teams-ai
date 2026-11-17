# Native prompt suggestions: real Claude / Codex proof

Local, on-demand proof that the native next-message suggestions work with the **real vendors on
your own subscription**. CI covers the same flow with deterministic fake vendors; this is the
check you run before trusting a vendor upgrade or a suggestion-related change.

```bash
pnpm test:real:suggestions                 # Claude + Codex in parallel, through the captured Host
pnpm test:real:suggestions -- --vendor codex
pnpm test:real:suggestions:ui              # live Electron app (dev:mcp), Claude
pnpm test:real:suggestions:ui -- --vendor all
```

## What is proven

Host level (`packages/legacy-agent-host/tests/native-prompt-suggestions-real.real.ts`):

- a human DM gets a suggestion bound to that exact delivered input, with only the public notice fields;
- the read-only `nativePromptProof` is current for the owner, and rejected when forged or presented by another member;
- no suggestion appears for a message the run did not send;
- stop/close are clean, no vendor process outlives the Host, credential copies are untouched.

Desktop level (`ui.ts`): in the real app, with physical CDP key events, `Tab` inserts the suggestion,
`Escape` dismisses it, the `Insert` button inserts it, and **no suggestion ever sends a message**.

## Outcomes and exit codes

| Exit | Meaning                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 0    | **pass** - proven                                                                                     |
| 1    | **fail** - the Host/app broke the contract, a process leaked, or the runner itself crashed            |
| 3    | **inconclusive** - nothing to judge: quota/login/binary problem, or the vendor produced no suggestion |

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
- **The weakest Claude model (Haiku) produced no suggestions** in the Host-level proof (0 of 4 turns, with
  tools), while Sonnet offered one on its first turn. So on Haiku the composer row never appears; that is
  the vendor not offering one, not a UI fault. Use Sonnet or stronger to see the feature. (Measured here,
  not documented by Anthropic; the effort level was not isolated.)
- The composer row also needs the member's `hostMemberId`, which the renderer only learns from
  `team.roster.read`. If that read answers `hold`, the notice reaches the renderer but **no row is ever
  drawn**, and the only trace is the warning "Saved launch settings are unavailable". The Desktop proof
  therefore refuses to run when `better-sqlite3` is not built for Electron
  (`pnpm install --ignore-scripts`; fix with `node scripts/postinstall-electron.cjs`).
- `runtime.open` of a cold native session occasionally reports `open-unknown`; the runner retries once and
  records every attempt (`openAttempts` in the receipt), so the flake rate stays visible.

## Environment

| Variable                                | Purpose                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `REAL_CLAUDE_BIN`, `REAL_CODEX_BIN`     | executable override (default: first on `PATH`)                                 |
| `REAL_CLAUDE_MODEL`, `REAL_CODEX_MODEL` | model override (defaults: `claude-sonnet-4-6`, your Codex `config.toml` model) |
| `REAL_RECEIPT_DIR`                      | receipts directory                                                             |
| `PNPM_ENTRY`                            | Corepack `dist/pnpm.js` for the Desktop proof if not next to the running Node  |

Requirements: Node >= 24 (the Desktop proof needs exactly v24.21.0 on darwin-arm64), `pnpm install`
done, >= 1.5 GiB free disk. The Desktop proof needs the app dependencies installed at the repo root with
their native modules built (a plain `pnpm install`, not `--ignore-scripts`).

## Safety

- The runner removes its work directory (credential copies) on exit and on SIGINT/SIGTERM/SIGHUP.
- The original `~/.codex/auth.json` is never written; its hash is compared before/after.
- Prompts are fixed, harmless trivia; nothing leaves your machine except the vendor calls themselves.
