# Phase 0 decision register

## Scope

This register contains only decisions established or narrowed by Phase 0A. It is not the Phase 0
freeze register. W1-W6 evidence and reciprocal reviews must add the remaining architecture outcomes
before 0D; no unevaluated question is presented here as accepted.

| Decision ID | Question | Source evidence | Options | Outcome | Confidence | Affected capabilities / ADRs | Owner | State |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `P0.D.BASE_PIN` | What immutable repository base governs Phase 0? | Canonical remote ref, prepared-state record, Git ancestry | Moving branch; pinned SHA | Pin `cbe501ad0f1fa0e51a038e832ad35fce4120321b`; later remote movement requires explicit impact/rebase review. | high | All Phase 0 evidence | Integration controller | `accepted` |
| `P0.D.PLAN_ADOPTION` | Which plan commit is executable on the implementation ancestry? | Source `16c156db8`; reviewed integration attempt; adopted `f1ad7a8c`; identical hashes | Read out-of-tree source; adopt content-equivalent bundle | Treat `16c156db8a85e75a6b679f6919e1013af74fb112` as source provenance and `f1ad7a8cba2f26abf5f42ddd206937c24d143f77` as authoritative in-branch plan bundle. | high | Packet `phase-00-r2`; all ADRs | Integration controller | `accepted` |
| `P0.D.BASELINE_FAILURES` | Does the broad gate failure block evidence work or authorize product changes? | `baseline.md`; hashed `check:ci` log; base/current path identity | Block all work; ignore; isolate narrow base fixes | Classify two records/five errors as `base_owned_fix`; no `unknown` failure exists. Adopt fixes independently and rerun before dependent admission. | high | Phase 0 admission | Integration controller / named prerequisite jobs | `narrowed` |
| `P0.D.PHASE_START` | How is a self-referential evidence commit represented? | Git content-addressing; packet requirement that lanes start at the evidence commit | Embed current head; rewrite after commit; external resolution | Store `phaseStartSha: null` in the self-containing evidence, then make the controller's immutable integration-attempt commit record authoritative and inject that SHA into lane jobs/prompts. | high | All W1-W6 lane identity and deduplication | Integration controller | `accepted` |
| `P0.D.PREWARM` | May clean Phase 0 jobs use subscription prewarm after the v1 incident? | v1 job: 22 attempts and prewarm failure; v2 manifest | Retry prewarm; disable prewarm | Clean v2 jobs use `prewarmOnStart=false`; the incident is orchestration evidence, not a repository failure. | high | Controller/job launch policy | Broker-only controller | `narrowed` |
| `P0.D.CAPACITY` | May the generic capacity controller refill W1-W6 before a phase start exists? | Capacity config; lane ledger; packet 0A.5 | Target six now; remain dry-run/zero | Keep `desiredWorkers=0`, `dryRun=true`, and all six slots `unstarted` until the external `phaseStartSha` and exact lane requests exist. | high | Worker admission and deduplication | Broker-only controller | `accepted` |
| `P0.D.TERMINAL_V1` | Does 0A add or estimate hosted terminal work in v1? | Parent plan; packet non-goals; estimate ledger | Include; exclude | Hosted terminal remains absent from v1 and contributes zero v1 implementation/packaging lines; only later absence evidence is permitted. | high | ADR-10/35; v1 artifact/capabilities | Phase controller | `accepted` |

## Decisions still requiring lane evidence

The following freeze areas intentionally have no 0A outcome: exact parity/actions and contract facets;
identity authority; provider/runtime-ingress topology; state/external-writer classes; child environment
exposure; lease/guard/process feasibility; snapshot/event and command/effect recovery; auth/proxy
schedules; artifact/ABI/backup feasibility; and the evidence-backed final estimate. Their owners and
acceptance criteria remain in the six `phase-00-r2` lane packets.
