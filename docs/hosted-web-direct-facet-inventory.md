# Direct feature facets before the Hosted foundation ratchet

Source: PR #252 `be0eae4292da2ff40e311a79b07262ba5194fcd7`, plus the F0 `team-task-board/renderer/hosted.ts` candidate in this checkpoint. This is a source inventory, not a list of confirmed architecture violations. The current cross-feature import rule admits exact `main/hosted`, `main/composition`, and `renderer/hosted` files. The public export classifier previously inspected only `index` entrypoints.

| Facet family | Existing files | Direct re-export declarations | Paths through `adapters/`, `infrastructure/`, or `composition/` |
|---|---:|---:|---:|
| `main/hosted.ts` | 15 | 82 | 51 |
| `main/composition.ts` | 4 | 6 | 6 |
| `renderer/hosted.ts` | 1 existing + 1 F0 candidate | 7 | 1 |
| **Total with F0 candidate** | **21** | **95** | **58** |

The third count is a triage signal only. A composition factory may be a legitimate public surface; an indirect import can still contain a forbidden concrete boundary even when its path does not contain these words. A global direct-facet classifier change therefore needs resolved export-origin analysis and cannot be justified from these counts alone.

| Facet | Candidate paths to inspect | Current decision |
|---|---:|---|
| `coordination-events/main/hosted` | 1 | Later main-facet ratchet |
| `external-writer-coordination/main/hosted` | 1 | Later main-facet ratchet |
| `hosted-operations/main/hosted` | 4 | Later main-facet ratchet |
| `hosted-producer-provenance/main/hosted` | 0 | Later main-facet ratchet |
| `hosted-query-context/main/hosted` | 1 | Later main-facet ratchet |
| `hosted-readiness/main/hosted` | 3 | Later main-facet ratchet |
| `hosted-state-compatibility/main/hosted` | 0 | Later main-facet ratchet |
| `internal-storage/main/hosted` | 3 | Later main-facet ratchet |
| `member-log-stream/main/hosted` | 2 | Later main-facet ratchet |
| `team-approvals/main/hosted` | 13 | Deferred approval path; later main-facet ratchet |
| `team-configuration/main/hosted` | 7 | Later main-facet ratchet |
| `team-lifecycle/main/hosted` | 3 | Later main-facet ratchet |
| `team-message-delivery/main/hosted` | 6 | Later main-facet ratchet |
| `team-task-board/main/hosted` | 6 | Later main-facet ratchet |
| `workspace-registry/main/hosted` | 1 | Later main-facet ratchet |
| `internal-storage/main/composition` | 2 | Later main-facet ratchet |
| `member-log-stream/main/composition` | 2 | Later main-facet ratchet |
| `member-work-sync/main/composition` | 1 | Later main-facet ratchet |
| `organizations/main/composition` | 1 | Later main-facet ratchet |
| `member-log-stream/renderer/hosted` | 0 | Included in F0 renderer-facet check |
| `team-task-board/renderer/hosted` | 1 | Included in F0 renderer-facet check; browser consumes this exact surface |

F0 enables the existing public export classifier for `renderer/hosted` as a facet family, verifies both renderer facets and the actual browser graph, and removes only the task-board Vite substitution. `main/hosted` and `main/composition` remain accepted cross-feature entrypoints without the new public-export ratchet in this checkpoint. This is an explicit enforcement gap, not a claim that those facets are clean.

F0b, if a later accepted consumer needs it, begins with a resolved-origin violation report for the 19 main facets, splits legitimate feature factories from concrete adapters, and migrates only the required public contracts. A provisional planning envelope is **1,500-3,500 changed LOC / 20-45 human hours, confidence 3/10**; it is outside the F0/F1/F2/D1/N1 budget and must be replaced with an exact inventory before scheduling. Do not expand the legacy baseline or rename a file to hide a concrete export.
