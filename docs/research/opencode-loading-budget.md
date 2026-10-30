# OpenCode slow-system loading budget

The runtime read host used one 30-second budget for graph verification and server
startup. A Windows report measured 21–24 seconds of verification plus about 23
seconds of startup. The runtime companion changes cold/catalog loading to one
180-second budget, respecting the original caller deadline and cancellation.

The desktop Settings CLI previously stopped after 90 seconds and the UI after
70 seconds, so changing only the runtime could not fix slow loading end to end.
Use shared browser-safe constants: 180 seconds for cold startup, 300 seconds for
the provider CLI (preserving the existing 240-second scoped catalog lease plus
owned cleanup), and 330 seconds for the outer UI wait. Clearing a project default
uses the same UI allowance because it refreshes the catalog. Explicit OAuth,
model-probe, Stop, cache and shorter caller budgets retain their own semantics.

The default V1 launch bridge gets 180 seconds; the already-longer V2, local-model
and serial subscription startup allowances are preserved. No provider result is
made successful by waiting longer, and no integrity/authentication guard is removed.

Validation covers actual CLI option propagation and UI virtual-time behavior,
including explicit shorter overrides and immediate errors. Native runtime tests
and Windows packaged CI remain required. This source patch alone does not change
the immutable public runtime 0.0.147; a new qualified runtime release and exact
manifest/lock update are required to deliver the runtime fix to packaged users.
