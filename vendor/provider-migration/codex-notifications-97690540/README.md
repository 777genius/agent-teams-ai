# Checked provider archive — 97690540

Immutable source [976905403b40078c3c2cfae3c442d5ec91056fc2](https://github.com/agent-teams-ai/old-provider-implementations/commit/976905403b40078c3c2cfae3c442d5ec91056fc2), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

This checked candidate adds typed Codex connection notifications for the existing 0.169 protocol gate. It retains the previous Claude checkpoint-source and OpenCode provider behavior. The complete old/new package metadata is identical; the application keeps its original dependency and peer graph.

Official [source and packed-consumer checks](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43510761520) passed on Node 24.21.0 and 26.11.1 with pnpm 11.18.0. These exact package bytes were downloaded from checked artifact 14078576670 and verified before repository ingestion. The original receipt.json bytes are retained as checked-artifact-receipt.json; source-receipt.json records the source, checks and original artifact identities.

Provider archive: agent-teams-provider-implementations-0.0.0.tgz, 178265 bytes, SHA-256 73dbbfba5e8fed6719ccdeaae499a47284b72ac831c33a2c7206fbf2799f77b8. Checked artifact ZIP: 185401 bytes, SHA-256 f6c7f2a5d609e9ddf651b4cccffd83c7027e3d37c4560613e3d6a8537aaf90d9.

The session-contracts archive remains byte-identical to the existing canonical pin, SHA-256 aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db. No duplicate contracts archive or historical pin is replaced.

Qualification of this checked artifact remains source and packed consumer only. The dependency's separate [native run43510761545](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43510761545) completed53/53 successfully on this source head. This does not qualify Codex0.169 in the application or the application's Host, Desktop or packaged Electron. Those consumers require their own exact-head frozen installation, archive/dist equality, original native interactions and physical cleanup results. The existing Codex Desktop Resume gate remains required.
