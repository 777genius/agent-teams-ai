# OpenCode Model Gauntlet Results

Generated: 2026-05-08T21:13:58.089Z

Runs per model: 1
Recommended threshold: average >= 80, successful runs >= 1, consistency >= 85, hard failures = 0

Provider-infra runs are reported separately and are not counted as model behavior. They still block a Recommended verdict until rerun succeeds.

Scoring weights: launchBootstrap=15, directReply=10, peerRelayAB=15, peerRelayBC=15, concurrentReplies=15, taskRefs=10, cleanTranscript=10, noDuplicateTokens=5, latencyStable=5.

## Model Summary

| Model | Verdict | Confidence | Readiness | Consistency | Score Spread | Behavior Avg | Overall Avg | Counted | Pass Runs | Weakest Stage | Weakest TaskRef | Dominant Failure | Blockers | Provider Infra | Runtime Transport | Model Fails | Protocol Runs | p50 | p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `opencode/big-pickle` | Infra blocked | blocked | 0 | 0 | 0 | n/a | 70 | 0/1 | 0/1 | concurrentReplies 0/1 (0%) | concurrentBob 0/1 (0%) | provider-infra | overall average 70 < 80; successful runs 0 < 1; consistency score 0 < 85; provider-infra failures 1; highest weighted stage loss concurrentReplies=15; weakest taskRefs concurrentBob=0/1 (0%); protocol violations in 1 runs | 1 | 0 | 0 | 1 | 281016ms | 281016ms |

## opencode/big-pickle

Readiness score: 0.

Score stability: n/a.

Recommendation blockers: overall average 70 < 80; successful runs 0 < 1; consistency score 0 < 85; provider-infra failures 1; highest weighted stage loss concurrentReplies=15; weakest taskRefs concurrentBob=0/1 (0%); protocol violations in 1 runs.

Weighted stage impact: concurrentReplies:loss=15, failed=1, pass=0/1 (0%); taskRefs:loss=10, failed=1, pass=0/1 (0%); noDuplicateTokens:loss=5, failed=1, pass=0/1 (0%).

Stage pass rates: launchBootstrap:1/1 (100%), directReply:1/1 (100%), peerRelayAB:1/1 (100%), peerRelayBC:1/1 (100%), concurrentReplies:0/1 (0%), taskRefs:0/1 (0%), cleanTranscript:1/1 (100%), noDuplicateTokens:0/1 (0%), latencyStable:1/1 (100%).

TaskRef pass rates: directReply:1/1 (100%), peerRelayAB:1/1 (100%), peerRelayBC:1/1 (100%), concurrentBob:0/1 (0%), concurrentTom:1/1 (100%).

Protocol totals: badMessages=0, duplicateOrMissingTokens=2, affectedRuns=1.

| Run | Outcome | Category | Score | Counted | Duration | Failed Stages | Slowest Stage | TaskRefs | Protocol | Diagnostics |
| ---: | --- | --- | ---: | --- | ---: | --- | --- | --- | --- | --- |
| 1 | provider-infra-blocked | provider-infra | 70 | no | 281016ms | concurrentReplies, taskRefs, noDuplicateTokens | concurrentReplies:189928ms | directReply:ok, peerRelayAB:ok, peerRelayBC:ok, concurrentBob:fail, concurrentTom:ok | token=GAUNTLET_CONCURRENT_BOB_OK_1+GAUNTLET_CONCURRENT_TOM_OK_1 | concurrentBob: Timed out waiting for OpenCode reply in /var/folders/7b/ydmc_b0n251bc4hss4tz8y880000gn/T/opencode-semantic-gauntlet-ZwZPyq/.claude/teams/opencode-semantic-realistic-gauntlet-opencode-big-pickle-1778274838090-1/inboxes/user.js |

