# Mixed Team Per-Member Runtime Lanes Plan

**Status**: proposed implementation plan after code-level confidence pass  
**Chosen path**: preserve the existing primary team bootstrap lane, add secondary per-member runtime lanes only where the primary lane cannot truthfully own a member, starting with `OpenCode`  
**Score**: `🎯 9   🛡️ 9   🧠 8`  
**Expected size**: roughly `1700-2900` lines in `claude_team`, plus only small additive follow-up work in `agent_teams_orchestrator` if a provider-specific side-lane seam needs extra metadata

## Executive Decision

The first version of mixed teams should **not** try to turn every provider/model difference into its own lane.

That would be too abstract for the current code and would create avoidable risk.

Instead, V1 should do this:

- keep the current **primary team bootstrap lane** as the owner for the lead and for teammates that the existing primary team bootstrap can already launch safely
- introduce **secondary member lanes** only for runtime families that cannot truthfully live on the primary lane
- start with **`OpenCode` as the first secondary-lane provider**
- ship the first mixed rollout for **`Anthropic` / `Codex` / `Gemini` leads with one `OpenCode` teammate**
- explicitly defer **`OpenCode`-led mixed teams** until canonical team ownership through the adapter path is hardened
- keep **secondary lanes single-member in V1**
- allow **at most one `OpenCode` secondary lane/member per team in V1** until provider-local OpenCode runtime stores become lane-scoped
- keep **team-level backend/fast UI** in V1
- make member-level backend/fast an **additive internal contract** first, not a renderer editing surface
- explicitly **exclude the current one-shot scheduler** from this phase because it is not a team-runtime lifecycle system

This is more reliable than the earlier generic framing and matches the real code much better.

### What this feature is really about

This is **not** a generic rewrite of all mixed-provider behavior.

The current system already has a working primary-lane notion of mixed teammate `provider/model/effort` for non-`OpenCode` teammates.  
The real missing capability is:

- providers that require a different runtime owner than the primary team bootstrap owner

So V1 should be implemented as a **side-lane extension**, not as a universal per-provider decomposition rewrite.

## Why The Earlier Draft Needed Tightening

The earlier draft had three low-confidence assumptions that were too loose:

1. It treated all mixed-provider differences as if they needed lane separation.
2. It implied schedule parity through the same coordinator, but the current scheduler does not launch persistent teams.
3. It talked about replacing `team -> run` maps wholesale, while a safer path is to keep the primary run maps and add side-lane tracking additively.

After checking the code, those assumptions should be corrected.

## What The Current Code Actually Proves

### 1. The primary team bootstrap path already supports member-level provider/model/effort

`TeamProvisioningService` already materializes member-level runtime intent through:

- `materializeEffectiveTeamMemberSpecs(...)`
- `resolveAndValidateLaunchIdentity(...)`
- deterministic team bootstrap inputs built from `effectiveMemberSpecs`

That means the primary lane is already more capable than a purely lead-only launch contract.

This is important because it means we should preserve and wrap that path, not bypass it.

### 2. The runtime adapter registry is currently provider-specific and effectively `OpenCode`-specific

The runtime adapter layer in:

- `src/main/services/team/runtime/TeamRuntimeAdapter.ts`
- `src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts`

is not a generic multi-provider lane system today.

In practice, this means:

- `Anthropic`, `Codex`, and `Gemini` still live on the primary team bootstrap path
- `OpenCode` is the provider that currently forces an alternate launch owner

That is the real reason `vector-room-7` broke.

### 3. Current live tracking is fundamentally primary-team-scoped

`TeamProvisioningService` still maintains:

- `provisioningRunByTeam`
- `aliveRunByTeam`
- `runtimeAdapterRunByTeam`

These encode a strong `team -> run` assumption.

Replacing them all in one shot would be high risk.  
The safer path is:

- keep them as the **primary lane truth**
- add **secondary lane tracking** next to them

### 4. `team.meta.json` is already lead-level launch truth

`TeamMetaStore` already persists:

- `providerId`
- `providerBackendId`
- `model`
- `effort`
- `fastMode`
- `launchIdentity`

This makes `team.meta.json` the natural **lead-level desired and resolved runtime source**.

### 5. `members.meta.json` is still missing the runtime fields needed for mixed-lane truth

`TeamMembersMetaStore` currently persists `TeamMember[]`, which already carries:

- `providerId`
- `model`
- `effort`

but not:

- `providerBackendId`
- `fastMode`

So the current member metadata is not rich enough to reconstruct mixed-lane runtime identity deterministically.

### 6. The current scheduler is not a team-runtime lifecycle engine

`ScheduledTaskExecutor` is a one-shot CLI runner:

- it spawns `claude -p`
- it uses `ScheduleLaunchConfig`
- it validates fast mode and provider env
- it does **not** create or reconcile a persistent team with member lanes

Therefore the current scheduler must be treated as **out of scope** for mixed-team lane rollout.  
The earlier draft was too optimistic there.

### 7. Backup already includes the right metadata files

`TeamBackupService` already backs up:

- `config.json`
- `team.meta.json`
- `members.meta.json`

This is good news: additive mixed-lane persistence does not require a separate backup architecture.

What it does require is:

- additive field compatibility
- restore/reconcile tests proving those new fields survive backup/restore intact

### 8. The current `OpenCode` adapter flattens failures across its own `expectedMembers`

`OpenCodeTeamRuntimeAdapter` maps blocked launch and readiness failures across every member in its `input.expectedMembers`.

This means the coordinator must treat adapter input subsets as a hard invariant:

- if the coordinator passes unrelated members into a side-lane adapter input, the adapter will correctly flatten that failure across all of them
- therefore adapter-local `expectedMembers` must contain only lane-owned members

This is not just an optimization. It is required for truthful failure attribution.

### 9. The primary lane already supports member-level `provider/model/effort`

This is an important positive fact from the code:

- teammate spawn prompts include provider/model/effort overrides
- `buildAgentToolArgsSuffix(...)` passes `provider`, `model`, and `effort` into persistent teammate spawn requests
- relaunch reconstruction already restores member `providerId/model/effort` from `members.meta.json`

So `Anthropic` / `Codex` / `Gemini` variation inside the primary lane is not hypothetical. The current primary bootstrap already has a real member-level provider/model/effort seam.

That is why V1 should preserve those members on the primary lane instead of over-normalizing them into new side lanes.

### 10. The primary lane does not yet honor member-level `providerBackendId/fastMode`

The current teammate spawn seam for the primary lane does **not** pass member-level:

- `providerBackendId`
- `fastMode`

through the Agent-team spawn contract.

That means the plan must be explicit:

- primary-lane teammates in V1 continue to inherit backend/fast behavior from the lead-side launch/runtime owner
- member-level backend/fast additions are additive persistence contracts first
- side-lane owners may consume those fields earlier than the primary lane

Without this clarification, the plan would over-promise primary-lane capability that the code does not currently have.

### 11. `restoreTeam(...)` is not backup restoration

There is another place where terminology can easily mislead implementation:

- `restoreTeam(...)` in `TeamDataService` simply undeletes `config.deletedAt`
- startup backup restoration is handled separately by `TeamBackupService.restoreIfNeeded()`

So any mixed-lane "restore" design must be explicit about which path it means:

- undelete
- startup recovery from persisted files
- backup restoration after source disappearance

### 12. `members.meta.json` already contains a root `providerBackendId`, but it is not member truth

`TeamMembersMetaStore` already persists a file-level:

- `providerBackendId`

at the root of `members.meta.json`.

That is useful as compatibility metadata, but it is **not** member-scoped runtime truth.

So V1 must be explicit:

- keep the existing root field for backward compatibility
- do not reinterpret that root field as if it were per-member backend truth
- add member-level backend/fast fields separately

### 13. `config.json` is intentionally normalized to lead-only before launch

`normalizeTeamConfigForLaunch(...)` removes teammates from `config.json` before the primary CLI launch, and `assertConfigLeadOnlyForLaunch(...)` enforces that invariant.

This is a critical architectural fact:

- `config.json` is not a reliable full-roster artifact during launch
- mixed-lane design must not rely on `config.json` as canonical teammate truth
- full desired roster must live in `members.meta.json`, not in the launch-time `config.json`

### 14. Live `addMember` and `restartMember` currently go through the lead-side Agent tool seam

`buildAddMemberSpawnMessage(...)` and `buildRestartMemberSpawnMessage(...)` tell the lead to spawn teammates through the Agent tool with:

- `provider`
- `model`
- `effort`

and no member-level:

- `providerBackendId`
- `fastMode`
- lane ownership metadata

That means the current add/restart seam is only safe for primary-lane teammates.  
It cannot be reused unchanged for `OpenCode` or any future secondary-lane member.

### 15. Launch roster fallbacks are degraded for mixed-lane truth

`resolveLaunchExpectedMembers(...)` falls back in this order:

1. `members.meta.json`
2. inboxes merged with `config.json` provider/model/effort overrides
3. `config.json` fallback

Only the first path can become authoritative mixed-lane truth.  
The inbox/config fallbacks recover at most:

- name
- role
- workflow
- isolation
- provider/model/effort

They do **not** recover:

- member-level backend
- member-level fast mode
- lane attribution
- resolved member launch identity

So mixed-lane relaunch/startup recovery must treat those fallbacks as degraded and non-authoritative.

### 16. Primary launch env and provider args are resolved once at the root request

The current create/launch flow calls `buildProvisioningEnv(request.providerId, request.providerBackendId)` once for the primary request and then carries:

- `shellEnv`
- `providerArgs`
- auth/runtime warnings

into the primary spawn.

That means secondary lanes must not inherit primary launch env blindly.  
Each secondary lane needs its own provider-aware env/auth/provider-args resolution.

### 17. `TeamMemberResolver` and `TeamMemberSnapshot` are not mixed-lane-aware today

Current team-view membership and runtime labels are still resolved mainly from:

- `config.members`
- `members.meta.json`
- inbox names

and `TeamMemberSnapshot` currently carries:

- `providerId`
- `model`
- `effort`

but not:

- `providerBackendId`
- `selectedFastMode`
- `resolvedFastMode`
- `laneId`
- `laneKind`

So renderer truth will diverge from runtime truth unless these contracts are upgraded explicitly.

### 18. `launch-state.json` normalization will drop new mixed-lane fields unless upgraded

`normalizePersistedLaunchSnapshot(...)` and `normalizePersistedMemberState(...)` rebuild the persisted launch-state shape field-by-field.

That means additive mixed-lane fields are **not** automatically safe just because they were written once.

Any mixed-lane schema rollout must therefore include:

- shared type updates
- launch-state write-path updates
- launch-state normalize/read-path updates

Otherwise read-normalize-write cycles will silently erase the new fields.

### 19. `expectedMembers` currently means the full expected teammate roster across many callers

Today the codebase uses `expectedMembers` as a durable "all expected teammates" field in:

- launch-state summaries
- bootstrap recovery
- provisioning progress/presentation
- Team list/detail launch badges

This is **not** a private primary-lane-only field.

So mixed-lane rollout must not silently repurpose existing `expectedMembers` to mean "primary bootstrap subset".

If V1 needs both concepts, it must add them explicitly, for example:

- `expectedMembers` as full mixed-team desired roster
- `primaryExpectedMembers` or `bootstrapExpectedMembers` as the primary-lane subset

instead of redefining the old field in place.

### 20. `choosePreferredLaunchSnapshot(...)` currently prefers by timestamp only

`TeamConfigReader` and other readers currently pick between bootstrap and persisted launch snapshots using only `updatedAt`.

That is safe enough today because the snapshots are structurally similar.  
It becomes unsafe for mixed teams if:

- bootstrap snapshot is structurally poorer and only knows about the primary lane
- persisted launch-state is structurally richer and includes lane-aware mixed truth

In that world, a newer bootstrap snapshot could silently clobber richer mixed truth.

So the mixed plan must include an explicit precedence rule:

- richer mixed-lane persisted launch-state must not be overridden by a structurally poorer bootstrap snapshot just because it is newer

### 21. Team summary readers currently have a much smaller launch-state size budget than the main store

Today:

- `TeamLaunchStateStore` reads up to `256 KB`
- `TeamConfigReader` summary path reads only up to `32 KB`
- `team-fs-worker` summary path also reads only up to `32 KB`

So a richer mixed-lane `launch-state.json` can become perfectly valid for the main runtime path while silently disappearing from Team list / dashboard summary readers.

The plan therefore needs an explicit size-budget rule for mixed-lane persistence.

### 22. Team summary logic is duplicated between main-thread and fs-worker paths

Mixed launch-state summary behavior is not centralized today:

- `TeamConfigReader` has its own launch-state summary path and bootstrap snapshot precedence logic
- `team-fs-worker` has a separate launch-state summary implementation

They are already not perfectly symmetric, and mixed-lane schema/precedence changes would widen that drift unless the plan explicitly treats them as a parity surface.

### 23. Post-launch `config.json` runtime projection is currently lossy

`applyEffectiveLaunchStateToConfig(...)` projects runtime state back into `config.members`, but only for:

- `providerId`
- `model`
- `effort`

It does **not** project:

- member backend
- fast mode
- lane ownership
- resolved launch identity

So post-launch `config.json` is not just non-canonical in principle - it is concretely a lossy projection today.

Mixed rollout must treat it only as a compatibility-facing artifact, never as authoritative runtime reconstruction input.

### 24. Live roster mutation on running teams is still lead-message-driven and not mixed-safe

Today, when a team is alive:

- `addMember` persists metadata, then tells the lead to spawn the teammate
- `replaceMembers` diffs the roster, sends lead spawn messages for added members, then sends a summary message
- `removeMember` marks metadata and sends a generic lead message

That means live roster mutation is fundamentally coupled to:

- lead-owned teammate spawning
- lead-side interpretation of roster changes
- no side-lane ownership contract

So V1 should not treat only "lane migration" as unsafe.  
The safer rule is broader: live roster mutation of a running mixed team is out of scope.

### 25. `OpenCode` bridge launch is still single-model and team-scoped

`OpenCodeLaunchTeamCommandBody` currently carries:

- one `selectedModel`
- one `teamName`
- one `runId`

for the whole `OpenCode` launch command.

That is a hard seam, not just an implementation detail.

So even before considering runtime stores, the current state-changing bridge contract is not yet a natural fit for:

- multiple independent `OpenCode` side lanes inside one mixed team
- different `OpenCode` side-lane members choosing different raw models concurrently

### 26. `OpenCode` provider-local runtime stores are team-scoped, not lane-scoped

The current provider-local runtime store namespace lives under:

- `<team>/.opencode-runtime/manifest.json`
- `<team>/.opencode-runtime/launch-state.json`
- `<team>/.opencode-runtime/opencode-launch-transaction.json`
- `<team>/.opencode-runtime/opencode-permissions.json`

And those stores currently encode:

- one `activeRunId` per team manifest
- one `activeCapabilitySnapshotId` per team manifest
- one active `OpenCode` launch transaction per team

This means the provider-local `OpenCode` state layer is still **team-scoped single-run state**, not a lane namespace that can safely host multiple concurrent `OpenCode` side lanes for the same logical team.

So V1 must be explicit:

- keep global mixed-team `launch-state.json` separate from provider-local `.opencode-runtime/launch-state.json`
- support **at most one `OpenCode` secondary lane/member per team**
- defer multi-`OpenCode` mixed teams until the provider-local runtime store namespace is lane-scoped

## The Real Problem We Need To Solve

`vector-room-7` failed because runtime ownership answered the wrong question.

Today the system effectively asks:

- "does this team contain OpenCode anywhere?"

But it should ask:

- "which runtime owner is allowed to launch each member?"

That distinction matters because:

- the lead and same-family teammates may still be valid on the primary lane
- a specific member such as an `OpenCode` teammate may require a side lane
- a side-lane failure must stay attributed to that member or lane only

## Goals

- Support mixed teams inside one logical team without splitting into fake subteams.
- Keep one lead and one canonical team identity.
- Make runtime ownership member-scoped where needed.
- Preserve the current primary team bootstrap path for the cases it already handles well.
- Add secondary lanes only where truth requires it.
- Make relaunch and restore deterministic.
- Keep renderer truth honest for partial success and partial failure.
- Roll out additively and safely.

## Non-Goals

- No hidden split-team illusion under the hood.
- No big-bang rewrite of every provider into lane adapters.
- No immediate per-member backend/fast editing UI.
- No claim that the current one-shot schedule system becomes mixed-team aware in this phase.
- No optimistic multi-member secondary lane grouping in V1.

## V1 Scope Decision

### ✅ In scope

- primary lane + secondary side-lane coordinator
- `OpenCode` as the first secondary-lane provider
- mixed teams where the lead remains on the existing primary team bootstrap path
- exactly one `OpenCode` secondary teammate per mixed team
- member-level lane attribution and persistence
- mixed create/launch/relaunch/restore/stop/reconcile for persistent teams
- truthful renderer diagnostics

### ❌ Out of scope for V1

- schedule parity through the current `ScheduledTaskExecutor`
- per-member backend/fast editing controls in the dialogs
- multi-member secondary lane grouping
- more than one `OpenCode` teammate inside the same mixed team
- converting `Codex` or `Anthropic` into side-lane providers unless a future runtime seam truly requires it
- `OpenCode`-led mixed teams where the canonical team owner would need to move onto the adapter path

## Chosen Runtime Ownership Model

## Two Kinds Of Lanes

### 1. Primary lane

The primary lane is the existing deterministic team bootstrap lane owned by the main team process.

It remains responsible for:

- the lead
- canonical team prompt/session semantics
- teammates that the current primary bootstrap owner can still launch truthfully

This is not a new idea. It is the current working system, formalized as a lane.

### 2. Secondary lanes

A secondary lane is a side runtime owner for a member that cannot be truthfully launched by the primary lane.

In V1:

- secondary lanes are **single-member only**
- the first supported owner is `OpenCode`
- a secondary lane never becomes the canonical team owner

This keeps the model simple and reliable.

## Compatibility Rule

The compatibility question in V1 is **not**:

- "same provider?"
- "same model?"
- "same effort?"

The real question is:

- "is this member allowed to remain owned by the current primary team bootstrap lane?"

### V1 compatibility policy

A member stays on the primary lane when:

- their provider/runtime family is supported by the primary team bootstrap owner
- no runtime family declares that the member must be isolated into a secondary lane

A member moves to a secondary lane when:

- their runtime family explicitly requires a separate runtime owner

### Initial concrete policy

In V1:

- `anthropic` -> primary-lane eligible
- `codex` -> primary-lane eligible
- `gemini` -> primary-lane eligible
- `opencode` -> secondary-lane required

This is intentionally specific because that is what the code currently supports.

### Lead policy in V1

For the first shipping phase:

- mixed teams are supported when the lead is `anthropic`, `codex`, or `gemini`
- pure `opencode` teams continue to use the existing runtime adapter path
- `opencode`-led mixed teams are deferred

This keeps canonical team ownership on the already-proven primary bootstrap path for V1 mixed support.

## Why We Are Not Using “Any Difference = New Lane”

That approach looks elegant on paper but is the wrong tradeoff here.

It would force us to:

- duplicate or replace working bootstrap behavior for `Codex` / `Anthropic` / `Gemini`
- redesign the renderer editor prematurely
- massively widen relaunch and restore risk

The better architecture is:

- generic coordinator
- specific V1 ownership policy
- a separate later phase for adapter-owned mixed primary lanes if we need them

That gives us scalability later without pretending the current code is more symmetric than it really is.

## Source Of Truth Matrix

The most important plan improvement is to separate **desired** truth from **resolved** truth.

| Artifact | Responsibility in V1 | Source kind |
| --- | --- | --- |
| `team.meta.json` | Lead-level desired runtime request and resolved lead launch identity | desired + resolved |
| `members.meta.json` | Member desired runtime contract overrides | desired |
| `launch-state.json` | Per-member resolved launch outcome, lane assignment, resolved launch identity | resolved |
| in-memory run maps | Live lane ownership and stop/reconcile handles | live runtime only |

### Rules

- `team.meta.json` is the source of truth for the lead request
- `members.meta.json` is the source of truth for member overrides
- `launch-state.json` is the source of truth for the most recent resolved lane/member execution
- live maps must never become the only source of member lane ownership
- `config.json` is not canonical teammate-roster truth during launch because it is intentionally normalized to lead-only
- post-launch `config.json` runtime projection is lossy and compatibility-facing only
- provider-local `OpenCode` runtime stores under `.opencode-runtime/*` are a separate provider-owned namespace, not the canonical mixed-team snapshot
- if a compact launch summary projection is introduced for Team list / dashboard, it must be derived from the same canonical snapshot precedence rules as the main runtime path
- the root `members.meta.json.providerBackendId` remains compatibility metadata, not member-scoped runtime truth
- team-view/runtime labels must eventually be derived from lane-aware snapshot truth, not only from `config + meta + inboxes`
- existing `launch-state.expectedMembers` semantics must remain explicit and backward-safe; do not silently redefine it to mean primary-only subset

## Contracts To Add Or Tighten

## 1. `TeamProvisioningMemberInput`

Extend `src/shared/types/team.ts`:

```ts
export interface TeamProvisioningMemberInput {
  name: string
  role?: string
  workflow?: string
  isolation?: 'worktree'
  providerId?: TeamProviderId
  providerBackendId?: TeamProviderBackendId
  model?: string
  effort?: EffortLevel
  fastMode?: TeamFastMode
}
```

Reason:

- member desired runtime contract must be able to express full future lane identity
- even if the renderer does not expose backend/fast editors in V1, the contract must exist additively

### V1 semantic rule

In the shipping V1 scope:

- member `providerId/model/effort` are meaningful for both primary-lane and secondary-lane members
- member `providerBackendId/fastMode` are meaningful for secondary-lane planning and future compatibility
- primary-lane teammates still inherit effective backend/fast behavior from the lead/runtime owner

## 2. `TeamMember`

Extend `TeamMember` additively with:

- `providerBackendId?: TeamProviderBackendId`
- `fastMode?: TeamFastMode`

### Guardrail

`config.json` writers must **not** start depending on those fields.  
They may remain omitted in canonical CLI-facing config writes until the CLI actually needs them.

This lets `members.meta.json` evolve without silently changing `config.json` semantics.

## 3. `TeamMemberSnapshot`

Extend renderer-facing member truth with:

- `providerBackendId?: TeamProviderBackendId`
- `selectedFastMode?: TeamFastMode`
- `resolvedFastMode?: boolean`
- `laneId?: string`
- `laneKind?: 'primary' | 'secondary'`

This is needed so Team Detail can show truthful member runtime identity without flattening everything into team-level labels.

### Guardrail

This is not optional polish.

The mixed feature must stay dark until `TeamMemberSnapshot` and the resolver path can consume lane-aware truth. Otherwise runtime behavior will be correct while Team Detail still lies.

## 4. `PersistedTeamLaunchMemberState`

Additive fields required:

- `providerId?: TeamProviderId`
- `providerBackendId?: TeamProviderBackendId`
- `launchIdentity?: ProviderModelLaunchIdentity`
- `laneId?: string`
- `laneKind?: 'primary' | 'secondary'`
- `laneOwnerProviderId?: TeamProviderId`

This is the minimum needed for deterministic relaunch and accurate diagnostics.

### Guardrail

Because `normalizePersistedLaunchSnapshot(...)` rebuilds the persisted structure explicitly, this schema work is incomplete until the normalizer also roundtrips these additive fields safely.

## 5. `TeamAgentRuntimeEntry`

Extend live runtime snapshot entries with:

- `providerId?: TeamProviderId`
- `providerBackendId?: TeamProviderBackendId`
- `laneId?: string`
- `laneKind?: 'primary' | 'secondary'`

This is a live presentation contract only.  
It does not replace persisted truth.

## 6. `MemberDraft`

Do **not** expose member-level backend/fast in the UI in V1.

But for future-proofing, the internal draft type may be extended additively later if needed.

In V1:

- renderer editing remains `providerId/model/effort`
- backend/fast remain inherited internal fields

That is the safer scope boundary.

## Domain Model

## Desired member contract

```ts
type DesiredTeamMemberRuntimeContract = {
  memberName: string
  providerId: TeamProviderId
  providerBackendId: TeamProviderBackendId | null
  model: string | null
  effort: EffortLevel | null
  fastMode: TeamFastMode | null
  cwd: string
}
```

This is reconstructed from:

- `team.meta.json` lead defaults
- `members.meta.json` member overrides

## Resolved member runtime identity

```ts
type ResolvedTeamMemberRuntimeIdentity = {
  memberName: string
  role: 'lead' | 'member'
  desired: DesiredTeamMemberRuntimeContract
  launchIdentity: ProviderModelLaunchIdentity
  laneRequirement: 'primary-eligible' | 'secondary-required'
}
```

This is computed after provider-aware resolution.

## Lane plan

```ts
type TeamRuntimeLanePlan = {
  laneId: string
  laneKind: 'primary' | 'secondary'
  ownerProviderId: TeamProviderId
  memberNames: string[]
  launchMode: 'existing-primary-bootstrap' | 'runtime-adapter'
}
```

### Important V1 simplification

Secondary lanes are single-member only, so:

- `laneKind === 'secondary'` always implies `memberNames.length === 1`
- in the shipping V1 scope, only one secondary `OpenCode` lane may exist for a team
- if a mixed draft includes more than one `OpenCode` teammate, the planner must reject it explicitly instead of silently grouping or serializing them

This is deliberate and should be written into the code as a policy, not left as an implicit side effect.

## Runtime Ownership Architecture

## New coordinator

Introduce a feature-owned coordinator:

`src/features/team-runtime-lanes/main/composition/createTeamRuntimeLaneCoordinator.ts`

Suggested facade:

`TeamRuntimeLaneCoordinator`

### Responsibilities

- read desired lead/member runtime contracts
- resolve member runtime identity
- partition members into primary vs secondary lanes
- launch the primary lane through the existing `TeamProvisioningService` path
- launch each secondary lane through an adapter owner
- merge lane results back into one aggregate team snapshot
- stop and reconcile all lanes

### Hard rules

- adapters never get unrelated members
- a secondary-lane failure cannot overwrite primary-lane member states
- in the shipping V1 mixed scope, the lead remains owned by the existing primary bootstrap lane

## Why the coordinator must preserve the primary path

The current primary path already owns:

- deterministic bootstrap
- lead inbox/session continuity
- much of the team lifecycle

So the coordinator should wrap it, not replace it.

That means the architecture is:

- existing primary provisioning path remains the canonical team owner
- secondary lanes are additive sidecars

This is safer than trying to make every provider look like a fully independent team owner.

## In-Memory Tracking Model

The earlier draft said to replace `team -> run` maps.  
That is too broad for V1.

## Safer V1 tracking decision

Keep:

- `provisioningRunByTeam`
- `aliveRunByTeam`

as the primary-lane run markers.

Add:

```ts
type SecondaryLaneRunRecord = {
  laneId: string
  providerId: TeamProviderId
  memberName: string
  runId: string
  cwd?: string
}
```

and:

```ts
private readonly secondaryLaneRunsByTeam = new Map<string, Map<string, SecondaryLaneRunRecord>>()
```

Optionally also add:

```ts
private readonly secondaryLaneProgressByRunId = new Map<string, TeamProvisioningProgress>()
```

### Why this is safer

- most of the codebase already assumes one primary team run
- mixed lanes only need additive side-lane tracking
- stop/reconcile/restore can aggregate over the new side map without destabilizing every existing caller

## Create And Launch Flow

## Critical bootstrap invariant

The current primary bootstrap flow explicitly embeds the teammate roster into:

- deterministic bootstrap spec `members`
- primary run `expectedMembers`
- primary-lane member spawn tracking

So a mixed-lane implementation must not treat those structures as the full mixed-team roster.

🚨 V1 rule:

- secondary-lane members must be excluded from the primary bootstrap spec
- secondary-lane members must be excluded from the primary in-memory `expectedMembers`
- aggregate mixed-team progress must track the full desired roster separately

Otherwise the primary lane will wait forever for members that are intentionally being launched elsewhere.

## Step 1 - persist desired contracts

Before runtime launch:

- write `team.meta.json` with lead request and lead launch identity seed
- write `members.meta.json` with full roster and member desired overrides

### Rule

Canonical team artifacts must always describe the full roster.  
No provider-specific adapter is allowed to "own" who belongs in the roster.

### Additional rule

That full roster must be persisted in:

- `members.meta.json`
- mixed-lane-aware `launch-state.json`

and **not** inferred from launch-time `config.json`, because the current launch flow intentionally strips teammates out of `config.json` before spawning the lead CLI.

## Step 2 - resolve member runtime identity

Resolve:

- lead desired contract
- each member desired contract
- resolved runtime identity for each member

This uses the same provider-aware resolution services already used for team launch, but now produces member-scoped output.

## Step 3 - partition lanes

Partition members into:

- primary-lane members
- secondary-lane members

### V1 partition policy

- lead is always primary
- primary-eligible members stay primary
- `OpenCode` members become one-member secondary lanes

### Bootstrap subset rule

After partitioning:

- `primaryBootstrapMembers = lead + primary-eligible teammates`
- `secondaryLaneMembers = secondary-required teammates`

Only `primaryBootstrapMembers` may feed:

- `buildDeterministicCreateBootstrapSpec(...)`
- `buildDeterministicLaunchBootstrapSpec(...)`
- primary-lane `expectedMembers`
- primary-lane `memberSpawnStatuses`

## Step 4 - launch primary lane first

Use the existing primary team bootstrap flow for:

- lead
- all primary-lane teammates

This preserves current session and deterministic bootstrap assumptions.

## Step 5 - launch secondary lanes after primary readiness

Once the primary lane reaches the point where it can truthfully own the team context:

- launch secondary lanes
- one side lane per member in V1

### Concurrency

Allow bounded parallelism only if provider-specific side-lane launches are proven safe.  
Default to conservative small concurrency.

### Join semantics

Secondary lanes must behave like post-bootstrap teammate attachments, not hidden members inside the original primary bootstrap transaction.

That means:

- the primary lane becomes ready against its own subset
- secondary lanes attach afterward
- mixed-team aggregate progress remains launching until both:
  - the primary lane is ready enough
  - every planned secondary lane has either joined or failed

## Explicit V1 mixed-team shipping matrix

### Supported in V1

- `Anthropic lead + one OpenCode teammate`
- `Codex lead + one OpenCode teammate`
- `Gemini lead + one OpenCode teammate`
- all existing pure non-OpenCode teams
- all existing pure OpenCode teams

### Deferred after V1

- more than one `OpenCode` teammate inside the same mixed team
- `OpenCode lead + Codex teammate`
- `OpenCode lead + Anthropic teammate`
- `OpenCode lead + Gemini teammate`

Those cases require canonical team ownership on the adapter path and should be treated as a separate risk class.

## Step 6 - merge lane outcomes

Merge:

- primary lane member evidence
- secondary lane member evidence

into one `launch-state.json` snapshot.

### Guardrail

Aggregate team state must be derived from member states, never the other way around.

### Aggregate roster truth

The mixed-team aggregate snapshot should distinguish:

- full desired roster for the whole launch
- primary bootstrap expected members only

Without that distinction, UI and restore logic will confuse:

- "primary bootstrap is still waiting"
with
- "a side lane has not attached yet"

### Backward-safe field rule

Because current readers and UI already treat `expectedMembers` as the full expected teammate roster, the mixed schema should add a new explicit field for the primary subset rather than silently changing the meaning of `expectedMembers`.

## Relaunch And Restore

This remains one of the highest-risk parts.

## Relaunch source rules

When relaunching:

1. desired contract comes from `members.meta.json` + lead-level `team.meta.json`
2. previous resolved member/lane truth comes from `launch-state.json`
3. current global provider settings are fallback only when stored team/member truth is absent

### Why this matters

The current relaunch flow:

- stops the team
- replaces members
- launches again

So if we do not persist member lane truth explicitly, relaunch will drift back toward team-level assumptions.

## Restore rules

On restore or startup reconciliation:

- restore primary lane from primary persisted state
- restore or reconcile secondary lanes from per-member lane attribution in `launch-state.json`
- if a secondary lane cannot be restored, only that member is degraded or failed

### Snapshot precedence rule

If both bootstrap-derived state and persisted launch-state exist:

- do not choose only by `updatedAt`
- prefer the snapshot that preserves mixed-lane structural truth
- a newer but structurally poorer bootstrap snapshot must not overwrite richer lane-aware launch-state

### Explicit non-goal

Do not reinterpret a previously mixed team as a pure team just because side-lane state is missing.

## Stop And Cleanup

## Ordering decision

For stop/relaunch:

1. stop secondary lanes first
2. stop primary lane second

### Why this order

- prevents side-lane members from being left attached to a dead team owner
- reduces orphaned-runtime risk

## Cleanup obligations

`stopTeam(...)` must:

- stop all secondary lanes
- stop the primary lane
- clear additive side-lane tracking maps
- persist a reconciled launch snapshot

No stop path may claim success while a side-lane member is still live.

## Live Edit And Add-Member Boundary

This is another high-risk area that the earlier draft was too soft about.

Today:

- `Edit Team` uses `replaceMembers(...)`
- runtime-affecting edits on a live team rely on `restartMember(...)`
- `Add member` is a post-bootstrap attachment flow

Those semantics are not equivalent for mixed lanes.

### V1 policy

#### Allowed

- fresh mixed create
- mixed relaunch
- mixed stop/start

#### Explicitly blocked

- live `addMember` on a running mixed team in V1
- live `replaceMembers` on a running mixed team in V1
- live `removeMember` on a running mixed team in V1
- live editing an existing member from primary-lane ownership to secondary-lane ownership
- live editing an existing member from secondary-lane ownership back to primary-lane ownership
- treating a lane migration as a simple restart
- using the current lead Agent tool restart flow as if it were a safe secondary-lane restart/migration path

### Why this is the right boundary

`addMember(...)` is already conceptually a post-bootstrap attachment flow.  
`restartMember(...)` is not. It assumes the same runtime ownership model still applies.

And for secondary lanes there is one more hard constraint:

- the current add/restart seam is lead-owned Agent tool spawning with only provider/model/effort overrides
- that seam is insufficient for side-lane runtime owners like `OpenCode`

So the safer V1 boundary is:

- ship fresh launch / relaunch / stop / startup recovery for mixed teams
- defer live roster mutation of running mixed teams
- defer live side-lane add-member and live lane migration to a later phase

## Renderer Truth

## V1 renderer scope

Do not redesign the team editor UI.

Do:

- show lead and members with truthful runtime identity
- show that some members are on secondary lanes when useful
- keep partial-failure attribution member-scoped

### Shipping rule

Mixed-team execution must not be enabled for real users until `TeamMemberSnapshot` and `TeamMemberResolver` can surface lane-aware truth.  
Without that, runtime behavior and Team Detail diverge immediately.

## Required visible truth

- lead row must always exist
- member rows must not inherit another member's failure
- provider/runtime labels must be per member, not flattened from one team-wide owner

## Current lead bug tie-in

The `vector-room-7` missing lead issue proves one more rule:

- lead visibility must not depend on provider-specific config writing quirks

The canonical roster must remain team-owned, not adapter-owned.

## Scheduler Boundary

This part needed the strongest correction.

## Current scheduler reality

`ScheduledTaskExecutor` is a one-shot CLI job runner.  
It is not a persistent team-runtime lifecycle owner.

Therefore this feature should **not** claim:

- mixed-team lane execution through the current schedule system
- schedule parity with the persistent mixed-team coordinator

## V1 schedule policy

- existing `ScheduleLaunchConfig` remains lead-level only
- current schedules remain independent one-shot prompt runs
- mixed-team lane coordination is explicitly out of scope for this feature

### Terminology clarification

This repository currently has multiple different "restore" concepts:

- `restoreTeam(...)` in `TeamDataService` is undelete of `config.deletedAt`
- `TeamBackupService.restoreIfNeeded()` is startup backup restoration
- startup reconciliation also reads persisted launch state

This feature plan uses:

- **relaunch** for stop + launch again with persisted team metadata
- **startup recovery** for recovering mixed-lane runtime truth from persisted files after app/runtime interruption

Keeping those concepts separate will reduce implementation mistakes.

## Future extension

If later the product adds a true "scheduled team relaunch / scheduled team run" feature, that feature must call the same `TeamRuntimeLaneCoordinator`.

But that is a different system than the current scheduler.

## Diagnostics And Observability

The coordinator must emit:

- member desired contract summary
- lane assignment summary
- per-lane prepare result
- per-member launch attribution
- aggregate launch snapshot revision

### Example diagnostics

- `member alice stays on primary lane (codex primary bootstrap)`
- `member tom routed to secondary lane opencode:tom`
- `member bob routed to secondary lane opencode:bob`

This is essential. Mixed teams will be too hard to debug without explicit lane attribution.

## Migration And Compatibility

## Read compatibility

Old teams remain valid:

- missing member `providerBackendId` -> inherit lead/default provider backend
- missing member `fastMode` -> `inherit`
- missing member lane attribution in `launch-state.json` -> assume primary-lane if the member is primary-eligible

### Important limit

That last fallback must be used only for clearly primary-eligible providers.  
Do not silently infer `OpenCode` members back onto the primary lane.

## Mixed-Lane Degraded Fallback Policy

This needed a stricter statement after the code pass.

### Pure primary-lane teams

For existing non-mixed teams, the current degraded launch-roster fallback behavior can stay:

- `members.meta.json`
- inboxes + `config.json`
- `config.json`

because the primary lane already understands member `provider/model/effort` in that model.

### Persisted mixed-lane teams

For teams that already have mixed-lane evidence, the coordinator must treat these as authoritative inputs:

- `members.meta.json`
- `launch-state.json`

If those files are missing or inconsistent, the product must **not** silently rebuild a mixed-lane plan from inboxes/config fallback only.

### Required degraded behavior

If mixed-lane evidence is missing:

- recover only the canonical team summary and visible roster if possible
- mark runtime/lane reconstruction as degraded
- block or require a fresh relaunch/bootstrap for mixed-lane execution

This is safer than pretending inbox/config fallback can recover member backend/fast/lane truth when the current code proves it cannot.

## Write policy

All new mixed launches must persist:

- member desired overrides in `members.meta.json`
- member resolved lane attribution in `launch-state.json`

Do not remove old team-level fields during rollout.

### Existing relaunch compatibility we can reuse

The current relaunch path already reconstructs member `providerId/model/effort` from `members.meta.json` when relaunching a team.

So mixed-lane persistence work should focus mainly on adding:

- lane attribution
- member-level backend/fast metadata
- resolved launch identity where needed

and should not re-solve the already-working member `provider/model/effort` relaunch behavior from scratch.

## Backup And Restore Compatibility

Because backup already captures `team.meta.json` and `members.meta.json`, this feature should follow a simple compatibility rule:

- only additive field changes in those files during V1
- no rename or shape break of the existing root files

### Required tests

- backup a team with mixed-lane additive member metadata
- restore it
- verify `team.meta.json`, `members.meta.json`, and `launch-state.json` still reconstruct the same desired + resolved member truth

## Dangerous And Thin Places

### 1. Treating lane compatibility as model/effort math instead of runtime ownership policy

This would produce an elegant but wrong planner.

Guardrail:

- first ask which runtime owner is allowed
- only then talk about model/effort/backend specifics

### 2. Letting side-lane adapters write canonical roster artifacts

That caused the missing-lead bug class already.

Guardrail:

- canonical roster is always written by team-owned code

### 3. Replacing the primary run maps too early

That would destabilize a lot of lifecycle code unrelated to mixed teams.

Guardrail:

- keep primary maps
- add side-lane maps

### 4. Claiming schedule parity too early

This would create a misleading plan and likely bugs.

Guardrail:

- keep current scheduler explicitly out of scope

### 5. Allowing multi-member secondary lanes in V1

That creates grouping bugs before ownership is stable.

Guardrail:

- V1 side lanes are single-member only

### 6. Mixing primary bootstrap expectations with aggregate mixed-team progress

This would create stuck launches and misleading `"Members joining"` states.

Guardrail:

- primary in-memory `expectedMembers` is subset-only
- persisted launch-state `expectedMembers` stays the full expected roster unless a new explicit field is introduced for the bootstrap subset
- aggregate desired roster is tracked separately

### 7. Treating live lane migration as a simple restart

This would corrupt ownership and attribution.

Guardrail:

- block lane-migration edits in V1
- implement migration later as a separate coordinator-backed increment

### 8. Assuming primary-lane teammates already support member-level backend/fast

This would create hidden runtime drift between persisted desired state and actual spawn behavior.

Guardrail:

- document that primary-lane teammates inherit backend/fast from the lead/runtime owner in V1
- only secondary-lane planning may consume member-level backend/fast earlier

### 9. Passing non-owned members into a side-lane adapter input

This would cause provider-local flattening of failures back onto unrelated members.

Guardrail:

- adapter inputs must be lane-local subsets only
- add tests where one side-lane member fails and no other member inherits that failure

### 10. Trusting `config.json` as canonical mixed-team roster truth

The launch path intentionally normalizes `config.json` to lead-only.

Guardrail:

- `config.json` may remain CLI-facing and lead-centric
- mixed full-roster truth must come from `members.meta.json` and mixed-lane-aware `launch-state.json`

### 11. Reusing the current lead Agent tool add-member/restart seam for secondary lanes

That seam only carries provider/model/effort and assumes the lead owns the teammate spawn.

Guardrail:

- coordinator-managed secondary-lane attachment must bypass the generic lead Agent tool spawn-message path
- V1 must not claim secondary-lane restart/migration support through the current restart helper

### 12. Treating inbox/config fallback as authoritative mixed-lane recovery

That would silently erase member backend/fast/lane truth on relaunch/startup recovery.

Guardrail:

- inbox/config fallback may recover names and basic provider/model/effort only
- persisted mixed-lane teams require `members.meta.json` + `launch-state.json` for authoritative recovery
- if those are missing, degrade explicitly instead of inventing a mixed plan

### 13. Reusing primary-lane env/provider args for side lanes

Primary create/launch resolves env/auth/provider args once for the root request.

Guardrail:

- every secondary lane resolves its own env/auth/provider args
- do not inherit root request provider args into side-lane launches

### 14. Treating renderer parity as optional polish

Today `TeamMemberResolver` is built from `config + meta + inboxes`, not lane-aware launch-state truth.

Guardrail:

- lane-aware `TeamMemberSnapshot` and resolver parity must land before mixed support is enabled
- do not treat this as a post-shipping cosmetic cleanup

### 15. Adding mixed-lane fields without upgrading launch-state normalization

`normalizePersistedLaunchSnapshot(...)` reconstructs known fields and would otherwise drop new member-level lane/runtime data.

Guardrail:

- any mixed-lane schema change must ship with normalizer support
- schema upgrade is not complete until read-normalize-write roundtrips preserve the new fields

### 16. Quietly redefining `expectedMembers`

That field is already used widely for launch badges, summaries, provisioning presentation, and recovery.

Guardrail:

- do not change `expectedMembers` from "full expected roster" to "primary subset"
- add a new explicit field for bootstrap/primary expected members instead

### 17. Choosing bootstrap vs persisted launch snapshot by timestamp only

Mixed teams introduce a structurally richer launch-state than bootstrap-only recovery can express.

Guardrail:

- timestamp-only precedence is not enough once mixed-lane fields exist
- snapshot selection must prefer structurally richer mixed-lane truth over a newer but poorer bootstrap snapshot

### 18. Letting mixed-lane launch-state outgrow Team list / dashboard summary readers

Main runtime storage and summary readers currently have different size budgets.

Guardrail:

- mixed-lane rollout must define an explicit launch-state size budget for summary-safe operation
- preferred V1 answer is a compact summary projection written from canonical snapshot truth, not a blind increase of all reader limits
- if that compact projection does not exist, rollout must stay blocked until reader limits, performance, and summary parity are explicitly re-validated

### 19. Updating summary logic only in one of the two reader paths

Team summaries are read both in-process and through `team-fs-worker`.

The current worker path does **not** use `choosePreferredLaunchSnapshot(...)` and does **not** read bootstrap launch snapshots. It only reads raw persisted `launch-state.json`.

Guardrail:

- schema, precedence, and summary derivation changes must land in both paths together
- preferred V1 answer is a shared summary derivation contract or compact summary artifact consumed by both paths
- if parity cannot be guaranteed, mixed launch-state summary should stay dark rather than diverge between worker and fallback modes

### 20. Treating post-launch `config.json` runtime projection as authoritative mixed truth

The existing config projection writes only provider/model/effort and is intentionally lossy.

Guardrail:

- never reconstruct mixed-lane runtime truth from projected `config.json`
- keep config projection compatibility-focused and minimal unless the CLI itself requires more

### 21. Allowing live roster mutation on running mixed teams in V1

Current live add/remove/replace flows all route through lead-side messaging and primary-lane assumptions.

Guardrail:

- V1 mixed support should block live roster mutation on running mixed teams
- require stop/edit/relaunch until a coordinator-owned live mutation model exists

### 22. Treating provider-local `OpenCode` runtime stores as if they were already lane-scoped

The current `.opencode-runtime` namespace is team-scoped and single-active-run-scoped.

Guardrail:

- keep provider-local `OpenCode` launch-state/manifest/transaction files separate from global mixed-team `launch-state.json`
- do not multiplex multiple `OpenCode` side lanes into the same provider-local store namespace in V1

### 23. Assuming multiple `OpenCode` side lanes are possible without changing the bridge contract

The current `OpenCode` launch command takes one `selectedModel` for the whole provider-owned run.

Guardrail:

- V1 mixed support must reject drafts with more than one `OpenCode` teammate
- future multi-`OpenCode` support requires both lane-scoped runtime-store namespacing and a bridge/API seam that can represent lane-local model ownership truthfully

### 24. Reusing the legacy "expected teammates vs confirmed artifacts" summary fallback for mixed teams

Current Team list / dashboard fallback summary logic infers partial launch failure by comparing:

- expected teammate names from config/meta
- confirmed artifacts such as config members and inbox files

That heuristic is not lane-aware.

For mixed teams, a side-lane member can be legitimately absent from primary-lane artifacts during bootstrap or attachment without meaning "launch failed".

Guardrail:

- once a team is mixed-aware, summary fallback must not reuse the legacy artifact-count heuristic as if it were canonical launch truth
- mixed teams should prefer canonical lane-aware snapshot/projection truth
- if that truth is missing, summary should degrade to unknown/pending rather than inventing a partial failure

### 25. Reusing the current primary-run `persistLaunchStateSnapshot(...)` as the canonical mixed snapshot writer

Today `persistLaunchStateSnapshot(run)` writes `launch-state.json` from one `ProvisioningRun` and uses:

- `run.expectedMembers`
- `run.memberSpawnStatuses`
- `run.provisioningComplete`

That is safe for a single primary run, but unsafe for mixed teams because:

- primary `run.expectedMembers` is only the bootstrap subset
- a clean-success primary run currently clears persisted launch-state entirely
- aggregate mixed truth may still include pending or failed side lanes

Guardrail:

- mixed teams need an aggregate snapshot writer owned by the coordinator, not direct reuse of the current primary-run persistence helper as canonical truth
- primary-lane snapshot persistence may remain lane-local input, but it must not overwrite or clear the global mixed-team launch snapshot on its own

### 26. Letting `createPersistedLaunchSnapshot(...)` auto-fail not-yet-attached side-lane members

Current `createPersistedLaunchSnapshot(...)` upgrades members from `starting` to `failed_to_start` whenever:

- `launchPhase !== 'active'`
- the member never reached spawned/alive/confirmed signals

That is a good repair for single-lane crashed launches, but dangerous for mixed teams if:

- the primary lane flips out of `active`
- a planned side lane has not attached yet
- the aggregate launch is not actually terminal

Guardrail:

- aggregate mixed `launchPhase` must stay `active` until every planned side lane is terminal or explicitly removed from the plan
- primary-lane completion must not by itself trigger terminalization of still-planned side-lane members
- if V1 cannot enforce that invariant, mixed aggregate snapshot creation must use a separate terminalization policy instead of reusing the default helper unchanged

### 27. Reusing bootstrap-specific pending copy for mixed side-lane attachment

Current Team list / Team detail copy for `partial_pending` talks in bootstrap terms such as:

- teammate still joining
- runtime pending bootstrap

For mixed teams, `partial_pending` may instead mean:

- primary lane is already ready
- one side lane has not attached yet
- one side lane is reconciling provider-local runtime truth

Guardrail:

- mixed renderer states must not over-interpret aggregate `partial_pending` as bootstrap-only
- once a team is mixed-aware, pending copy should become lane-aware or neutral, for example "launch still reconciling" rather than "pending bootstrap"

## Rollout Plan

## Phase 0 - Additive contracts and persistence parity

**Commit boundary**: `feat(team-runtime): add additive mixed-lane contracts`

`🎯 10   🛡️ 10   🧠 4`  
Roughly `420-750` lines

### Scope

- extend shared member runtime contracts with `providerBackendId` and `fastMode`
- extend `TeamMemberSnapshot` and persisted launch member contracts with lane-aware additive fields
- extend `members.meta.json` read/write shape
- extend launch-state member shape additively
- upgrade launch-state normalizer/read path so the new fields survive roundtrip
- add explicit mixed-safe roster fields instead of redefining `expectedMembers`
- define a mixed-safe launch-state size budget for summary readers
- choose a summary-safe read strategy for Team list / dashboard, preferably a compact summary projection derived from canonical snapshot precedence
- define aggregate mixed-team snapshot ownership so primary-lane persistence helpers cannot overwrite or clear canonical mixed truth
- no behavior change yet

### Tests

- backward-compatible meta read/write
- backward-compatible launch-state normalization
- launch-state roundtrip preserves new additive mixed-lane fields
- old readers still see `expectedMembers` as full expected roster
- summary readers continue to read mixed launch-state within the agreed size budget
- summary strategy tests prove worker and in-process readers agree even when bootstrap snapshot and persisted launch-state disagree on recency
- aggregate snapshot tests prove primary-lane clean-success does not clear pending mixed side-lane truth
- member contract serialization tests
- backup/restore compatibility for additive member runtime metadata
- explicit semantic tests proving primary-lane teammates still inherit backend/fast in V1
- `TeamMemberSnapshot` compatibility tests for sparse old teams

## Phase 1 - Coordinator shell plus resolver parity

**Commit boundary**: `feat(team-runtime): introduce mixed-lane coordinator shell`

`🎯 9   🛡️ 10   🧠 6`  
Roughly `520-900` lines

### Scope

- add `TeamRuntimeLaneCoordinator`
- keep current primary launch path untouched behaviorally
- add side-lane tracking maps without enabling mixed behavior yet
- make `TeamMemberResolver` and related team-view snapshot assembly lane-aware for additive fields
- centralize Team summary derivation so `TeamConfigReader` and `team-fs-worker` consume the same mixed-summary contract instead of reimplementing snapshot choice independently
- introduce coordinator-owned aggregate launch-state assembly so lane-local progress feeds one canonical mixed snapshot
- primary-only teams remain identical

### Tests

- single-provider create/launch parity
- no regression in pure `OpenCode` gated path
- no regression in stop/reconcile for primary-only teams
- no regression in existing mixed primary-lane member `provider/model/effort` behavior
- team view remains stable for old teams with no mixed-lane fields
- lead synthesis still works when lane-aware fields are missing
- worker and in-process team summary paths derive the same launch summary from the same mixed snapshot
- worker and in-process paths agree when bootstrap snapshot is newer than persisted launch-state and when persisted launch-state is structurally richer than bootstrap snapshot
- mixed-aware teams do not fall back to the legacy artifact-count partial-failure heuristic when canonical lane-aware snapshot truth is missing
- lane-local primary snapshot updates do not clear or terminalize the aggregate mixed snapshot prematurely

## Phase 2 - Enable `OpenCode` single-member secondary lanes

**Commit boundary**: `feat(team-runtime): enable opencode secondary member lanes`

`🎯 9   🛡️ 9   🧠 8`  
Roughly `650-1100` lines

### Scope

- remove team-wide `OpenCode` capture logic
- allow one `OpenCode` member to become a single-member secondary lane
- reject mixed drafts with more than one `OpenCode` teammate with a clear unsupported-in-v1 message
- exclude secondary-lane members from primary bootstrap spec and primary `expectedMembers`
- launch primary lane plus side lanes
- merge lane results into member-scoped launch-state
- keep aggregate mixed `launchPhase` active until all planned lanes are terminal, even if the primary lane finishes earlier

### Tests

- `Codex` lead + `OpenCode` teammate
- `Anthropic` lead + `OpenCode` teammate
- `Gemini` lead + `OpenCode` teammate
- multiple `OpenCode` teammates in one mixed team are rejected explicitly in V1
- primary lane does not wedge waiting for side-lane members
- one failing `OpenCode` side lane does not flatten failure onto other members
- mixed launch keeps `config.json` lead-only while `members.meta.json` retains the full desired roster
- every `OpenCode` side lane resolves its own env/auth/provider args instead of reusing the lead launch env
- global mixed-team `launch-state.json` and provider-local `.opencode-runtime/launch-state.json` remain separate and do not overwrite each other
- primary-lane clean-success does not clear aggregate mixed launch-state while a side lane is still pending

## Phase 3 - Lifecycle parity for mixed persistent teams

**Commit boundary**: `feat(team-runtime): add mixed-lane lifecycle parity`

`🎯 8   🛡️ 9   🧠 7`  
Roughly `450-850` lines

### Scope

- mixed relaunch
- mixed restore/startup recovery
- mixed stop
- mixed reconcile
- explicit blocking for unsupported live lane-migration edits
- explicit degraded-state handling when persisted mixed-lane truth is missing and only inbox/config fallback is available
- explicit blocking for live side-lane add-member in V1
- mixed-safe snapshot precedence when bootstrap and persisted launch-state disagree
- mixed-safe summary precedence in both Team summary reader paths
- explicit blocking for live roster mutation on running mixed teams

### Tests

- create -> launch -> relaunch
- create -> launch -> stop
- startup recovery with stale secondary lane
- partial side-lane failure stays member-scoped
- live lane-migration edit is rejected with a clear message
- relaunch preserves primary-lane member `provider/model/effort` and does not invent member-level backend/fast behavior
- persisted mixed-lane recovery degrades explicitly when `members.meta.json` or lane-aware `launch-state.json` is missing
- live side-lane add-member attempt is rejected with a clear unsupported-in-v1 message
- richer persisted mixed launch-state wins over a newer bootstrap-only snapshot when both exist
- Team list / dashboard summary stays stable in both worker and in-process modes for the same mixed team
- live `addMember` / `replaceMembers` / `removeMember` on a running mixed team are rejected with clear stop-edit-relaunch guidance

## Phase 4 - Renderer truth and diagnostics polish

**Commit boundary**: `feat(team-runtime): surface mixed-lane member truth in ui`

`🎯 8   🛡️ 8   🧠 5`  
Roughly `180-320` lines

### Scope

- member lane labels
- member-scoped failure copy
- mixed-aware pending/reconciling copy that does not pretend every pending state is "bootstrap pending"
- cleaner diagnostics and affordances on top of already-landed resolver parity

### Tests

- Team Detail shows lead reliably
- member rows show provider/runtime truth
- side-lane failure does not flatten team-wide
- Team list/detail pending copy stays truthful when the primary lane is ready but a side lane is still attaching or reconciling

## Future Phase - Live mixed-team roster mutation

Not part of the first mixed-team rollout.

Only start this after primary mixed launch/relaunch/recovery is stable.

### Scope

- add or remove members on a running mixed team
- replace member roster on a running mixed team
- restart a secondary-lane member through a coordinator-owned path
- explicit migration workflow for primary <-> secondary lane changes

### Why this is deferred

The current live add/remove/replace/restart seams are lead-Agent-tool-based or lead-message-based and do not carry enough runtime metadata for side-lane ownership. Shipping them in V1 would be materially riskier than fresh mixed launch support.

## Future Phase - `OpenCode` lane-scoped runtime namespace and multi-`OpenCode` mixed teams

Not part of the first mixed-team rollout.

Only start this after the single-`OpenCode`-teammate V1 is stable.

### Scope

- introduce lane-scoped provider-local runtime-store namespace, for example `.opencode-runtime/<laneId>/...`
- replace team-scoped single active-run assumptions in manifest/transaction/permission stores
- extend bridge/API contracts so `OpenCode` side-lane launches can represent lane-local model ownership truthfully
- only after that allow more than one `OpenCode` teammate inside the same mixed team

## Future Phase - Scheduled team runtime coordinator

Not part of this feature.

Only start this when the product adds a real scheduled team-runtime flow distinct from the current one-shot scheduler.

## Test Plan

## Main-process tests

- member desired-contract inheritance from lead defaults
- lane partition policy: primary-eligible vs secondary-required
- launch-state merge preserves per-member attribution
- side-lane run tracking does not break primary run tracking

## Integration tests

- mixed create writes full canonical roster
- mixed launch persists member lane attribution
- mixed relaunch uses persisted member truth, not current global defaults
- side-lane stop/reconcile only affects side-lane members
- mixed launch/relaunch never treats lead-only `config.json` as the canonical full roster source
- degraded inbox/config fallback for a mixed team does not silently reconstruct `OpenCode` back onto the primary lane
- team-view snapshots reflect lane-aware persisted truth instead of flattening back to config/meta-only labels
- Team list / dashboard summaries still read mixed launch-state within the supported size budget
- mixed drafts with more than one `OpenCode` teammate are rejected explicitly in V1
- global mixed-team `launch-state.json` and provider-local `.opencode-runtime/launch-state.json` remain disambiguated
- mixed Team list / dashboard summaries do not infer partial failure from missing side-lane artifacts while the team is still launching

## Renderer tests

- lead row remains visible even when old data is sparse
- mixed team rows show member-level runtime truth
- partial failure UI remains member-scoped

## Live Signoff

Required live signoff before rollout:

1. `Codex` lead + `OpenCode` teammate
2. `Anthropic` lead + `OpenCode` teammate
3. `Gemini` lead + `OpenCode` teammate
4. mixed team relaunch
5. mixed team stop and restart
6. startup recovery with an interrupted side lane
7. Team Detail truth matches persisted lane/member runtime identity for a mixed team
8. mixed draft with two `OpenCode` teammates is rejected with a clear unsupported-in-v1 message

## Final Recommendation

Implement mixed teams as:

- one canonical primary team bootstrap lane
- additive single-member secondary lanes where runtime ownership truly requires it
- in V1, at most one `OpenCode` secondary teammate per mixed team
- member-scoped persistence before behavior changes
- side-lane tracking added beside, not instead of, current primary run maps
- fresh mixed launch/relaunch/recovery first, with live side-lane attachment deferred

This is the most reliable and scalable path because it:

- matches the real code
- fixes the `vector-room-7` class of bugs directly
- keeps working bootstrap behavior intact
- gives us a clean extension point for future side-lane providers without over-engineering V1
