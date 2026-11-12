# Native provider paths

Immutable provider source [bc1c93b5eedd410b519559ee5bbe036a50fc5670](https://github.com/agent-teams-ai/old-provider-implementations/commit/bc1c93b5eedd410b519559ee5bbe036a50fc5670), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

The archive is the exact retained output of the existing packed-consumer check on Node 24.21.0 / pnpm 11.18.0. Both exact CI Node versions (24.21.0 and 26.11.1) passed `pnpm check`: build, typecheck, 510 source tests and both packed consumers. No vendored dist or archive bytes were edited.

Provider archive SHA-256: `ceafcfc99defd2a402cef7091041bf46bd828c3baeff8bc05529f06f397fd384`. The neutral Session SPI archive remains byte-identical and retains its prior frontend pin.

Compared with the prior Codex-login archive, six adapter path guards use native absolute paths, with one shared Windows lexical validator (two compiled files added). No existing public declaration or Session SPI changes. Source/package checks are independent of actual native Windows process and Desktop qualification, which remain required on the integrated source.
