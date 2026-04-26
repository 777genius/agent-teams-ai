# OpenCode Model Gauntlet Results

Generated: 2026-04-26T01:18:27Z

## Methodology

The gauntlet uses production-path OpenCode Agent Teams launch and delivery code. It checks launch/bootstrap, direct user-to-member delivery, teammate-to-teammate relay, chained relay to a third teammate, near-concurrent delivery, taskRefs preservation, transcript hygiene, duplicate visible reply prevention, and latency.

Verdicts:

- `Recommended` requires at least 3 successful runs, average score >= 90, consistency score >= 85, no hard failures, no provider-infra failures, and no harness failures.
- `Strong candidate` means the model performed well in counted behavioral runs and has at least one full successful run, but does not yet satisfy the stricter repeated-run recommendation threshold.
- `Tested only` means the model has real gauntlet evidence but showed behavioral/runtime instability.
- `Infra blocked` means provider/API/catalog/credit errors prevented useful model judgment.

Provider-infra runs are reported separately and are not counted as model behavior. They still block a `Recommended` verdict until rerun succeeds.

Credit/key/max-token allowance failures are treated as inconclusive provider-infra samples, not as model-quality verdicts. They are intentionally not surfaced as `Not recommended` in the product UI and should be rerun after balance or key limits are restored.

Current generated reports also include scoring weights, readiness score, consistency score, score spread, recommendation blockers, weighted stage impact, weakest-stage pass rates, weakest `taskRefs` pass rates, protocol-violation totals, stage durations, and primary failure categories. This makes the scorecard more actionable than a single average: a model can now be separated into provider-infra blocked, runtime-transport unstable, or model-behavior weak.

The readiness score is not a replacement for the `Recommended` gate. It is a practical ranking signal that combines behavioral average, counted pass rate, `taskRefs` preservation, protocol cleanliness, consistency, and provider-infra cleanliness. The `Recommended` verdict remains stricter and still requires repeated successful runs with no hard/provider/harness failures.

The consistency score protects against misleading averages. A model with one excellent run and one weak run can keep a high average, but it will now show score spread and can be blocked from `Recommended` when consistency is below the configured threshold.

Confidence:

- `high`: at least 3 counted behavioral runs and no provider-infra contamination.
- `medium`: at least 2 counted behavioral runs.
- `low`: 1 counted behavioral run.
- `blocked`: no useful behavioral sample because infra or harness failures dominated.

Current UI policy: all previously passing OpenCode routes are shown as `Tested`, not `Recommended`. A model should only be promoted to `Recommended` after a fresh 3-run gauntlet passes the current average, consistency, hard-failure, provider-infra, and harness-failure gates.

## OpenRouter Rank 11-20 Fresh Batch

Source: OpenRouter activity screenshot ranks 11-20, excluding `openrouter/google/gemini-2.5-flash` and `openrouter/z-ai/glm-5.1` because both already had clean 100/100 gauntlet evidence.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-rank11-20-gauntlet-1777183582" OPENCODE_E2E_MODELS="openrouter/google/gemini-2.5-flash-lite,openrouter/nvidia/nemotron-3-super-120b-a12b:free,openrouter/xiaomi/mimo-v2-pro,openrouter/openai/gpt-5.4,openrouter/openai/gpt-oss-120b,openrouter/google/gemini-3.1-pro-preview,openrouter/moonshotai/kimi-k2.5,openrouter/qwen/qwen3.6-plus" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

Host note: the run produced a usable report, then the harness failed while the machine was out of disk space (`ENOSPC`). Treat `openrouter/moonshotai/kimi-k2.5` as inconclusive because its failure was directly caused by `ENOSPC`. The other completed rows are useful model signals.

| Model | Verdict | Readiness | Avg | Pass Runs | Dominant Failure | p50 | Key finding |
| --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| `openrouter/google/gemini-2.5-flash-lite` | Tested only | 54 | 35 | 0/1 | model-behavior | 246674ms | Passed launch/direct reply, then timed out or failed peer relay and concurrent delivery. |
| `openrouter/nvidia/nemotron-3-super-120b-a12b:free` | Tested only | 54 | 35 | 0/1 | model-behavior | 202862ms | Passed launch/direct reply, then failed peer relay through OpenCode delivery. |
| `openrouter/xiaomi/mimo-v2-pro` | Strong candidate | 100 | 100 | 1/1 | none | 163958ms | Passed launch, direct reply, peer relays, concurrent replies, taskRefs, transcript hygiene, and duplicate guard. |
| `openrouter/openai/gpt-5.4` | Tested only | 55 | 70 | 0/1 | runtime-transport | 290561ms | Passed direct and peer relays, then failed concurrent Tom reply, taskRefs, and duplicate-token correctness. |
| `openrouter/openai/gpt-oss-120b` | Infra blocked | 0 | 65 | 0/0 | provider-infra | 464553ms | Passed early stages, then timed out during concurrent delivery and taskRefs checks. |
| `openrouter/google/gemini-3.1-pro-preview` | Tested only | 40 | 0 | 0/1 | model-behavior | 19977ms | Failed launch readiness before usable Agent Teams behavior. |
| `openrouter/moonshotai/kimi-k2.5` | Inconclusive | 40 | 0 | 0/1 | host ENOSPC | 1720ms | Failure happened while materializing task fixtures because the host disk was full. Rerun after disk cleanup. |
| `openrouter/qwen/qwen3.6-plus` | Tested only | 68 | 95 | 0/1 | model-behavior | 224986ms | Completed all functional stages but failed duplicate-token/protocol cleanliness, so it is not safe as `Tested`. |

Additional context from the same screenshot: `openrouter/google/gemini-2.5-flash` and `openrouter/z-ai/glm-5.1` were already tracked as `Tested` from earlier 1/1 100/100 gauntlets. After this batch, `openrouter/xiaomi/mimo-v2-pro` is also tracked as `Tested`. No model from this batch should be marked `Recommended` yet because none has a fresh 3-run clean pass under the current gate.

## MiniMax M2.7 Fresh Rerun

Source: targeted rerun after a previous near-concurrent runtime transport failure.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-minimax-m27-rerun-1777183082" OPENCODE_E2E_MODELS="openrouter/minimax/minimax-m2.7" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model | Input $/1M | Output $/1M | Verdict | Readiness | Avg | Pass Runs | Dominant Failure | p50 | Key finding |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: | --- |
| `openrouter/minimax/minimax-m2.7` | 0.30 | 1.20 | Strong candidate | 100 | 100 | 1/1 | none | 141289ms | Fresh rerun passed launch, direct reply, peer relays, concurrent replies, taskRefs, transcript hygiene, and duplicate guard. |

Interpretation: the latest rerun clears the previous near-concurrent delivery failure for one sample. Keep it as `Tested`, not `Recommended`, because the combined history still includes one prior runtime transport failure and the current recommendation gate requires repeated clean runs.

## Cheap Top Models Single-Run

Source: top models from the OpenRouter activity screenshot, filtered by lower OpenRouter API pricing first. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-cheap-top-gauntlet-1777157371" OPENCODE_E2E_MODELS="openrouter/minimax/minimax-m2.5,openrouter/x-ai/grok-4.1-fast,openrouter/deepseek/deepseek-v3.2,openrouter/minimax/minimax-m2.7,openrouter/google/gemini-3-flash-preview" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                      | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure  |      p50 | Key finding                                                                  |
| ------------------------------------------ | ---------: | ----------: | ---------------- | --------: | --: | --------: | ----------------- | -------: | ---------------------------------------------------------------------------- |
| `openrouter/minimax/minimax-m2.5`          |       0.15 |        1.15 | Strong candidate |       100 | 100 |       1/1 | none              | 163891ms | Passed launch, direct, peer relay, multi-hop, concurrent, taskRefs, hygiene. |
| `openrouter/x-ai/grok-4.1-fast`            |       0.20 |        0.50 | Strong candidate |       100 | 100 |       1/1 | none              | 123333ms | Passed all gauntlet stages and was cheaper/faster than MiniMax M2.5 here.    |
| `openrouter/deepseek/deepseek-v3.2`        |      0.252 |       0.378 | Tested only      |        55 |  70 |       0/1 | runtime-transport | 316760ms | Failed concurrent Tom reply, lost taskRefs for concurrentTom, protocol miss. |
| `openrouter/minimax/minimax-m2.7`          |       0.30 |        1.20 | Tested only      |        55 |  70 |       0/1 | runtime-transport | 305447ms | Same concurrent Tom/runtime-transport failure pattern as DeepSeek V3.2.      |
| `openrouter/google/gemini-3-flash-preview` |       0.50 |        3.00 | Strong candidate |       100 | 100 |       1/1 | none              |  85298ms | Passed all gauntlet stages and was the fastest in this cheap-top batch.      |

Interpretation: for the cheap top-model lane, the first models worth repeating with 3-run gauntlet are `openrouter/google/gemini-3-flash-preview`, `openrouter/x-ai/grok-4.1-fast`, and `openrouter/minimax/minimax-m2.5`. `openrouter/deepseek/deepseek-v3.2` and `openrouter/minimax/minimax-m2.7` should stay below recommendation until their concurrent delivery/runtime-transport failures are resolved or disproven by repeat runs.

## Diverse Models Single-Run

Source: broader OpenRouter model mix, biased toward moderate pricing and different providers. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-diverse-gauntlet-1777158534" OPENCODE_E2E_MODELS="openrouter/qwen/qwen3-coder-flash,openrouter/qwen/qwen3-coder,openrouter/google/gemini-3.1-flash-lite-preview,openrouter/mistralai/devstral-2512,openrouter/moonshotai/kimi-k2.6,openrouter/openai/gpt-5.4-mini,openrouter/xiaomi/mimo-v2-pro" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                             | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure  |      p50 | Key finding                                                                  |
| ------------------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ----------------- | -------: | ---------------------------------------------------------------------------- |
| `openrouter/qwen/qwen3-coder-flash`               |      0.195 |       0.975 | Tested only      |        60 |  50 |       0/1 | model-behavior    | 281611ms | Passed direct and first relay, then failed chained/concurrent reply flow.    |
| `openrouter/qwen/qwen3-coder`                     |       0.22 |        1.00 | Tested only      |        55 |  70 |       0/1 | runtime-transport | 271746ms | Failed concurrent Tom reply and taskRefs, with one protocol token issue.     |
| `openrouter/google/gemini-3.1-flash-lite-preview` |       0.25 |        1.50 | Strong candidate |       100 | 100 |       1/1 | none              |  88292ms | Passed launch, direct, peer relay, multi-hop, concurrent, taskRefs, hygiene. |
| `openrouter/mistralai/devstral-2512`              |       0.40 |        2.00 | Strong candidate |       100 | 100 |       1/1 | none              |  86424ms | Passed all stages and was the fastest in this diverse batch.                 |
| `openrouter/moonshotai/kimi-k2.6`                 |     0.7448 |       4.655 | Tested only      |        60 |  50 |       0/1 | model-behavior    | 282340ms | Same chained/concurrent weakness pattern as Qwen3 Coder Flash.               |
| `openrouter/openai/gpt-5.4-mini`                  |       0.75 |        4.50 | Tested only      |        55 |  70 |       0/1 | runtime-transport | 267937ms | Failed concurrent Tom reply and taskRefs despite passing earlier stages.     |
| `openrouter/xiaomi/mimo-v2-pro`                   |       1.00 |        3.00 | Strong candidate |       100 | 100 |       1/1 | none              | 115528ms | Passed all stages; slower than Devstral and Gemini Flash Lite in this run.   |

Interpretation: the next 3-run promotion candidates from this diverse batch are `openrouter/mistralai/devstral-2512`, `openrouter/google/gemini-3.1-flash-lite-preview`, and `openrouter/xiaomi/mimo-v2-pro`. Keep `openrouter/qwen/qwen3-coder-flash`, `openrouter/qwen/qwen3-coder`, `openrouter/moonshotai/kimi-k2.6`, and `openrouter/openai/gpt-5.4-mini` as `Tested only` until repeat runs prove they can handle chained relay plus concurrent delivery reliably.

## Additional Catalog Models Single-Run

Source: newer OpenRouter catalog entries across DeepSeek, Xiaomi, Z.ai, Qwen, MiniMax, and Mistral. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-diverse-gauntlet-1777160285" OPENCODE_E2E_MODELS="openrouter/deepseek/deepseek-v4-flash,openrouter/xiaomi/mimo-v2.5,openrouter/xiaomi/mimo-v2.5-pro,openrouter/z-ai/glm-5.1,openrouter/qwen/qwen3.6-plus,openrouter/minimax/minimax-m2-her,openrouter/mistralai/mistral-small-2603" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                     | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                                                  |
| ----------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ---------------- | -------: | ---------------------------------------------------------------------------- |
| `openrouter/deepseek/deepseek-v4-flash`   |       0.14 |        0.28 | Infra blocked    |         0 |  35 |       0/1 | provider-infra   | 397985ms | Launched and replied directly, then hit OpenCode tool/runtime connectivity.  |
| `openrouter/xiaomi/mimo-v2.5`             |       0.40 |        2.00 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5365ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/xiaomi/mimo-v2.5-pro`         |       1.00 |        3.00 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5240ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/z-ai/glm-5.1`                 |       1.05 |        3.50 | Strong candidate |       100 | 100 |       1/1 | none             | 132735ms | Passed launch, direct, peer relay, multi-hop, concurrent, taskRefs, hygiene. |
| `openrouter/qwen/qwen3.6-plus`            |      0.325 |        1.95 | Tested only      |        61 |  85 |       0/1 | model-behavior   | 128215ms | Passed stages but failed taskRefs/noDuplicateTokens, so not a candidate.     |
| `openrouter/minimax/minimax-m2-her`       |       0.30 |        1.20 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5347ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/mistralai/mistral-small-2603` |       0.15 |        0.60 | Tested only      |        60 |  50 |       0/1 | model-behavior   | 238670ms | Passed direct and first relay, then failed chained/concurrent reply flow.    |

Interpretation: `openrouter/z-ai/glm-5.1` is the only new repeat-run candidate from this batch. `openrouter/qwen/qwen3.6-plus` is interesting but should remain `Tested only`: it completed most stages but failed metadata/dedup correctness, which is exactly the class of issue that breaks the Messages UI. Xiaomi v2.5/v2.5 Pro and MiniMax M2 HER are currently unusable through this OpenCode route because OpenCode does not expose those provider-scoped model ids in its live catalog.

## Flash And Compact Models Single-Run

Source: lower-cost flash/compact routes across Z.ai, Qwen, StepFun, MiniMax, Xiaomi, and Mistral. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-diverse-gauntlet-1777161454" OPENCODE_E2E_MODELS="openrouter/z-ai/glm-5-turbo,openrouter/z-ai/glm-4.7-flash,openrouter/qwen/qwen3.5-flash-02-23,openrouter/stepfun/step-3.5-flash,openrouter/minimax/minimax-m2.1,openrouter/xiaomi/mimo-v2-flash,openrouter/mistralai/ministral-14b-2512" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                     | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure  |      p50 | Key finding                                                                  |
| ----------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ----------------- | -------: | ---------------------------------------------------------------------------- |
| `openrouter/z-ai/glm-5-turbo`             |       1.20 |        4.00 | Tested only      |        54 |  35 |       0/1 | model-behavior    | 130954ms | Passed direct reply, then failed peer relay and concurrent delivery.         |
| `openrouter/z-ai/glm-4.7-flash`           |       0.06 |        0.40 | Strong candidate |       100 | 100 |       1/1 | none              | 243535ms | Passed all stages, but was slow enough to need repeat latency validation.    |
| `openrouter/qwen/qwen3.5-flash-02-23`     |      0.065 |        0.26 | Tested only      |        68 |  95 |       0/1 | model-behavior    |  93897ms | Completed the flow but failed duplicate-token correctness.                   |
| `openrouter/stepfun/step-3.5-flash`       |       0.10 |        0.30 | Strong candidate |       100 | 100 |       1/1 | none              |  97550ms | Passed launch, direct, peer relay, multi-hop, concurrent, taskRefs, hygiene. |
| `openrouter/minimax/minimax-m2.1`         |       0.29 |        0.95 | Strong candidate |       100 | 100 |       1/1 | none              | 115326ms | Passed all stages; cheaper than M2.5/M2.7 and worth a 3-run check.           |
| `openrouter/xiaomi/mimo-v2-flash`         |       0.09 |        0.29 | Tested only      |        55 |  70 |       0/1 | runtime-transport | 263893ms | Failed concurrent Tom reply and taskRefs despite passing earlier stages.     |
| `openrouter/mistralai/ministral-14b-2512` |       0.20 |        0.20 | Infra blocked    |         0 |   0 |       0/1 | provider-infra    |   5364ms | Not found in the live OpenCode provider-scoped catalog.                      |

Interpretation: `openrouter/stepfun/step-3.5-flash` and `openrouter/minimax/minimax-m2.1` are the most practical new repeat-run candidates from this batch: both passed 100/100 and stayed near 1.5-2 minutes. `openrouter/z-ai/glm-4.7-flash` also passed, but its p50 was 243s, so it needs latency repeat validation before promotion. `openrouter/qwen/qwen3.5-flash-02-23` is not safe despite 95/100 because duplicate visible reply tokens are a user-facing Messages UI bug.

## Pro And Small Alternative Models Single-Run

Source: another non-overlapping batch across DeepSeek, Z.ai, Qwen, Mistral, Baidu, and Nous. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-diverse-gauntlet-1777162728" OPENCODE_E2E_MODELS="openrouter/deepseek/deepseek-v4-pro,openrouter/z-ai/glm-4.7,openrouter/qwen/qwen3.5-35b-a3b,openrouter/mistralai/ministral-8b-2512,openrouter/mistralai/ministral-3b-2512,openrouter/baidu/ernie-4.5-21b-a3b,openrouter/nousresearch/hermes-4-70b" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                    | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                                                  |
| ---------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ---------------- | -------: | ---------------------------------------------------------------------------- |
| `openrouter/deepseek/deepseek-v4-pro`    |      0.435 |        0.87 | Tested only      |        54 |  35 |       0/1 | model-behavior   | 297105ms | Passed direct reply, then timed out on peer relay and concurrent delivery.   |
| `openrouter/z-ai/glm-4.7`                |       0.38 |        1.74 | Strong candidate |       100 | 100 |       1/1 | none             | 170582ms | Passed launch, direct, peer relay, multi-hop, concurrent, taskRefs, hygiene. |
| `openrouter/qwen/qwen3.5-35b-a3b`        |     0.1625 |        1.30 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5414ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/mistralai/ministral-8b-2512` |       0.15 |        0.15 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5354ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/mistralai/ministral-3b-2512` |       0.10 |        0.10 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5312ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/baidu/ernie-4.5-21b-a3b`     |       0.07 |        0.28 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5335ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/nousresearch/hermes-4-70b`   |       0.13 |        0.40 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   7575ms | Not found in the live OpenCode provider-scoped catalog or launch handshake.  |

Interpretation: `openrouter/z-ai/glm-4.7` is the only new repeat-run candidate from this batch. `openrouter/deepseek/deepseek-v4-pro` was a useful negative result: it is inexpensive for a large pro model, but failed the Agent Teams relay scenario badly. The other five routes are currently catalog/launch blocked in OpenCode, so they should not appear as viable Agent Teams choices until OpenCode exposes them.

## Legacy And Broad Provider Models Single-Run

Source: another broad batch across Anthropic, xAI, Google, Mistral, DeepSeek, Qwen, and Z.ai. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-diverse-gauntlet-1777163463" OPENCODE_E2E_MODELS="openrouter/anthropic/claude-haiku-4.5,openrouter/x-ai/grok-4,openrouter/google/gemini-2.0-flash-001,openrouter/mistralai/devstral-small,openrouter/deepseek/deepseek-chat-v3.1,openrouter/qwen/qwen3-30b-a3b,openrouter/z-ai/glm-4.5-air" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                    | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                                                  |
| ---------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ---------------- | -------: | ---------------------------------------------------------------------------- |
| `openrouter/anthropic/claude-haiku-4.5`  |       1.00 |        5.00 | Strong candidate |       100 | 100 |       1/1 | none             |  91040ms | Passed launch, direct, peer relay, multi-hop, concurrent, taskRefs, hygiene. |
| `openrouter/x-ai/grok-4`                 |       3.00 |       15.00 | Tested only      |        54 |  35 |       0/1 | model-behavior   | 165700ms | Passed direct reply, then failed peer relay with empty assistant turn.       |
| `openrouter/google/gemini-2.0-flash-001` |       0.10 |        0.40 | Tested only      |        60 |  50 |       0/1 | model-behavior   | 113041ms | Passed direct and first relay, then failed chained/concurrent relay.         |
| `openrouter/mistralai/devstral-small`    |       0.10 |        0.30 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5603ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/deepseek/deepseek-chat-v3.1` |       0.15 |        0.75 | Tested only      |        52 |  70 |       0/1 | model-behavior   | 271581ms | Failed concurrent replies, taskRefs, and duplicate-token correctness.        |
| `openrouter/qwen/qwen3-30b-a3b`          |       0.08 |        0.28 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5477ms | Not found in the live OpenCode provider-scoped catalog.                      |
| `openrouter/z-ai/glm-4.5-air`            |       0.13 |        0.85 | Infra blocked    |         0 |  35 |       0/1 | provider-infra   | 140700ms | Passed direct reply, then failed peer relay through OpenCode tool handling.  |

Interpretation: `openrouter/anthropic/claude-haiku-4.5` is the only new strong result in this batch and is now a serious cheap-Anthropic repeat-run candidate. `openrouter/x-ai/grok-4` is a useful negative result because `grok-4.1-fast` passed earlier while full `grok-4` failed this Agent Teams relay scenario. Older `gemini-2.0-flash-001` also looks unsafe compared with newer Gemini 3 Flash routes.

## Older Strong Families Regression Batch

Source: another non-overlapping batch covering older/alternate routes from families that looked promising elsewhere. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-diverse-gauntlet-1777164494" OPENCODE_E2E_MODELS="openrouter/anthropic/claude-sonnet-4.5,openrouter/anthropic/claude-opus-4.5,openrouter/google/gemini-2.5-flash-lite,openrouter/mistralai/mistral-medium-3,openrouter/x-ai/grok-3-mini,openrouter/qwen/qwen3-next-80b-a3b-instruct,openrouter/z-ai/glm-4.6" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                         | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure  |      p50 | Key finding                                                                  |
| --------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ----------------- | -------: | ---------------------------------------------------------------------------- |
| `openrouter/anthropic/claude-sonnet-4.5`      |       3.00 |       15.00 | Infra blocked |         0 |  70 |       0/1 | provider-infra    | 281971ms | Passed most flow, then failed concurrent Tom/taskRefs/protocol handling.     |
| `openrouter/anthropic/claude-opus-4.5`        |       5.00 |       25.00 | Infra blocked |         0 |  70 |       0/1 | provider-infra    | 274162ms | Same concurrent Tom/taskRefs/protocol failure pattern as Sonnet 4.5.         |
| `openrouter/google/gemini-2.5-flash-lite`     |       0.10 |        0.40 | Tested only   |        52 |  70 |       0/1 | runtime-transport | 264105ms | Failed concurrent Tom reply and taskRefs, confirming older negative signal.  |
| `openrouter/mistralai/mistral-medium-3`       |       0.40 |        2.00 | Tested only   |        46 |  15 |       0/1 | runtime-transport | 217744ms | Timed out already on direct reply, not viable for Agent Teams.               |
| `openrouter/x-ai/grok-3-mini`                 |       0.30 |        0.50 | Tested only   |        54 |  35 |       0/1 | model-behavior    | 142579ms | Passed direct reply, then failed peer relay/concurrent delivery.             |
| `openrouter/qwen/qwen3-next-80b-a3b-instruct` |       0.09 |        1.10 | Infra blocked |         0 |  35 |       0/1 | provider-infra    | 237510ms | Passed direct reply, then timed out on peer relay through OpenCode.          |
| `openrouter/z-ai/glm-4.6`                     |       0.39 |        1.90 | Tested only   |        54 |  35 |       0/1 | runtime-transport | 293919ms | Fresh gauntlet regressed vs older smoke: direct reply only, peer relay fail. |

Interpretation: this batch produced no new repeat-run candidate. It also downgrades confidence in several older `Tested` routes: `openrouter/z-ai/glm-4.6` and `openrouter/mistralai/mistral-medium-3` should not be promoted without a future clean gauntlet. The newer winners from the same families remain more interesting: `glm-4.7`, `glm-5.1`, `grok-4.1-fast`, and `gemini-3-flash-preview`.

## Broad Cheap Alternatives Single-Run

Source: another broad batch across OpenAI, Qwen, xAI, MiniMax, and Google cheap/compact routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-broad-cheap-gauntlet-1777166547" OPENCODE_E2E_MODELS="openrouter/openai/gpt-oss-120b,openrouter/openai/gpt-5-nano,openrouter/qwen/qwen3-coder-30b-a3b-instruct,openrouter/qwen/qwen3-coder-next,openrouter/x-ai/grok-4-fast,openrouter/minimax/minimax-m2,openrouter/google/gemini-2.0-flash-lite-001" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                          | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure  |      p50 | Key finding                                                                                      |
| ---------------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ----------------- | -------: | ------------------------------------------------------------------------------------------------ |
| `openrouter/openai/gpt-oss-120b`               |      0.039 |        0.19 | Tested only      |        60 |  50 |       0/1 | model-behavior    | 237273ms | Passed launch, direct, and first relay, then failed chained relay, concurrent, and hygiene.      |
| `openrouter/openai/gpt-5-nano`                 |       0.05 |        0.40 | Strong candidate |       100 | 100 |       1/1 | none              | 235304ms | Passed launch, direct, peer relays, concurrent replies, taskRefs, transcript hygiene.            |
| `openrouter/qwen/qwen3-coder-30b-a3b-instruct` |       0.07 |        0.27 | Tested only      |        55 |  70 |       0/1 | runtime-transport | 285835ms | Passed direct and peer relay, then failed concurrent reply, taskRefs, and duplicate-token check. |
| `openrouter/qwen/qwen3-coder-next`             |       0.14 |        0.80 | Infra blocked    |         0 |   0 |       0/1 | provider-infra    |   5448ms | Not found in the live OpenCode provider-scoped catalog.                                          |
| `openrouter/x-ai/grok-4-fast`                  |       0.20 |        0.50 | Infra blocked    |         0 |  60 |       0/1 | provider-infra    | 272477ms | Passed most flow, then failed concurrent Tom reply, taskRefs, hygiene, and duplicate check.      |
| `openrouter/minimax/minimax-m2`                |      0.255 |        1.00 | Strong candidate |       100 | 100 |       1/1 | none              | 116814ms | Passed launch, direct, peer relays, concurrent replies, taskRefs, transcript hygiene.            |
| `openrouter/google/gemini-2.0-flash-lite-001`  |      0.075 |        0.30 | Infra blocked    |         0 |   0 |       0/1 | provider-infra    |   5321ms | Not found in the live OpenCode provider-scoped catalog.                                          |

Interpretation: `openrouter/minimax/minimax-m2` is the best new practical candidate from this batch because it passed 100/100 with much lower latency than `gpt-5-nano`. `openrouter/openai/gpt-5-nano` also passed cleanly, but its single run was slow enough to require repeat validation. `openrouter/openai/gpt-oss-120b`, `openrouter/qwen/qwen3-coder-30b-a3b-instruct`, and `openrouter/x-ai/grok-4-fast` are not safe for Agent Teams despite partial success, because they failed exactly the multi-agent relay/concurrent behaviors we care about.

## Broad General Alternatives Single-Run

Source: another broad batch across OpenAI, Qwen, DeepSeek, Mistral, and Nvidia routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-broad-general-gauntlet-1777167901" OPENCODE_E2E_MODELS="openrouter/openai/gpt-5.4-nano,openrouter/openai/gpt-4.1-nano,openrouter/qwen/qwen-plus,openrouter/qwen/qwen3-235b-a22b-2507,openrouter/deepseek/deepseek-v3.2-exp,openrouter/mistralai/codestral-2508,openrouter/nvidia/nemotron-3-super-120b-a12b" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                          | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure  |      p50 | Key finding                                                                                     |
| ---------------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ----------------- | -------: | ----------------------------------------------------------------------------------------------- |
| `openrouter/openai/gpt-5.4-nano`               |       0.20 |        1.25 | Tested only      |        55 |  70 |       0/1 | runtime-transport | 262911ms | Passed direct and peer relays, then failed concurrent Tom reply, taskRefs, and duplicate check. |
| `openrouter/openai/gpt-4.1-nano`               |       0.10 |        0.40 | Infra blocked    |         0 |   0 |       0/1 | provider-infra    |   5317ms | Not found in the live OpenCode provider-scoped catalog.                                         |
| `openrouter/qwen/qwen-plus`                    |       0.26 |        0.78 | Infra blocked    |         0 |   0 |       0/1 | provider-infra    |   5230ms | Not found in the live OpenCode provider-scoped catalog.                                         |
| `openrouter/qwen/qwen3-235b-a22b-2507`         |      0.071 |        0.10 | Infra blocked    |         0 |   0 |       0/1 | provider-infra    |   5356ms | Not found in the live OpenCode provider-scoped catalog.                                         |
| `openrouter/deepseek/deepseek-v3.2-exp`        |       0.27 |        0.41 | Infra blocked    |         0 |   0 |       0/1 | provider-infra    |   5195ms | Not found in the live OpenCode provider-scoped catalog.                                         |
| `openrouter/mistralai/codestral-2508`          |       0.30 |        0.90 | Strong candidate |       100 | 100 |       1/1 | none              |  79312ms | Passed launch, direct, peer relays, concurrent replies, taskRefs, transcript hygiene.           |
| `openrouter/nvidia/nemotron-3-super-120b-a12b` |       0.09 |        0.45 | Tested only      |        54 |  35 |       0/1 | model-behavior    | 150382ms | Passed direct reply, then failed peer relay, concurrent delivery, hygiene, and latency.         |

Interpretation: `openrouter/mistralai/codestral-2508` is the standout here: it had the fastest clean 100/100 pass among the latest two batches and was already on the tested list. `openrouter/openai/gpt-5.4-nano` looks unsafe despite decent partial progress because it failed the concurrent/taskRefs path. `openrouter/nvidia/nemotron-3-super-120b-a12b` is not a viable Agent Teams model right now: it got only the first direct reply right.

## Broad Affordable Alternatives Single-Run

Source: another broad batch across Mistral, Cohere, Reka, Google Gemma, and Qwen low-cost routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-broad-affordable-gauntlet-1777168585" OPENCODE_E2E_MODELS="openrouter/mistralai/mistral-small-3.2-24b-instruct,openrouter/mistralai/mistral-nemo,openrouter/cohere/command-r7b-12-2024,openrouter/cohere/command-r-08-2024,openrouter/rekaai/reka-flash-3,openrouter/google/gemma-4-31b-it,openrouter/qwen/qwen3-32b" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                                 | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure  |      p50 | Key finding                                                                                 |
| ----------------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ----------------- | -------: | ------------------------------------------------------------------------------------------- |
| `openrouter/mistralai/mistral-small-3.2-24b-instruct` |      0.075 |        0.20 | Tested only   |        55 |  70 |       0/1 | runtime-transport | 274129ms | Passed direct and peer relays, then failed concurrent Tom reply, taskRefs, duplicate check. |
| `openrouter/mistralai/mistral-nemo`                   |       0.01 |        0.03 | Infra blocked |         0 |   0 |       0/1 | provider-infra    |   5692ms | Not found in the live OpenCode provider-scoped catalog.                                     |
| `openrouter/cohere/command-r7b-12-2024`               |     0.0375 |        0.15 | Infra blocked |         0 |   0 |       0/1 | provider-infra    |   5463ms | Not found in the live OpenCode provider-scoped catalog.                                     |
| `openrouter/cohere/command-r-08-2024`                 |       0.15 |        0.60 | Infra blocked |         0 |   0 |       0/1 | provider-infra    |   5239ms | Not found in the live OpenCode provider-scoped catalog.                                     |
| `openrouter/rekaai/reka-flash-3`                      |       0.10 |        0.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra    |   5225ms | Not found in the live OpenCode provider-scoped catalog.                                     |
| `openrouter/google/gemma-4-31b-it`                    |       0.13 |        0.38 | Tested only   |        46 |  15 |       0/1 | runtime-transport | 217938ms | Launched, but timed out already on direct reply.                                            |
| `openrouter/qwen/qwen3-32b`                           |       0.08 |        0.24 | Infra blocked |         0 |   0 |       0/1 | provider-infra    |   5639ms | Not found in the live OpenCode provider-scoped catalog.                                     |

Interpretation: this batch produced no new candidate for recommendation. `mistral-small-3.2-24b-instruct` is close enough to be useful as a negative regression target, but it failed the same concurrent/taskRefs path that matters most for Agent Teams. The cheaper Cohere/Reka/Mistral Nemo/Qwen 32B routes are blocked by OpenCode catalog support, not by model behavior.

## Small And Mid Budget Routes Single-Run

Source: another small/mid budget batch across OpenAI OSS, Google Gemma, Qwen, Mistral, Reka, and Nvidia routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-small-mid-gauntlet-1777169220" OPENCODE_E2E_MODELS="openrouter/openai/gpt-oss-20b,openrouter/google/gemma-3-27b-it,openrouter/qwen/qwen3-14b,openrouter/qwen/qwen3-8b,openrouter/mistralai/mistral-small-24b-instruct-2501,openrouter/rekaai/reka-edge,openrouter/nvidia/nemotron-3-nano-30b-a3b" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                                  | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                             |
| ------------------------------------------------------ | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -------: | ------------------------------------------------------- |
| `openrouter/openai/gpt-oss-20b`                        |       0.03 |        0.14 | Tested only   |        46 |  15 |       0/1 | model-behavior   | 218186ms | Launched, but timed out already on direct reply.        |
| `openrouter/google/gemma-3-27b-it`                     |       0.08 |        0.16 | Tested only   |        46 |  15 |       0/1 | model-behavior   | 219925ms | Launched, but timed out already on direct reply.        |
| `openrouter/qwen/qwen3-14b`                            |       0.06 |        0.24 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5761ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/qwen/qwen3-8b`                             |       0.05 |        0.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5297ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/mistralai/mistral-small-24b-instruct-2501` |       0.05 |        0.08 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5478ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/rekaai/reka-edge`                          |       0.10 |        0.10 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5452ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/nvidia/nemotron-3-nano-30b-a3b`            |       0.05 |        0.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5443ms | Not found in the live OpenCode provider-scoped catalog. |

Interpretation: this batch is a clean negative result. The two routes that did launch, `gpt-oss-20b` and `gemma-3-27b-it`, failed before producing a first visible reply. The remaining cheap routes are unavailable in OpenCode provider scope today. None should be promoted or prioritized for Agent Teams.

## Legacy Diverse Routes Single-Run

Source: another diverse batch across Mistral, OpenAI, Qwen, DeepSeek, MiniMax, and Nvidia routes that were not covered by the previous small/mid batches. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-legacy-diverse-gauntlet-1777169838" OPENCODE_E2E_MODELS="openrouter/mistralai/mistral-small-3.1-24b-instruct,openrouter/mistralai/mixtral-8x7b-instruct,openrouter/openai/gpt-4o-mini,openrouter/qwen/qwq-32b,openrouter/deepseek/deepseek-chat,openrouter/minimax/minimax-01,openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                                 | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                                                                |
| ----------------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -------: | ------------------------------------------------------------------------------------------ |
| `openrouter/mistralai/mistral-small-3.1-24b-instruct` |       0.35 |        0.56 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   9235ms | Did not reach ready state in OpenCode provider-scope launch.                               |
| `openrouter/mistralai/mixtral-8x7b-instruct`          |       0.54 |        0.54 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5467ms | Not found in the live OpenCode provider-scoped catalog.                                    |
| `openrouter/openai/gpt-4o-mini`                       |       0.15 |        0.60 | Infra blocked |         0 |  70 |       0/1 | provider-infra   | 268294ms | Passed direct and peer relays, then failed concurrent delivery, taskRefs, duplicate check. |
| `openrouter/qwen/qwq-32b`                             |       0.15 |        0.58 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5232ms | Not found in the live OpenCode provider-scoped catalog.                                    |
| `openrouter/deepseek/deepseek-chat`                   |       0.32 |        0.89 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5145ms | Not found in the live OpenCode provider-scoped catalog.                                    |
| `openrouter/minimax/minimax-01`                       |       0.20 |        1.10 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   8112ms | Did not reach ready state in OpenCode provider-scope launch.                               |
| `openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5` |       0.10 |        0.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5220ms | Not found in the live OpenCode provider-scoped catalog.                                    |

Interpretation: no new candidate here. `gpt-4o-mini` is the only model that got far enough to be behaviorally interesting, but it failed exactly the concurrent/taskRefs path and should not be used for Agent Teams. The others are currently blocked before meaningful model behavior can be scored.

## Alternative Compact Routes Single-Run

Source: another compact/alternate batch across OpenAI, DeepSeek, Qwen, Google Gemma, and Nvidia routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-alt-compact-gauntlet-1777170257" OPENCODE_E2E_MODELS="openrouter/openai/gpt-4o-mini-2024-07-18,openrouter/openai/gpt-4o-mini-search-preview,openrouter/deepseek/deepseek-chat-v3-0324,openrouter/qwen/qwen3-next-80b-a3b-thinking,openrouter/qwen/qwen-turbo,openrouter/google/gemma-4-26b-a4b-it,openrouter/nvidia/nemotron-nano-9b-v2" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                          | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                                                                      |
| ---------------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ---------------- | -------: | ------------------------------------------------------------------------------------------------ |
| `openrouter/openai/gpt-4o-mini-2024-07-18`     |       0.15 |        0.60 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5446ms | Not found in the live OpenCode provider-scoped catalog.                                          |
| `openrouter/openai/gpt-4o-mini-search-preview` |       0.15 |        0.60 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5345ms | Not found in the live OpenCode provider-scoped catalog.                                          |
| `openrouter/deepseek/deepseek-chat-v3-0324`    |       0.20 |        0.77 | Tested only      |        54 |  35 |       0/1 | model-behavior   | 123504ms | Passed direct reply, then failed peer relay, concurrent delivery, hygiene, and latency.          |
| `openrouter/qwen/qwen3-next-80b-a3b-thinking`  |     0.0975 |        0.78 | Tested only      |        46 |  15 |       0/1 | model-behavior   | 218859ms | Launched, but timed out already on direct reply.                                                 |
| `openrouter/qwen/qwen-turbo`                   |     0.0325 |        0.13 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |   5163ms | Not found in the live OpenCode provider-scoped catalog.                                          |
| `openrouter/google/gemma-4-26b-a4b-it`         |       0.06 |        0.33 | Strong candidate |       100 | 100 |       1/1 | none             | 175859ms | Passed launch, direct, peer relays, concurrent replies, taskRefs, transcript hygiene.            |
| `openrouter/nvidia/nemotron-nano-9b-v2`        |       0.04 |        0.16 | Infra blocked    |         0 |  35 |       0/1 | provider-infra   | 150316ms | Passed direct reply, then failed peer relay and later Agent Teams stages through OpenCode tools. |

Interpretation: `openrouter/google/gemma-4-26b-a4b-it` is a useful new cheap candidate and is notably better than `gemma-4-31b-it`, which timed out on direct reply. It should be repeated before any promotion because this is only one successful run. `deepseek-chat-v3-0324`, Qwen Next Thinking, and Nemotron Nano are not safe for Agent Teams.

## OpenAI Codex And Prior Tested Routes Single-Run

Source: a targeted batch across routes that had older smoke/tested signals in the UI and needed a fresh deeper gauntlet check. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-openai-codex-gauntlet-1777171112" OPENCODE_E2E_MODELS="openrouter/openai/gpt-5.1,openrouter/openai/gpt-5.1-codex-mini,openrouter/openai/gpt-5.1-codex,openrouter/openai/gpt-5.3-codex,openrouter/openai/gpt-5.4-mini,openrouter/qwen/qwen3-max,openrouter/moonshotai/kimi-k2.6" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                  | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure  |      p50 | Key finding                                                                                 |
| -------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ----------------- | -------: | ------------------------------------------------------------------------------------------- |
| `openrouter/openai/gpt-5.1`            |       1.25 |       10.00 | Infra blocked    |         0 |  70 |       0/1 | provider-infra    | 266597ms | Passed direct and peer relays, then failed concurrent Tom reply, taskRefs, duplicate check. |
| `openrouter/openai/gpt-5.1-codex-mini` |       0.25 |        2.00 | Strong candidate |       100 | 100 |       1/1 | none              |  83426ms | Passed launch, direct, peer relays, concurrent replies, taskRefs, transcript hygiene.       |
| `openrouter/openai/gpt-5.1-codex`      |       1.25 |       10.00 | Tested only      |        40 |   0 |       0/1 | model-behavior    |  65076ms | Failed launch readiness during model verification.                                          |
| `openrouter/openai/gpt-5.3-codex`      |       1.75 |       14.00 | Strong candidate |       100 | 100 |       1/1 | none              | 111932ms | Passed launch, direct, peer relays, concurrent replies, taskRefs, transcript hygiene.       |
| `openrouter/openai/gpt-5.4-mini`       |       0.75 |        4.50 | Infra blocked    |         0 |  70 |       0/1 | provider-infra    | 265504ms | Passed direct and peer relays, then failed concurrent Tom reply, taskRefs, duplicate check. |
| `openrouter/qwen/qwen3-max`            |       0.78 |        3.90 | Tested only      |        55 |  70 |       0/1 | runtime-transport | 298675ms | Passed direct and peer relays, then failed concurrent Tom reply, taskRefs, duplicate check. |
| `openrouter/moonshotai/kimi-k2.6`      |     0.7448 |       4.655 | Strong candidate |       100 | 100 |       1/1 | none              | 163496ms | Passed launch, direct, peer relays, concurrent replies, taskRefs, transcript hygiene.       |

Interpretation: this batch materially changes the UI status of several routes. `gpt-5.1-codex-mini`, `gpt-5.3-codex`, and `kimi-k2.6` remain strong repeat-run candidates. `gpt-5.1`, `gpt-5.4-mini`, and `qwen3-max` should no longer be treated as safe just because older smoke evidence existed: each failed the concurrent/taskRefs path. `gpt-5.1-codex` also failed launch readiness and should stay below `Tested` until rerun cleanly.

## Upper Tier Prior Tested Routes Single-Run

Source: a targeted upper-tier batch across Anthropic, OpenAI, Google, Mistral, and Xiaomi routes that were still present in the UI tested set or looked like possible production candidates. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-upper-tier-gauntlet-1777172576" OPENCODE_E2E_MODELS="openrouter/anthropic/claude-opus-4.6,openrouter/anthropic/claude-opus-4.7,openrouter/openai/gpt-5.4,openrouter/google/gemini-2.5-flash,openrouter/mistralai/mistral-medium-3.1,openrouter/mistralai/devstral-2512,openrouter/xiaomi/mimo-v2-pro" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                     | Input $/1M | Output $/1M | Verdict          | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                                                           |
| ----------------------------------------- | ---------: | ----------: | ---------------- | --------: | --: | --------: | ---------------- | -------: | ------------------------------------------------------------------------------------- |
| `openrouter/anthropic/claude-opus-4.6`    |       5.00 |       25.00 | Infra blocked    |         0 |  15 |       0/1 | provider-infra   | 220945ms | Launched, but timed out already on direct reply.                                      |
| `openrouter/anthropic/claude-opus-4.7`    |       5.00 |       25.00 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |  26623ms | Failed OpenCode launch readiness.                                                     |
| `openrouter/openai/gpt-5.4`               |       2.50 |       15.00 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |  26608ms | Failed OpenCode launch readiness.                                                     |
| `openrouter/google/gemini-2.5-flash`      |       0.30 |        2.50 | Strong candidate |       100 | 100 |       1/1 | none             | 108333ms | Passed launch, direct, peer relays, concurrent replies, taskRefs, transcript hygiene. |
| `openrouter/mistralai/mistral-medium-3.1` |       0.40 |        2.00 | Tested only      |        54 |  35 |       0/1 | model-behavior   | 227298ms | Passed direct reply, then timed out on peer relay and later Agent Teams stages.       |
| `openrouter/mistralai/devstral-2512`      |       0.40 |        2.00 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |  23751ms | Failed OpenCode launch readiness.                                                     |
| `openrouter/xiaomi/mimo-v2-pro`           |       1.00 |        3.00 | Infra blocked    |         0 |   0 |       0/1 | provider-infra   |  27870ms | Failed OpenCode launch readiness.                                                     |

Interpretation: `openrouter/google/gemini-2.5-flash` is the only positive result in this upper-tier batch and remains a serious repeat-run candidate. The fresh evidence is negative for `opus-4.6`, `opus-4.7`, `gpt-5.4`, `mistral-medium-3.1`, `devstral-2512`, and `mimo-v2-pro`, so these routes were removed from the UI tested set and marked not recommended until a future clean gauntlet disproves this run.

## Free Route Variants Single-Run

Source: a free-route batch across Gemma, Nvidia, OpenAI OSS, and Qwen. These routes are intentionally tracked separately from paid routes because free provider routing can have different capacity, latency, and model behavior. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-free-routes-gauntlet-1777173485" OPENCODE_E2E_MODELS="openrouter/google/gemma-4-26b-a4b-it:free,openrouter/google/gemma-4-31b-it:free,openrouter/nvidia/nemotron-3-super-120b-a12b:free,openrouter/nvidia/nemotron-3-nano-30b-a3b:free,openrouter/openai/gpt-oss-120b:free,openrouter/qwen/qwen3-coder:free,openrouter/qwen/qwen3-next-80b-a3b-instruct:free" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                               | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                                                              |
| --------------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -------: | ---------------------------------------------------------------------------------------- |
| `openrouter/google/gemma-4-26b-a4b-it:free`         |       0.00 |        0.00 | Tested only   |        40 |   0 |       0/1 | model-behavior   |  65701ms | Failed launch readiness during model verification; paid Gemma 4 26B behaved much better. |
| `openrouter/google/gemma-4-31b-it:free`             |       0.00 |        0.00 | Tested only   |        40 |   0 |       0/1 | model-behavior   |  65528ms | Failed launch readiness during model verification.                                       |
| `openrouter/nvidia/nemotron-3-super-120b-a12b:free` |       0.00 |        0.00 | Tested only   |        54 |  35 |       0/1 | model-behavior   | 127081ms | Passed direct reply, then failed peer relay and later Agent Teams stages.                |
| `openrouter/nvidia/nemotron-3-nano-30b-a3b:free`    |       0.00 |        0.00 | Tested only   |        54 |  35 |       0/1 | model-behavior   | 259532ms | Passed direct reply, then timed out on peer relay and later Agent Teams stages.          |
| `openrouter/openai/gpt-oss-120b:free`               |       0.00 |        0.00 | Infra blocked |         0 |  35 |       0/1 | provider-infra   | 253457ms | Passed direct reply, then timed out on peer relay and later Agent Teams stages.          |
| `openrouter/qwen/qwen3-coder:free`                  |       0.00 |        0.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5414ms | Not found in the live OpenCode provider-scoped catalog.                                  |
| `openrouter/qwen/qwen3-next-80b-a3b-instruct:free`  |       0.00 |        0.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5702ms | Not found in the live OpenCode provider-scoped catalog.                                  |

Interpretation: none of these free routes should be promoted. The most important result is that `openrouter/google/gemma-4-26b-a4b-it:free` does not inherit the positive signal from the paid `openrouter/google/gemma-4-26b-a4b-it` route; the free route failed launch verification. Existing free-route UI status was tightened accordingly.

## Next Diverse Routes Single-Run

Source: another batch across Kimi, DeepSeek, Z.ai, and xAI routes that were not covered by the latest gauntlet batches. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-diverse-gauntlet-1777174654" OPENCODE_E2E_MODELS="openrouter/moonshotai/kimi-k2.5,openrouter/moonshotai/kimi-k2-0905,openrouter/moonshotai/kimi-k2,openrouter/deepseek/deepseek-v3.2-speciale,openrouter/deepseek/deepseek-v3.1-terminus,openrouter/z-ai/glm-4.5,openrouter/x-ai/grok-4.20" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                        | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |     p50 | Key finding                                                               |
| -------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | ------: | ------------------------------------------------------------------------- |
| `openrouter/moonshotai/kimi-k2.5`            |       0.44 |        2.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 31813ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |
| `openrouter/moonshotai/kimi-k2-0905`         |       0.40 |        2.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 25066ms | Launch was blocked by OpenRouter key/max_tokens allowance for 16k output. |
| `openrouter/moonshotai/kimi-k2`              |       0.57 |        2.30 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 24283ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |
| `openrouter/deepseek/deepseek-v3.2-speciale` |       0.40 |        1.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  7401ms | OpenRouter reported no endpoints that support tool use for this route.    |
| `openrouter/deepseek/deepseek-v3.1-terminus` |       0.21 |        0.79 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 23360ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |
| `openrouter/z-ai/glm-4.5`                    |       0.60 |        2.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  7378ms | Production Agent Teams prompt exceeded the route/key token allowance.     |
| `openrouter/x-ai/grok-4.20`                  |       2.00 |        6.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5280ms | Not found in the live OpenCode provider-scoped catalog.                   |

Interpretation: this batch produced no new promotion candidate. The Kimi and DeepSeek Terminus results are not useful behavioral judgments yet because they were blocked by the current OpenRouter key/max_tokens allowance before Agent Teams messaging could start. `deepseek-v3.2-speciale` and `grok-4.20` are more actionable negatives for the UI: one lacks tool-use endpoints, the other is not available in the live OpenCode catalog. `glm-4.5` is also not safe under current production prompts because launch fails before the team reaches ready state.

## Next Mixed Routes Single-Run

Source: another mixed batch across OpenAI, Gemini, Z.ai, xAI, Qwen, and Mistral routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-mixed-gauntlet-1777175031" OPENCODE_E2E_MODELS="openrouter/openai/gpt-5.5,openrouter/google/gemini-3.1-pro-preview-customtools,openrouter/google/gemini-3.1-flash-image-preview,openrouter/z-ai/glm-5v-turbo,openrouter/x-ai/grok-4.20-multi-agent,openrouter/qwen/qwen3.5-plus-02-15,openrouter/mistralai/mistral-small-creative" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                                  | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |     p50 | Key finding                                                               |
| ------------------------------------------------------ | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | ------: | ------------------------------------------------------------------------- |
| `openrouter/openai/gpt-5.5`                            |       5.00 |       30.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 10120ms | Launch was blocked by OpenRouter key/max_tokens allowance even at 512.    |
| `openrouter/google/gemini-3.1-pro-preview-customtools` |       2.00 |       12.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  8751ms | Production Agent Teams prompt exceeded the route/key token allowance.     |
| `openrouter/google/gemini-3.1-flash-image-preview`     |       0.50 |        3.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5985ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/z-ai/glm-5v-turbo`                         |       1.20 |        4.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6234ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/x-ai/grok-4.20-multi-agent`                |       2.00 |        6.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5976ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/qwen/qwen3.5-plus-02-15`                   |       0.26 |        1.56 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 29055ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |
| `openrouter/mistralai/mistral-small-creative`          |       0.10 |        0.30 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6181ms | Not found in the live OpenCode provider-scoped catalog.                   |

Interpretation: this batch produced no new candidate. The most actionable result is catalog coverage: `gemini-3.1-flash-image-preview`, `glm-5v-turbo`, `grok-4.20-multi-agent`, and `mistral-small-creative` are present in OpenRouter but not usable through the current live OpenCode provider-scoped catalog. `gpt-5.5` and `qwen3.5-plus-02-15` are blocked by the current OpenRouter key/max_tokens allowance, so they need a rerun only if we raise the key limits. `gemini-3.1-pro-preview-customtools` is not viable under current production Agent Teams prompts because the route/key token allowance is too low.

## Next Cheap/Mid Routes Single-Run

Source: another cheap/mid batch across OpenAI, MiniMax, Gemma, Mistral Voxtral, and Qwen. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-cheap-mid-gauntlet-1777175221" OPENCODE_E2E_MODELS="openrouter/openai/gpt-5.2,openrouter/openai/gpt-5.3-chat,openrouter/minimax/minimax-m1,openrouter/google/gemma-3n-e4b-it,openrouter/google/gemma-3n-e2b-it:free,openrouter/mistralai/voxtral-small-24b-2507,openrouter/qwen/qwen3.5-397b-a17b" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                         | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |     p50 | Key finding                                                               |
| --------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | ------: | ------------------------------------------------------------------------- |
| `openrouter/openai/gpt-5.2`                   |       1.75 |       14.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  9666ms | Launch was blocked by OpenRouter key/max_tokens allowance even at 512.    |
| `openrouter/openai/gpt-5.3-chat`              |       1.75 |       14.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6261ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/minimax/minimax-m1`               |       0.40 |        2.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  8741ms | Production Agent Teams prompt exceeded the route/key token allowance.     |
| `openrouter/google/gemma-3n-e4b-it`           |       0.06 |        0.12 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  8583ms | OpenRouter reported no endpoints that support tool use for this route.    |
| `openrouter/google/gemma-3n-e2b-it:free`      |       0.00 |        0.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  8754ms | OpenRouter reported no endpoints that support tool use for this route.    |
| `openrouter/mistralai/voxtral-small-24b-2507` |       0.10 |        0.30 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6042ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/qwen/qwen3.5-397b-a17b`           |       0.39 |        2.34 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 27540ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |

Interpretation: this batch produced no new candidate. `gpt-5.3-chat` and `voxtral-small-24b-2507` are OpenRouter-visible but absent from the current OpenCode provider-scoped catalog. Gemma 3n routes are not useful for Agent Teams through this path because OpenRouter reported no tool-use endpoints. `minimax-m1` is not a replacement for the stronger MiniMax M2/M2.1/M2.5 routes: it fails before the team reaches ready state under production prompts.

## Next Practical Routes Single-Run

Source: practical/cheap route batch across OpenAI, xAI, Qwen, and DeepSeek Chimera. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-practical-gauntlet-1777175565" OPENCODE_E2E_MODELS="openrouter/openai/gpt-5-mini,openrouter/openai/gpt-5-chat,openrouter/openai/gpt-5-codex,openrouter/x-ai/grok-3-mini-beta,openrouter/qwen/qwen-2.5-coder-32b-instruct,openrouter/qwen/qwen-2.5-72b-instruct,openrouter/tngtech/deepseek-r1t2-chimera" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                         | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |     p50 | Key finding                                                               |
| --------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | ------: | ------------------------------------------------------------------------- |
| `openrouter/openai/gpt-5-mini`                |       0.25 |        2.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 29354ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |
| `openrouter/openai/gpt-5-chat`                |       1.25 |       10.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6166ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/openai/gpt-5-codex`               |       1.25 |       10.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  8741ms | Production Agent Teams prompt exceeded the route/key token allowance.     |
| `openrouter/x-ai/grok-3-mini-beta`            |       0.30 |        0.50 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 35543ms | Launch was blocked by OpenRouter key/max_tokens allowance for 8k output.  |
| `openrouter/qwen/qwen-2.5-coder-32b-instruct` |       0.66 |        1.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  8845ms | OpenRouter reported no endpoints that support tool use for this route.    |
| `openrouter/qwen/qwen-2.5-72b-instruct`       |       0.12 |        0.39 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6023ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/tngtech/deepseek-r1t2-chimera`    |       0.30 |        1.10 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5970ms | Not found in the live OpenCode provider-scoped catalog.                   |

Interpretation: this batch produced no new candidate. `gpt-5-mini`, `grok-3-mini-beta`, and `gpt-5-codex` need a rerun only if key/max-token limits are raised enough for production Agent Teams prompts. The Qwen 2.5 and DeepSeek Chimera routes are not useful through the current OpenCode path: either they are absent from the live OpenCode catalog or OpenRouter reports no tool-use endpoints.

## Legacy And Preview Routes Single-Run

Source: another batch across legacy Anthropic/Gemini/Mistral routes and Qwen VL. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-legacy-preview-gauntlet-1777175763" OPENCODE_E2E_MODELS="openrouter/google/gemini-2.5-pro-preview,openrouter/google/gemini-2.5-pro-preview-05-06,openrouter/mistralai/mistral-saba,openrouter/mistralai/mistral-large-2411,openrouter/anthropic/claude-3.5-haiku,openrouter/anthropic/claude-3.7-sonnet,openrouter/qwen/qwen3-vl-30b-a3b-instruct" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                            | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                            |
| ------------------------------------------------ | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | ---------------------------------------------------------------------- |
| `openrouter/google/gemini-2.5-pro-preview`       |       1.25 |       10.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6854ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/google/gemini-2.5-pro-preview-05-06` |       1.25 |       10.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 9299ms | Launch was blocked by OpenRouter key/max_tokens allowance even at 512. |
| `openrouter/mistralai/mistral-saba`              |       0.20 |        0.60 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5764ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/mistralai/mistral-large-2411`        |       2.00 |        6.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5928ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/anthropic/claude-3.5-haiku`          |       0.80 |        4.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8470ms | Production Agent Teams prompt exceeded the route/key token allowance.  |
| `openrouter/anthropic/claude-3.7-sonnet`         |       3.00 |       15.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8163ms | Launch was blocked by OpenRouter key/max_tokens allowance even at 512. |
| `openrouter/qwen/qwen3-vl-30b-a3b-instruct`      |       0.13 |        0.52 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6018ms | Not found in the live OpenCode provider-scoped catalog.                |

Interpretation: this batch produced no new candidate. The older preview/legacy routes are not better than the already-tested modern winners: they either are missing from the OpenCode catalog or cannot accept production Agent Teams prompts under the current key/token allowance. For practical usage, keep focus on the routes that already passed full gauntlet stages, such as Gemini 3 Flash, Gemini 3.1 Flash Lite, MiniMax M2/M2.1/M2.5, Codestral 2508, GLM 4.7/5.1, Step 3.5 Flash, and Claude Sonnet 4.6 until repeated promotion runs are done.

## Cheap Tool-Capable Routes Single-Run

Source: another cheap/diverse batch selected from the live OpenRouter model catalog for long-context routes that advertised tool support. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-cheap-tools-gauntlet-1777176070" OPENCODE_E2E_MODELS="openrouter/inclusionai/ling-2.6-1t:free,openrouter/inclusionai/ling-2.6-flash:free,openrouter/nvidia/nemotron-nano-12b-v2-vl:free,openrouter/meta-llama/llama-3.1-8b-instruct,openrouter/qwen/qwen-2.5-7b-instruct,openrouter/amazon/nova-lite-v1,openrouter/z-ai/glm-4-32b,openrouter/google/gemini-2.5-flash-lite-preview-09-2025" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                                     | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |     p50 | Key finding                                                               |
| --------------------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | ------: | ------------------------------------------------------------------------- |
| `openrouter/inclusionai/ling-2.6-1t:free`                 |       0.00 |        0.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6516ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/inclusionai/ling-2.6-flash:free`              |       0.00 |        0.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6031ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/nvidia/nemotron-nano-12b-v2-vl:free`          |       0.00 |        0.00 | Tested only   |        40 |   0 |       0/1 | model-behavior   | 65941ms | Failed launch readiness because model verification timed out.             |
| `openrouter/meta-llama/llama-3.1-8b-instruct`             |       0.02 |        0.05 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6117ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/qwen/qwen-2.5-7b-instruct`                    |       0.04 |        0.10 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5760ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/amazon/nova-lite-v1`                          |       0.06 |        0.24 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6086ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/z-ai/glm-4-32b`                               |       0.10 |        0.10 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6226ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/google/gemini-2.5-flash-lite-preview-09-2025` |       0.10 |        0.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 26204ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |

Interpretation: this batch produced no new candidate. The important practical signal is that OpenRouter catalog availability plus advertised tool support still does not mean the route is visible to the OpenCode provider-scoped catalog. The only non-catalog failure worth revisiting later is `openrouter/google/gemini-2.5-flash-lite-preview-09-2025`, which reached OpenRouter but was blocked by current key/max-token allowance.

## Diverse Tool-Capable Routes Single-Run

Source: another cheap/mid diverse batch selected from the live OpenRouter model catalog for routes that advertised tool support. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-diverse-tools-gauntlet-1777176324" OPENCODE_E2E_MODELS="openrouter/bytedance-seed/seed-1.6-flash,openrouter/meta-llama/llama-4-scout,openrouter/qwen/qwen3-30b-a3b-instruct-2507,openrouter/meta-llama/llama-3.3-70b-instruct,openrouter/bytedance-seed/seed-2.0-mini,openrouter/qwen/qwen3-vl-32b-instruct,openrouter/alibaba/tongyi-deepresearch-30b-a3b,openrouter/arcee-ai/trinity-large-preview" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                            | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |     p50 | Key finding                                                               |
| ------------------------------------------------ | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | ------: | ------------------------------------------------------------------------- |
| `openrouter/bytedance-seed/seed-1.6-flash`       |      0.075 |        0.30 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  6015ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/meta-llama/llama-4-scout`            |       0.08 |        0.30 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5266ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/qwen/qwen3-30b-a3b-instruct-2507`    |       0.09 |        0.30 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 27361ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |
| `openrouter/meta-llama/llama-3.3-70b-instruct`   |       0.10 |        0.32 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5511ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/bytedance-seed/seed-2.0-mini`        |       0.10 |        0.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5502ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/qwen/qwen3-vl-32b-instruct`          |      0.104 |       0.416 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5737ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/alibaba/tongyi-deepresearch-30b-a3b` |       0.09 |        0.45 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5490ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/arcee-ai/trinity-large-preview`      |       0.15 |        0.45 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  5505ms | Not found in the live OpenCode provider-scoped catalog.                   |

Interpretation: this batch also produced no candidate. Most of these OpenRouter routes are not currently usable through OpenCode's provider-scoped catalog even though OpenRouter advertises tool support. `openrouter/qwen/qwen3-30b-a3b-instruct-2507` reached a different failure mode: it was visible enough to hit OpenRouter, but the production Agent Teams launch was blocked by the key/max-token allowance.

## Wide Tool-Capable Routes Single-Run

Source: another low/mid-cost batch selected from the live OpenRouter model catalog for tool-capable routes that had not yet been recorded. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-wide-tools-gauntlet-1777176494" OPENCODE_E2E_MODELS="openrouter/amazon/nova-micro-v1,openrouter/arcee-ai/trinity-mini,openrouter/qwen/qwen3.5-9b,openrouter/essentialai/rnj-1-instruct,openrouter/upstage/solar-pro-3,openrouter/allenai/olmo-3.1-32b-instruct,openrouter/inception/mercury-2,openrouter/qwen/qwen-plus-2025-07-28" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                      | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| ------------------------------------------ | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/amazon/nova-micro-v1`          |      0.035 |        0.14 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6041ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/arcee-ai/trinity-mini`         |      0.045 |        0.15 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5490ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/qwen/qwen3.5-9b`               |       0.10 |        0.15 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5554ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/essentialai/rnj-1-instruct`    |       0.15 |        0.15 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5569ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/upstage/solar-pro-3`           |       0.15 |        0.60 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5425ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/allenai/olmo-3.1-32b-instruct` |       0.20 |        0.60 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5458ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/inception/mercury-2`           |       0.25 |        0.75 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8281ms | Production Agent Teams prompt exceeded the route/key token allowance. |
| `openrouter/qwen/qwen-plus-2025-07-28`     |       0.26 |        0.78 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5495ms | Not found in the live OpenCode provider-scoped catalog.               |

Interpretation: no new candidate. The repeated pattern is now clear enough to trust for UI status: many OpenRouter routes are real catalog entries, but unavailable through the OpenCode provider-scoped launch catalog. `openrouter/inception/mercury-2` is visible enough to execute, but cannot fit the production Agent Teams launch prompt under the current route/key allowance.

## Broad Tool-Capable Routes Single-Run

Source: another broad batch selected from the live OpenRouter model catalog for cheap or mid-cost tool-capable routes that had not yet been recorded. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-broad-tools-gauntlet-1777176681" OPENCODE_E2E_MODELS="openrouter/tencent/hy3-preview:free,openrouter/nvidia/nemotron-nano-9b-v2:free,openrouter/google/gemma-3-12b-it,openrouter/openai/gpt-oss-safeguard-20b,openrouter/qwen/qwen3-30b-a3b-thinking-2507,openrouter/qwen/qwen3-vl-8b-instruct,openrouter/nex-agi/deepseek-v3.1-nex-n1,openrouter/baidu/ernie-4.5-vl-28b-a3b" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                         | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |      p50 | Key finding                                                               |
| --------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -------: | ------------------------------------------------------------------------- |
| `openrouter/tencent/hy3-preview:free`         |       0.00 |        0.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   6736ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/nvidia/nemotron-nano-9b-v2:free`  |       0.00 |        0.00 | Tested only   |        54 |  35 |       0/1 | model-behavior   | 217470ms | Passed direct reply, then failed peer relay through OpenCode tool usage.  |
| `openrouter/google/gemma-3-12b-it`            |       0.04 |        0.13 | Infra blocked |         0 |  15 |       0/1 | provider-infra   | 222783ms | Launched, but timed out already on direct reply.                          |
| `openrouter/openai/gpt-oss-safeguard-20b`     |      0.075 |        0.30 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  23531ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |
| `openrouter/qwen/qwen3-30b-a3b-thinking-2507` |       0.08 |        0.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |  27877ms | Launch was blocked by OpenRouter key/max_tokens allowance for 32k output. |
| `openrouter/qwen/qwen3-vl-8b-instruct`        |       0.08 |        0.50 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5427ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/nex-agi/deepseek-v3.1-nex-n1`     |      0.135 |        0.50 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5521ms | Not found in the live OpenCode provider-scoped catalog.                   |
| `openrouter/baidu/ernie-4.5-vl-28b-a3b`       |       0.14 |        0.56 | Infra blocked |         0 |   0 |       0/1 | provider-infra   |   5306ms | Not found in the live OpenCode provider-scoped catalog.                   |

Interpretation: no new candidate. The best partial signal was `openrouter/nvidia/nemotron-nano-9b-v2:free`, which launched and answered the direct user message but failed peer relay through OpenCode's tool path. `openrouter/google/gemma-3-12b-it` launched but timed out on the first direct reply, so it is not a practical Agent Teams route.

## Mid Tool-Capable Routes Single-Run

Source: another mid-cost batch selected from the live OpenRouter model catalog for tool-capable routes that had not yet been recorded. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-mid-tools-gauntlet-1777177301" OPENCODE_E2E_MODELS="openrouter/thedrummer/rocinante-12b,openrouter/meta-llama/llama-3.1-70b-instruct,openrouter/qwen/qwen-plus-2025-07-28:thinking,openrouter/z-ai/glm-4.6v,openrouter/prime-intellect/intellect-3,openrouter/anthropic/claude-3-haiku,openrouter/openai/gpt-4.1-mini,openrouter/bytedance-seed/seed-2.0-lite" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                           | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| ----------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/thedrummer/rocinante-12b`           |       0.17 |        0.43 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5720ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/meta-llama/llama-3.1-70b-instruct`  |       0.40 |        0.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5418ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/qwen/qwen-plus-2025-07-28:thinking` |       0.26 |        0.78 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5491ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/z-ai/glm-4.6v`                      |       0.30 |        0.90 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5503ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/prime-intellect/intellect-3`        |       0.20 |        1.10 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8182ms | Production Agent Teams prompt exceeded the route/key token allowance. |
| `openrouter/anthropic/claude-3-haiku`           |       0.25 |        1.25 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5465ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-4.1-mini`                |       0.40 |        1.60 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 7631ms | Production Agent Teams prompt exceeded the route/key token allowance. |
| `openrouter/bytedance-seed/seed-2.0-lite`       |       0.25 |        2.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5473ms | Not found in the live OpenCode provider-scoped catalog.               |

Interpretation: no new candidate. `openrouter/openai/gpt-4.1-mini` and `openrouter/prime-intellect/intellect-3` are visible enough to hit OpenRouter, but they cannot fit the production Agent Teams bootstrap under the current route/key token allowance. The rest are unavailable through OpenCode's provider-scoped catalog.

## Upper-Mid Tool-Capable Routes Single-Run

Source: upper-mid/high-interest routes selected from the live OpenRouter model catalog, including larger Qwen, DeepSeek, Amazon Nova, OpenAI o-series, and Mistral routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-upper-mid-gauntlet-1777177431" OPENCODE_E2E_MODELS="openrouter/qwen/qwen3-235b-a22b,openrouter/qwen/qwen3.5-122b-a10b,openrouter/deepseek/deepseek-r1-0528,openrouter/amazon/nova-2-lite-v1,openrouter/openai/o4-mini,openrouter/openai/o3-mini,openrouter/mistralai/mistral-large-2407" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                     | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                            |
| ----------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | ---------------------------------------------------------------------- |
| `openrouter/qwen/qwen3-235b-a22b`         |      0.455 |        1.82 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5318ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/qwen/qwen3.5-122b-a10b`       |       0.26 |        2.08 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5539ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/deepseek/deepseek-r1-0528`    |       0.50 |        2.15 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5529ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/amazon/nova-2-lite-v1`        |       0.30 |        2.50 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5396ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/openai/o4-mini`               |       1.10 |        4.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8177ms | Launch was blocked by OpenRouter key/max_tokens allowance even at 512. |
| `openrouter/openai/o3-mini`               |       1.10 |        4.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5454ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/mistralai/mistral-large-2407` |       2.00 |        6.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5584ms | Not found in the live OpenCode provider-scoped catalog.                |

Interpretation: no new candidate. These higher-profile routes do not currently improve the Agent Teams OpenCode set: most are absent from OpenCode's provider-scoped catalog, and `openrouter/openai/o4-mini` was blocked by key/max-token allowance even at the reduced 512-token verification cap.

## Remaining Mid Tool-Capable Routes Single-Run

Source: another batch from the remaining unrecorded low/mid-cost tool-capable OpenRouter routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-remaining-mid-gauntlet-1777177599" OPENCODE_E2E_MODELS="openrouter/thedrummer/unslopnemo-12b,openrouter/arcee-ai/trinity-large-thinking,openrouter/qwen/qwen3-vl-235b-a22b-instruct,openrouter/qwen/qwen3-vl-8b-thinking,openrouter/kwaipilot/kat-coder-pro-v2,openrouter/qwen/qwen3-235b-a22b-thinking-2507,openrouter/xiaomi/mimo-v2-omni,openrouter/deepseek/deepseek-r1" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                           | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| ----------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/thedrummer/unslopnemo-12b`          |       0.40 |        0.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6576ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/arcee-ai/trinity-large-thinking`    |       0.22 |        0.85 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 9348ms | Production Agent Teams prompt exceeded the route/key token allowance. |
| `openrouter/qwen/qwen3-vl-235b-a22b-instruct`   |       0.20 |        0.88 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6038ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/qwen/qwen3-vl-8b-thinking`          |      0.117 |       1.365 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5979ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/kwaipilot/kat-coder-pro-v2`         |       0.30 |        1.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6162ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/qwen/qwen3-235b-a22b-thinking-2507` |     0.1495 |       1.495 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8808ms | Production Agent Teams prompt exceeded the route/key token allowance. |
| `openrouter/xiaomi/mimo-v2-omni`                |       0.40 |        2.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8381ms | Production Agent Teams prompt exceeded the route/key token allowance. |
| `openrouter/deepseek/deepseek-r1`               |       0.70 |        2.50 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8272ms | Production Agent Teams prompt exceeded the route/key token allowance. |

Interpretation: no new candidate. The main useful signal is negative: several reasoning/thinking or VL routes are either absent from OpenCode's provider-scoped catalog or too constrained for production Agent Teams bootstrap prompts under the current key/route allowance.

## High-Profile Routes Single-Run

Source: high-profile OpenAI/Cohere routes selected from the remaining unrecorded tool-capable OpenRouter models. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-high-profile-gauntlet-1777177738" OPENCODE_E2E_MODELS="openrouter/openai/o4-mini-high,openrouter/openai/o3-mini-high,openrouter/openai/gpt-4.1,openrouter/openai/gpt-5,openrouter/openai/gpt-4o,openrouter/cohere/command-r-plus-08-2024" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                      | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                            |
| ------------------------------------------ | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | ---------------------------------------------------------------------- |
| `openrouter/openai/o4-mini-high`           |       1.10 |        4.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6810ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/openai/o3-mini-high`           |       1.10 |        4.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6182ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/openai/gpt-4.1`                |       2.00 |        8.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 9192ms | Launch was blocked by OpenRouter key/max_tokens allowance even at 512. |
| `openrouter/openai/gpt-5`                  |       1.25 |       10.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8688ms | Launch was blocked by OpenRouter key/max_tokens allowance even at 512. |
| `openrouter/openai/gpt-4o`                 |       2.50 |       10.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6099ms | Not found in the live OpenCode provider-scoped catalog.                |
| `openrouter/cohere/command-r-plus-08-2024` |       2.50 |       10.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6050ms | Not found in the live OpenCode provider-scoped catalog.                |

Interpretation: no new candidate. This confirms that several familiar high-profile OpenRouter IDs are not available through the current OpenCode provider-scoped catalog. The two visible OpenAI routes in this batch, `gpt-4.1` and `gpt-5`, are blocked by current key/max-token allowance before they can prove Agent Teams behavior.

## Tail Mid Tool-Capable Routes Single-Run

Source: another tail batch from the remaining unrecorded mid-cost tool-capable OpenRouter routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-tail-mid-gauntlet-1777177902" OPENCODE_E2E_MODELS="openrouter/qwen/qwen3-vl-30b-a3b-thinking,openrouter/sao10k/l3.1-euryale-70b,openrouter/qwen/qwen3.5-27b,openrouter/arcee-ai/virtuoso-large,openrouter/openai/gpt-3.5-turbo,openrouter/bytedance-seed/seed-1.6,openrouter/z-ai/glm-4.5v,openrouter/nvidia/llama-3.1-nemotron-70b-instruct" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                               | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| --------------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/qwen/qwen3-vl-30b-a3b-thinking`         |       0.13 |        1.56 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6770ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/sao10k/l3.1-euryale-70b`                |       0.85 |        0.85 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6150ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/qwen/qwen3.5-27b`                       |      0.195 |        1.56 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6142ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/arcee-ai/virtuoso-large`                |       0.75 |        1.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6001ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-3.5-turbo`                   |       0.50 |        1.50 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5883ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/bytedance-seed/seed-1.6`                |       0.25 |        2.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6180ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/z-ai/glm-4.5v`                          |       0.60 |        1.80 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 9425ms | Production Agent Teams prompt exceeded the route/key token allowance. |
| `openrouter/nvidia/llama-3.1-nemotron-70b-instruct` |       1.20 |        1.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6030ms | Not found in the live OpenCode provider-scoped catalog.               |

Interpretation: no new candidate. This further confirms that most long-tail OpenRouter routes are not available through the current OpenCode provider-scoped catalog. `openrouter/z-ai/glm-4.5v` is visible enough to reach OpenRouter, but its effective token allowance is too small for production Agent Teams launch prompts.

## Final Mid Tool-Capable Routes Single-Run

Source: final mid-cost tail batch selected from the remaining unrecorded OpenRouter routes before the expensive deep-research/pro tier. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-next-final-mid-gauntlet-1777178031" OPENCODE_E2E_MODELS="openrouter/qwen/qwen-vl-max,openrouter/qwen/qwen3-vl-235b-a22b-thinking,openrouter/openai/gpt-audio-mini,openrouter/amazon/nova-pro-v1,openrouter/relace/relace-search,openrouter/qwen/qwen-max,openrouter/mistralai/pixtral-large-2411,openrouter/mistralai/mixtral-8x22b-instruct" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                         | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                             |
| --------------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | ------------------------------------------------------- |
| `openrouter/qwen/qwen-vl-max`                 |       0.52 |        2.08 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6496ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/qwen/qwen3-vl-235b-a22b-thinking` |       0.26 |        2.60 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5985ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/openai/gpt-audio-mini`            |       0.60 |        2.40 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6015ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/amazon/nova-pro-v1`               |       0.80 |        3.20 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6113ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/relace/relace-search`             |       1.00 |        3.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5935ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/qwen/qwen-max`                    |       1.04 |        4.16 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6078ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/mistralai/pixtral-large-2411`     |       2.00 |        6.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6114ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/mistralai/mixtral-8x22b-instruct` |       2.00 |        6.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 5803ms | Not found in the live OpenCode provider-scoped catalog. |

Interpretation: no new candidate. Every route in this batch exists in OpenRouter but was missing from the current OpenCode provider-scoped launch catalog, so none can be offered as a practical Agent Teams OpenCode choice.

## More High-Value Routes Single-Run

Source: additional high-value and legacy/pro OpenRouter routes selected from the remaining unrecorded tool-capable routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-more-gauntlet-1777178255" OPENCODE_E2E_MODELS="openrouter/openai/gpt-3.5-turbo-16k,openrouter/mistralai/mistral-large,openrouter/openai/o4-mini-deep-research,openrouter/ai21/jamba-large-1.7,openrouter/openai/o3,openrouter/openai/gpt-5.1-codex-max" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                     | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| ----------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/openai/gpt-3.5-turbo-16k`     |       3.00 |        4.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6940ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/mistralai/mistral-large`      |       2.00 |        6.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5846ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/o4-mini-deep-research` |       2.00 |        8.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6124ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/ai21/jamba-large-1.7`         |       2.00 |        8.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6067ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/o3`                    |       2.00 |        8.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6181ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-5.1-codex-max`     |       1.25 |       10.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 9088ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |

Interpretation: no new candidate. Five routes are still absent from OpenCode's provider-scoped catalog. `openrouter/openai/gpt-5.1-codex-max` is visible enough to reach OpenRouter, but the current key/max_tokens allowance cannot support even the reduced production launch check.

## More Legacy Audio And Chat Routes Single-Run

Source: second additional batch from remaining OpenAI audio/versioned routes, Amazon Nova Premier, and GPT-5.2 Chat. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-more-gauntlet-1777178436" OPENCODE_E2E_MODELS="openrouter/openai/gpt-audio,openrouter/openai/gpt-4o-audio-preview,openrouter/openai/gpt-4o-2024-11-20,openrouter/openai/gpt-4o-2024-08-06,openrouter/amazon/nova-premier-v1,openrouter/openai/gpt-5.2-chat" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                    | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| ---------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/openai/gpt-audio`            |       2.50 |       10.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6425ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-4o-audio-preview` |       2.50 |       10.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6152ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-4o-2024-11-20`    |       2.50 |       10.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5901ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-4o-2024-08-06`    |       2.50 |       10.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6163ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/amazon/nova-premier-v1`      |       2.50 |       12.50 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5831ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-5.2-chat`         |       1.75 |       14.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 9207ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |

Interpretation: no new candidate. The audio/versioned OpenAI routes and Nova Premier are unavailable through the current OpenCode provider-scoped launch catalog. `openrouter/openai/gpt-5.2-chat` reached OpenRouter but is not practical with the current key/max_tokens allowance for production Agent Teams prompts.

## Expensive Remaining Routes Single-Run

Source: next remaining high-cost OpenRouter routes before the ultra-expensive pro tail. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-more-gauntlet-1777178600" OPENCODE_E2E_MODELS="openrouter/x-ai/grok-3,openrouter/anthropic/claude-sonnet-4,openrouter/x-ai/grok-3-beta,openrouter/anthropic/claude-3.7-sonnet:thinking,openrouter/openai/gpt-4o-2024-05-13,openrouter/~anthropic/claude-opus-latest" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                             | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| ------------------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/x-ai/grok-3`                          |       3.00 |       15.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8702ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |
| `openrouter/anthropic/claude-sonnet-4`            |       3.00 |       15.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 7765ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |
| `openrouter/x-ai/grok-3-beta`                     |       3.00 |       15.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 7590ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |
| `openrouter/anthropic/claude-3.7-sonnet:thinking` |       3.00 |       15.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5562ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-4o-2024-05-13`             |       5.00 |       15.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5641ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/~anthropic/claude-opus-latest`        |       5.00 |       25.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5368ms | Not found in the live OpenCode provider-scoped catalog.               |

Interpretation: no new candidate. The visible expensive Grok/Sonnet routes were blocked by key/max_tokens allowance during launch bootstrap. The thinking/legacy alias routes were absent from OpenCode's provider-scoped launch catalog.

## Turbo And Deep-Research Tail Single-Run

Source: additional expensive OpenAI legacy Turbo and deep-research routes from the remaining unrecorded tail. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-more-gauntlet-1777178755" OPENCODE_E2E_MODELS="openrouter/openai/gpt-4-turbo,openrouter/openai/gpt-4-turbo-preview,openrouter/openai/gpt-4-1106-preview,openrouter/openai/o3-deep-research,openrouter/openai/o1" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                   | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                             |
| --------------------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | ------------------------------------------------------- |
| `openrouter/openai/gpt-4-turbo`         |      10.00 |       30.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6739ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/openai/gpt-4-turbo-preview` |      10.00 |       30.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6031ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/openai/gpt-4-1106-preview`  |      10.00 |       30.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6093ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/openai/o3-deep-research`    |      10.00 |       40.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6252ms | Not found in the live OpenCode provider-scoped catalog. |
| `openrouter/openai/o1`                  |      15.00 |       60.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6146ms | Not found in the live OpenCode provider-scoped catalog. |

Interpretation: no new candidate. These expensive OpenAI legacy/deep-research routes exist in OpenRouter, but none is currently launchable through OpenCode's provider-scoped catalog.

## Ultra-Expensive Pro Tail Single-Run

Source: small ultra-expensive batch from remaining Opus/OpenAI Pro routes. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-more-gauntlet-1777178864" OPENCODE_E2E_MODELS="openrouter/anthropic/claude-opus-4.1,openrouter/anthropic/claude-opus-4,openrouter/openai/o3-pro,openrouter/openai/gpt-5-pro" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                  | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| -------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/anthropic/claude-opus-4.1` |      15.00 |       75.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 9975ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |
| `openrouter/anthropic/claude-opus-4`   |      15.00 |       75.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8442ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |
| `openrouter/openai/o3-pro`             |      20.00 |       80.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6138ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-5-pro`          |      15.00 |      120.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8762ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |

Interpretation: no new candidate. Opus 4.x and GPT-5 Pro reached OpenRouter but were blocked by key/max_tokens allowance before behavioral testing. `o3-pro` was absent from OpenCode's provider-scoped launch catalog.

## Final Pro Tail Single-Run

Source: final pro-tail batch, excluding `openrouter/auto` because it is an aggregator route rather than a stable model candidate. Prices were read from `https://openrouter.ai/api/v1/models` before the run.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-more-gauntlet-1777178974" OPENCODE_E2E_MODELS="openrouter/anthropic/claude-opus-4.6-fast,openrouter/openai/gpt-5.2-pro,openrouter/openai/gpt-5.5-pro,openrouter/openai/gpt-5.4-pro" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                       | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                                           |
| ------------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | --------------------------------------------------------------------- |
| `openrouter/anthropic/claude-opus-4.6-fast` |      30.00 |      150.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 7245ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-5.2-pro`             |      21.00 |      168.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 9413ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |
| `openrouter/openai/gpt-5.5-pro`             |      30.00 |      180.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6177ms | Not found in the live OpenCode provider-scoped catalog.               |
| `openrouter/openai/gpt-5.4-pro`             |      30.00 |      180.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 8702ms | OpenRouter key/max_tokens allowance was too low for launch bootstrap. |

Interpretation: no new candidate. The only remaining pro-tail routes either are absent from OpenCode's provider-scoped catalog or cannot pass the launch bootstrap with the current OpenRouter key/max_tokens allowance. Further testing here requires a higher key allowance before behavioral conclusions are possible.

## Auto Router Single-Run

Source: final unrecorded OpenRouter tool-capable route from the catalog sweep. `openrouter/auto` is an aggregator route rather than a stable model candidate, but it was still checked to avoid leaving an unclassified entry.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-more-gauntlet-1777179110" OPENCODE_E2E_MODELS="openrouter/openrouter/auto" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                        | Input $/1M | Output $/1M | Verdict       | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                             |
| ---------------------------- | ---------: | ----------: | ------------- | --------: | --: | --------: | ---------------- | -----: | ------------------------------------------------------- |
| `openrouter/openrouter/auto` |      -1.00 |       -1.00 | Infra blocked |         0 |   0 |       0/1 | provider-infra   | 6596ms | Not found in the live OpenCode provider-scoped catalog. |

Interpretation: no candidate. Even the OpenRouter auto-router was not present in OpenCode's provider-scoped launch catalog, and it would be unsuitable for a stable Agent Teams recommendation anyway because routing can vary by request.

## Edge Free And Non-Tool Routes Single-Run

Source: first edge batch outside the tool-capable sweep. These routes were selected from unrecorded low-cost/free OpenRouter entries to explicitly classify non-tool, OCR/audio/router-like models that are unlikely to fit Agent Teams.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-edge-gauntlet-1777179178" OPENCODE_E2E_MODELS="openrouter/openrouter/pareto-code,openrouter/openrouter/bodybuilder,openrouter/baidu/qianfan-ocr-fast:free,openrouter/google/lyria-3-pro-preview,openrouter/liquid/lfm-2.5-1.2b-thinking:free,openrouter/liquid/lfm-2.5-1.2b-instruct:free,openrouter/google/gemma-3-4b-it:free,openrouter/meta-llama/llama-3.2-3b-instruct:free" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                              | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                              |
| -------------------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | -------------------------------------------------------- |
| `openrouter/openrouter/pareto-code`                |      -1.00 |       -1.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6615ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/openrouter/bodybuilder`                |      -1.00 |       -1.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6048ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/baidu/qianfan-ocr-fast:free`           |       0.00 |        0.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6035ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/google/lyria-3-pro-preview`            |       0.00 |        0.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6088ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/liquid/lfm-2.5-1.2b-thinking:free`     |       0.00 |        0.00 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 8597ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/liquid/lfm-2.5-1.2b-instruct:free`     |       0.00 |        0.00 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 8563ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/google/gemma-3-4b-it:free`             |       0.00 |        0.00 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 8759ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/meta-llama/llama-3.2-3b-instruct:free` |       0.00 |        0.00 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 7912ms | OpenRouter reported no tool-use endpoint for this route. |

Interpretation: no new candidate. The router/OCR/audio-like routes were absent from OpenCode's provider-scoped catalog. The small free text routes were visible enough to reach OpenRouter, but lack tool-use endpoints, so they cannot support Agent Teams MCP messaging.

## Edge Guard Vision And Distill Routes Single-Run

Source: second edge batch outside the tool-capable sweep, covering free Gemma/Hermes, small Granite/Phi, guard, vision, and distill routes.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-edge-gauntlet-1777179324" OPENCODE_E2E_MODELS="openrouter/google/gemma-3-27b-it:free,openrouter/nousresearch/hermes-3-llama-3.1-405b:free,openrouter/google/gemma-3-4b-it,openrouter/ibm-granite/granite-4.0-h-micro,openrouter/microsoft/phi-4,openrouter/meta-llama/llama-guard-4-12b,openrouter/qwen/qwen-vl-plus,openrouter/deepseek/deepseek-r1-distill-qwen-32b" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                                  | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                              |
| ------------------------------------------------------ | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | -------------------------------------------------------- |
| `openrouter/google/gemma-3-27b-it:free`                |       0.00 |        0.00 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 9675ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/nousresearch/hermes-3-llama-3.1-405b:free` |       0.00 |        0.00 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 8710ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/google/gemma-3-4b-it`                      |       0.04 |        0.08 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 8724ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/ibm-granite/granite-4.0-h-micro`           |      0.017 |        0.11 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6065ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/microsoft/phi-4`                           |      0.065 |        0.14 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6055ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/meta-llama/llama-guard-4-12b`              |       0.18 |        0.18 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6048ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/qwen/qwen-vl-plus`                         |     0.1365 |      0.4095 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5995ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/deepseek/deepseek-r1-distill-qwen-32b`     |       0.29 |        0.29 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5822ms | Not found in the live OpenCode provider-scoped catalog.  |

Interpretation: no new candidate. Free Gemma/Hermes and paid Gemma lacked tool-use endpoints, while Granite/Phi/guard/vision/distill routes were absent from OpenCode's provider-scoped launch catalog.

## Edge Creative Small And UI Routes Single-Run

Source: third edge batch outside the tool-capable sweep, covering audio/creative preview, free uncensored/Gemma, small Liquid/Llama, UI-TARS, ERNIE thinking, and Arcee Spotlight.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-edge-gauntlet-1777179503" OPENCODE_E2E_MODELS="openrouter/google/lyria-3-clip-preview,openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition:free,openrouter/google/gemma-3-12b-it:free,openrouter/liquid/lfm-2-24b-a2b,openrouter/meta-llama/llama-3.2-1b-instruct,openrouter/bytedance/ui-tars-1.5-7b,openrouter/baidu/ernie-4.5-21b-a3b-thinking,openrouter/arcee-ai/spotlight" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                                                      | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                              |
| -------------------------------------------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | -------------------------------------------------------- |
| `openrouter/google/lyria-3-clip-preview`                                   |       0.00 |        0.00 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6694ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition:free` |       0.00 |        0.00 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 8886ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/google/gemma-3-12b-it:free`                                    |       0.00 |        0.00 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 8542ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/liquid/lfm-2-24b-a2b`                                          |       0.03 |        0.12 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6188ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/meta-llama/llama-3.2-1b-instruct`                              |      0.027 |        0.20 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6094ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/bytedance/ui-tars-1.5-7b`                                      |       0.10 |        0.20 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5779ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/baidu/ernie-4.5-21b-a3b-thinking`                              |       0.07 |        0.28 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6056ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/arcee-ai/spotlight`                                            |       0.18 |        0.18 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6007ms | Not found in the live OpenCode provider-scoped catalog.  |

Interpretation: no new candidate. The free Dolphin/Gemma routes lacked tool-use endpoints. The creative preview, small Liquid/Llama, UI, ERNIE, and Arcee routes were absent from OpenCode's provider-scoped launch catalog.

## Edge Llama Hermes Reasoning And Vision Routes Single-Run

Source: fourth edge batch outside the tool-capable sweep, covering small Llama, Llama vision, Llama Guard, Hermes 70B, Olmo/Tencent reasoning, Llama 4 Maverick, and Nemotron VL.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-edge-gauntlet-1777179653" OPENCODE_E2E_MODELS="openrouter/meta-llama/llama-3.2-3b-instruct,openrouter/meta-llama/llama-3.2-11b-vision-instruct,openrouter/meta-llama/llama-guard-3-8b,openrouter/nousresearch/hermes-3-llama-3.1-70b,openrouter/allenai/olmo-3-32b-think,openrouter/tencent/hunyuan-a13b-instruct,openrouter/meta-llama/llama-4-maverick,openrouter/nvidia/nemotron-nano-12b-v2-vl" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                                 | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                              |
| ----------------------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | -------------------------------------------------------- |
| `openrouter/meta-llama/llama-3.2-3b-instruct`         |      0.051 |        0.34 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6598ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/meta-llama/llama-3.2-11b-vision-instruct` |      0.245 |       0.245 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 9078ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/meta-llama/llama-guard-3-8b`              |       0.48 |        0.03 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5728ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/nousresearch/hermes-3-llama-3.1-70b`      |       0.30 |        0.30 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6140ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/allenai/olmo-3-32b-think`                 |       0.15 |        0.50 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5893ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/tencent/hunyuan-a13b-instruct`            |       0.14 |        0.57 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6118ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/meta-llama/llama-4-maverick`              |       0.15 |        0.60 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6072ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/nvidia/nemotron-nano-12b-v2-vl`           |       0.20 |        0.60 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6214ms | Not found in the live OpenCode provider-scoped catalog.  |

Interpretation: no new candidate. Llama vision lacked a tool-use endpoint. The rest of this edge batch was absent from OpenCode's provider-scoped launch catalog.

## Edge Mid-Cost Creative Coder And Distill Routes Single-Run

Source: fifth edge batch outside the tool-capable sweep, covering creative/roleplay routes, Qwen VL, WizardLM, Arcee Coder, Baidu ERNIE, Sao10K, and DeepSeek distill.

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_REPORT_DIR="/tmp/opencode-edge-gauntlet-1777179799" OPENCODE_E2E_MODELS="openrouter/thedrummer/cydonia-24b-v4.1,openrouter/qwen/qwen2.5-vl-72b-instruct,openrouter/microsoft/wizardlm-2-8x22b,openrouter/arcee-ai/coder-large,openrouter/thedrummer/skyfall-36b-v2,openrouter/baidu/ernie-4.5-300b-a47b,openrouter/sao10k/l3.3-euryale-70b,openrouter/deepseek/deepseek-r1-distill-llama-70b" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                               | Input $/1M | Output $/1M | Verdict         | Readiness | Avg | Pass Runs | Dominant Failure |    p50 | Key finding                                              |
| --------------------------------------------------- | ---------: | ----------: | --------------- | --------: | --: | --------: | ---------------- | -----: | -------------------------------------------------------- |
| `openrouter/thedrummer/cydonia-24b-v4.1`            |       0.30 |        0.50 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 6797ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/qwen/qwen2.5-vl-72b-instruct`           |       0.25 |        0.75 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 8233ms | OpenRouter reported no tool-use endpoint for this route. |
| `openrouter/microsoft/wizardlm-2-8x22b`             |       0.62 |        0.62 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5419ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/arcee-ai/coder-large`                   |       0.50 |        0.80 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5508ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/thedrummer/skyfall-36b-v2`              |       0.55 |        0.80 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5589ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/baidu/ernie-4.5-300b-a47b`              |       0.28 |        1.10 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5441ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/sao10k/l3.3-euryale-70b`                |       0.65 |        0.75 | Infra blocked   |         0 |   0 |       0/1 | provider-infra   | 5581ms | Not found in the live OpenCode provider-scoped catalog.  |
| `openrouter/deepseek/deepseek-r1-distill-llama-70b` |       0.70 |        0.80 | Not recommended |         0 |   0 |       0/1 | provider-infra   | 7560ms | OpenRouter reported no tool-use endpoint for this route. |

Interpretation: no new candidate. Qwen VL and DeepSeek distill lacked tool-use endpoints. The creative, WizardLM, coder, ERNIE, and Sao10K routes were absent from OpenCode's provider-scoped launch catalog.

## Latest Single-Run Format Smoke

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=1 OPENCODE_E2E_MODELS="opencode/minimax-m2.5-free" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                        | Verdict     | Confidence | Behavior Avg | Overall Avg | Counted | Pass Runs | Provider Infra | Runtime Transport | Model Fails |      p50 |
| ---------------------------- | ----------- | ---------- | -----------: | ----------: | ------: | --------: | -------------: | ----------------: | ----------: | -------: |
| `opencode/minimax-m2.5-free` | Tested only | low        |           35 |          35 |     1/1 |       0/1 |              0 |                 0 |           1 | 226017ms |

Per-run details from the latest smoke:

| Run | Outcome         | Category       | Score | Counted | Duration | Failed Stages                                                                                  | Slowest Stage        | TaskRefs       | Protocol |
| --: | --------------- | -------------- | ----: | ------- | -------: | ---------------------------------------------------------------------------------------------- | -------------------- | -------------- | -------- |
|   1 | behavioral-fail | model-behavior |    35 | yes     | 226017ms | peerRelayAB, peerRelayBC, concurrentReplies, cleanTranscript, noDuplicateTokens, latencyStable | peerRelayAB:183786ms | directReply:ok | -        |

This result is useful as a smoke signal only. It is not enough to mark the model `Recommended`, and the latest single-run result shows instability in peer relay. Keep it below `Recommended` until it passes repeated counted runs.

## Repeated Top-3 Run

Source command:

```bash
OPENCODE_E2E=1 OPENCODE_E2E_SEMANTIC_MODEL_GAUNTLET=1 OPENCODE_E2E_USE_REAL_APP_CREDENTIALS=1 OPENCODE_E2E_GAUNTLET_RUNS=3 OPENCODE_E2E_MODELS="openrouter/minimax/minimax-m2.7,openrouter/anthropic/claude-sonnet-4.6,openrouter/google/gemini-3.1-pro-preview" pnpm vitest run test/main/services/team/OpenCodeSemanticModelGauntlet.live.test.ts
```

| Model                                      | Verdict            | Confidence | Behavior Avg | Overall Avg | Counted | Pass Runs | Provider Infra | Runtime Transport | Model Fails |      p50 |      p95 |
| ------------------------------------------ | ------------------ | ---------- | -----------: | ----------: | ------: | --------: | -------------: | ----------------: | ----------: | -------: | -------: |
| `openrouter/minimax/minimax-m2.7`          | Strong candidate   | high       |         88.3 |        88.3 |     3/3 |       2/3 |              0 |                 1 |           0 | 102425ms | 298070ms |
| `openrouter/anthropic/claude-sonnet-4.6`   | Recommended        | high       |          100 |         100 |     3/3 |       3/3 |              0 |                 0 |           0 | 107810ms | 109271ms |
| `openrouter/google/gemini-3.1-pro-preview` | Infra/test blocked | blocked    |          n/a |        33.3 |   mixed |       0/3 |       multiple |             mixed |       mixed | 251812ms | 315644ms |

## Interpretation

`openrouter/anthropic/claude-sonnet-4.6` historically passed repeated production-path launches, direct delivery, peer relay, chained peer relay, concurrent deliveries, taskRefs, transcript hygiene, and duplicate guard checks. It is still kept as `Tested` in UI until rerun under the current gauntlet and recommendation gate.

`openrouter/minimax/minimax-m2.7` is a strong candidate, not recommended yet. It passed 2/3 full runs, but one run hit a runtime transport failure during near-concurrent delivery: `tom` attempted `agent-teams_message_send` with correct payload, OpenCode returned `OpenCode tool failed without output`, and the expected visible reply never reached `user.json`.

Latest 2026-04-26 targeted rerun passed 1/1 with 100/100 readiness and no runtime transport, taskRefs, protocol, duplicate-token, or transcript-hygiene failures. Product UI now treats it as `Tested`, not `Recommended`.

`opencode/minimax-m2.5-free` has mixed gauntlet evidence: one earlier single-run pass and one latest single-run behavioral failure in peer relay. It should stay below `Recommended` and needs repeated runs before any promotion.

`openrouter/google/gemini-3.1-pro-preview` is not judged as a clean model failure from this evidence because OpenRouter credit/max-token limits contaminated the run. It needs rerun after provider limits are resolved.
