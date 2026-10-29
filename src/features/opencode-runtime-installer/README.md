# OpenCode managed installation

This process-limited slice owns generation selection and the native npm package
boundary. The legacy installer coordinates download, atomic activation, status and
resolver invalidation through the public main entrypoint. V2 versions come only
from the pinned runtime qualification contract; native metadata stays beside bin/.
The existing IPC/preload/store transports accept an optional generation choice.
Focused tests cover package identity, archive safety and managed activation.

Existing V1 installations stay on V1 without a dashboard offer to migrate to V2.
Fresh installs can still select the qualified V2 through the primary install action.

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
