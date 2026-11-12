# OpenCode managed installation

This process-limited slice owns generation selection and the native npm package
boundary. The legacy installer coordinates download, atomic activation, status and
resolver invalidation through the public main entrypoint. V2 CLI releases stay in
the supported stable range; their execution engine comes from the pinned runtime
qualification contract. Native metadata stays beside bin/.
The existing IPC/preload/store transports accept an optional generation choice.
Focused tests cover package identity, archive safety and managed activation.

Fresh installs select V1 by default, including platforms with qualified V2 support.
A first-time implicit install and explicit updates resolve the latest supported
stable release within the selected generation. If the global npm `latest` tag
moves outside that range or its native platform package is unavailable, a root
registry snapshot and at most one snapshot per platform package select the highest
compatible, installable release. The selected exact version is retained through native package lookup and
download; update discovery verifies the same platform package availability.
Package identity and sha512 transport integrity are verified before activation.
Existing V1/V2 installs remain in their selected generation on update; explicit
V2 requests and support-only repair are preserved. The dashboard does not promote
V2 during first-time installation.

External V2 support is an optional ZIP delivery pinned by the runtime lock. The
main support installer streams verified archive records into immutable UUID
instances and atomically publishes a per-descriptor location receipt. Native
selection and authentication remain separate. A support-only install/repair
uses the existing Install transport with `supportOnly: true`; native Update
keeps its existing intent. Status checks only support metadata and helper
availability. Every install/repair and runtime acquisition verifies actual bytes.
An absent external descriptor retains the old bundled runtime mode; malformed
or incomplete new metadata fails closed. Focused coverage is in
`test/features/opencode-runtime-installer/v2Support.test.ts` and the existing
installer, quick-connect, environment, and packaged-runtime suites.

When the desktop Host is selected, the existing Install and Refresh actions use
`CapturedOpenCodeRuntimeInstaller`. Native acquisition is followed by publication
through the original private source grant. The Host retains the exact candidate
in its existing command receipt and verifies native identity before new launches
can capture it. A restarted installer recovers that original receipt before a new
acquisition; an unknown native outcome never starts a replacement check.
CLI version, engine version and source revision are distinct status fields.
Running captures keep their original selection. This route retains the selected
V1/V2 generation; transitions and provider versions outside the Host qualification
contract fail explicitly.
