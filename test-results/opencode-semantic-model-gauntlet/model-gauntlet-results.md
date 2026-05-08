# OpenCode Model Gauntlet Results

Generated: 2026-05-08T18:34:37.950Z

Runs per model: 1
Recommended threshold: average >= 80, successful runs >= 1, consistency >= 85, hard failures = 0

Provider-infra runs are reported separately and are not counted as model behavior. They still block a Recommended verdict until rerun succeeds.

Scoring weights: launchBootstrap=15, directReply=10, peerRelayAB=15, peerRelayBC=15, concurrentReplies=15, taskRefs=10, cleanTranscript=10, noDuplicateTokens=5, latencyStable=5.

## Model Summary

| Model | Verdict | Confidence | Readiness | Consistency | Score Spread | Behavior Avg | Overall Avg | Counted | Pass Runs | Weakest Stage | Weakest TaskRef | Dominant Failure | Blockers | Provider Infra | Runtime Transport | Model Fails | Protocol Runs | p50 | p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `opencode/big-pickle` | Tested only | low | 73 | 100 | 0 | 90 | 90 | 1/1 | 0/1 | taskRefs 0/1 (0%) | concurrentBob 0/1 (0%) | model-behavior | successful runs 0 < 1; hard failures 1; model-behavior failures 1; highest weighted stage loss taskRefs=10; weakest taskRefs concurrentBob=0/1 (0%) | 0 | 0 | 1 | 0 | 124249ms | 124249ms |

## opencode/big-pickle

Readiness score: 73.

Score stability: consistency=100, min=90, max=90, spread=0, stdDev=0, samples=1.

Recommendation blockers: successful runs 0 < 1; hard failures 1; model-behavior failures 1; highest weighted stage loss taskRefs=10; weakest taskRefs concurrentBob=0/1 (0%).

Weighted stage impact: taskRefs:loss=10, failed=1, pass=0/1 (0%).

Stage pass rates: launchBootstrap:1/1 (100%), directReply:1/1 (100%), peerRelayAB:1/1 (100%), peerRelayBC:1/1 (100%), concurrentReplies:1/1 (100%), taskRefs:0/1 (0%), cleanTranscript:1/1 (100%), noDuplicateTokens:1/1 (100%), latencyStable:1/1 (100%).

TaskRef pass rates: directReply:1/1 (100%), peerRelayAB:1/1 (100%), peerRelayBC:1/1 (100%), concurrentBob:0/1 (0%), concurrentTom:1/1 (100%).

Protocol totals: badMessages=0, duplicateOrMissingTokens=0, affectedRuns=0.

| Run | Outcome | Category | Score | Counted | Duration | Failed Stages | Slowest Stage | TaskRefs | Protocol | Diagnostics |
| ---: | --- | --- | ---: | --- | ---: | --- | --- | --- | --- | --- |
| 1 | behavioral-fail | model-behavior | 90 | yes | 124249ms | taskRefs | peerRelayAB:27950ms | directReply:ok, peerRelayAB:ok, peerRelayBC:ok, concurrentBob:fail, concurrentTom:ok | - | runId=34e07fb0-df87-4419-be0c-0f5386847b23 |

