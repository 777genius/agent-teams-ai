# Team extension launch readiness: evidence and options

Research checkpoint: 2026-10-26. Initial app source review was at
`837e428d7bc513068ee041db6de7c4c407a17fdd`; two independent reviews informed this
follow-up. App boundaries were rechecked at
`705bd0855ba8dd6438bfcd24d0babbb759b29923`, alongside the pinned orchestrator
`v0.0.139` and UAP
`e84b4da218f4445986daa9ed15f40acd828ae06f`. Source links retain the inspected
revisions. An SDK/source pin refresh does not itself qualify agent launches.

## Owner direction and current conclusion

The requested outcome includes installing extensions and launching teams whose
members can actually discover and use the intended Skills and plugin MCP tools.
The latest owner direction is to research complex or risky launch changes and
discuss the alternatives before implementing them. This is a proposal and an
evidence checkpoint, not an amendment to the accepted architecture or a claim
that S25/S26 are complete.

The existing integration qualifies substantial installation and management
behavior. It does **not yet establish that every member launched by the desktop
app uses the same native extension environment**. One conditional Codex profile
divergence was reproduced with the real app resolution code and isolated test
boundaries. The historical report that agents saw MCP but not Skills has not
been reproduced against the owner's actual team or profiles.

The recommended sequence is **A: align and qualify user-scope launches, then B:
complete the focused project/worktree preparation boundary**. Defer C, per-run
profile overlays. The [accepted project/worktree boundary][plan-boundary] already
allows a focused provisioning port; importing the whole draft Host migration
PR #982 is not a prerequisite for that port.

## What runs today

| Boundary           | Source behavior                                                                                                                                                                                                                                                                                           | Consequence for extension availability                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extensions capture | [Desktop composition][capture] derives explicit native roots from a passive environment and captures executable paths. Its installation scope is currently user.                                                                                                                                          | UAP operates on those captured profiles; this is not a promise about every later process environment.                                                                           |
| Team environment   | [Provisioning environment][provisioning-env] resolves shell HOME, custom Claude configuration, provider/backend and credentials. [Provider environment resolution][provider-env] applies the selected Codex runtime context for ordinary launches. Gateway members take a separate `runtime-only` branch. | Launch profile identity must include the actual member/backend path, not only the label `codex` or `claude`.                                                                    |
| Team MCP           | [Team MCP configuration][team-mcp] explicitly provides the app's `agent-teams` server. [Member MCP configuration][member-mcp] also carries member policy, setting sources and strictness.                                                                                                                 | Task/mailbox/team tools can work even when an installed plugin's MCP server or Skills are absent.                                                                               |
| Skills             | The reviewed [bootstrap specification][bootstrap] and launch prompt builders carry native configuration and bootstrap instructions, not copies of every UAP Skill body.                                                                                                                                   | Skill availability depends on native discovery in the effective profile, working directory, settings and policy. Injecting Skill text into a prompt would be a different proof. |
| Runtime process    | [Deterministic launch][launch-args] invokes the orchestration runtime with a bootstrap spec. [OpenCode bridge dispatch][bridge-dispatch] starts `runtime opencode-command`; the semantic member CWD is carried through its command contract.                                                              | Inspect the actual downstream member/session, not just the outer Electron or bridge process CWD.                                                                                |

There are two distinct MCP assertions: **the built-in Agent Teams MCP works**,
and **the UAP-installed plugin MCP works**. The first cannot substitute for the
second. A plugin may additionally contain Skills; its MCP connection cannot
establish that those Skill bodies reached the native agent.

### Native discovery and policy qualifications

- **Claude:** official [Skill documentation][claude-skills] distinguishes startup
  discovery of metadata from loading a Skill body on invocation. Explicit
  `settingSources` can include or exclude personal/project Skills. The app's
  [MCP scope policy][mcp-policy] maps `inheritScopes` to setting-source arguments;
  therefore a setting presented as MCP scope can also affect native Skill
  discovery. This is a concrete coupling to qualify, not a reproduced cause of
  the reported incident. Default, `appOnly` and `strictAllowlist` currently keep
  all three setting sources; strict MCP configuration is a separate argument.
  Forcing every source on would change native configuration and hook policy.
  [Claude settings documentation][claude-settings] also identifies
  `CLAUDE_CONFIG_DIR` as a home-configuration override.
- **Codex:** pinned upstream [skill-root source at `rust-v0.153.4`][codex-roots]
  reads both the legacy `$CODEX_HOME/skills` user location and `$HOME/.agents/skills`,
  with separate project and plugin roots. Changing `CODEX_HOME` can lose
  profile-local Skills/plugin registration while shared home Skills remain
  visible. A blanket assertion that all Codex Skills disappear would be wrong.
- **OpenCode:** official [Skills documentation][opencode-skills] describes native
  discovery from project/global OpenCode, Claude-compatible and agent-compatible
  roots, and loading through the native `skill` tool. Its [configuration
  documentation][opencode-config] describes merged sources and custom
  `OPENCODE_CONFIG_DIR`. Effective runtime policy, origin and version must be
  observed in the launched session.

Official documentation was checked on 2026-10-26. It describes current behavior,
not a test result for every pinned native version. The Codex source above was
also inspected from the pinned tag; the retrieved file blob was
`ac2bf3e9cdf8ccf0c396f011f3dbb8f515db39c7`.

### The final working directory has different owners

[OpenCode workspace preparation][opencode-workspaces] explicitly filters
OpenCode members, resolves their worktrees and assigns the resulting
`member.cwd` before its runtime launch. That is a usable preparation seam for
OpenCode.

The deterministic [Claude/Codex bootstrap specification][bootstrap] currently
passes the request's CWD plus `isolation: 'worktree'`; its own comment states
that the runtime owns per-member isolation. A top-level `--worktree` is also
passed downstream by [launch argument construction][launch-args]. The pinned
orchestrator's [`normalizeMember`][runtime-member-normalization] explicitly
omits `member.cwd` when `isolation` is `worktree`. Passing a prepared CWD in that
bootstrap spec therefore cannot bind the isolated member to it. Disabling
isolation to retain CWD would change worktree ownership and lifecycle behavior.

An app hook at the OpenCode seam cannot qualify every Claude/Codex member's
final directory. The required seam is after the existing runtime has allocated
the actual member worktree and before the native session starts. The runtime
must expose that final CWD through a qualified preparation handshake; a source
checkout path or a guessed future worktree path is insufficient.

There is also a CWD-dependent MCP boundary: the app's
[`buildRuntimeBootstrapMemberMcpLaunchConfigs`][member-mcp-current] builds member
configuration from `member.cwd || input.cwd` before the downstream runtime has
resolved those isolated directories. With strict MCP configuration, restoring
files into the final worktree alone would not prove that the generated config
contains its project MCP entries. Final-CWD preparation must bind both UAP
projection and CWD-derived MCP/settings resolution to the same member directory,
while preserving that member's existing allowlist, strictness and setting
sources. This is a source-level risk to qualify, not a reproduced plugin failure.

Copying a source checkout's `.uap` state into a worktree is not the accepted
solution. The plan requires restoring the exact locked dependency selection into
the actual execution directory through UAP, preserving scope ownership.
At the inspected UAP revision, [Management startup and environment identity][uap-context]
still explicitly use the user-scope contract. Existing [Claude][uap-claude-project]
and [OpenCode][uap-opencode-project] project CLI contracts are useful foundations;
they do not automatically extend the Management API or app launch boundary.

## Reproduced conditional Codex profile divergence

[Extension capture][capture] reads ambient `CODEX_HOME` or a HOME-based default.
[Launch context application][codex-runtime-context] overwrites `CODEX_HOME` with
`snapshot.runtimeContext.codexHome`. That snapshot field originates in the
native app-server's initialize response via [account snapshot creation][account-context];
it should not be described as necessarily being a separate directory for each
account.

The existing [passive account-context projector][passive-context] can reuse a
cached snapshot without refreshing it. Ordinary launch instead calls
[`getCodexLaunchSnapshot`][codex-launch-refresh] with
`refreshRuntimeMissing` and `refreshBlockedLaunch`, and can re-resolve the native
binary/context. A shared cached projection is a useful input to A, but does not
close this refresh race by itself. The final launch environment must still agree
with the captured non-secret identity, or require a fresh review before spawn.

A temporary diagnostic exercised the real desktop composition, provider
environment builder and `ProviderConnectionService`. Only external environment,
native executable, SDK transport and account-snapshot boundaries were replaced
with disposable fixtures. The successful diagnostic spawned no native client
and used no real user profile or credential.

Reproduction outline:

1. Create a temporary HOME and an ambient Codex root A. Capture the real desktop
   extension context, recording the targets supplied to the stub SDK transport.
2. Supply a healthy fixture account snapshot with runtime home A through
   `setCodexAccountFeature`. Build the real launch environment; captured and
   launch roots are equal.
3. Change only the fixture snapshot's runtime home to B. Build the real launch
   environment again. It now uses B, while the captured UAP target still uses A.
4. Re-observe the captured extension context. Its current-profile check still
   accepts it because that check repeats passive ambient capture.

Observed result:

```json
{
  "proof": "actual-app-source-profile-resolution",
  "captured": "ambient-codex-profile",
  "aligned": "ambient-codex-profile",
  "selectedLaunch": "selected-account-codex-profile",
  "contextStillAccepted": true,
  "nativeSpawned": false
}
```

The temporary harness is `/tmp/uap-profile-root-proof/proof.test.ts`, with
`/tmp/uap-profile-root-proof/vitest.config.mjs`. From the app checkout:

```sh
node node_modules/vitest/vitest.mjs run --config /tmp/uap-profile-root-proof/vitest.config.mjs --maxWorkers=1
```

Result: one diagnostic test passed. These temporary files are not durable
repository fixtures; the outline above and existing
[profile admission tests][profile-tests] and [provider connection tests][connection-tests]
describe the boundaries needed to recreate it. The diagnostic deliberately
asserted divergence. It must **not** become a passing CI regression test that
normalizes the defect. A fix should instead test root agreement or an explicit
refusal when identity changes.

This establishes a conditional integration discrepancy. It does not establish
that the owner's native account currently returns a different home, that a
live native process lost a Skill, or that this caused the historical incident.
The ordinary same-root control passed.

## Evidence still needed for actual teams

Current [desktop native MCP proof][tool-proof] requires OpenCode `1.18.34` and
uses a real native client with a scripted loopback provider. The app's
[runtime lock][runtime-lock] pins orchestrator `v0.0.139` and includes qualified
OpenCode v2 versions, including `2.1.4` on several platforms. UAP also has v2
adapter coverage; this is a qualification gap, not a demonstrated
incompatibility. A standalone 1.x proof cannot qualify an actual v2 team lane.

Record these levels independently for **each expected team member**, including
the lead when it executes work:

| Level             | Required evidence                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed files   | UAP operation/lock identity, native target root and installed byte digests.                                                                             |
| Native discovery  | Exact Skill/plugin origin, enabled state and native discovery surface for the effective member environment. A filesystem listing alone is insufficient. |
| Skill body use    | Native Skill invocation/loading evidence and a result that requires content found only inside the installed Skill/supporting file.                      |
| Plugin MCP use    | That member's native `initialize`, tool discovery and `tools/call`, followed by the server's fresh result returning to the same member session.         |
| Actual app launch | App run/member/session identity, effective native binary/version, final CWD and non-secret profile identity bound to those observations.                |

A minimal qualification fixture should install a small package through the app,
then use the real app team-creation/launch entrypoint. Give the Skill a fresh
random challenge in its body or supporting file; exclude that challenge from
the task prompt, Skill description, bootstrap prompt and MCP schema. Ask the
member to use the named Skill, require the native loading event or equivalent
documented native evidence, and validate the challenge. A generic filesystem
search or prompt containing the Skill body must not satisfy the native-discovery
assertion.

Give the plugin MCP server a separate server-only nonce. Retain per-member
native events and server request/result evidence so one successful lead cannot
stand in for all teammates. Reuse the existing bounded loopback-provider pattern
where the runtime supports it, labeling it as scripted-provider execution;
qualify real-model/OAuth behavior separately. Include fresh launches after
removal, a sibling project/profile control, a selected custom Codex home, and an
isolated worktree once its preparation path is implemented. Policy-denied
Skills/tools should produce the expected unavailable result without relaxing
the user's policy.

## Alternatives for discussion

These are proposals for owner discussion, not implementation approval. The
independent reviews agree on A before B and on deferring C. The pinned runtime
normalization is now verified; the required preparation handshake still needs
design and qualification, so the scope descriptions are not delivery estimates.

| Option                                                             | Change and benefit                                                                                                                                                                                                   | Scope and remaining risk                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Shared profile identity and actual user-scope qualification** | Reuse the non-secret context projection for effective HOME, native root, binary and member/backend identity. Compare it with the final launch environment after any refresh; add actual-team discovery/use evidence. | Smallest production boundary. Must handle missing/stale snapshots and gateway/runtime-only branches explicitly. Root agreement still needs native loading/use proof. Does not complete S25/S26.                           |
| **B. Focused project/worktree preparation**                        | Qualify UAP Management project scope and restore exact locked dependencies in the runtime's final member CWD before native spawn, with MCP/settings resolved for that same CWD.                                      | Requires an explicit runtime/provisioning handshake for Claude/Codex; the pinned bootstrap CWD field cannot provide it under worktree isolation. Scope, admission, recovery and member policy remain qualification gates. |
| **C. Per-run isolated native profiles/overlays**                   | Give each run an explicit extension/config snapshot with stronger isolation.                                                                                                                                         | Adds profile lifecycle, precedence, authentication and trust ownership. `CODEX_HOME` alone still shares HOME Skill roots; changing HOME also affects credentials and trust. Defer until a separate design is justified.   |

### A: shared identity without profile migration

For A, calling the active launch environment builder from passive Extensions
capture would introduce unrelated runtime/auth work. The existing
`applyPassiveProviderStatusConnectionEnv` explicitly avoids credential
decryption, account refresh, runtime installation and login commands; a focused
identity projection can preserve that contract. Capture canonical HOME, native
configuration root, actual executable and the effective provider/backend/member
route. HOME is independently relevant because compatible Skill roots may sit
outside the native config root. Recheck the identity against the actual launch
environment after account/runtime refresh; a stale or missing snapshot cannot
silently establish agreement. Gateway members using `runtime-only` must retain
their own routing instead of inheriting the global selected account.

If the selected profile changes from A to B, existing files remain in A. The
proposed behavior is a fresh context and explicit review for B, with no copying
of Skills, plugins, credentials, native configuration or trust decisions between
profiles. An already running member may still use A: preserve the current
conservative provider-level admission until captured active-run identities can
prove a narrower lock is safe. Merely changing the selected account must not
unlock an older run's profile.

### B: prepare at the actual runtime boundary

Keep the existing ownership split: the runtime allocates and owns worktrees;
UAP owns locked dependency restore and native projection; the app's launch
coordinator owns admission and member policy. A focused preparation port should
connect those owners without adding a plugin manager, copying `.uap` ownership
state or creating a second worktree scheduler. The required order is:

1. Obtain the runtime's final canonical member CWD and effective profile identity
   after allocation, including the executing lead where applicable.
2. Prepare/apply the exact reviewed dependency lock for that directory through
   qualified UAP project scope, retaining operation identity for recovery and
   retry. Launch preparation must not silently resolve newer dependencies.
3. Resolve CWD-dependent MCP/settings configuration for the same directory,
   preserving the member's allowlist, setting sources, strictness and native
   trust requirements. A denied source or tool remains denied.
4. Recheck identity and hand off admission to native spawn. Failure, cancellation,
   timeout or mismatched identity prevents the affected launch. Cleanup is
   limited to resources owned by that preparation/run.

[ExtensionRuntimeGate][gate] currently rejects a mutation when overlapping
resources are already marked as launching. Calling public UAP Apply inside the
existing `admitLaunch` operation would self-refuse on overlapping resources.
The narrow port therefore needs an ordered preparation-to-launch admission
handoff with no unguarded interval. A bypass flag would discard the protection
this integration already qualifies.

The recommended next decision is A as a small reviewed correction and
qualification milestone, followed by B in separately reviewable engine and
runtime/provisioning slices, after discussing the profile-change behavior and
final-CWD contract with the owner. Neither proposal is accepted by this note.
Keep installation, discovery, body use and plugin MCP results separate until
the exact app-launched member evidence supports the full claim.

## Additional detected installation targets

The requested selector starts with Claude, Codex and OpenCode checked and shows
additional detected clients unchecked. This is a separate installation-target
task; showing a client does not qualify it as a team runtime. Management can
authorize only targets captured by the trusted host at startup.

UAP already owns reusable read-only native detection:
[`clientdetect.Detector.Detect`][uap-detector] returns configuration roots and
executable paths without executing discovered binaries. There is currently no
supported external wire API exposing both facts for trusted host capture.
[`doctor --format json`][uap-doctor] deliberately omits paths; the
[Skill Picker target projection][uap-picker-targets] has no executable and its
`displayPath` can be a projection destination. Management Session returns the
explicit startup targets rather than discovering more clients. Completing host
capture needs a separately reviewed Go contract using that existing detector;
duplicating client path rules in TypeScript or treating display paths as
authority would create inconsistent ownership.

[plan-boundary]: uap-management-integration-plan.md#projectworktree-boundary
[capture]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/features/extension-management/main/composition/createDesktopExtensionManagement.ts#L58
[provider-env]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/runtime/providerAwareCliEnv.ts#L65
[provisioning-env]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningEnvBuilder.ts#L305
[team-mcp]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/TeamMcpConfigBuilder.ts#L565
[member-mcp]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningMemberMcpLaunchConfig.ts#L83
[member-mcp-current]: https://github.com/777genius/agent-teams-ai/blob/705bd0855ba8dd6438bfcd24d0babbb759b29923/src/main/services/team/provisioning/TeamProvisioningMemberMcpLaunchConfig.ts#L75
[runtime-member-normalization]: https://github.com/777genius/agent_teams_orchestrator/blob/v0.0.139/src/services/teamBootstrap/teamBootstrapSpec.ts#L275
[bootstrap]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningBootstrapSpec.ts#L35
[launch-args]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningLaunchTeamFlow.ts#L508
[bridge-dispatch]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient.ts#L394
[mcp-policy]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/shared/utils/teamMemberMcpPolicy.ts#L127
[opencode-workspaces]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningPrepareCoordinator.ts#L810
[codex-runtime-context]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/runtime/ProviderConnectionService.ts#L314
[account-context]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/features/codex-account/main/composition/createCodexAccountFeature.ts#L614
[passive-context]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/runtime/ProviderConnectionService.ts#L785
[codex-launch-refresh]: https://github.com/777genius/agent-teams-ai/blob/705bd0855ba8dd6438bfcd24d0babbb759b29923/src/main/services/runtime/ProviderConnectionService.ts#L1601
[profile-tests]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/test/features/extension-management/nativeProfileAdmission.test.ts
[connection-tests]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/test/main/services/runtime/ProviderConnectionService.test.ts
[tool-proof]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/scripts/e2e/uap-management-tool-use.ts#L18
[runtime-lock]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/runtime.lock.json
[gate]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/features/extension-management/core/application/ExtensionRuntimeGate.ts
[uap-context]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/cli/internal/agentpluginscli/management_context.go#L22
[uap-claude-project]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/docs/CLAUDE_PROJECT_INSTALLATION.md
[uap-opencode-project]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/docs/OPENCODE_PROJECT_SCOPE.md
[uap-detector]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/install/integrationctl/agentplugins/adapters/clientdetect/detector.go#L81
[uap-doctor]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/cli/internal/agentpluginscli/read.go#L68
[uap-picker-targets]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/cli/internal/agentpluginscli/skills_picker.go#L203
[claude-skills]: https://code.claude.com/docs/en/agent-sdk/skills
[claude-settings]: https://code.claude.com/docs/en/settings
[codex-roots]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/skills/src/host_roots.rs#L87
[opencode-skills]: https://opencode.ai/docs/skills/
[opencode-config]: https://opencode.ai/docs/config/
