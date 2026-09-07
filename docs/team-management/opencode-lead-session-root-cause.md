# OpenCode lead without a committed session: root cause

Investigated 2026-09-07. This document exists because the symptom was diagnosed
three times, each time one layer too shallow, and because the fix that shipped
first treated the symptom rather than the cause. If you are here to change
anything about OpenCode lead bootstrap, read this before you do.

## The symptom

A team on the OpenCode runtime launches, looks alive in the UI, and the lead
answers nobody. Every message to it - from the user, from teammates, from the
board - is refused with:

```
No stored OpenCode session record for <team>/primary/team-lead
```

The delivery row spends its whole attempt budget in under a minute, settles
`failed_terminal`, and stays that way for the life of the team. Nothing recovers
it. The user sees a team that is running and silent, with no indication why.

## The root cause

**On the `pure_opencode_member_lanes` path, no launch command was ever sent for
the lead.**

Not a race, not a timeout, not a lost response. The lead was absent from the
roster the app asked the orchestrator to launch.

The chain:

1. The lane planner (`planTeamRuntimeLanes`) works on the **teammate** roster.
   `isLeadMember` is filtered out during normalization, in both
   `selectMembersMetaTeammates` and `extractTeammateSpecsFromConfig`. No plan it
   produces names a lead - that is true of all five of its modes and is part of
   its contract.
2. The lead is synthesized back in exactly one place,
   `buildOpenCodeRuntimeAdapterLaunchMembers`, whose result is
   `runtimeLaunchMembers`.
3. That result reached only `runOpenCodeTeamRuntimeAdapterLaunch`. The aggregate
   path was handed `lanePlan.primaryMembers`, which never contained a lead.
4. `config.json` records the lead regardless
   (`TeamProvisioningOpenCodeTeamConfigWriter`), so the app then addressed a
   member nobody had launched.

When **every** teammate qualified for a side lane, the effect was total:
`primaryMembers` came out empty and `launchOpenCodeAggregatePrimaryLane`
returned at its very first line (`if (effectiveMembers.length === 0) return
null`). No `launchTeam lane=primary` was sent for that team at all, ever.

### When it triggers

The aggregate path is taken when the plan is `pure_opencode_member_lanes`, which
happens when **at least one teammate** has either:

- a model different from the lead's (`usesDistinctModel`), or
- its own working directory or worktree (`usesDistinctRoot`).

A homogeneous team takes `pure_opencode` or `pure_opencode_solo`, where the lead
reaches the bridge normally. That is why the failure looked intermittent.

## The evidence

From the bridge command ledger on a developer machine (2888 records):

| Team | `launchTeam` commands | Primary lane |
|---|---|---|
| `beacon-desk-24` | 3 × secondary only | **never launched**, yet 3 DMs to `primary/team-lead` |
| `zai-managed-heavy-e2e-20260716-202700` | 5 × secondary only | **never launched**, yet 11 DMs to `primary/team-lead` |
| `vector-room-182` | primary + 2 × secondary | launched, but created the session for `tom`, not the lead |

`vector-room-182` is the clearest: the primary lane ran, and it ran a
**teammate**. The orchestrator's session store holds
`vector-room-182::primary::tom`, while the app kept asking for
`vector-room-182/primary/team-lead`.

Of 16 teams with a real OpenCode primary lane on disk, 9 had no committed lead
session.

## What was ruled out, and how

**Upstream OpenCode is not involved.** The string `No stored OpenCode session
record` does not exist in the OpenCode source; it is thrown by our own bundled
orchestrator (`agent_teams_orchestrator`, package `claude-multimodel`). A GitHub
code search for it returns three hits across all of GitHub, none of them in the
OpenCode repository.

Three real OpenCode issues were considered and rejected as causes: they are all
on the ACP transport, and this app talks HTTP (`POST /session`,
`prompt_async` - see `OpenCodeApiCapabilities.ts`). One of them
([#38064](https://github.com/anomalyco/opencode/issues/38064)) actually proves
the opposite of a session-creation race: the session row is durable before the
first prompt.

**A bootstrap timeout is not the cause either.** The orchestrator does have a
narrow MCP readiness budget during bootstrap, and it throws before the session is
written to its store - a real defect, tracked separately. But it cannot explain
these artifacts: for the affected teams no primary launch was attempted, so
there was nothing to time out.

## Why the app never noticed

Three separate places let the failure pass silently. Each is worth keeping in
mind when touching this area:

- **The launch reports success.** The orchestrator's `success()` always returns
  `ok: true`; a member failure lives inside `data.teamLaunchState`. The app's
  ledger records the transport status, so the artifacts read
  `status=completed err=None`.
- **The lead veto has a hole.** `classifyOpenCodePrimaryLeadBootstrap` returns
  `'confirmed'` when the lead is absent from the result. Its comment justifies
  this by `normalizeExpectedOpenCodeRuntimeLaunchMembers` turning a missing
  expected member into `failed_to_start` - but that function is not called
  anywhere in production code.
- **The evidence commit is skipped without a word.** In
  `TeamProvisioningOpenCodeAggregateLaunchPersistence`, a member that is
  confirmed but carries no `runtimeSessionId` hits a bare `continue`.

## Why the self-heal ladder is off by default

`OpenCodePrimaryLaneBootstrapSelfHeal` re-bootstraps a primary lane that holds no
committed session: stop the lane, relaunch it, require committed lead evidence.
It was written as a fix for this symptom and originally shipped enabled.

It is gated behind `CLAUDE_TEAM_OPENCODE_PRIMARY_LANE_SELF_HEAL_ENABLED`, default
off, on the branch of PR #582 - the branch that introduces the ladder in the
first place. Two reasons:

1. **Against this root cause it cannot work.** The re-bootstrap relaunches the
   primary lane through the same code path that omitted the lead in the first
   place. A second attempt omits it again. It would spend two relaunches, tens of
   seconds and the lead's whole context, and end in the same terminal state.
2. **Relaunching a lead unasked is a product decision with a blast radius.** The
   lane-storage probe it depends on keys off a fixed set of evidence filenames.
   If that layout ever changes, the probe starts reporting healthy lanes as
   unbootstrapped, and every user's lead restarts twice per run - with no way to
   stop it short of a new release.

It is kept rather than deleted because the non-aggregate path does launch the
lead, and a genuine bootstrap failure there is exactly what it was built for.
Turn it on deliberately, for a reproduction you understand.

## What is fixed, and what is not

Fixed here, in this repository, on `main`:

| Fix | Where |
|---|---|
| Lead is placed on the aggregate primary lane | `TeamProvisioningOpenCodeRuntimeAdapterTeamFlow` |

The lead is added at the aggregate boundary, not in the planner: the planner's
contract holds for all five of its modes, and only this one path needs the lead
materialized into a roster.

Fixed in the orchestrator, released separately with its binary
(`777genius/agent_teams_orchestrator#65`):

| Fix | Where |
|---|---|
| A failed bootstrap leaves the session record stale instead of deleting it | `cleanupFailedLaunchSession` |

**Still open**, and deliberately so - each rides with the branch that owns the
code, not with this fix:

| Gap | Where it will land |
|---|---|
| Absent lead read as `'confirmed'` by the lead veto | branch of PR #580 |
| Self-heal ladder enabled by default | branch of PR #582 |
| Confirmed member without a session id skipped with a bare `continue` | `TeamProvisioningOpenCodeAggregateLaunchPersistence`, unclaimed |
| Members outside `expectedMembers` dropped from the launch result | `OpenCodeTeamRuntimeAdapter`, unclaimed |

The last two matter for anyone debugging this again: the evidence commit can
still be skipped in silence when a member is confirmed without a session id, so
the original symptom is reachable by a second route even with the launch fixed.

## How to tell it is happening again

- `~/.claude/teams/<team>/.opencode-runtime/lanes/primary/` holds only
  `opencode-prompt-delivery-ledger.json`, with no `opencode-sessions.json`.
- The orchestrator's store
  (`~/Library/Application Support/claude-multimodel-nodejs/opencode/session-store.json`
  on macOS) has no `<team>::primary::<lead>` key, or has one for the wrong
  member.
- The bridge ledger shows `sendMessage` to `primary/<lead>` with no preceding
  `launchTeam lane=primary` for the same team.

The first check to run is the third one: if the launch was never sent, nothing
downstream can explain it.
