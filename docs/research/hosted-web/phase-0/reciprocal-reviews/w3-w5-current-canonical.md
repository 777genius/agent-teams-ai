# Phase 0 W3/W5 current canonical reciprocal compatibility review

- Review time: `2026-07-11T21:05:00Z`
- Canonical review HEAD / adopted W5 commit: `ffaecae3fc70a42df1ac49c65469f84515ea5ed8`
- Adopted W3 commit: `7f23e7b628b09e8fbed71c914af5e665f14dab25`
- W3 ancestry: `7f23e7b...` is an ancestor of `ffaecae3...`
- Review scope: the already adopted W3 and W5 outputs at canonical HEAD; no producer output was
  regenerated or edited
- Disposition: **reciprocally compatible within the Phase 0 r3 evidence-only boundary**

This is the current canonical review of the adopted pair. The older
[`w3-w5.md`](./w3-w5.md) remains the historical remediation review and is not the disposition for the
adopted W5 commit.

## Phase 0 r3 narrowing

The current lane artifacts retain their `phase-00-r2` provenance. This review applies the controller's
Phase 0 r3 narrowing without rewriting those adopted artifacts:

- W3 proves only that `better-sqlite3#backup` is feasible with an active WAL on the exercised current
  Linux Node ABI and that the production `TeamBackupService` has been fault-characterized as a
  `legacy_unverified safety copy`.
- W3 does **not** prove or provide hosted backup, hosted restore, a deployment recovery point, coordinated
  recovery, final packaged Electron/container ABI compatibility, production worker wiring, writer drain,
  watcher-watermark closure, immutable recovery-point publication, or credential/keyring preservation.
- W5's recovery model does not promote W3's feasibility or characterization into a hosted capability.
  All 101 W5 effects remain fail closed: 50 are `operator_required_until_transaction_exists` and 51 are
  `operator_required`.
- W3 and W5 estimates remain overlapping decompositions of `EST-RECOVERY-STATE`; they must not be added.

Accordingly, compatibility here means that W5 consumes W3's writer truth without contradiction or
capability inflation. It is not a Phase 1 admission, production recovery claim, or hosted backup signoff.

## Reciprocal findings

### W5 against W3

Pass. W5 explicitly binds
`docs/research/hosted-web/phase-0/state-writers/writer-coordination.json` as its integrated W3 authority.
Every one of the 101 generated effects references `P0.W3.WRITER_COORDINATION` (50 through the future
`sqlite.mutate` seam and 51 through the general writer authority), and no effect has
`automaticRecoveryAdmitted=true`. Current uncoordinated task, inbox, provider, process, Git, review and
runtime effects therefore remain operator-gated.

The W5 focused suite also passes its actual fresh-process proof: seven tests, including 52 two-process
effect-recovery schedules, the independent 114-member source census and omission controls, schema checks,
snapshot schedules and immutable fingerprint oracles.

### W3 against W5

Pass under r3 narrowing. No W3-owned output changed between the W3 adoption commit and canonical HEAD.
The current production backup service classification remains `legacy_unverified safety copy`; all 12
fault-matrix rows have `recoveryPointSafe=false`. The WAL spike remains `executable-spike` evidence with
an explicit limitation that it is not final packaged Electron/container proof.

W3's estimate says W5 owns the shared workflow once. W5 uses the same `EST-RECOVERY-STATE` bucket and
explicitly says not to sum W3's shared transaction/storage fixtures twice. There is no reciprocal estimate
contradiction.

## Commands and results

All commands were read-only with respect to repository content. Executable fixtures used only
marker-owned operating-system temporary directories. The review worktree intentionally had no local
`node_modules`; W3 commands used the dependency-materialized canonical integration checkout's dependency
tree while executing this worktree's sources. W5's ESM TypeScript census was run in that clean integration
checkout, whose HEAD was independently verified as the same canonical SHA.

| Command | Exit | Result |
| --- | ---: | --- |
| `git rev-parse HEAD` | 0 | `ffaecae3fc70a42df1ac49c65469f84515ea5ed8` |
| `git merge-base --is-ancestor 7f23e7b628b09e8fbed71c914af5e665f14dab25 ffaecae3fc70a42df1ac49c65469f84515ea5ed8` | 0 | W3 is an ancestor of W5/current HEAD |
| `git diff --quiet 7f23e7b628b09e8fbed71c914af5e665f14dab25 ffaecae3fc70a42df1ac49c65469f84515ea5ed8 -- .codex-handoff/phase-00-w3.json docs/research/hosted-web/phase-0/state-writers scripts/hosted-web/phase-0/state-writers test/architecture/hosted-web/phase-0/state-writers` | 0 | no adopted W3 output changed after W3 adoption |
| `NODE_PATH="$DEPS" node --import "$DEPS/tsx/dist/loader.mjs" test/architecture/hosted-web/phase-0/state-writers/team-backup-service-faults.test.mjs` | 0 | 7 tests passed; TB-01 through TB-12 characterized |
| `NODE_PATH="$DEPS" node scripts/hosted-web/phase-0/state-writers/sqlite-online-backup-spike.mjs` | 0 | WAL active; 2,000 independently reopened rows; `integrity_check=ok` |
| `NODE_PATH="$DEPS" node scripts/hosted-web/phase-0/state-writers/external-writer-negative-fixture.mjs` | 0 | `lostExternalUpdate=true` |
| `NODE_PATH="$DEPS" node scripts/hosted-web/phase-0/state-writers/verify-evidence.mjs` | 0 | 6 evidence files, 17 families and 12 operations verified |
| `NODE_PATH="$DEPS" node --test test/architecture/hosted-web/phase-0/state-writers/state-writers.test.mjs` | 0 | focused W3 architecture test passed |
| `(cd /var/data/agent-teams-hosted-web-refactor/worktrees/integration-hosted-web-feature-boundaries && git status --short && git rev-parse HEAD && node scripts/hosted-web/phase-0/recovery-events/generate-evidence.mjs --check)` | 0 | clean checkout at `ffaecae3...`; 9 W5 evidence files verified fresh |
| `(cd /var/data/agent-teams-hosted-web-refactor/worktrees/integration-hosted-web-feature-boundaries && node test/architecture/hosted-web/phase-0/recovery-events/recovery-events.test.mjs)` | 0 | 7 tests passed, including 52 two-process recovery schedules and omission controls |
| read-only compatibility assertion below | 0 | 101/101 W5 effects bind W3 authority; 0 admit automatic recovery; legacy and estimate boundaries preserved |

For the W3 commands, the exact dependency variable was:

```bash
DEPS=/var/data/agent-teams-hosted-web-refactor/worktrees/integration-hosted-web-feature-boundaries/node_modules
```

The read-only compatibility assertion was:

```bash
node - <<'NODE'
const fs = require('fs')
const read = (path) => JSON.parse(fs.readFileSync(path, 'utf8'))
const w3Handoff = read('.codex-handoff/phase-00-w3.json')
const w5Handoff = read('.codex-handoff/phase-00-w5.json')
const backup = read('docs/research/hosted-web/phase-0/state-writers/backup-behavior.json')
const wal = read('docs/research/hosted-web/phase-0/state-writers/sqlite-online-backup-results.json')
const w3Estimate = read('docs/research/hosted-web/phase-0/state-writers/estimate-input.json')
const effects = read('docs/research/hosted-web/phase-0/recovery-events/effect-recovery-matrix.json').effects
const w5Estimate = read('docs/research/hosted-web/phase-0/recovery-events/estimate-input.json')
const assert = (condition, message) => { if (!condition) throw new Error(message) }
assert(w3Handoff.status === 'ready_for_focused_re_review', 'unexpected W3 handoff state')
assert(w5Handoff.status === 'remediated_pending_reciprocal_review', 'unexpected W5 handoff state')
assert(w5Handoff.integratedW3Authority?.path === 'docs/research/hosted-web/phase-0/state-writers/writer-coordination.json', 'W5 does not bind adopted W3 writer authority')
assert(w5Handoff.integratedW3Authority?.preserved === true, 'W5 does not preserve W3 authority')
assert(effects.length === 101, 'unexpected W5 effect count')
assert(effects.every((effect) => effect.automaticRecoveryAdmitted === false), 'W5 promotes an effect beyond W3 proof')
assert(effects.every((effect) => effect.writerEvidenceRef.startsWith('P0.W3.WRITER_COORDINATION')), 'W5 effect lacks W3 writer evidence reference')
assert(backup.currentService?.classification === 'legacy_unverified safety copy', 'legacy backup overclaimed')
assert(backup.faultMatrix.every((row) => row.recoveryPointSafe === false), 'legacy backup fault row overclaims recovery safety')
assert(wal.proofLevel === 'executable-spike', 'WAL proof level changed')
assert(wal.limitations.some((item) => item.includes('not the final packaged Electron ABI or final container image')), 'WAL final-artifact limitation missing')
assert(w3Estimate.parentBucketFit.includes('W5 owns shared'), 'W3 estimate overlap rule missing')
assert(w5Estimate.bucketId === 'EST-RECOVERY-STATE', 'W5 estimate bucket changed')
assert(w5Estimate.overlap.some((item) => item.includes('do not sum')), 'W5 estimate deduplication rule missing')
console.log(JSON.stringify({ w5Effects: effects.length, automaticRecoveryAdmitted: 0, compatible: true }))
NODE
```

Initial direct invocations without the dependency path failed with `ERR_MODULE_NOT_FOUND` for `tsx`,
`better-sqlite3` and ESM `typescript`. Those were environment-only attempts before the successful commands
above; they did not contradict the evidence and did not modify the worktree.

## Compatibility disposition

**Accept the adopted W3/W5 pair as current Phase 0 reciprocal evidence.** W5 closes the historical
fresh-process, source-census, handoff and whitespace findings while preserving W3's fail-closed writer
authority. W3 remains limited to current-ABI WAL Online Backup feasibility plus legacy service
characterization. No hosted backup or recovery capability may be inferred from this acceptance.

No W3/W5 lane evidence, handoff, controller ledger, Phase 0 index, decision/estimate ledger, Phase 1
packet, production source, terminal implementation or other project was changed by this review.
