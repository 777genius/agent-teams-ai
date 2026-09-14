# Team Provisioning Feature

Owns desktop team creation, draft launch, relaunch, provisioning preflight, run status, cancellation, and launch diagnostics.

## Boundaries

- `contracts/` owns the stable provisioning IPC channel names.
- `core/application/` coordinates launch policy through narrow ports and plans provisioning progress state transitions without depending on Electron, Zustand, or concrete filesystem services.
- `main/adapters/input/` validates untrusted IPC input and owns renderer progress delivery.
- `main/adapters/output/` binds filesystem, metadata, cache, diagnostics, and launch-observability effects.
- `main/composition/` is the only place where concrete main-process services are wired to the application layer.
- `renderer/` owns provisioning controls, progress side effects, and team/run-scoped runtime freshness memory, binding IPC, view refresh, analytics, and runtime cleanup through narrow ports.

Create and launch always record launch intent before provisioning starts, engage the team watch scope before startup artifacts are written, report progress to the launch I/O governor before notifying the invoking renderer, and invalidate roster snapshots only after successful completion.

Renderer store composition belongs in the app store composition root. Provisioning policies and control actions must be added through the feature's public entrypoints instead of growing `teamSlice.ts` with new IPC calls or duplicated state rules.

This feature is being migrated incrementally from the legacy
`TeamProvisioningService` hierarchy. New slices use explicit composition; the
legacy service remains a stable compatibility facade while callers migrate.

## Reference Slice

`getProvisioningStatus` is the first complete walking slice:

```text
IPC / HTTP
  -> TeamProvisioningService compatibility facade
  -> TeamProvisioningStatusApi
  -> GetProvisioningStatusUseCase
  -> ProvisioningStatusReaderPort
  -> LegacyProvisioningStatusReaderAdapter
  -> existing progress state owner
```

The use case owns the `Unknown runId` application rule. The adapter only maps the
narrow reader port to the current state owner and receives explicit dependencies;
it never receives the whole provisioning service.

## Extending The Feature

For the next slice:

1. Define or reuse a stable contract under `contracts/`.
2. Add one use case and only the ports it consumes under `core/application/`.
3. Implement runtime or legacy integration under `main/adapters/`.
4. Construct the slice under `main/composition/`.
5. Delegate from the compatibility facade without adding inheritance or hidden
   service-host dependencies.
6. Add focused use-case, adapter, composition, and public-parity tests.

Do not add empty folders or speculative abstractions. See
`docs/team-management/team-provisioning-target-architecture.md` for the complete
migration standard.

The renderer entrypoint also exposes `MemberSettingsRelaunchDraft` and its draft
projection/validation helpers. Member settings pass configured intent and the
original target fingerprint through `TeamMemberSettingsDialogBridge` to the
existing launch dialog. These helpers do not persist settings; submission uses
the existing replace-members/launch sequence, with fresh roster checks before
replacement (and before stopping a live team).

For a settings-originated relaunch, the optional `memberSettingsRelaunch` field on
`ReplaceMembersRequest` carries the target and roster fingerprints into the
existing IPC mutation gate. `persistNodeMemberSettingsRelaunch` validates this
intent and composes the existing member repository and team metadata store.
The config lock covers conflict checks, configured member writes and rollback;
lead model/effort also update saved launch defaults and launch identity. This
bounded path keeps the roster identity unchanged; add/remove members separately.
Ordinary replace-members requests retain their existing behavior. HTTP mode
already rejects replace-members and gains no new support in this repair.

The settings editor captures the opaque `getSavedRequest().savedSettingsFingerprint`
when it opens. The relaunch intent carries that token unchanged, alongside member
fingerprints. Persistence compares saved model, effort, provider, launch identity
and inherited launch defaults before writes, then rechecks defaults inside the
lead metadata update. Missing tokens fail closed. The mutation boundary also
checks the existing `hasProvisioningRun` query, because a configuring successor
has not yet become an alive team.

Settings roster projection uses the same canonical legacy-lead classification as
member settings. Canonical metadata launch discovery also excludes those leads.
Native launch setup carries `configuredMemberSpecs` separately through run and
spawn orchestration to `persistDeterministicLaunchMetadata`. The synthetic request
and effective specs still construct runtime behavior; the writer uses configured
model/effort/provider/backend/fast-mode fields while retaining effective workspace
materialization and existing tombstone handling. Metadata discovery carries backend
and fast-mode selections so explicit siblings survive the same round trip.

After completion, `config.json` retains effective provider/model/effort for runtime
consumers. `TeamMemberResolver.configuredRuntimeSettings` and
`LegacyMemberSettingsRepositoryAdapter` instead read provider/model/effort/backend/
fast-mode from the matching canonical `members.meta.json` row. An absent field on
that row means inheritance; it must not fall back to effective config. For legacy
members with no matching metadata row, config remains the configured source
(including its legacy `provider` alias). Metadata for another member does not
change that compatibility policy. The resolver keeps configured backend selections
separate from effective backend resolution.

`MemberSettingsRelaunchFiles.test.ts` executes completion's real
`applyEffectiveLaunchStateToConfig`, reopens files with fresh stores and the actual
member resolver/editor projection, and resubmits settings with a changed lead
default through persistence and launch setup again. It checks both effective
runtime values and durable absence of cleared/inherited overrides alongside an
explicit mixed-provider/backend/fast-mode sibling.
