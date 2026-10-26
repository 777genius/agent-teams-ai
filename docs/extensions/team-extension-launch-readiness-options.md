# Team extension launch readiness: evidence and options

Research checkpoint: 2026-10-26. App source inspected at
`837e428d7bc513068ee041db6de7c4c407a17fdd`; UAP source inspected at
`e84b4da218f4445986daa9ed15f40acd828ae06f`. The SDK pin refresh being prepared
alongside this note does not itself qualify agent launches.

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
passed downstream by [launch argument construction][launch-args]. Consequently,
an app hook at the OpenCode seam cannot prove preparation of every Claude/Codex
member's final directory. Those lanes need a qualified final-CWD handshake, or
a verified existing contract for preparing and using an explicit directory.
This review did not inspect the pinned orchestrator's complete spawning code.

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

These size ranges are initial engineering estimates, not measured diffs or
delivery promises. The final runtime seam still needs inspection.

| Option                                                             | Change and benefit                                                                                                                                                                                                                                                                         | Scope/risk and approximate size                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Shared profile identity and actual user-scope qualification** | Reuse or extract the non-secret cached context projection already present in [passive provider status][passive-context]. Capture effective HOME, native root, binary and member/backend identity; freeze/recheck the relevant selection at launch. Add actual-team discovery/use evidence. | Lowest production risk. Roughly 100–300 production LOC plus 500–1,000 harness/test LOC. Must handle gateway/runtime-only branches and stale/missing snapshots explicitly. Does not complete S25/S26.                                                                                            |
| **B. Focused project/worktree preparation**                        | Extend qualified UAP Management project scope and restore exact locked dependencies after the final CWD is known, before the native session starts. Use a narrow provisioning/runtime contract.                                                                                            | Completes the original target when all required lanes pass. Roughly 800–2,000 production LOC across affected owners plus 1,000–2,500 test/harness LOC; runtime contract uncertainty may change this. Scope, recovery identity and policy require qualification, not just removal of a UI guard. |
| **C. Per-run isolated native profiles/overlays**                   | Give each run an explicit extension/config snapshot with stronger isolation.                                                                                                                                                                                                               | New architecture beyond the current plan; no credible small LOC estimate yet. `CODEX_HOME` alone still shares HOME Skill roots, while changing HOME affects authentication and trust. Separate native precedence and lifecycle design is required. Defer.                                       |

For A, calling the active launch environment builder from passive Extensions
capture would introduce unrelated runtime/auth work. The existing
`applyPassiveProviderStatusConnectionEnv` explicitly avoids credential
decryption, account refresh, runtime installation and login commands; a focused
identity projection can preserve that contract. Do not assume every gateway
member should inherit the global selected account.

For B, admission needs an explicit ordered preparation-to-launch handoff.
[ExtensionRuntimeGate][gate] currently rejects a mutation when overlapping
resources are already marked as launching. Calling public UAP Apply inside the
existing `admitLaunch` operation would self-refuse on overlapping resources.
The narrow port must coordinate mutation/recovery admission and recheck identity
at spawn without an unguarded interval; it should not bypass those guards.

The recommended next decision is A as a small reviewed correction and
qualification milestone, followed by B in separately reviewable engine and
runtime/provisioning slices, after discussing these options with the owner.
Keep installation, discovery, body use and plugin MCP results separate until
the exact app-launched member evidence supports the full claim.

[plan-boundary]: uap-management-integration-plan.md#projectworktree-boundary
[capture]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/features/extension-management/main/composition/createDesktopExtensionManagement.ts#L58
[provider-env]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/runtime/providerAwareCliEnv.ts#L65
[provisioning-env]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningEnvBuilder.ts#L305
[team-mcp]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/TeamMcpConfigBuilder.ts#L565
[member-mcp]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningMemberMcpLaunchConfig.ts#L83
[bootstrap]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningBootstrapSpec.ts#L35
[launch-args]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningLaunchTeamFlow.ts#L508
[bridge-dispatch]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient.ts#L394
[mcp-policy]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/shared/utils/teamMemberMcpPolicy.ts#L127
[opencode-workspaces]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/team/provisioning/TeamProvisioningPrepareCoordinator.ts#L810
[codex-runtime-context]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/runtime/ProviderConnectionService.ts#L314
[account-context]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/features/codex-account/main/composition/createCodexAccountFeature.ts#L614
[passive-context]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/main/services/runtime/ProviderConnectionService.ts#L785
[profile-tests]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/test/features/extension-management/nativeProfileAdmission.test.ts
[connection-tests]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/test/main/services/runtime/ProviderConnectionService.test.ts
[tool-proof]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/scripts/e2e/uap-management-tool-use.ts#L18
[runtime-lock]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/runtime.lock.json
[gate]: https://github.com/777genius/agent-teams-ai/blob/837e428d7bc513068ee041db6de7c4c407a17fdd/src/features/extension-management/core/application/ExtensionRuntimeGate.ts
[uap-context]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/cli/internal/agentpluginscli/management_context.go#L22
[uap-claude-project]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/docs/CLAUDE_PROJECT_INSTALLATION.md
[uap-opencode-project]: https://github.com/777genius/universal-agent-plugins/blob/e84b4da218f4445986daa9ed15f40acd828ae06f/docs/OPENCODE_PROJECT_SCOPE.md
[claude-skills]: https://code.claude.com/docs/en/agent-sdk/skills
[claude-settings]: https://code.claude.com/docs/en/settings
[codex-roots]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/skills/src/host_roots.rs#L87
[opencode-skills]: https://opencode.ai/docs/skills/
[opencode-config]: https://opencode.ai/docs/config/
