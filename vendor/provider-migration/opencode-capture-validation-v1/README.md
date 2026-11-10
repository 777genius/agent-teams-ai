# OpenCode capture validation v1

Immutable provider artifact from owning-repository source checkpoint
`d58fc8428cd359860b4feaacb3cf90387c0d2f8e`.
SHA-256: `17f3294ef85b56503d049e00f794bd9fc2c2a00540048a291387da3cb79a7e2a`.

Compared with Claude idle notification v1, only
`dist/features/provider-session-implementation/adapters/opencode-protocol/input-window-capture.js`
changes. The runtime guard validates captured snapshot item fields and routes
invalid shapes through the existing capture-gap path.

All 209 archive files remain present, including 206 dist files. The Claude SDK
session module and its idle notification fix are byte-identical to the c3
predecessor. Session SPI is unchanged. Native/Desktop qualification is separate;
previous archives and evidence remain immutable.
