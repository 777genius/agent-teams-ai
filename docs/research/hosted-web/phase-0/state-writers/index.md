# Phase 0 W3 — State, External Writers, and Backup

Phase start `a32f509e6d9bd31ba2135940e336729bf90c3d93` was verified before edits. This
lane characterizes current state; it does not implement hosted mutation or replace the legacy backup.
All executable evidence uses marker-owned directories below the operating-system temporary root.

## Evidence index

| Evidence ID                        | Authority                                                            | Result                                                                                                                 | Proof level             |
| ---------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `P0.W3.STATE_FAMILY_CATALOG`       | `state-family-catalog.json`                                          | 17 families: 16 current/fallback and one Phase 1-required identity/lifecycle family                                    | `source_observed`       |
| `P0.W3.WRITER_COORDINATION`        | `writer-coordination.json`                                           | 12 mutation/backup operations classified; six writer identities remain unresolved                                      | `fixture_characterized` |
| `P0.W3.SCHEMA_UNKNOWN_FIELDS`      | `schema-unknown-fields.json`                                         | CLI JSON must preserve unknowns; app projections need version/refuse policy; SQLite future-version writes remain a gap | `source_observed`       |
| `P0.W3.BACKUP_BEHAVIOR`            | `backup-behavior.json`, `team-backup-service-faults.test.mjs`        | 12 fault cases construct production `TeamBackupService`; it remains `legacy_unverified`, not a recovery point          | `fixture_characterized` |
| `P0.W3.SQLITE_ONLINE_BACKUP_SPIKE` | `sqlite-online-backup-results.json`, `sqlite-online-backup-spike.md` | WAL-active online backup, independent reopen, BUSY/corrupt/deadline fail-closed behavior                               | `fixture_characterized` |
| `P0.W3.ESTIMATE`                   | `estimate-input.json`                                                | 4.5k–7.25k changed lines if shared W5 workflow is counted once                                                         | `source_observed`       |

The catalog's unresolved-writer count is eight because two grouped runtime/transcript families and the
future identity family also name unknown owners. The handoff reports six actionable external writer
identities after collapsing those catalog details into controller decisions.

## Findings that constrain Phase 1

1. `TeamTaskWriter`'s promise lock is process-local. The negative child-process fixture deterministically
   overwrites the external update after the app's stale read. Atomic rename prevents torn bytes, not lost
   updates.
2. No source evidence proves that Claude-native task/config/inbox writers share the app's locks. Those
   active-run direct mutations are `quiescent-only`, not cooperative.
3. OpenCode inbox delivery is provider-mediated and has useful ledgers, but transport delivery is not a
   semantic mutation acknowledgement. The exact user-inbox reply writer remains unresolved.
4. `TeamKanbanManager` performs unlocked read-modify-write and rewrites a sanitized projection. It becomes
   app-exclusive only after the controller lease, per-team coordinator, and expected revision exist.
5. Launch state and summary are two sequential replacements. The boundary is process-local and its
   written-run guard disappears on restart, so neither pairwise atomicity nor hosted exclusivity is proven.
6. Internal storage is a single worker connection in WAL mode at `user_version=3`. A future
   `user_version` is currently opened without closing known-table mutation, leaving ADR-23 implementation
   open.
7. The marker-owned production-service fixture exercises 12 cases across config readiness, matching
   async/sync enumeration, copy/enumeration errors, stale and retention pruning, identity mutation,
   split manifest/registry publication, corrupt-registry rebuild, shutdown error swallowing, and
   missing/corrupt/partial/mtime restore. The observed partial states confirm that `TeamBackupService`
   remains `legacy_unverified`; its mutex still does not fence an external provider writer.
8. `better-sqlite3#backup` is sufficient for the SQLite participant. The Phase 1 worker operation must be
   async/awaited, have its own bounded deadline/progress cancellation, reopen/integrity-check the result,
   and have no raw DB/WAL/SHM or checkpoint fallback.

## ADR recommendations

- ADR-23: retain/accept the machine-readable compatibility design, but keep implementation open. Add a
  negative fixture that proves a future `user_version` cannot mutate known tables.
- ADR-24: retain. Generic file observations stay team-scoped `ExternalFileActor`; unresolved paths cannot
  acquire a current RunId from UI selection, mtime, or claimed JSON fields.
- ADR-29: accept. Freeze the per-operation matrix. Any uncharacterized provider/version defaults to
  `uncoordinated_external`; Claude config/task/native-inbox direct active writes remain unavailable.
- ADR-32: accept with two products. The spike closes only Online Backup API feasibility. Full
  `deployment_recovery_point` remains gated on W4 process drain, ADR-24 watermark closure, participant
  manifests, immutable publication, credential exclusions, and final-image ABI proof.

## Uncertainty and integration dependencies

No real provider was launched and no user state was inspected. W2 must supply sanitized provider/version
fixtures and runtime topology before the unresolved writer rows can be narrowed. W4 supplies the hosted
lease and proven process drain. W5 owns shared durable command/BackupRun/event orchestration, so its lines
must not be counted again in W3. W6/integration must repeat the SQLite probe against the final packaged
Node ABI/addon in the supported container image.

There is no lane-local blocker. The unresolved items are explicit Phase 1 admission gates rather than a
reason to weaken the writer or backup contract.
