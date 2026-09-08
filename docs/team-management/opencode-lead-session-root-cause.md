# OpenCode lead without a committed session: a closed incident

> **Status: fixed on `main` since 2026-07-20. This is a post-mortem, not an open
> bug.** The defect described here was closed as a side effect of `55dbb5010`
> ("refactor(team): split provisioning service facades"). If you are reading this
> because you are seeing the symptom today, **it is not this bug** - jump to
> [Is it this bug?](#is-it-this-bug) before you change anything.

Written 2026-09-07, after an investigation that reached the right mechanism and
the wrong conclusion. Both halves are recorded on purpose: the mechanism is worth
knowing, and the mistake is worth not repeating.

## The symptom

A team on the OpenCode runtime launches, looks alive in the UI, and the lead
answers nobody. Every message to it is refused with:

```
No stored OpenCode session record for <team>/primary/team-lead
```

The delivery row spends its attempt budget in under a minute, settles
`failed_terminal`, and stays that way for the life of the team.

## The mechanism (as it was before 2026-07-20)

**No launch command was ever sent for the lead on the
`pure_opencode_member_lanes` path.**

1. The lane planner works on the **teammate** roster - `isLeadMember` is filtered
   out of it upstream, in `selectMembersMetaTeammates` and
   `extractTeammateSpecsFromConfig`. Note that `normalizePlannedMembers` inside
   the planner does *not* filter it; the absence comes from the callers.
2. The lead is synthesized back in one place,
   `buildOpenCodeRuntimeAdapterLaunchMembers`, whose result is
   `runtimeLaunchMembers`.
3. Back then that result reached only `runOpenCodeTeamRuntimeAdapterLaunch`. The
   aggregate path was handed `lanePlan.primaryMembers`, which contained no lead.
4. `config.json` records the lead regardless, so the app addressed a member
   nobody had launched.

When every teammate qualified for a side lane, `primaryMembers` came out empty
and `launchOpenCodeAggregatePrimaryLane` returned at its first line
(`if (effectiveMembers.length === 0) return null`) - no `launchTeam lane=primary`
for that team at all.

### Why it looked intermittent

The aggregate path is taken when at least one teammate has a **different model**
than the lead or its **own worktree/cwd**. Homogeneous teams took another path
where the lead reached the bridge normally.

## How it got fixed

`TeamProvisioningServiceMemberLifecycleFacade.preserveAtomicOpenCodeRuntimePreparation()`
(added in `55dbb5010`, called from the constructor via
`initializeTeamProvisioningService`) wraps `prepareOpenCodeRuntimeAdapterLaunch`
and **re-plans the lane plan from `prepared.runtimeLaunchMembers`** - the roster
that already carries the synthesized lead. A lead has no `cwd` and takes
`request.model`, so it matches neither `usesDistinctModel` nor `usesDistinctRoot`
and always lands in `primaryMembers`.

Verified empirically by running the real planner with a lead-bearing roster:

```
MODE=pure_opencode_member_lanes
PRIMARY=["team-lead"]
SIDE=["alice"]
```

The same facade also overrides `runOpenCodeWorktreeRootAggregateLaunch` and
replaces `input.members` with the remembered `runtimeLaunchMembers`, so both the
plan and the roster carry the lead.

The fix was incidental - the commit is a facade refactor, and nothing in it
mentions this defect. That is exactly why this file exists.

## The evidence, and the trap in it

From the bridge command ledger:

| Team | `launchTeam` | Primary lane | Date |
|---|---|---|---|
| `beacon-desk-24` | 3 × secondary only | never launched, 3 DMs to `primary/team-lead` | 2026-07-18 |
| `zai-managed-heavy-e2e-...` | 5 × secondary only | never launched, 11 DMs to `primary/team-lead` | 2026-07-16 |
| `vector-room-182` | primary + 2 × secondary | launched for `tom`, not the lead | 2026-07-18 |

Every artifact predates `55dbb5010` (2026-07-20). The investigation read them as
current, built a fix on top, and the fix turned out to be a no-op: the guard it
added ("is a lead already on the plan?") is always true today.

**The lesson, stated plainly: date your artifacts against the code that produced
them.** A session store and a command ledger are append-only and keep entries for
months; nothing in them says which build wrote them.

## Is it this bug?

If you are seeing `No stored OpenCode session record` today, check in this order:

1. **Was a primary launch even attempted?** In the bridge command ledger
   (`~/Library/Application Support/agent-teams-ai/opencode-bridge/command-ledger.json`
   on macOS), look for `opencode.launchTeam` with `lane=primary` for that team.
   If there is none, and the entry is recent, something regressed the facade
   above - start there. If there is one, this is a different failure.
2. **Is the record in the orchestrator's store?**
   `~/Library/Application Support/claude-multimodel-nodejs/opencode/session-store.json`,
   key `<team>::primary::<lead>`. Present means the app is asking for the wrong
   name; absent means bootstrap never committed it.
3. **Did the bootstrap fail and get cleaned up?** Until
   `agent_teams_orchestrator#65`, `cleanupFailedLaunchSession` deleted the record
   outright, which made the failure permanent - `sendMessage` recovers only from
   a record that is *stale*, never from a missing one.
4. **Was the member confirmed without a session id?** In
   `TeamProvisioningOpenCodeAggregateLaunchPersistence`, a member that is
   confirmed but carries no `runtimeSessionId` still hits a bare `continue`. No
   evidence, no diagnostic. This route is open and reaches the same symptom.

## Still open

These are unrelated to the closed defect, but they are the reason the failure was
invisible for so long, and they are worth closing:

| Gap | Where |
|---|---|
| Confirmed member without a session id skipped in silence | `TeamProvisioningOpenCodeAggregateLaunchPersistence`, unclaimed |
| Absent lead read as `'confirmed'` by the lead veto | branch of PR #580 |
| Members outside `expectedMembers` dropped from the launch result | `OpenCodeTeamRuntimeAdapter`, unclaimed |

The last one is subtler than it looks: keeping such members is *not* a safe
default, because `commitOpenCodeRuntimeAdapterLaunchSessionEvidence` iterates
over all result members and is shared with secondary lanes, so a teammate
reported on the primary lane would get its session committed under
`laneId: 'primary'`. Whatever closes that gap has to scope what it keeps.

## What was ruled out

**Upstream OpenCode is not involved.** `No stored OpenCode session record` is
thrown by our own bundled orchestrator (`agent_teams_orchestrator`, package
`claude-multimodel`), not by OpenCode - a GitHub code search returns three hits
across all of GitHub, none in the OpenCode repository.

Three real OpenCode issues were considered and rejected: all three are on the ACP
transport, and this app talks HTTP (`POST /session`, `prompt_async`, see
`OpenCodeApiCapabilities.ts`). One of them
([#38064](https://github.com/anomalyco/opencode/issues/38064)) proves the
opposite of a session-creation race - the session row is durable before the first
prompt.

**A bootstrap MCP-readiness timeout was also considered.** The orchestrator does
have a narrow budget there and throws before writing the session to its store.
Real, but it cannot explain these artifacts: no primary launch was attempted, so
there was nothing to time out.
