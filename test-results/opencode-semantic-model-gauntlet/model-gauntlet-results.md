# OpenCode Model Gauntlet Results

Generated: 2026-05-14T06:34:47.601Z

Runs per model: 1
Recommended threshold: average >= 70, successful runs >= 1, consistency >= 85, hard failures = 0

Provider-infra runs are reported separately and are not counted as model behavior. They still block a Recommended verdict until rerun succeeds.

Scoring weights: launchBootstrap=15, directReply=10, peerRelayAB=15, peerRelayBC=15, concurrentReplies=15, taskRefs=10, cleanTranscript=10, noDuplicateTokens=5, latencyStable=5.

## Model Summary

| Model | Verdict | Confidence | Readiness | Consistency | Score Spread | Behavior Avg | Overall Avg | Counted | Pass Runs | Weakest Stage | Weakest TaskRef | Dominant Failure | Blockers | Provider Infra | Runtime Transport | Model Fails | Protocol Runs | p50 | p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `opencode/big-pickle` | Recommended | low | 100 | 100 | 0 | 100 | 100 | 1/1 | 1/1 | cleanTranscript 1/1 (100%) | concurrentBob 1/1 (100%) | none | - | 0 | 0 | 0 | 0 | 132968ms | 132968ms |

## opencode/big-pickle

Readiness score: 100.

Score stability: consistency=100, min=100, max=100, spread=0, stdDev=0, samples=1.

Recommendation blockers: -.

Weighted stage impact: -.

Stage pass rates: launchBootstrap:1/1 (100%), directReply:1/1 (100%), peerRelayAB:1/1 (100%), peerRelayBC:1/1 (100%), concurrentReplies:1/1 (100%), taskRefs:1/1 (100%), cleanTranscript:1/1 (100%), noDuplicateTokens:1/1 (100%), latencyStable:1/1 (100%).

TaskRef pass rates: directReply:1/1 (100%), peerRelayAB:1/1 (100%), peerRelayBC:1/1 (100%), concurrentBob:1/1 (100%), concurrentTom:1/1 (100%).

Protocol totals: badMessages=0, duplicateOrMissingTokens=0, affectedRuns=0.

| Run | Outcome | Category | Score | Counted | Duration | Failed Stages | Slowest Stage | TaskRefs | Protocol | Diagnostics |
| ---: | --- | --- | ---: | --- | ---: | --- | --- | --- | --- | --- |
| 1 | passed | none | 100 | yes | 132968ms | - | launchBootstrap:49092ms | directReply:ok, peerRelayAB:ok, peerRelayBC:ok, concurrentBob:ok, concurrentTom:ok | - | runId=5f3d0b1b-17eb-44d6-8b61-644e6f8673c6 |

