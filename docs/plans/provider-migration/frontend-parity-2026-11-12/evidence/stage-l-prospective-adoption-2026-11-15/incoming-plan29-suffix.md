
## Original pending-CREATE observation after Stop

At `27b1acf48278dcd0fb348c626696eac2dc64de73`, original ARM64
[job132984523065](https://github.com/777genius/agent-teams-ai/actions/runs/43770293297/job/132984523065)
passes CMake/link and the original service, service-pair, I386-root and
root-first scenarios. It then fails the pending-CREATE scenario because a
post-dispatch query reuses the warm-scope `activeProcesses > 0` assertion.
The original query has matching key/birth, zero query/dispatch errors and
zero active Job processes; rootExited was not retained in the old failure
record, so this does not establish an early Stop ACK or native PASS.
Artifact14184765230 is15521 bytes, SHA-256
`5b1e4ddc8988dca12e90842b144a5f0cb7e2a72ad66ab04c1e75343f3294031f`.

The bounded TEST-only correction keeps the warm query assertion and uses the
existing completion predicate for this one observation after TerminateJobObject:
the original root HANDLE must still be unsignalled or the original Job active.
Root-exited plus Job-empty still fails. The C++ barrier uses the same existing
`absent` predicate. One bounded record retains both original query facts before
the assertion. Single Stop, pending reply, Settle and registration refusals,
no-child-effect, final original HANDLE absence and all deadlines remain intact.
Product custody, actors and workflow gates are unchanged. R1 and R2 reviewed
the exact two-file correction; resulting-source Windows execution is required.
