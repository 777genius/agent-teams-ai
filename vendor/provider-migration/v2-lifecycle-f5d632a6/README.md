# Checked provider archives for bounded V2 lifecycle cleanup

This paired implementation and Session SPI selection comes from provider commit
`f5d632a6122df2f6995451bd33e6a0fbcda67680` (tree
`716c54386d6b62567009a737cf963d1a8a744031`). Both archives are the exact bytes
installed and tested by the producer repository's original packed-consumer test.
They were copied here without editing or repacking.

The source is a descendant of the previously selected `9423f600`, `c79b81bf`
and `c930d3c8` revisions. Relative to the previously selected `c930d3c8`
implementation archive, only the OpenCode driver-session and V2 read-cut
JavaScript members change. The update joins the original aborted fetch within
the existing bounded cleanup path and adds passive lifecycle diagnostics.
Unsettled work still retains an unresolved result. Claude, Codex and native
prompt suggestion members, public declarations, package exports and dependency
versions are unchanged. The entire Session SPI archive is byte-identical to
the previously selected SPI.

## Producer checks

With pinned pnpm 11.18.0, the original complete `pnpm check` passed on Node
26.11.1: build, typecheck, all 571 controlled source tests and both packed
consumers, with no skips. Its two checked archives are byte-identical to this
retained Node 24.21.0 pair.

On Node 24.21.0, build, typecheck, all 571 source tests and the contracts packed
consumer passed. The first complete check failed because the implementation
packed consumer's dependency-install child received SIGKILL. That original
failed result is retained. The unchanged complete implementation packed test
then passed after selecting the existing task dependency store with
`PNPM_CONFIG_STORE_DIR`; no deadlines, assertions or source were changed.
The cause of the original SIGKILL was not independently established.

`source-receipt.json` records exact commands, outcomes and log digests;
`checked-artifact-receipt.json` identifies the retained pair. Both Host package
dependencies, the workspace SPI override and the lockfile select this same
directory. Historical archives and fixed donor proof pins remain intact.

These receipts cover source and packed-consumer checks. They do not claim
Host, application, packaged Electron, real-provider authentication or external
inference qualification. No real Claude or Codex command was executed.
