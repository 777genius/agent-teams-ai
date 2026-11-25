# Work-sync storage preparation

`BackendSelectingMemberWorkSyncStore` owns the admitted per-team replica mutex.
Its key is the normalized team name, so case and whitespace aliases cannot
interleave preparation with publication. Report-journal reads and mutations
use this same fence because their SQLite `ready()` callback can import data.

`memberWorkSyncColdPreparation.ts` validates the captured replica, canonical
rows, active JSON and any unconsumed archives before writing a dirty fence.
Only then may it import, verify and prime the exact importer used by the
public action. The action starts with a bare dirty fence; recovery never
replays a previous action or claim.

## Primary incarnation

The internal-storage gateway stores one `member_work_sync_primary_incarnations`
row per normalized team in the same database as the work-sync rows. A bound
import changes this ownership and the complete team snapshot in one transaction.
A different existing owner is refused. An ordinary unbound import cannot erase
the owner; only lifecycle purge uses the explicit reset operation.

Lifecycle preparation may establish an owner for an empty team. Older databases
may also migrate an already validated bound **clean** publication, or the
existing independent proof from nonempty canonical statuses that all carry the
same incarnation. A bare dirty empty snapshot cannot establish ownership.
Dirty recovery requires healthy actual database integrity; empty recovery also
requires the matching durable owner. Unbound, foreign and malformed evidence
does not qualify.

## Interrupted imports

The dirty candidate retains all validated incoming records. It is evidence for
authority preparation and is not general permission to replay an import.
On an import error, recovery waits for physical worker settlement when required,
checks actual database integrity and the captured replica binding, then compares
all primary rows and the owner. An exact committed result can publish clean; an
exact preimage can restore the original clean input without losing replica-only
records. Other outcomes retain dirty evidence. The original error is always
returned, even when recovery succeeds.

The focused integration coverage is in
`test/features/member-work-sync/main/MemberWorkSyncPreparedBackend.test.ts`.
Historical SQLite upgrade coverage is in
`test/features/internal-storage/InternalStorageMigrations.workSyncOwnership.test.ts`.
